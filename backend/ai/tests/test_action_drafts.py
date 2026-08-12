from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch
from uuid import uuid4

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from ai.action_types import (
    AI_CONFIRMATION_CAPTAIN,
    AI_CONFIRMATION_TRANSFER_PAYER,
    AI_CONFIRMATION_TRANSFER_RECIPIENT,
)
from ai.agent.drafts import build_action_draft_payload, create_action_draft
from ai.lifecycle import finish_interaction_success
from ai.models import (
    AIActionDraft,
    AIActionDraftStatus,
    AIInteraction,
    AIInteractionStatus,
)
from chat.models import ChatMessage, ChatMessageSenderKind
from expenses.services import (
    confirm_transfer_received,
    create_expense,
    finalize_settlement,
    mark_transfer_sent,
    set_contribution,
)
from test_helpers import create_completed_user
from trips.models import (
    MemberStatus,
    TimelineActivityAssigneeScope,
    TimelineActivityStatus,
    TripMember,
    TripRole,
)
from trips.services import create_trip


class AIActionDraftModelTests(TestCase):
    def setUp(self):
        self.user = create_completed_user(
            "agent-draft@example.com",
            "agentdraft",
            "AID001",
        )
        self.trip = create_trip(
            captain=self.user,
            name="Agent Draft Trip",
            destination="Da Nang",
            start_date="2026-06-01",
            end_date="2026-06-03",
        )
        self.prompt_message = ChatMessage.objects.create(
            trip=self.trip,
            sender=self.user,
            sender_display_name_snapshot=self.user.display_name,
            sender_identify_tag_snapshot=self.user.identify_tag,
            content="@GoPlanAI add dinner expense",
            client_message_id=uuid4(),
        )
        self.response_message = ChatMessage.objects.create(
            trip=self.trip,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            content="I prepared a draft.",
        )
        self.interaction = AIInteraction.objects.create(
            trip=self.trip,
            requested_by=self.user,
            prompt_message=self.prompt_message,
            prompt="add dinner expense",
            status=AIInteractionStatus.SUCCEEDED,
            lock_expires_at=timezone.now() + timedelta(minutes=2),
        )

    def test_action_draft_persists_preview_and_payload(self):
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            payload={"title": "Dinner", "total_amount": "1200000"},
            preview={"title": "Dinner", "amount": "1,200,000 VND"},
            missing_fields=[],
            preconditions={},
            required_confirmation="CAPTAIN",
            expires_at=timezone.now() + timedelta(hours=24),
        )

        self.assertEqual(str(draft.trip_id), str(self.trip.id))
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["title"], "Dinner")
        self.assertEqual(draft.preview["amount"], "1,200,000 VND")

    def test_indexes_exist_for_trip_status_expiry_and_response_message(self):
        index_names = {index.name for index in AIActionDraft._meta.indexes}
        self.assertIn("ai_draft_trip_status_exp_idx", index_names)
        self.assertIn("ai_draft_response_idx", index_names)


class AIActionDraftPayloadTests(AIActionDraftModelTests):
    def test_partial_timeline_create_keeps_json_safe_clock_until_complete(self):
        section = self.trip.timeline_sections.order_by("section_date").first()

        draft = create_action_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            action_type="timeline.activity.create",
            payload={
                "section_id": str(section.id),
                "data": {
                    "title": "Museum visit",
                    "system_type": "SIGHTSEEING",
                    "time_mode": "TIME_RANGE",
                    "start_time": "2026-04-20T08:00:00+07:00",
                },
            },
        )

        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(
            draft.payload["data"]["start_time"],
            "08:00:00",
        )
        self.assertEqual(
            {field["name"] for field in draft.missing_fields},
            {"end_time"},
        )

    def test_captain_can_confirm_captain_managed_draft(self):
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            payload={"title": "Dinner"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            expires_at=timezone.now() + timedelta(hours=24),
        )

        payload = build_action_draft_payload(draft, viewer=self.user)

        self.assertTrue(payload["can_confirm"])
        self.assertTrue(payload["can_cancel"])

    def test_captain_can_confirm_draft_with_inferred_confirmation(self):
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.READY,
            payload={
                "section_id": str(
                    self.trip.timeline_sections.order_by("section_date")
                    .first()
                    .id
                ),
                "data": {"title": "Museum", "time_mode": "FLEXIBLE"},
            },
            preview={"title": "Museum"},
            missing_fields=[],
            preconditions={},
            required_confirmation="",
            expires_at=timezone.now() + timedelta(hours=24),
        )

        payload = build_action_draft_payload(draft, viewer=self.user)

        self.assertEqual(payload["required_confirmation"], AI_CONFIRMATION_CAPTAIN)
        self.assertTrue(payload["can_confirm"])

    def test_member_cannot_confirm_captain_managed_draft(self):
        member = create_completed_user(
            "agent-member@example.com",
            "agentmember",
            "AID002",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=member,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            payload={"title": "Dinner"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            expires_at=timezone.now() + timedelta(hours=24),
        )

        payload = build_action_draft_payload(draft, viewer=member)

        self.assertFalse(payload["can_confirm"])
        self.assertTrue(payload["can_cancel"])

    def test_assignee_can_confirm_timeline_status_update_draft(self):
        member = create_completed_user(
            "agent-status-member@example.com",
            "agentstatus",
            "AID003",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Museum",
            time_mode="FLEXIBLE",
            assignee_scope="USER",
            assignee_user=member,
            position=0,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=member,
            action_type="timeline.activity.status.update",
            status=AIActionDraftStatus.READY,
            payload={"activity_id": str(activity.id), "status": "IN_PROGRESS"},
            preview={"title": "Museum", "status": "IN_PROGRESS"},
            missing_fields=[],
            preconditions={},
            required_confirmation="TIMELINE_ACTIVITY_STATUS",
            expires_at=timezone.now() + timedelta(hours=24),
        )

        payload = build_action_draft_payload(draft, viewer=member)

        self.assertTrue(payload["can_confirm"])

    def test_assignee_can_edit_timeline_status_needs_info_draft(self):
        member = create_completed_user(
            "agent-edit-status-member@example.com",
            "agenteditstatus",
            "AID004",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Museum",
            time_mode="FLEXIBLE",
            assignee_scope=TimelineActivityAssigneeScope.USER,
            assignee_user=member,
            position=0,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.status.update",
            status=AIActionDraftStatus.NEEDS_INFO,
            payload={"activity_id": str(activity.id)},
            preview={"title": "Museum"},
            missing_fields=[{"name": "status", "label": "Status"}],
            preconditions={},
            required_confirmation="TIMELINE_ACTIVITY_STATUS",
            expires_at=timezone.now() + timedelta(hours=24),
        )

        payload = build_action_draft_payload(draft, viewer=member)

        self.assertFalse(payload["can_confirm"])
        self.assertFalse(payload["can_cancel"])
        self.assertTrue(payload["can_edit"])

    def test_malformed_transfer_id_cannot_break_draft_payload_rendering(self):
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="settlement.transfer.mark_sent",
            status=AIActionDraftStatus.READY,
            payload={"transfer_id": "not-a-uuid"},
            preview={"transfer_id": "not-a-uuid"},
            missing_fields=[],
            preconditions={},
            required_confirmation=AI_CONFIRMATION_TRANSFER_PAYER,
            expires_at=timezone.now() + timedelta(hours=24),
        )

        payload = build_action_draft_payload(draft, viewer=self.user)

        self.assertFalse(payload["can_confirm"])

    def test_missing_section_field_includes_select_options(self):
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            payload={"data": {"title": "Museum", "time_mode": "FLEXIBLE"}},
            preview={"title": "Museum"},
            missing_fields=[{"name": "section_id", "label": "Timeline day"}],
            preconditions={},
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            expires_at=timezone.now() + timedelta(hours=24),
        )

        payload = build_action_draft_payload(draft, viewer=self.user)

        section_field = payload["missing_fields"][0]
        self.assertEqual(section_field["type"], "select")
        self.assertEqual(
            section_field["options"][0]["value"],
            str(self.trip.timeline_sections.order_by("section_date").first().id),
        )

    def test_expired_ready_draft_payload_is_rendered_as_expired(self):
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            payload={"title": "Dinner", "total_amount": "1200000"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        payload = build_action_draft_payload(draft, viewer=self.user)

        self.assertEqual(payload["status"], AIActionDraftStatus.EXPIRED)
        self.assertFalse(payload["can_confirm"])
        self.assertFalse(payload["can_cancel"])

    def test_missing_target_identity_is_rendered_as_read_only_target_field(self):
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.update",
            status=AIActionDraftStatus.NEEDS_INFO,
            payload={"data": {"title": "Museum"}},
            preview={"title": "Museum"},
            missing_fields=[{"name": "activity_id", "label": "Activity"}],
            preconditions={},
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            expires_at=timezone.now() + timedelta(hours=24),
        )

        payload = build_action_draft_payload(draft, viewer=self.user)

        self.assertEqual(payload["missing_fields"][0]["type"], "target")

class AIActionDraftAPITests(APITestCase, AIActionDraftModelTests):
    def _detail_url(self, draft_id):
        return f"/api/trips/{self.trip.id}/ai/action-drafts/{draft_id}"

    def _cancel_url(self, draft_id):
        return f"/api/trips/{self.trip.id}/ai/action-drafts/{draft_id}/cancel"

    def test_action_draft_detail_exposes_display_and_summary(self):
        self.client.force_authenticate(self.user)
        display_value = {
            "icon": "activity",
            "kicker": "Activity · Sightseeing",
            "title": "Museum Visit",
            "tone": "create",
        }
        summary_value = "[READY] timeline.activity.create: Museum Visit"
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.READY,
            required_confirmation="CAPTAIN",
            payload={"data": {"title": "Museum Visit"}},
            preview={"title": "Museum Visit"},
            display=display_value,
            summary=summary_value,
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.get(self._detail_url(draft.id))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["draft"]["display"], display_value)
        self.assertEqual(response.data["draft"]["summary"], summary_value)

    def test_captain_reads_action_draft_detail(self):
        self.client.force_authenticate(self.user)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            required_confirmation="CAPTAIN",
            payload={"title": "Dinner"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.get(self._detail_url(draft.id))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["draft"]["id"], str(draft.id))
        self.assertTrue(response.data["draft"]["can_confirm"])

    def test_requester_can_cancel_own_draft(self):
        self.client.force_authenticate(self.user)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            required_confirmation="CAPTAIN",
            payload={"title": "Dinner"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(self._cancel_url(draft.id))

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.CANCELLED)
        self.assertEqual(draft.cancelled_by_id, self.user.id)

    @patch("ai.chat_changes.push_chat_message")
    def test_cancel_expired_draft_marks_expired_and_returns_conflict(self, push_chat_message):
        self.client.force_authenticate(self.user)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            required_confirmation="CAPTAIN",
            payload={"title": "Dinner", "total_amount": "1200000"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(self._cancel_url(draft.id))

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_EXPIRED")
        self.assertEqual(response.data["draft"]["status"], AIActionDraftStatus.EXPIRED)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.EXPIRED)
        push_chat_message.assert_called_once_with(self.response_message)


class AIActionDraftTransferRefreshTests(AIActionDraftModelTests):
    @patch("ai.chat_changes.push_chat_message")
    def test_manual_mark_transfer_sent_refreshes_ai_transfer_drafts(self, push_chat_message):
        member = create_completed_user(
            "agent-transfer-member@example.com",
            "agenttransfer",
            "AID006",
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
            title="Dinner",
            total_amount=Decimal("100000"),
            collector=self.user,
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.user.id,
            actor=self.user,
            amount=Decimal("100000"),
        )
        settlement = finalize_settlement(trip_id=self.trip.id, actor=self.user)
        transfer = settlement.transfers.get()
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="settlement.transfer.confirm_received",
            status=AIActionDraftStatus.READY,
            payload={"transfer_id": str(transfer.id)},
            preview={"title": "Confirm received"},
            missing_fields=[],
            preconditions={},
            required_confirmation=AI_CONFIRMATION_TRANSFER_RECIPIENT,
            expires_at=timezone.now() + timedelta(hours=24),
        )
        previous_updated_at = self.response_message.updated_at

        self.assertFalse(
            build_action_draft_payload(draft, viewer=self.user)["can_confirm"]
        )
        with self.captureOnCommitCallbacks(execute=True):
            mark_transfer_sent(
                trip_id=self.trip.id,
                transfer_id=transfer.id,
                actor=member,
            )

        self.response_message.refresh_from_db()
        self.trip.refresh_from_db()
        draft.refresh_from_db()
        self.assertGreater(self.response_message.updated_at, previous_updated_at)
        self.assertEqual(self.trip.chat_change_sequence, 1)
        self.assertEqual(self.response_message.change_sequence, 1)
        self.assertTrue(
            build_action_draft_payload(draft, viewer=self.user)["can_confirm"]
        )
        push_chat_message.assert_called_once()
        self.assertEqual(push_chat_message.call_args.args[0].id, self.response_message.id)
        self.assertEqual(push_chat_message.call_args.args[0].change_sequence, 1)

    @patch("ai.chat_changes.push_chat_message")
    def test_manual_confirm_received_refreshes_ai_transfer_drafts(
        self,
        push_chat_message,
    ):
        payer = create_completed_user(
            "agent-transfer-payer@example.com",
            "agenttransferpayer",
            "AID007",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=payer,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.user,
            title="Dinner",
            total_amount=Decimal("100000"),
            collector=self.user,
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.user.id,
            actor=self.user,
            amount=Decimal("100000"),
        )
        settlement = finalize_settlement(trip_id=self.trip.id, actor=self.user)
        transfer = settlement.transfers.get()
        mark_transfer_sent(
            trip_id=self.trip.id,
            transfer_id=transfer.id,
            actor=payer,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="settlement.transfer.confirm_received",
            status=AIActionDraftStatus.READY,
            payload={"transfer_id": str(transfer.id)},
            preview={"title": "Confirm received"},
            missing_fields=[],
            preconditions={},
            required_confirmation=AI_CONFIRMATION_TRANSFER_RECIPIENT,
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.captureOnCommitCallbacks(execute=True):
            confirm_transfer_received(
                trip_id=self.trip.id,
                transfer_id=transfer.id,
                actor=self.user,
            )

        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        draft.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 1)
        self.assertEqual(self.response_message.change_sequence, 1)
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        push_chat_message.assert_called_once()
        self.assertEqual(
            push_chat_message.call_args.args[0].change_sequence,
            1,
        )


class AIActionDraftPatchTests(APITestCase, AIActionDraftModelTests):
    def _create_patch_draft(
        self,
        *,
        payload=None,
        missing_fields=None,
        status=AIActionDraftStatus.NEEDS_INFO,
        expires_at=None,
    ):
        return AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=status,
            required_confirmation="CAPTAIN",
            payload=payload if payload is not None else {"title": "Lunch"},
            preview={"title": "Lunch"},
            missing_fields=(
                missing_fields
                if missing_fields is not None
                else [{"name": "total_amount", "label": "Amount"}]
            ),
            preconditions={},
            expires_at=expires_at or timezone.now() + timedelta(hours=24),
        )

    def _create_contribution_patch_draft(self, *, missing_field):
        return AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.contribution.set",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"expense_id": str(uuid4())},
            preview={"title": "Record contribution"},
            missing_fields=[
                {"name": missing_field, "label": "Contribution amount"}
            ],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

    def _assert_field_validation_patch_preserves_snapshot(
        self,
        *,
        draft,
        patch_payload,
        expected_field_errors,
        push_chat_message,
    ):
        self.client.force_authenticate(self.user)
        original_payload = draft.payload
        draft_updated_at = draft.updated_at
        message_updated_at = self.response_message.updated_at
        original_trip_sequence = self.trip.chat_change_sequence
        original_message_sequence = self.response_message.change_sequence

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {"payload": patch_payload},
                format="json",
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertEqual(response.data["field_errors"], expected_field_errors)
        self.assertEqual(
            response.data["draft"]["status"],
            AIActionDraftStatus.NEEDS_INFO,
        )
        draft.refresh_from_db()
        self.response_message.refresh_from_db()
        self.trip.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload, original_payload)
        self.assertEqual(draft.updated_at, draft_updated_at)
        self.assertEqual(self.response_message.updated_at, message_updated_at)
        self.assertEqual(
            self.response_message.change_sequence,
            original_message_sequence,
        )
        self.assertEqual(self.trip.chat_change_sequence, original_trip_sequence)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    def _assert_patch_request_is_a_true_noop(
        self,
        *,
        request_data,
        draft,
        push_chat_message,
    ):
        self.client.force_authenticate(self.user)
        original_payload = draft.payload
        draft_updated_at = draft.updated_at
        message_updated_at = self.response_message.updated_at
        original_trip_sequence = self.trip.chat_change_sequence
        original_message_sequence = self.response_message.change_sequence

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                request_data,
                format="json",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), {"draft"})
        self.assertEqual(response.data["draft"]["status"], AIActionDraftStatus.NEEDS_INFO)
        draft.refresh_from_db()
        self.response_message.refresh_from_db()
        self.trip.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload, original_payload)
        self.assertEqual(draft.updated_at, draft_updated_at)
        self.assertEqual(self.response_message.updated_at, message_updated_at)
        self.assertEqual(
            self.response_message.change_sequence,
            original_message_sequence,
        )
        self.assertEqual(self.trip.chat_change_sequence, original_trip_sequence)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_with_absent_payload_is_a_true_noop(self, push_chat_message):
        draft = self._create_patch_draft()

        self._assert_patch_request_is_a_true_noop(
            request_data={},
            draft=draft,
            push_chat_message=push_chat_message,
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_with_empty_payload_is_a_true_noop(self, push_chat_message):
        draft = self._create_patch_draft()

        self._assert_patch_request_is_a_true_noop(
            request_data={"payload": {}},
            draft=draft,
            push_chat_message=push_chat_message,
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_with_effectively_unchanged_value_is_a_true_noop(
        self,
        push_chat_message,
    ):
        draft = self._create_patch_draft(
            payload={
                "title": "Lunch",
                "total_amount": "500000",
                "currency_code": self.trip.currency_code,
            },
        )

        self._assert_patch_request_is_a_true_noop(
            request_data={"payload": {"total_amount": "500000"}},
            draft=draft,
            push_chat_message=push_chat_message,
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_empty_patch_still_expires_before_noop_return(self, push_chat_message):
        draft = self._create_patch_draft(
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        self.client.force_authenticate(self.user)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {},
                format="json",
            )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_EXPIRED")
        self.assertEqual(response.data["draft"]["status"], AIActionDraftStatus.EXPIRED)
        draft.refresh_from_db()
        self.response_message.refresh_from_db()
        self.trip.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.EXPIRED)
        self.assertEqual(self.trip.chat_change_sequence, 1)
        self.assertEqual(self.response_message.change_sequence, 1)
        self.assertEqual(len(callbacks), 1)
        push_chat_message.assert_not_called()
        callbacks[0]()
        push_chat_message.assert_called_once()

    @patch("ai.chat_changes.push_chat_message")
    def test_empty_patch_still_checks_editable_status_before_noop_return(
        self,
        push_chat_message,
    ):
        draft = self._create_patch_draft(
            payload={"title": "Lunch", "total_amount": "500000"},
            missing_fields=[],
            status=AIActionDraftStatus.READY,
        )
        self.client.force_authenticate(self.user)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {"payload": {}},
                format="json",
            )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.data,
            {
                "detail": "Draft is not waiting for more information.",
                "error_code": "AI_DRAFT_NOT_READY",
            },
        )
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 0)
        self.assertEqual(self.response_message.change_sequence, 0)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_empty_patch_still_checks_permission_before_noop_return(
        self,
        push_chat_message,
    ):
        member = create_completed_user(
            "agent-empty-patch-member@example.com",
            "agentemptypatch",
            "AEP001",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        draft = self._create_patch_draft()
        self.client.force_authenticate(member)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {},
                format="json",
            )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.data,
            {
                "detail": "You cannot update this draft.",
                "error_code": "AI_DRAFT_FORBIDDEN",
            },
        )
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 0)
        self.assertEqual(self.response_message.change_sequence, 0)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_unchanged_disallowed_field_still_errors_before_noop_return(
        self,
        push_chat_message,
    ):
        draft = self._create_patch_draft()
        self.client.force_authenticate(self.user)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {"payload": {"title": "Lunch"}},
                format="json",
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.data,
            {
                "detail": (
                    "Only fields currently requested by this draft can be updated. "
                    "Unsupported field(s): title."
                ),
                "error_code": "AI_DRAFT_PATCH_FIELD_NOT_ALLOWED",
            },
        )
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 0)
        self.assertEqual(self.response_message.change_sequence, 0)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    def test_requester_patches_missing_fields_and_draft_becomes_ready(self):
        self.client.force_authenticate(self.user)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={"title": "Lunch"},
            preview={"title": "Lunch"},
            missing_fields=[{"name": "total_amount", "label": "Amount"}],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {
                "payload": {
                    "total_amount": "500000",
                }
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["total_amount"], "500000")
        self.assertEqual(draft.preview["total_amount"], "500000")
        self.assertEqual(response.data["draft"]["preview"]["total_amount"], "500000")
        self.assertEqual(draft.missing_fields, [])

    @patch("ai.chat_changes.push_chat_message")
    def test_currency_change_patch_restamps_ready_expense_and_confirms(
        self,
        push_chat_message,
    ):
        from ai.agent.executor import confirm_action_draft
        from expenses.models import Expense
        from trips.models import Trip

        draft = create_action_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            action_type="expense.create",
            payload={
                "title": "Lunch",
                "currency_code": "VND",
            },
        )
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload["currency_code"], "VND")
        self.assertNotIn("hero", draft.display)
        Trip.objects.filter(pk=self.trip.pk).update(currency_code="USD")
        self.client.force_authenticate(self.user)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {"payload": {"total_amount": "25.50"}},
                format="json",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), {"draft"})
        self.assertEqual(response.data["draft"]["status"], AIActionDraftStatus.READY)
        self.assertEqual(response.data["draft"]["preview"]["currency_code"], "USD")
        self.assertEqual(
            response.data["draft"]["display"]["hero"]["currency"],
            "USD",
        )
        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["currency_code"], "USD")
        self.assertEqual(draft.preview["currency_code"], "USD")
        self.assertEqual(draft.display["hero"]["currency"], "USD")
        self.assertEqual(self.trip.chat_change_sequence, 1)
        self.assertEqual(self.response_message.change_sequence, 1)
        self.assertEqual(len(callbacks), 1)
        push_chat_message.assert_not_called()

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.user,
        )
        expense = Expense.objects.get(pk=confirmed.result["object_id"])
        self.assertEqual(confirmed.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(expense.total_amount, Decimal("25.50"))
        self.assertEqual(expense.currency_code, "USD")

    @patch("ai.chat_changes.push_chat_message")
    def test_same_amount_patch_after_currency_change_restamps_and_revalidates(
        self,
        push_chat_message,
    ):
        from trips.models import Trip

        draft = create_action_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            action_type="expense.create",
            payload={
                "title": "Lunch",
                "currency_code": "VND",
                "total_amount": "25.50",
            },
        )
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload["currency_code"], "VND")
        self.assertEqual(draft.payload["total_amount"], "25.50")
        self.assertIn(
            "total_amount",
            {field["name"] for field in draft.missing_fields},
        )
        Trip.objects.filter(pk=self.trip.pk).update(currency_code="USD")
        self.client.force_authenticate(self.user)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {"payload": {"total_amount": "25.50"}},
                format="json",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["draft"]["status"], AIActionDraftStatus.READY)
        self.assertEqual(response.data["draft"]["preview"]["currency_code"], "USD")
        self.assertEqual(response.data["draft"]["display"]["hero"]["currency"], "USD")
        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["currency_code"], "USD")
        self.assertEqual(draft.payload["total_amount"], "25.50")
        self.assertEqual(draft.preview["currency_code"], "USD")
        self.assertEqual(draft.display["hero"]["currency"], "USD")
        self.assertEqual(draft.missing_fields, [])
        self.assertEqual(self.trip.chat_change_sequence, 1)
        self.assertEqual(self.response_message.change_sequence, 1)
        self.assertEqual(len(callbacks), 1)
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_currency_change_patch_rejects_amount_invalid_for_current_trip(
        self,
        push_chat_message,
    ):
        from trips.models import Trip

        self.trip.currency_code = "USD"
        self.trip.save(update_fields=["currency_code", "updated_at"])
        draft = create_action_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            action_type="expense.create",
            payload={"title": "Lunch"},
        )
        self.assertEqual(draft.payload["currency_code"], "USD")
        Trip.objects.filter(pk=self.trip.pk).update(currency_code="VND")

        self._assert_field_validation_patch_preserves_snapshot(
            draft=draft,
            patch_payload={"total_amount": "25.50"},
            expected_field_errors={
                "total_amount": (
                    "Amount has too many decimal places for this currency."
                )
            },
            push_chat_message=push_chat_message,
        )
        self.assertEqual(draft.payload["currency_code"], "USD")

    @patch("ai.chat_changes.push_chat_message")
    def test_empty_patch_after_currency_change_remains_true_noop(
        self,
        push_chat_message,
    ):
        from trips.models import Trip

        draft = create_action_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            action_type="expense.create",
            payload={"title": "Lunch"},
        )
        original_display = draft.display
        self.assertEqual(draft.payload["currency_code"], "VND")
        Trip.objects.filter(pk=self.trip.pk).update(currency_code="USD")

        self._assert_patch_request_is_a_true_noop(
            request_data={"payload": {}},
            draft=draft,
            push_chat_message=push_chat_message,
        )
        self.assertEqual(draft.payload["currency_code"], "VND")
        self.assertEqual(draft.display, original_display)

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_rejects_fractional_vnd_amount_without_mutating_draft(
        self,
        push_chat_message,
    ):
        self.assertEqual(self.trip.currency_code, "VND")
        self.client.force_authenticate(self.user)
        draft = self._create_patch_draft()
        original_payload = draft.payload
        draft_updated_at = draft.updated_at
        message_updated_at = self.response_message.updated_at
        original_trip_sequence = self.trip.chat_change_sequence
        original_message_sequence = self.response_message.change_sequence

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {"payload": {"total_amount": "25.50"}},
                format="json",
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertEqual(
            response.data["field_errors"],
            {
                "total_amount": (
                    "Amount has too many decimal places for this currency."
                )
            },
        )
        self.assertEqual(
            response.data["draft"]["status"],
            AIActionDraftStatus.NEEDS_INFO,
        )
        draft.refresh_from_db()
        self.response_message.refresh_from_db()
        self.trip.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload, original_payload)
        self.assertEqual(draft.updated_at, draft_updated_at)
        self.assertEqual(self.response_message.updated_at, message_updated_at)
        self.assertEqual(
            self.response_message.change_sequence,
            original_message_sequence,
        )
        self.assertEqual(self.trip.chat_change_sequence, original_trip_sequence)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_rejects_fractional_vnd_for_every_contribution_shape(
        self,
        push_chat_message,
    ):
        amount_error = "Amount has too many decimal places for this currency."
        member_id = str(self.user.id)
        cases = (
            ("amount", {"amount": "25.50"}, "amount"),
            ("paid_amount", {"paid_amount": "25.50"}, "paid_amount"),
            (
                "contribution_amount",
                {"contribution_amount": "25.50"},
                "contribution_amount",
            ),
            (
                "contributions",
                {
                    "contributions": [
                        {"user_id": member_id, "amount": "25.50"}
                    ]
                },
                "contributions.0.amount",
            ),
            (
                "member_contributions",
                {"member_contributions": {member_id: "25.50"}},
                f"member_contributions.{member_id}",
            ),
            *(
                (
                    "member_contributions",
                    {
                        "member_contributions": {
                            member_id: {field: "25.50"}
                        }
                    },
                    f"member_contributions.{member_id}.{field}",
                )
                for field in ("amount", "paid_amount", "contribution_amount")
            ),
        )

        for missing_field, patch_payload, error_path in cases:
            with self.subTest(error_path=error_path):
                draft = self._create_contribution_patch_draft(
                    missing_field=missing_field,
                )
                self._assert_field_validation_patch_preserves_snapshot(
                    draft=draft,
                    patch_payload=patch_payload,
                    expected_field_errors={error_path: amount_error},
                    push_chat_message=push_chat_message,
                )

    def test_patch_accepts_max_decimalfield_amount_for_usd(self):
        self.trip.currency_code = "USD"
        self.trip.save(update_fields=["currency_code", "updated_at"])
        self.client.force_authenticate(self.user)
        draft = self._create_patch_draft()

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"total_amount": "999999999999.99"}},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["total_amount"], "999999999999.99")
        self.assertEqual(draft.missing_fields, [])

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_rejects_decimalfield_overflow_without_mutation(
        self,
        push_chat_message,
    ):
        self.trip.currency_code = "USD"
        self.trip.save(update_fields=["currency_code", "updated_at"])
        draft = self._create_patch_draft()

        self._assert_field_validation_patch_preserves_snapshot(
            draft=draft,
            patch_payload={"total_amount": "1000000000000.00"},
            expected_field_errors={
                "total_amount": (
                    "Amount must have no more than 12 digits before the decimal point."
                )
            },
            push_chat_message=push_chat_message,
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_rejects_contribution_decimalfield_overflow_without_mutation(
        self,
        push_chat_message,
    ):
        self.trip.currency_code = "USD"
        self.trip.save(update_fields=["currency_code", "updated_at"])
        draft = self._create_contribution_patch_draft(
            missing_field="contributions",
        )

        self._assert_field_validation_patch_preserves_snapshot(
            draft=draft,
            patch_payload={
                "contributions": [
                    {
                        "user_id": str(self.user.id),
                        "amount": "1000000000000.00",
                    }
                ]
            },
            expected_field_errors={
                "contributions.0.amount": (
                    "Amount must have no more than 12 digits before the decimal point."
                )
            },
            push_chat_message=push_chat_message,
        )

    def test_patch_accepts_two_decimal_amount_for_usd(self):
        self.trip.currency_code = "USD"
        self.trip.save(update_fields=["currency_code", "updated_at"])
        self.client.force_authenticate(self.user)
        draft = self._create_patch_draft()

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"total_amount": "25.50"}},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["total_amount"], "25.50")
        self.assertEqual(draft.missing_fields, [])

    def test_patch_missing_target_identity_field_is_rejected(self):
        self.client.force_authenticate(self.user)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.update",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"data": {"title": "Museum"}},
            preview={"title": "Museum"},
            missing_fields=[{"name": "activity_id", "label": "Activity"}],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"activity_id": str(uuid4())}},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.data["error_code"],
            "AI_DRAFT_PATCH_FIELD_NOT_ALLOWED",
        )

    def test_patch_rejects_payload_fields_that_are_not_currently_missing(self):
        self.client.force_authenticate(self.user)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={"title": "Lunch"},
            preview={"title": "Lunch"},
            missing_fields=[{"name": "total_amount", "label": "Amount"}],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"expense_id": str(uuid4())}},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_PATCH_FIELD_NOT_ALLOWED")
        draft.refresh_from_db()
        self.assertNotIn("expense_id", draft.payload)

    def test_patch_keeps_legacy_string_missing_field_until_value_is_present(self):
        self.client.force_authenticate(self.user)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={"title": "Lunch"},
            preview={"title": "Lunch"},
            missing_fields=["total_amount"],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"total_amount": ""}},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(
            draft.missing_fields,
            [{"name": "total_amount", "label": "Amount", "type": "money"}],
        )

    def test_patch_expired_needs_info_draft_marks_expired_and_returns_conflict(self):
        self.client.force_authenticate(self.user)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={"title": "Lunch"},
            preview={"title": "Lunch"},
            missing_fields=[{"name": "total_amount", "label": "Amount"}],
            preconditions={},
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"total_amount": "500000"}},
            format="json",
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_EXPIRED")
        self.assertEqual(response.data["draft"]["status"], AIActionDraftStatus.EXPIRED)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.EXPIRED)
        self.assertNotIn("total_amount", draft.payload)

    def test_patch_timeline_create_missing_data_field_updates_nested_payload(self):
        self.client.force_authenticate(self.user)
        section = self.trip.timeline_sections.order_by("section_date").first()
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={
                "section_id": str(section.id),
                "data": {"time_mode": "FLEXIBLE", "system_type": "SIGHTSEEING"},
            },
            preview={"title": "Museum"},
            missing_fields=[{"name": "title", "label": "Title"}],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"title": "Museum"}},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["data"]["title"], "Museum")
        self.assertNotIn("title", draft.payload)
        self.assertEqual(
            response.data["draft"]["preview"]["data"],
            {
                "time_mode": "FLEXIBLE",
                "system_type": "SIGHTSEEING",
                "title": "Museum",
            },
        )
        self.assertEqual(
            response.data["draft"]["preview"]["section_label"],
            section.label,
        )
        self.assertEqual(
            response.data["draft"]["preview"]["section_date"],
            section.section_date.isoformat(),
        )
        self.assertEqual(
            response.data["draft"]["preview"]["resolved_data"]["title"],
            "Museum",
        )

    def test_patch_timeline_create_rejects_untrusted_trip_scoped_references(self):
        from trips.models import TimelineCustomType

        self.client.force_authenticate(self.user)
        section = self.trip.timeline_sections.order_by("section_date").first()
        other_trip = create_trip(
            captain=self.user,
            name="Patch Foreign Trip",
            destination="Hue",
            start_date="2026-08-01",
            end_date="2026-08-02",
        )
        foreign_section = other_trip.timeline_sections.order_by("section_date").first()
        foreign_custom = TimelineCustomType.objects.create(
            trip=other_trip,
            name="Foreign patch custom",
            normalized_name="foreign-patch-custom",
            created_by=self.user,
        )
        left_assignee = create_completed_user(
            "agent-patch-left@example.com",
            "agentpatchleft",
            "AID006",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=left_assignee,
            role=TripRole.MEMBER,
            status=MemberStatus.LEFT,
        )

        cases = (
            (
                "section_id",
                {
                    "data": {
                        "title": "Foreign day",
                        "time_mode": "FLEXIBLE",
                        "system_type": "SIGHTSEEING",
                    }
                },
                str(foreign_section.id),
            ),
            (
                "custom_type_id",
                {
                    "section_id": str(section.id),
                    "data": {
                        "title": "Foreign custom",
                        "time_mode": "FLEXIBLE",
                    },
                },
                str(foreign_custom.id),
            ),
            (
                "assignee_user_id",
                {
                    "section_id": str(section.id),
                    "data": {
                        "title": "Inactive assignee",
                        "time_mode": "FLEXIBLE",
                        "system_type": "SIGHTSEEING",
                        "assignee_scope": "USER",
                    },
                },
                str(left_assignee.id),
            ),
        )

        for field_name, payload, invalid_value in cases:
            with self.subTest(field_name=field_name):
                draft = AIActionDraft.objects.create(
                    trip=self.trip,
                    interaction=self.interaction,
                    response_message=self.response_message,
                    requested_by=self.user,
                    action_type="timeline.activity.create",
                    status=AIActionDraftStatus.NEEDS_INFO,
                    required_confirmation="CAPTAIN",
                    payload=payload,
                    preview={"title": payload.get("data", {}).get("title", "")},
                    missing_fields=[
                        {"name": field_name, "label": field_name}
                    ],
                    preconditions={},
                    expires_at=timezone.now() + timedelta(hours=24),
                )
                original_payload = draft.payload

                response = self.client.patch(
                    f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                    {"payload": {field_name: invalid_value}},
                    format="json",
                )

                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.data["error_code"],
                    "FIELD_VALIDATION_FAILED",
                )
                self.assertIn(field_name, response.data["field_errors"])
                draft.refresh_from_db()
                self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
                self.assertEqual(draft.payload, original_payload)
                review_wire = str(
                    {
                        "preview": response.data["draft"]["preview"],
                        "display": response.data["draft"]["display"],
                    }
                )
                self.assertNotIn(invalid_value, review_wire)

    def test_patch_timeline_update_missing_data_object_updates_nested_payload(self):
        self.client.force_authenticate(self.user)
        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Old Museum",
            time_mode="FLEXIBLE",
            system_type="SIGHTSEEING",
            position=0,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.update",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={"activity_id": str(activity.id), "data": {}},
            preview={"action_type": "timeline.activity.update"},
            missing_fields=[
                {
                    "name": "data",
                    "label": "Activity details",
                    "type": "json",
                }
            ],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"data": {"title": "Museum"}}},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["data"], {"title": "Museum"})
        self.assertEqual(response.data["draft"]["preview"]["title"], "Museum")
        self.assertEqual(
            response.data["draft"]["preview"]["data"],
            {"title": "Museum"},
        )
        self.assertEqual(
            response.data["draft"]["preview"]["target_title"],
            "Old Museum",
        )
        self.assertEqual(
            response.data["draft"]["preview"]["resolved_data"]["title"],
            "Museum",
        )
        self.assertEqual(
            response.data["draft"]["display"]["meta"][0],
            {"label": "Target", "value": "Old Museum"},
        )

    def test_assignee_patches_timeline_status_missing_info(self):
        member = create_completed_user(
            "agent-patch-status-member@example.com",
            "agentpatchstatus",
            "AID005",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Museum",
            time_mode="FLEXIBLE",
            assignee_scope=TimelineActivityAssigneeScope.USER,
            assignee_user=member,
            position=0,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.status.update",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="TIMELINE_ACTIVITY_STATUS",
            payload={"activity_id": str(activity.id)},
            preview={"title": "Museum"},
            missing_fields=[{"name": "status", "label": "Status"}],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )
        self.client.force_authenticate(member)

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"status": TimelineActivityStatus.IN_PROGRESS}},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["status"], TimelineActivityStatus.IN_PROGRESS)
        self.assertTrue(response.data["draft"]["can_confirm"])


class AIActionDraftDisplayAndSummaryTests(AIActionDraftModelTests):
    """Test that tool-created drafts keep display and summary after finishing."""

    @patch("ai.chat_changes.push_chat_message")
    def test_draft_persisted_with_display_and_summary(self, _push):
        # Arrange: put the interaction back into PENDING so finish_interaction_success can run
        self.interaction.status = AIInteractionStatus.PENDING
        self.interaction.response_message = None
        self.interaction.save()

        create_action_draft(
            trip=self.trip,
            interaction=self.interaction,
            action_type="expense.create",
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            status=AIActionDraftStatus.READY,
            payload={"title": "Dinner", "total_amount": "1200000"},
            missing_fields=[],
            preconditions={},
        )

        with self.captureOnCommitCallbacks(execute=False):
            finish_interaction_success(
                interaction=self.interaction,
                message_text="I prepared a draft.",
            )

        self.interaction.refresh_from_db()
        draft = AIActionDraft.objects.get(interaction=self.interaction)
        self.assertEqual(draft.response_message, self.interaction.response_message)

        # display must have icon matching the expense family and a non-empty kicker
        self.assertEqual(draft.display.get("icon"), "expense")
        self.assertTrue(draft.display.get("kicker"))

        # summary must contain the draft title and status
        self.assertIn("Dinner", draft.summary)
        self.assertIn(AIActionDraftStatus.READY, draft.summary)


class AIActionDraftPatchFieldValidationTests(APITestCase, AIActionDraftModelTests):
    """Pydantic schema validation on PATCH — structured field_errors response."""

    def _create_needs_info_activity_draft(self):
        section = self.trip.timeline_sections.order_by("section_date").first()
        return AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={
                "section_id": str(section.id),
                "title": "Museum Visit",
                "system_type": "SIGHTSEEING",
                "time_mode": "TIME_RANGE",
            },
            preview={"title": "Museum Visit"},
            missing_fields=[
                {"name": "start_time", "label": "Start time"},
                {"name": "end_time", "label": "End time"},
            ],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

    def _create_needs_info_activity_update_draft(
        self,
        *,
        data,
        missing_fields,
    ):
        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Museum Visit",
            time_mode="TIME_RANGE",
            start_time="08:00",
            end_time="10:00",
            system_type="SIGHTSEEING",
            position=0,
        )
        return AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.update",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"activity_id": str(activity.id), "data": data},
            preview={"title": "Museum Visit"},
            missing_fields=missing_fields,
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_nested_patch_rejects_end_before_existing_start(
        self,
        push_chat_message,
    ):
        draft = self._create_needs_info_activity_update_draft(
            data={"start_time": "10:00"},
            missing_fields=[
                {
                    "name": "data",
                    "label": "Activity details",
                    "type": "json",
                }
            ],
        )
        self.client.force_authenticate(self.user)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            res = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                data={"payload": {"data": {"end_time": "08:00"}}},
                format="json",
            )

        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertEqual(set(res.data["field_errors"]), {"data"})
        self.assertEqual(
            set(res.data),
            {"detail", "error_code", "field_errors", "draft"},
        )
        self.assertEqual(
            res.data["draft"]["status"],
            AIActionDraftStatus.NEEDS_INFO,
        )
        self.assertTrue(res.data["draft"]["can_edit"])
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload["data"], {"start_time": "10:00"})
        self.assertEqual(draft.result, {})
        self.assertEqual(draft.error_code, "")
        self.assertEqual(draft.error_detail, "")
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 0)
        self.assertEqual(self.response_message.change_sequence, 0)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    def test_direct_patch_rejects_start_after_existing_end(self):
        draft = self._create_needs_info_activity_update_draft(
            data={"end_time": "08:00"},
            missing_fields=[{"name": "start_time", "label": "Start time"}],
        )
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"start_time": "10:00"}},
            format="json",
        )

        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertIn("start_time", res.data["field_errors"])
        self.assertEqual(
            res.data["draft"]["status"],
            AIActionDraftStatus.NEEDS_INFO,
        )
        self.assertTrue(res.data["draft"]["can_edit"])
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload["data"], {"end_time": "08:00"})
        self.assertEqual(draft.result, {})
        self.assertEqual(draft.error_code, "")
        self.assertEqual(draft.error_detail, "")

    def test_valid_one_sided_patch_becomes_ready_with_merged_nested_data(self):
        draft = self._create_needs_info_activity_update_draft(
            data={"start_time": "08:00"},
            missing_fields=[{"name": "end_time", "label": "End time"}],
        )
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"end_time": "10:00"}},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        self.assertEqual(set(res.data), {"draft"})
        self.assertEqual(res.data["draft"]["status"], AIActionDraftStatus.READY)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(
            draft.payload["data"],
            {"start_time": "08:00:00", "end_time": "10:00:00"},
        )
        self.assertEqual(draft.missing_fields, [])
        self.assertEqual(draft.error_code, "")
        self.assertEqual(draft.error_detail, "")

    def test_valid_nested_one_sided_patch_becomes_ready(self):
        draft = self._create_needs_info_activity_update_draft(
            data={"start_time": "08:00"},
            missing_fields=[
                {
                    "name": "data",
                    "label": "Activity details",
                    "type": "json",
                }
            ],
        )
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"data": {"end_time": "10:00"}}},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(
            draft.payload["data"],
            {"start_time": "08:00:00", "end_time": "10:00:00"},
        )
        self.assertEqual(draft.missing_fields, [])

    def test_nested_legacy_values_are_canonicalized_before_validation(self):
        draft = self._create_needs_info_activity_update_draft(
            data={},
            missing_fields=[
                {
                    "name": "data",
                    "label": "Activity details",
                    "type": "json",
                }
            ],
        )
        self.client.force_authenticate(self.user)

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={
                "payload": {
                    "data": {
                        "time_mode": "ANCHOR",
                        "start_time": "2026-04-20T08:00:00+07:00",
                        "system_type": "DINING",
                        "assignee_scope": "GROUP",
                    }
                }
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["data"]["time_mode"], "AT_TIME")
        self.assertEqual(draft.payload["data"]["start_time"], "08:00:00")
        self.assertIsNone(draft.payload["data"]["end_time"])
        self.assertEqual(draft.payload["data"]["system_type"], "FOOD")
        self.assertEqual(draft.payload["data"]["assignee_scope"], "EVERYONE")
        self.assertEqual(draft.missing_fields, [])

    @patch("ai.chat_changes.push_chat_message")
    def test_explicit_non_dict_data_patch_is_rejected_without_mutation(
        self,
        push_chat_message,
    ):
        malformed_values = (
            "not-an-object",
            "",
            "   ",
            1,
            True,
            ["not", "an", "object"],
            None,
        )
        self.client.force_authenticate(self.user)

        for malformed_data in malformed_values:
            with self.subTest(data=malformed_data):
                draft = self._create_needs_info_activity_update_draft(
                    data={"start_time": "08:00"},
                    missing_fields=[
                        {
                            "name": "data",
                            "label": "Activity details",
                            "type": "json",
                        }
                    ],
                )
                original_payload = draft.payload
                original_updated_at = draft.updated_at
                with self.captureOnCommitCallbacks(execute=False) as callbacks:
                    res = self.client.patch(
                        f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                        data={"payload": {"data": malformed_data}},
                        format="json",
                    )

                self.assertEqual(res.status_code, 400)
                self.assertEqual(
                    res.data["error_code"],
                    "FIELD_VALIDATION_FAILED",
                )
                self.assertEqual(set(res.data["field_errors"]), {"data"})
                draft.refresh_from_db()
                self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
                self.assertEqual(draft.payload, original_payload)
                self.assertEqual(draft.updated_at, original_updated_at)
                self.assertEqual(callbacks, [])

        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 0)
        self.assertEqual(self.response_message.change_sequence, 0)
        push_chat_message.assert_not_called()

    def test_empty_data_object_is_a_true_noop(self):
        draft = self._create_needs_info_activity_update_draft(
            data={"start_time": "08:00"},
            missing_fields=[
                {
                    "name": "data",
                    "label": "Activity details",
                    "type": "json",
                }
            ],
        )
        original_updated_at = draft.updated_at
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"data": {}}},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload["data"], {"start_time": "08:00"})
        self.assertEqual(draft.updated_at, original_updated_at)

    def test_direct_leaf_patch_recovers_legacy_non_dict_data(self):
        draft = self._create_needs_info_activity_update_draft(
            data="legacy-invalid-data",
            missing_fields=[{"name": "title", "label": "Title"}],
        )
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"title": "Recovered activity"}},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(
            draft.payload["data"],
            {"title": "Recovered activity"},
        )

    def test_nested_patch_recovers_legacy_non_dict_data(self):
        draft = self._create_needs_info_activity_update_draft(
            data=["legacy-invalid-data"],
            missing_fields=[
                {
                    "name": "data",
                    "label": "Activity details",
                    "type": "json",
                }
            ],
        )
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"data": {"title": "Recovered activity"}}},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(
            draft.payload["data"],
            {"title": "Recovered activity"},
        )

    def test_empty_nested_object_recovers_legacy_non_dict_data(self):
        draft = self._create_needs_info_activity_update_draft(
            data="legacy-invalid-data",
            missing_fields=[
                {
                    "name": "data",
                    "label": "Activity details",
                    "type": "json",
                }
            ],
        )
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"data": {}}},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload["data"], {})
        self.assertEqual(
            draft.missing_fields,
            [
                {
                    "name": "data",
                    "label": "Activity details",
                    "type": "json",
                }
            ],
        )

    def test_patch_returns_field_errors_when_end_before_start(self):
        draft = self._create_needs_info_activity_draft()
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {
                "start_time": "2026-04-20T10:00:00+07:00",
                "end_time":   "2026-04-20T08:00:00+07:00",
            }},
            format="json",
        )

        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertEqual(res.data["detail"], "Field validation failed.")
        self.assertTrue(any("end_time" in k for k in res.data["field_errors"]))
        self.assertIn("draft", res.data)
        self.assertEqual(res.data["draft"]["id"], str(draft.id))
        self.assertEqual(
            set(res.data),
            {"detail", "error_code", "field_errors", "draft"},
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_target_merged_validation_rejects_invalid_patch_without_side_effects(
        self,
        push_chat_message,
    ):
        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Flexible target",
            time_mode="FLEXIBLE",
            system_type="SIGHTSEEING",
            position=0,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.update",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={"activity_id": str(activity.id), "data": {}},
            preview={"title": activity.title},
            missing_fields=[{"name": "time_mode", "label": "Time mode"}],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )
        original_payload = draft.payload
        original_updated_at = draft.updated_at
        original_trip_sequence = self.trip.chat_change_sequence
        original_message_sequence = self.response_message.change_sequence
        self.client.force_authenticate(self.user)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.patch(
                f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                {"payload": {"time_mode": "TIME_RANGE"}},
                format="json",
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertIn("start_time", response.data["field_errors"])
        self.assertIn("end_time", response.data["field_errors"])
        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.payload, original_payload)
        self.assertEqual(draft.updated_at, original_updated_at)
        self.assertEqual(self.trip.chat_change_sequence, original_trip_sequence)
        self.assertEqual(
            self.response_message.change_sequence,
            original_message_sequence,
        )
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    def test_field_validation_precedes_expiry_without_mutating_snapshot(self):
        draft = self._create_needs_info_activity_draft()
        draft.expires_at = timezone.now() - timedelta(seconds=1)
        draft.save(update_fields=["expires_at"])
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {
                "start_time": "2026-04-20T10:00:00+07:00",
                "end_time": "2026-04-20T08:00:00+07:00",
            }},
            format="json",
        )

        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertEqual(res.data["draft"]["status"], AIActionDraftStatus.EXPIRED)
        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(self.trip.chat_change_sequence, 0)
        self.assertEqual(self.response_message.change_sequence, 0)

    def test_field_validation_precedes_forbidden_and_preserves_current_draft(self):
        draft = self._create_needs_info_activity_draft()
        member = create_completed_user(
            "agent-field-validation-member@example.com",
            "agentfieldmember",
            "AIF001",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        self.client.force_authenticate(member)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {
                "start_time": "2026-04-20T10:00:00+07:00",
                "end_time": "2026-04-20T08:00:00+07:00",
            }},
            format="json",
        )

        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertFalse(res.data["draft"]["can_edit"])
        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(self.trip.chat_change_sequence, 0)

    def test_field_validation_precedes_not_editable_status(self):
        draft = self._create_needs_info_activity_draft()
        draft.status = AIActionDraftStatus.READY
        draft.save(update_fields=["status"])
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {
                "start_time": "2026-04-20T10:00:00+07:00",
                "end_time": "2026-04-20T08:00:00+07:00",
            }},
            format="json",
        )

        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "FIELD_VALIDATION_FAILED")
        self.assertEqual(res.data["draft"]["status"], AIActionDraftStatus.READY)
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 0)

    def test_valid_patch_forbidden_error_keeps_legacy_body_without_draft(self):
        draft = self._create_needs_info_activity_draft()
        member = create_completed_user(
            "agent-valid-field-member@example.com",
            "agentvalidmember",
            "AIF002",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        self.client.force_authenticate(member)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {
                "start_time": "2026-04-20T08:00:00+07:00",
                "end_time": "2026-04-20T10:00:00+07:00",
            }},
            format="json",
        )

        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data["error_code"], "AI_DRAFT_FORBIDDEN")
        self.assertEqual(set(res.data), {"detail", "error_code"})

    def test_valid_patch_not_editable_error_keeps_legacy_body_without_draft(self):
        draft = self._create_needs_info_activity_draft()
        draft.status = AIActionDraftStatus.READY
        draft.save(update_fields=["status"])
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {
                "start_time": "2026-04-20T08:00:00+07:00",
                "end_time": "2026-04-20T10:00:00+07:00",
            }},
            format="json",
        )

        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.data["error_code"], "AI_DRAFT_NOT_READY")
        self.assertEqual(set(res.data), {"detail", "error_code"})

    def test_patch_valid_time_range_passes_pydantic_check(self):
        draft = self._create_needs_info_activity_draft()
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {
                "start_time": "2026-04-20T08:00:00+07:00",
                "end_time":   "2026-04-20T10:00:00+07:00",
            }},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(
            draft.status,
            AIActionDraftStatus.READY,
            {"missing_fields": draft.missing_fields, "payload": draft.payload},
        )
        self.assertEqual(draft.missing_fields, [])
        self.assertNotIn("title", draft.payload)
        self.assertNotIn("system_type", draft.payload)
        self.assertNotIn("time_mode", draft.payload)
        self.assertEqual(draft.payload["data"]["title"], "Museum Visit")
        self.assertEqual(draft.payload["data"]["system_type"], "SIGHTSEEING")
        self.assertEqual(draft.payload["data"]["time_mode"], "TIME_RANGE")
        self.assertEqual(draft.payload["data"]["start_time"], "08:00:00")
        self.assertEqual(draft.payload["data"]["end_time"], "10:00:00")

    def test_nested_timeline_fields_take_precedence_over_legacy_top_level_fields(self):
        draft = self._create_needs_info_activity_draft()
        draft.payload["data"] = {
            "title": "Canonical museum visit",
            "system_type": "FOOD",
            "time_mode": "TIME_RANGE",
        }
        draft.save(update_fields=["payload", "updated_at"])
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"start_time": "08:00", "end_time": "10:00"}},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.missing_fields, [])
        self.assertNotIn("title", draft.payload)
        self.assertNotIn("system_type", draft.payload)
        self.assertNotIn("time_mode", draft.payload)
        self.assertEqual(
            draft.payload["data"]["title"],
            "Canonical museum visit",
        )
        self.assertEqual(draft.payload["data"]["system_type"], "FOOD")
        self.assertEqual(draft.payload["data"]["time_mode"], "TIME_RANGE")

    def test_incoming_nested_timeline_fields_win_independent_of_json_key_order(self):
        section = self.trip.timeline_sections.order_by("section_date").first()
        patch_payloads = (
            {
                "title": "Legacy leaf title",
                "data": {"title": "Canonical nested title"},
            },
            {
                "data": {"title": "Canonical nested title"},
                "title": "Legacy leaf title",
            },
        )
        self.client.force_authenticate(self.user)

        for patch_payload in patch_payloads:
            with self.subTest(keys=tuple(patch_payload)):
                draft = AIActionDraft.objects.create(
                    trip=self.trip,
                    interaction=self.interaction,
                    response_message=self.response_message,
                    requested_by=self.user,
                    action_type="timeline.activity.create",
                    status=AIActionDraftStatus.NEEDS_INFO,
                    required_confirmation=AI_CONFIRMATION_CAPTAIN,
                    payload={
                        "section_id": str(section.id),
                        "data": {
                            "system_type": "SIGHTSEEING",
                            "time_mode": "FLEXIBLE",
                        },
                    },
                    preview={},
                    missing_fields=[
                        {"name": "title", "label": "Title"},
                        {"name": "data", "label": "Activity details"},
                    ],
                    preconditions={},
                    expires_at=timezone.now() + timedelta(hours=24),
                )

                response = self.client.patch(
                    f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
                    data={"payload": patch_payload},
                    format="json",
                )

                self.assertEqual(response.status_code, 200)
                draft.refresh_from_db()
                self.assertEqual(draft.status, AIActionDraftStatus.READY)
                self.assertEqual(
                    draft.payload["data"]["title"],
                    "Canonical nested title",
                )
                self.assertNotIn("title", draft.payload)

    def test_patch_synthetic_time_range_updates_nested_payload(self):
        section = self.trip.timeline_sections.order_by("section_date").first()
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation="CAPTAIN",
            payload={
                "section_id": str(section.id),
                "data": {
                    "title": "Museum Visit",
                    "system_type": "SIGHTSEEING",
                    "time_mode": "TIME_RANGE",
                },
            },
            preview={"title": "Museum Visit"},
            missing_fields=[
                {
                    "name": "time_range",
                    "label": "Time",
                    "type": "time_range",
                    "constraints": {"pair": ["start_time", "end_time"]},
                },
            ],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )
        self.client.force_authenticate(self.user)

        res = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            data={"payload": {"start_time": "08:30", "end_time": "10:00"}},
            format="json",
        )

        self.assertEqual(res.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.payload["data"]["start_time"], "08:30:00")
        self.assertEqual(draft.payload["data"]["end_time"], "10:00:00")
        self.assertEqual(draft.missing_fields, [])


class AIActionDraftNullResponseMessageTests(APITestCase, AIActionDraftModelTests):
    """Verify that v2 drafts with response_message=None don't crash."""

    def _cancel_url(self, draft_id):
        return f"/api/trips/{self.trip.id}/ai/action-drafts/{draft_id}/cancel"

    def _make_v2_draft(self, **kwargs):
        defaults = dict(
            trip=self.trip,
            interaction=self.interaction,
            response_message=None,
            requested_by=self.user,
            action_type="expense.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"title": "Lunch"},
            preview={"title": "Lunch"},
            missing_fields=[{"name": "total_amount", "label": "Amount"}],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )
        defaults.update(kwargs)
        return AIActionDraft.objects.create(**defaults)

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_draft_without_response_message_does_not_crash(self, push_chat_message):
        self.client.force_authenticate(self.user)
        draft = self._make_v2_draft()

        response = self.client.patch(
            f"/api/trips/{self.trip.id}/ai/action-drafts/{draft.id}",
            {"payload": {"total_amount": "500000"}},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.payload["total_amount"], "500000")
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_confirm_or_cancel_paths_skip_response_message_when_null(self, push_chat_message):
        self.client.force_authenticate(self.user)
        draft = self._make_v2_draft(
            status=AIActionDraftStatus.READY,
            missing_fields=[],
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        response = self.client.post(self._cancel_url(draft.id))

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_EXPIRED")
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.EXPIRED)
        push_chat_message.assert_not_called()
