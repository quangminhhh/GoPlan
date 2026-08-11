import os
import subprocess
import sys
from datetime import date, time, timedelta
from decimal import Decimal
from uuid import uuid4

from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from ai.agent.tools import TOOLS, openai_tool_params, resolve_tool


class AIAgentImportSmokeTests(SimpleTestCase):
    def test_chat_services_and_action_drafts_import_in_clean_process(self):
        environment = os.environ.copy()
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import django; "
                    "django.setup(); "
                    "import chat.services; "
                    "import ai.agent.drafts"
                ),
            ],
            capture_output=True,
            check=False,
            env=environment,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)


class ToolRegistryTests(SimpleTestCase):
    def test_registry_includes_all_expected_tools(self):
        names = {t.name for t in TOOLS}
        self.assertIn("create_timeline_activity", names)
        self.assertIn("create_expense", names)
        self.assertIn("update_action_draft", names)
        self.assertIn("respond_to_user", names)

    def test_openai_tool_params_round_trip(self):
        params = openai_tool_params()
        self.assertEqual(len(params), len(TOOLS))
        for p in params:
            self.assertEqual(p["type"], "function")
            self.assertIn("name", p["function"])
            self.assertIn("parameters", p["function"])

    def test_resolve_tool_returns_handler(self):
        tool = resolve_tool("create_timeline_activity")
        self.assertEqual(tool.name, "create_timeline_activity")
        self.assertTrue(callable(tool.handler))


class ToolHandlerTests(TestCase):
    def setUp(self):
        from chat.models import ChatMessage
        from ai.models import AIInteraction, AIInteractionStatus
        from test_helpers import create_completed_user
        from trips.services import create_trip

        self.user = create_completed_user(
            "tool-handler@example.com",
            "toolhandler",
            "TH001",
        )
        self.trip = create_trip(
            captain=self.user,
            name="Tool Handler Trip",
            destination="Hanoi",
            start_date="2026-07-01",
            end_date="2026-07-03",
        )
        self.prompt_message = ChatMessage.objects.create(
            trip=self.trip,
            sender=self.user,
            sender_display_name_snapshot=self.user.display_name,
            sender_identify_tag_snapshot=self.user.identify_tag,
            content="@GoPlanAI add activity",
            client_message_id=uuid4(),
        )
        self.interaction = AIInteraction.objects.create(
            trip=self.trip,
            requested_by=self.user,
            prompt_message=self.prompt_message,
            prompt="add activity",
            status=AIInteractionStatus.RUNNING,
            lock_expires_at=timezone.now() + timedelta(minutes=5),
        )

    def test_create_timeline_activity_persists_draft(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraft, AIActionDraftStatus

        section_id = uuid4()
        result = handlers.create_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateTimelineActivityArgs(
                section_id=section_id,
                title="X",
                system_type="SIGHTSEEING",
                time_mode="FLEXIBLE",
            ),
        )
        self.assertIsInstance(result.draft, AIActionDraft)
        self.assertEqual(result.draft.action_type, "timeline.activity.create")
        self.assertEqual(result.draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertIn(
            "section_id",
            {field["name"] for field in result.draft.missing_fields},
        )
        self.assertEqual(
            result.draft.payload,
            {
                "section_id": str(section_id),
                "data": {
                    "title": "X",
                    "system_type": "SIGHTSEEING",
                    "time_mode": "FLEXIBLE",
                    "assignee_scope": "EVERYONE",
                },
            },
        )
        self.assertEqual(result.draft.display["icon"], "activity")
        self.assertNotIn("section_label", result.draft.preview)
        self.assertNotIn("section_date", result.draft.preview)
        self.assertNotIn(
            "Date",
            {row["label"]: row["value"] for row in result.draft.display["meta"]},
        )
        review_wire = str(
            {
                "preview": result.draft.preview,
                "display": result.draft.display,
            }
        )
        self.assertNotIn(str(section_id), review_wire)

    def test_create_timeline_activity_resolves_section_context_for_review(self):
        from ai.agent import handlers, schemas

        section = self.trip.timeline_sections.order_by("section_date").first()
        result = handlers.create_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateTimelineActivityArgs(
                section_id=section.id,
                title="Sunset walk",
                system_type="SIGHTSEEING",
                time_mode="TIME_RANGE",
                start_time=time(18, 0),
                end_time=time(20, 0),
                location_label="Da Nang beach",
            ),
        )

        draft = result.draft
        self.assertEqual(draft.preview["section_label"], section.label)
        self.assertEqual(
            draft.preview["section_date"],
            section.section_date.isoformat(),
        )
        self.assertEqual(draft.preview["resolved_data"]["title"], "Sunset walk")
        self.assertEqual(
            draft.preview["resolved_data"]["start_time"],
            "18:00:00",
        )
        meta = {row["label"]: row["value"] for row in draft.display["meta"]}
        self.assertEqual(
            meta["Date"],
            f"{section.label} · {section.section_date.isoformat()}",
        )
        self.assertEqual(meta["Time"], "18:00 – 20:00")
        self.assertEqual(meta["Location"], "Da Nang beach")

    def test_create_timeline_activity_persists_section_date_for_uncreated_day(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraft

        result = handlers.create_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateTimelineActivityArgs(
                section_date=date(2026, 7, 3),
                title="X",
                system_type="SIGHTSEEING",
                time_mode="FLEXIBLE",
            ),
        )

        self.assertIsInstance(result.draft, AIActionDraft)
        self.assertEqual(result.draft.action_type, "timeline.activity.create")
        self.assertEqual(
            result.draft.payload,
            {
                "section_date": "2026-07-03",
                "data": {
                    "title": "X",
                    "system_type": "SIGHTSEEING",
                    "time_mode": "FLEXIBLE",
                    "assignee_scope": "EVERYONE",
                },
            },
        )

    def test_update_timeline_activity_persists_nested_patch_data(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraft

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Old stop",
            time_mode="FLEXIBLE",
            system_type="SIGHTSEEING",
        )
        result = handlers.update_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateTimelineActivityArgs(
                activity_id=activity.id,
                title="Updated stop",
            ),
        )

        self.assertIsInstance(result.draft, AIActionDraft)
        self.assertEqual(result.draft.action_type, "timeline.activity.update")
        self.assertEqual(
            result.draft.payload,
            {
                "activity_id": str(activity.id),
                "data": {
                    "title": "Updated stop",
                },
            },
        )
        self.assertEqual(
            result.draft.preconditions["target"]["id"],
            str(activity.id),
        )

    def test_update_timeline_activity_persists_extended_patch_data(self):
        from ai.agent import handlers, schemas

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Old stop",
            time_mode="FLEXIBLE",
            system_type="SIGHTSEEING",
        )
        result = handlers.update_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateTimelineActivityArgs(
                activity_id=activity.id,
                note="Bring cash.",
                meeting_point="Hotel lobby",
                reminder_offsets_minutes=[30],
            ),
        )

        self.assertEqual(
            result.draft.payload,
            {
                "activity_id": str(activity.id),
                "data": {
                    "note": "Bring cash.",
                    "meeting_point": "Hotel lobby",
                    "reminder_offsets_minutes": [30],
                },
            },
        )

    def test_update_timeline_activity_resolves_target_and_end_time_only(self):
        from ai.agent import handlers, schemas

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Old stop",
            time_mode="TIME_RANGE",
            start_time=time(8, 0),
            end_time=time(9, 0),
            system_type="SIGHTSEEING",
            location_label="Old Quarter",
        )

        result = handlers.update_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateTimelineActivityArgs(
                activity_id=activity.id,
                end_time=time(10, 0),
            ),
        )

        draft = result.draft
        self.assertEqual(
            draft.payload,
            {
                "activity_id": str(activity.id),
                "data": {"end_time": "10:00:00"},
            },
        )
        self.assertEqual(draft.preview["data"], {"end_time": "10:00:00"})
        self.assertEqual(draft.preview["target_title"], "Old stop")
        self.assertEqual(draft.preview["section_label"], section.label)
        self.assertEqual(
            draft.preview["resolved_data"]["start_time"],
            "08:00:00",
        )
        self.assertEqual(
            draft.preview["resolved_data"]["end_time"],
            "10:00:00",
        )
        meta = {row["label"]: row["value"] for row in draft.display["meta"]}
        self.assertEqual(draft.display["title"], "Old stop")
        self.assertEqual(meta["Target"], "Old stop")
        self.assertEqual(meta["Time"], "08:00 – 10:00")
        self.assertEqual(meta["Location"], "Old Quarter")

    def test_update_timeline_activity_distinguishes_missing_and_cleared_location(self):
        from ai.agent import handlers, schemas

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Cafe stop",
            time_mode="FLEXIBLE",
            system_type="FOOD",
            location_label="Riverside Cafe",
        )

        preserved = handlers.update_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateTimelineActivityArgs(
                activity_id=activity.id,
                note="Bring cash",
            ),
        ).draft
        cleared = handlers.update_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateTimelineActivityArgs(
                activity_id=activity.id,
                location_label="",
            ),
        ).draft

        preserved_meta = {
            row["label"]: row["value"] for row in preserved.display["meta"]
        }
        cleared_meta = {
            row["label"]: row["value"] for row in cleared.display["meta"]
        }
        self.assertNotIn("location_label", preserved.payload["data"])
        self.assertEqual(
            preserved.preview["resolved_data"]["location_label"],
            "Riverside Cafe",
        )
        self.assertEqual(preserved_meta["Location"], "Riverside Cafe")
        self.assertIn("location_label", cleared.payload["data"])
        self.assertEqual(cleared.payload["data"]["location_label"], "")
        self.assertEqual(cleared.preview["resolved_data"]["location_label"], "")
        self.assertEqual(cleared_meta["Location"], "Cleared")

    def test_update_timeline_activity_all_day_clears_stale_clock_range_in_review(self):
        from ai.agent import handlers, schemas

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Museum",
            time_mode="TIME_RANGE",
            start_time=time(8, 0),
            end_time=time(10, 0),
            system_type="SIGHTSEEING",
        )

        draft = handlers.update_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateTimelineActivityArgs(
                activity_id=activity.id,
                time_mode="ALL_DAY",
            ),
        ).draft

        resolved = draft.preview["resolved_data"]
        self.assertEqual(resolved["time_mode"], "ALL_DAY")
        self.assertIsNone(resolved["start_time"])
        self.assertIsNone(resolved["end_time"])
        meta = {row["label"]: row["value"] for row in draft.display["meta"]}
        self.assertEqual(meta["Time"], "All day")

    def test_create_timeline_activity_reviews_all_hidden_editable_fields(self):
        from ai.agent import handlers, schemas
        from test_helpers import create_completed_user
        from trips.models import (
            MemberStatus,
            TimelineCustomType,
            TripMember,
            TripRole,
        )

        section = self.trip.timeline_sections.order_by("section_date").first()
        custom_type = TimelineCustomType.objects.create(
            trip=self.trip,
            name="Photo walk",
            normalized_name="photo-walk",
            created_by=self.user,
        )
        assignee = create_completed_user(
            "tool-hidden-assignee@example.com",
            "toolhidden",
            "TH002",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=assignee,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

        draft = handlers.create_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateTimelineActivityArgs(
                section_id=section.id,
                title="Hidden detail review",
                custom_type_id=custom_type.id,
                time_mode="AT_TIME",
                start_time=time(9, 0),
                assignee_scope="USER",
                assignee_user_id=assignee.id,
                booking_reference="BK-42",
                contact_name="Lan",
                contact_phone="+84 123",
                external_link="https://example.com/booking",
                location_note="Use the east entrance",
                meeting_point="Hotel lobby",
                note="Bring water",
                reminder_offsets_minutes=[1440, 30],
            ),
        ).draft

        meta = {row["label"]: row["value"] for row in draft.display["meta"]}
        self.assertEqual(meta["Custom type"], "Photo walk")
        self.assertEqual(meta["Assignee"], assignee.display_name)
        self.assertEqual(meta["Booking reference"], "BK-42")
        self.assertEqual(meta["Contact name"], "Lan")
        self.assertEqual(meta["Contact phone"], "+84 123")
        self.assertEqual(meta["External link"], "https://example.com/booking")
        self.assertEqual(meta["Location note"], "Use the east entrance")
        self.assertEqual(meta["Meeting point"], "Hotel lobby")
        self.assertEqual(meta["Note"], "Bring water")
        self.assertEqual(meta["Reminders"], "1 day before · 30 minutes before")
        review_wire = str({"preview": draft.preview, "display": draft.display})
        self.assertNotIn(str(section.id), review_wire)
        self.assertNotIn(str(custom_type.id), review_wire)
        self.assertNotIn(str(assignee.id), review_wire)

    def test_create_timeline_activity_rejects_untrusted_trip_scoped_references(self):
        from ai.agent.drafts import create_action_draft
        from ai.models import AIActionDraftStatus
        from test_helpers import create_completed_user
        from trips.models import (
            MemberStatus,
            TimelineCustomType,
            TripMember,
            TripRole,
        )
        from trips.services import create_trip

        other_captain = create_completed_user(
            "tool-other-captain@example.com",
            "toolothercaptain",
            "TH004",
        )
        other_trip = create_trip(
            captain=other_captain,
            name="Other Tool Trip",
            destination="Hue",
            start_date="2026-08-01",
            end_date="2026-08-02",
        )
        local_section = self.trip.timeline_sections.order_by("section_date").first()
        foreign_section = other_trip.timeline_sections.order_by("section_date").first()
        foreign_custom = TimelineCustomType.objects.create(
            trip=other_trip,
            name="Foreign custom",
            normalized_name="foreign-custom",
            created_by=other_captain,
        )
        inactive_custom = TimelineCustomType.objects.create(
            trip=self.trip,
            name="Inactive custom",
            normalized_name="inactive-custom",
            is_active=False,
            created_by=self.user,
        )
        inactive_assignee = create_completed_user(
            "tool-left-assignee@example.com",
            "toolleftassignee",
            "TH005",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=inactive_assignee,
            role=TripRole.MEMBER,
            status=MemberStatus.LEFT,
        )
        foreign_assignee = create_completed_user(
            "tool-foreign-assignee@example.com",
            "toolforeignassignee",
            "TH006",
        )
        removed_assignee = create_completed_user(
            "tool-removed-assignee@example.com",
            "toolremovedassignee",
            "TH007",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=removed_assignee,
            role=TripRole.MEMBER,
            status=MemberStatus.REMOVED,
        )

        cases = (
            (
                "missing section",
                {"section_id": str(uuid4())},
                {"section_id"},
            ),
            (
                "foreign section",
                {
                    "section_id": str(foreign_section.id),
                    "data": {
                        "title": "Foreign timeline day",
                        "time_mode": "TIME_RANGE",
                        "system_type": "SIGHTSEEING",
                    },
                },
                {"section_id"},
            ),
            (
                "foreign custom type",
                {
                    "section_id": str(local_section.id),
                    "data": {
                        "title": "Foreign custom",
                        "time_mode": "FLEXIBLE",
                        "custom_type_id": str(foreign_custom.id),
                    },
                },
                {"custom_type_id"},
            ),
            (
                "inactive custom type",
                {
                    "section_id": str(local_section.id),
                    "data": {
                        "title": "Inactive custom",
                        "time_mode": "FLEXIBLE",
                        "custom_type_id": str(inactive_custom.id),
                    },
                },
                {"custom_type_id"},
            ),
            (
                "left assignee",
                {
                    "section_id": str(local_section.id),
                    "data": {
                        "title": "Inactive assignee",
                        "time_mode": "FLEXIBLE",
                        "system_type": "SIGHTSEEING",
                        "assignee_scope": "USER",
                        "assignee_user_id": str(inactive_assignee.id),
                    },
                },
                {"assignee_user_id"},
            ),
            (
                "foreign assignee",
                {
                    "section_id": str(local_section.id),
                    "data": {
                        "title": "Foreign assignee",
                        "time_mode": "FLEXIBLE",
                        "system_type": "SIGHTSEEING",
                        "assignee_scope": "USER",
                        "assignee_user_id": str(foreign_assignee.id),
                    },
                },
                {"assignee_user_id"},
            ),
            (
                "removed assignee",
                {
                    "section_id": str(local_section.id),
                    "data": {
                        "title": "Removed assignee",
                        "time_mode": "FLEXIBLE",
                        "system_type": "SIGHTSEEING",
                        "assignee_scope": "USER",
                        "assignee_user_id": str(removed_assignee.id),
                    },
                },
                {"assignee_user_id"},
            ),
        )

        base_payload = {
            "data": {
                "title": "Untrusted reference",
                "time_mode": "FLEXIBLE",
                "system_type": "SIGHTSEEING",
            }
        }
        for label, overrides, expected_missing in cases:
            with self.subTest(label=label):
                payload = {
                    **base_payload,
                    **overrides,
                }
                draft = create_action_draft(
                    trip=self.trip,
                    interaction=self.interaction,
                    action_type="timeline.activity.create",
                    payload=payload,
                )
                self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
                self.assertTrue(
                    expected_missing
                    <= {field["name"] for field in draft.missing_fields}
                )
                untrusted_ids = (
                    str(foreign_section.id),
                    str(foreign_custom.id),
                    str(inactive_custom.id),
                    str(inactive_assignee.id),
                    str(foreign_assignee.id),
                    str(removed_assignee.id),
                )
                review_wire = str(
                    {
                        "preview": draft.preview,
                        "display": draft.display,
                        "missing_fields": draft.missing_fields,
                    }
                )
                for untrusted_id in untrusted_ids:
                    self.assertNotIn(untrusted_id, review_wire)

    def test_update_timeline_activity_reviews_explicit_clears_not_missing_fields(self):
        from ai.agent import handlers, schemas

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Clear hidden details",
            time_mode="FLEXIBLE",
            system_type="SIGHTSEEING",
            booking_reference="KEEP-ME",
            contact_name="Old name",
            contact_phone="Old phone",
            external_link="https://example.com/old",
            location_note="Old location note",
            meeting_point="Old point",
            note="Old note",
        )

        draft = handlers.update_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateTimelineActivityArgs(
                activity_id=activity.id,
                contact_name="",
                contact_phone="",
                external_link="",
                location_note="",
                meeting_point="",
                note="",
                reminder_offsets_minutes=[],
            ),
        ).draft

        meta = {row["label"]: row["value"] for row in draft.display["meta"]}
        for label in (
            "Contact name",
            "Contact phone",
            "External link",
            "Location note",
            "Meeting point",
            "Note",
            "Reminders",
        ):
            self.assertEqual(meta[label], "Cleared")
        self.assertNotIn("Booking reference", meta)
        self.assertNotIn("booking_reference", draft.payload["data"])

    def test_update_timeline_activity_reviews_structured_place_and_custom_type_transition(self):
        from ai.agent import handlers, schemas
        from trips.models import TimelineCustomType

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Old manual stop",
            time_mode="FLEXIBLE",
            system_type="SIGHTSEEING",
            location_mode="MANUAL",
            location_label="Old manual label",
        )
        custom_type = TimelineCustomType.objects.create(
            trip=self.trip,
            name="Workshop",
            normalized_name="workshop",
            created_by=self.user,
        )

        draft = handlers.update_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateTimelineActivityArgs(
                activity_id=activity.id,
                custom_type_id=custom_type.id,
                location_mode="STRUCTURED",
                place=schemas.PlaceArgs(
                    provider="google",
                    provider_id="place-123",
                    title="New structured venue",
                    address="1 River Road",
                    lat="16.054407",
                    lng="108.202164",
                ),
            ),
        ).draft

        resolved = draft.preview["resolved_data"]
        meta = {row["label"]: row["value"] for row in draft.display["meta"]}
        self.assertEqual(resolved["system_type"], "")
        self.assertEqual(resolved["custom_type_label"], "Workshop")
        self.assertEqual(meta["Location"], "New structured venue")
        self.assertEqual(meta["Custom type"], "Workshop")
        review_wire = str({"preview": draft.preview, "display": draft.display})
        self.assertNotIn("place-123", review_wire)
        self.assertNotIn("16.054407", review_wire)
        self.assertNotIn("108.202164", review_wire)

    def test_update_timeline_activity_invalid_merged_states_never_become_ready(self):
        from ai.agent.drafts import create_action_draft
        from ai.models import AIActionDraftStatus
        from test_helpers import create_completed_user
        from trips.models import (
            MemberStatus,
            TimelineActivityAssigneeScope,
            TimelineCustomType,
            TripMember,
            TripRole,
        )

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Planner target",
            time_mode="FLEXIBLE",
            system_type="SIGHTSEEING",
            location_mode="MANUAL",
            assignee_scope=TimelineActivityAssigneeScope.NONE,
        )
        inactive_custom = TimelineCustomType.objects.create(
            trip=self.trip,
            name="Inactive",
            normalized_name="inactive",
            is_active=False,
            created_by=self.user,
        )
        inactive_user = create_completed_user(
            "tool-inactive-assignee@example.com",
            "toolinactive",
            "TH003",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=inactive_user,
            role=TripRole.MEMBER,
            status=MemberStatus.LEFT,
        )
        cases = (
            ("time range without clocks", {"time_mode": "TIME_RANGE"}),
            (
                "structured without place",
                {"location_mode": "STRUCTURED"},
            ),
            (
                "place while manual",
                {
                    "place": {
                        "provider": "google",
                        "provider_id": "hidden",
                        "title": "Venue",
                    }
                },
            ),
            ("empty system type", {"system_type": ""}),
            (
                "simultaneous system and custom",
                {
                    "system_type": "FOOD",
                    "custom_type_id": str(inactive_custom.id),
                },
            ),
            (
                "assignee on non-user scope",
                {"assignee_user_id": str(inactive_user.id)},
            ),
            (
                "reminders while flexible",
                {"reminder_offsets_minutes": [30]},
            ),
            (
                "inactive custom type",
                {"custom_type_id": str(inactive_custom.id)},
            ),
            (
                "inactive assignee",
                {
                    "assignee_scope": "USER",
                    "assignee_user_id": str(inactive_user.id),
                },
            ),
        )

        for label, data in cases:
            with self.subTest(label=label):
                draft = create_action_draft(
                    trip=self.trip,
                    interaction=self.interaction,
                    action_type="timeline.activity.update",
                    payload={
                        "activity_id": str(activity.id),
                        "data": data,
                    },
                )
                self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)

    def test_update_timeline_activity_canonicalizes_at_time_end_clear(self):
        from ai.agent.drafts import create_action_draft
        from ai.models import AIActionDraftStatus

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Clock transition",
            time_mode="TIME_RANGE",
            start_time=time(8, 0),
            end_time=time(10, 0),
            system_type="SIGHTSEEING",
        )

        draft = create_action_draft(
            trip=self.trip,
            interaction=self.interaction,
            action_type="timeline.activity.update",
            payload={
                "activity_id": str(activity.id),
                "data": {"time_mode": "AT_TIME"},
            },
        )

        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertIn("end_time", draft.payload["data"])
        self.assertIsNone(draft.payload["data"]["end_time"])
        self.assertEqual(draft.preview["resolved_data"]["time_mode"], "AT_TIME")
        self.assertIsNone(draft.preview["resolved_data"]["end_time"])

    def test_update_expense_persists_description_and_collector(self):
        from ai.agent import handlers, schemas
        from expenses.services import create_expense

        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.user,
            title="Lunch",
            description="Old",
            total_amount=Decimal("2000000"),
            collector_id=self.user.id,
        )
        result = handlers.update_expense(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.UpdateExpenseArgs(
                expense_id=expense.id,
                description="Updated description",
                collector_id=self.user.id,
            ),
        )

        self.assertEqual(result.draft.action_type, "expense.update")
        self.assertEqual(
            result.draft.payload,
            {
                "expense_id": str(expense.id),
                "target_title": "Lunch",
                "description": "Updated description",
                "collector_id": str(self.user.id),
            },
        )

    def test_create_expense_keeps_fractional_vnd_draft_needs_info(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraftStatus

        self.assertEqual(self.trip.currency_code, "VND")
        result = handlers.create_expense(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateExpenseArgs(
                title="Coffee",
                total_amount=Decimal("25.50"),
                currency_code="USD",
            ),
        )

        self.assertEqual(result.draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(result.draft.payload["currency_code"], "VND")
        self.assertEqual(result.draft.display["hero"]["currency"], "VND")
        self.assertEqual(
            [field["name"] for field in result.draft.missing_fields],
            ["total_amount"],
        )

    def test_create_expense_uses_trip_currency_from_draft_through_confirmation(self):
        from ai.agent import handlers, schemas
        from ai.agent.executor import confirm_action_draft
        from ai.models import AIActionDraftStatus
        from expenses.models import Expense

        self.assertEqual(self.trip.currency_code, "VND")
        result = handlers.create_expense(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateExpenseArgs(
                title="Coffee",
                total_amount=Decimal("100"),
                currency_code="USD",
            ),
        )

        draft = result.draft
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["currency_code"], "VND")
        self.assertEqual(draft.display["hero"]["currency"], "VND")

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.user,
        )

        expense = Expense.objects.get(pk=confirmed.result["object_id"])
        self.assertEqual(confirmed.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(expense.total_amount, Decimal("100"))
        self.assertEqual(expense.currency_code, "VND")

    def test_create_expense_accepts_two_decimal_amount_for_usd_trip(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraftStatus

        self.trip.currency_code = "USD"
        self.trip.save(update_fields=["currency_code", "updated_at"])
        result = handlers.create_expense(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateExpenseArgs(
                title="Coffee",
                total_amount=Decimal("25.50"),
                currency_code="USD",
            ),
        )

        self.assertEqual(result.draft.status, AIActionDraftStatus.READY)
        self.assertEqual(result.draft.missing_fields, [])

    def test_create_expense_reloads_locked_trip_and_stamps_omitted_currency(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraftStatus
        from trips.models import Trip

        self.assertEqual(self.trip.currency_code, "VND")
        Trip.objects.filter(pk=self.trip.pk).update(currency_code="USD")

        result = handlers.create_expense(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateExpenseArgs(
                title="Coffee",
                total_amount=Decimal("25.50"),
            ),
        )

        self.assertEqual(self.trip.currency_code, "VND")
        self.assertEqual(result.draft.status, AIActionDraftStatus.READY)
        self.assertEqual(result.draft.payload["currency_code"], "USD")
        self.assertEqual(result.draft.preview["currency_code"], "USD")
        self.assertEqual(result.draft.display["hero"]["currency"], "USD")
        self.assertEqual(result.draft.missing_fields, [])

    def test_create_expense_keeps_decimalfield_overflow_draft_needs_info(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraftStatus

        self.trip.currency_code = "USD"
        self.trip.save(update_fields=["currency_code", "updated_at"])
        result = handlers.create_expense(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.CreateExpenseArgs(
                title="Coffee",
                total_amount=Decimal("1000000000000.00"),
            ),
        )

        self.assertEqual(result.draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(result.draft.payload["currency_code"], "USD")
        self.assertEqual(
            [field["name"] for field in result.draft.missing_fields],
            ["total_amount"],
        )

    def test_set_expense_contribution_persists_target_precondition(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraft
        from expenses.services import create_expense

        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.user,
            title="Lunch",
            description="",
            total_amount=Decimal("2000000"),
            collector_id=self.user.id,
        )

        result = handlers.set_expense_contribution(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.SetExpenseContributionArgs(
                expense_id=expense.id,
                contributions=[
                    {
                        "user_id": str(self.user.id),
                        "amount": "2000000",
                    },
                ],
            ),
        )

        self.assertIsInstance(result.draft, AIActionDraft)
        self.assertEqual(result.draft.action_type, "expense.contribution.set")
        self.assertEqual(
            result.draft.preconditions["target"]["id"],
            str(expense.id),
        )
        self.assertEqual(
            result.draft.preconditions["target"]["type"],
            "expense",
        )

    def test_set_expense_contribution_scope_persists_all_paid_payload(self):
        from ai.agent import handlers, schemas
        from expenses.services import create_expense

        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.user,
            title="Lunch",
            description="",
            total_amount=Decimal("100003"),
            collector_id=self.user.id,
        )

        result = handlers.set_expense_contribution(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.SetExpenseContributionArgs(
                expense_id=expense.id,
                scope="all_participants_paid",
            ),
        )

        self.assertEqual(result.draft.payload["scope"], "all_participants_paid")
        self.assertNotIn("contributions", result.draft.payload)

    def test_transfer_handler_enriches_display_payload_from_transfer(self):
        from ai.agent import handlers, schemas
        from expenses.services import (
            create_expense,
            finalize_settlement,
            set_contribution,
        )
        from trips.models import MemberStatus, TripMember, TripRole
        from test_helpers import create_completed_user

        member = create_completed_user(
            "tool-transfer-member@example.com",
            "tooltransfer",
            "TH002",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.user,
            title="Hotel",
            description="",
            total_amount=Decimal("900000"),
            collector_id=self.user.id,
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.user.id,
            amount=Decimal("900000"),
            actor=self.user,
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=member.id,
            amount=Decimal("0"),
            actor=self.user,
        )
        settlement = finalize_settlement(trip_id=self.trip.id, actor=self.user)
        transfer = settlement.transfers.get()

        result = handlers.mark_transfer_sent(
            trip=self.trip,
            interaction=self.interaction,
            actor=member,
            args=schemas.MarkTransferSentArgs(transfer_id=transfer.id),
        )

        self.assertEqual(result.draft.payload["amount"], "450000.00")
        self.assertEqual(result.draft.payload["currency_code"], "VND")
        self.assertEqual(result.draft.payload["from_name"], member.display_name)
        self.assertEqual(result.draft.payload["to_name"], self.user.display_name)
        self.assertEqual(result.draft.display["hero"]["value"], "450,000")
        self.assertEqual(
            result.draft.display["meta"],
            [
                {"label": "From", "value": member.display_name},
                {"label": "To", "value": self.user.display_name},
            ],
        )

    def test_finalize_settlement_skips_draft_when_trip_already_finalized(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraft
        from expenses.services import (
            create_expense,
            finalize_settlement,
            set_contribution,
        )

        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.user,
            title="Hotel",
            description="",
            total_amount=Decimal("1000000"),
            collector_id=self.user.id,
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.user.id,
            amount=Decimal("1000000"),
            actor=self.user,
        )
        finalize_settlement(trip_id=self.trip.id, actor=self.user)

        result = handlers.finalize_settlement(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.FinalizeSettlementArgs(),
        )

        self.assertIsNone(result.draft)
        self.assertIn("đã được quyết toán", result.message)
        self.assertFalse(
            AIActionDraft.objects.filter(action_type="settlement.finalize").exists()
        )

    def test_finalize_settlement_skips_draft_when_expenses_are_underfunded(self):
        from ai.agent import handlers, schemas
        from ai.models import AIActionDraft
        from expenses.services import create_expense

        create_expense(
            trip_id=self.trip.id,
            actor=self.user,
            title="Hotel",
            description="",
            total_amount=Decimal("1000000"),
            collector_id=self.user.id,
        )

        result = handlers.finalize_settlement(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.FinalizeSettlementArgs(),
        )

        self.assertIsNone(result.draft)
        self.assertIn("Chưa thể chốt quyết toán", result.message)
        self.assertIn("1000000.00 VND", result.message)
        self.assertFalse(
            AIActionDraft.objects.filter(action_type="settlement.finalize").exists()
        )

    def test_delete_activity_handler_enriches_display_payload_from_target(self):
        from ai.agent import handlers, schemas

        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Dragon Bridge photo walk",
            time_mode="FLEXIBLE",
            system_type="SIGHTSEEING",
        )

        result = handlers.delete_timeline_activity(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.DeleteTimelineActivityArgs(activity_id=activity.id),
        )

        self.assertEqual(result.draft.payload["title"], "Dragon Bridge photo walk")
        self.assertEqual(result.draft.display["title"], "Dragon Bridge photo walk")

    def test_delete_expense_handler_enriches_display_payload_from_target(self):
        from ai.agent import handlers, schemas
        from expenses.services import create_expense

        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.user,
            title="Hotel deposit",
            description="",
            total_amount=Decimal("1000000"),
            collector_id=self.user.id,
        )

        result = handlers.delete_expense(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.DeleteExpenseArgs(expense_id=expense.id),
        )

        self.assertEqual(result.draft.payload["title"], "Hotel deposit")
        self.assertEqual(result.draft.payload["total_amount"], "1000000.00")
        self.assertEqual(result.draft.display["title"], "Hotel deposit")
        self.assertEqual(result.draft.display["hero"]["value"], "1,000,000")

    def test_respond_to_user_returns_message_without_draft(self):
        from ai.agent import handlers, schemas

        result = handlers.respond_to_user(
            trip=self.trip,
            interaction=self.interaction,
            actor=self.user,
            args=schemas.RespondToUserArgs(message="hello"),
        )
        self.assertIsNone(result.draft)
        self.assertEqual(result.message, "hello")
