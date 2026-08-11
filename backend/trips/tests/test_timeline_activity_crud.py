from __future__ import annotations

from datetime import date, time

from rest_framework.exceptions import ValidationError
from rest_framework.test import APITestCase

from accounts.tokens import AccessToken
from test_helpers import create_completed_user
from trips.models import (
    TimelineActivity,
    TimelineActivityAssigneeScope,
    TimelineCustomType,
    TimelineSection,
)
from trips.services import create_timeline_activity
from trips.tests.timeline_helpers import (
    make_timeline_activity,
    make_trip_with_timeline,
)


def _auth(user):
    return {"HTTP_AUTHORIZATION": f"Bearer {AccessToken.for_user(user)}"}


class TimelineActivityCrudTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("captain@example.com", "captain", "CAP001")
        self.member = create_completed_user("member@example.com", "member", "MEM001")
        self.outsider = create_completed_user("out@example.com", "out", "OUT001")
        self.trip = make_trip_with_timeline(
            captain=self.captain,
            members=[self.member],
            start_date=date(2026, 6, 1),
            end_date=date(2026, 6, 3),
        )
        self.section = TimelineSection.objects.get(trip=self.trip, section_date=date(2026, 6, 1))

    def _create_url(self, section_id=None):
        return f"/api/trips/{self.trip.id}/timeline/sections/{section_id or self.section.id}/activities"

    def _detail_url(self, activity_id):
        return f"/api/trips/{self.trip.id}/timeline/activities/{activity_id}"

    def _valid_payload(self, **overrides):
        payload = {
            "title": "Bus to Da Lat",
            "time_mode": "AT_TIME",
            "start_time": "06:30:00",
            "system_type": "TRANSPORTATION",
            "location_mode": "MANUAL",
            "location_label": "Bus station",
        }
        payload.update(overrides)
        return payload

    def _valid_service_payload(self, **overrides):
        payload = {
            "title": "Bus to Da Lat",
            "time_mode": "AT_TIME",
            "start_time": time(6, 30),
            "system_type": "TRANSPORTATION",
            "location_mode": "MANUAL",
            "location_label": "Bus station",
        }
        payload.update(overrides)
        return payload

    # -------- Create --------

    def test_captain_creates_activity_201(self):
        res = self.client.post(
            self._create_url(), self._valid_payload(), format="json", **_auth(self.captain)
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["activity"]["title"], "Bus to Da Lat")
        self.assertEqual(res.data["activity"]["activity_type"]["code"], "TRANSPORTATION")
        self.assertEqual(res.data["activity"]["position"], 0)

    def test_member_cannot_create_activity_403(self):
        res = self.client.post(
            self._create_url(), self._valid_payload(), format="json", **_auth(self.member)
        )
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data["error_code"], "NOT_CAPTAIN")

    def test_at_time_requires_start_time(self):
        payload = self._valid_payload()
        payload.pop("start_time")
        res = self.client.post(self._create_url(), payload, format="json", **_auth(self.captain))
        self.assertEqual(res.status_code, 400)

    def test_at_time_rejects_end_time(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(end_time="08:00:00"),
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 400)

    def test_all_day_rejects_start_time(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(time_mode="ALL_DAY", start_time="06:30:00"),
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 400)

    def test_flexible_activity_allows_no_times(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(time_mode="FLEXIBLE", start_time=None, end_time=None),
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["activity"]["time_mode"], "FLEXIBLE")
        self.assertIsNone(res.data["activity"]["start_time"])
        self.assertIsNone(res.data["activity"]["end_time"])

    def test_flexible_activity_rejects_times(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(time_mode="FLEXIBLE", start_time="06:30:00", end_time=None),
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 400)

    def test_time_range_requires_end_after_start(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(time_mode="TIME_RANGE", start_time="08:00:00", end_time="06:00:00"),
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 400)

    def test_must_have_exactly_one_type(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(system_type=""),
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 400)

    def test_structured_location_requires_place(self):
        payload = self._valid_payload(location_mode="STRUCTURED")
        res = self.client.post(self._create_url(), payload, format="json", **_auth(self.captain))
        self.assertEqual(res.status_code, 400)

    def test_manual_location_rejects_place(self):
        payload = self._valid_payload()
        payload["place"] = {
            "provider": "here",
            "provider_id": "x",
            "title": "x",
        }
        res = self.client.post(self._create_url(), payload, format="json", **_auth(self.captain))
        self.assertEqual(res.status_code, 400)

    def test_structured_location_persists_place(self):
        payload = self._valid_payload(location_mode="STRUCTURED")
        payload["place"] = {
            "provider": "here",
            "provider_id": "here:place:1",
            "title": "Bus station",
            "address": "Saigon",
            "lat": "10.84",
            "lng": "106.81",
        }
        res = self.client.post(self._create_url(), payload, format="json", **_auth(self.captain))
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["activity"]["location"]["location_mode"], "STRUCTURED")
        self.assertIsNotNone(res.data["activity"]["location"]["place"])

    def test_assignee_must_be_active_member(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(assignee_user_id=str(self.outsider.id)),
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "INVALID_ASSIGNEE")

    def test_assignee_active_member_ok(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(assignee_user_id=str(self.member.id)),
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["activity"]["assignee_scope"], "USER")
        self.assertEqual(res.data["activity"]["assignee"]["id"], str(self.member.id))

    def test_assignee_everyone_ok(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(assignee_scope="EVERYONE"),
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["activity"]["assignee_scope"], "EVERYONE")
        self.assertIsNone(res.data["activity"]["assignee"])
        activity = TimelineActivity.objects.get(pk=res.data["activity"]["id"])
        self.assertEqual(activity.assignee_scope, TimelineActivityAssigneeScope.EVERYONE)
        self.assertIsNone(activity.assignee_user_id)

    def test_everyone_rejects_specific_assignee_user(self):
        res = self.client.post(
            self._create_url(),
            self._valid_payload(
                assignee_scope="EVERYONE",
                assignee_user_id=str(self.member.id),
            ),
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 400)
        self.assertIn("assignee_user_id", res.data)

    def test_custom_type_must_belong_to_trip(self):
        other_trip = make_trip_with_timeline(captain=self.captain, name="Other", start_date=date(2026, 7, 1), end_date=date(2026, 7, 2))
        ct = TimelineCustomType.objects.create(
            trip=other_trip, name="Coffee", normalized_name="coffee"
        )
        res = self.client.post(
            self._create_url(),
            self._valid_payload(system_type="", custom_type_id=str(ct.id)),
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "INVALID_CUSTOM_TYPE")

    def test_create_rejects_inactive_custom_type(self):
        ct = TimelineCustomType.objects.create(
            trip=self.trip, name="Coffee", normalized_name="coffee", is_active=False
        )

        res = self.client.post(
            self._create_url(),
            self._valid_payload(system_type="", custom_type_id=str(ct.id)),
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "INVALID_CUSTOM_TYPE")

    def test_service_create_rejects_invalid_time_fields_before_persisting(self):
        with self.assertRaises(ValidationError):
            create_timeline_activity(
                self.trip.id,
                self.section.id,
                actor=self.captain,
                data=self._valid_service_payload(
                    title="Invalid all day",
                    time_mode="ALL_DAY",
                    start_time=time(6, 30),
                ),
            )

        self.assertFalse(TimelineActivity.objects.filter(title="Invalid all day").exists())

    def test_service_create_rejects_invalid_choice_fields_before_persisting(self):
        invalid_cases = [
            self._valid_service_payload(title="Invalid time mode", time_mode="NOT_A_MODE"),
            self._valid_service_payload(title="Invalid location mode", location_mode="NOT_A_MODE"),
        ]

        for payload in invalid_cases:
            with self.subTest(title=payload["title"]):
                with self.assertRaises(ValidationError):
                    create_timeline_activity(
                        self.trip.id,
                        self.section.id,
                        actor=self.captain,
                        data=payload,
                    )

        self.assertFalse(
            TimelineActivity.objects.filter(
                title__in=["Invalid time mode", "Invalid location mode"],
            ).exists()
        )

    def test_service_create_rejects_invalid_type_selection_before_persisting(self):
        invalid_cases = [
            self._valid_service_payload(title="Missing type", system_type=""),
            self._valid_service_payload(title="Unknown type", system_type="NOT_A_TYPE"),
            self._valid_service_payload(
                title="Two types",
                custom_type_id=TimelineCustomType.objects.create(
                    trip=self.trip,
                    name="Coffee",
                    normalized_name="coffee",
                ).id,
            ),
        ]

        for payload in invalid_cases:
            with self.subTest(title=payload["title"]):
                with self.assertRaises(ValidationError):
                    create_timeline_activity(
                        self.trip.id,
                        self.section.id,
                        actor=self.captain,
                        data=payload,
                    )

        self.assertFalse(
            TimelineActivity.objects.filter(
                title__in=["Missing type", "Unknown type", "Two types"],
            ).exists()
        )

    def test_service_create_rejects_invalid_location_before_persisting(self):
        with self.assertRaises(ValidationError):
            create_timeline_activity(
                self.trip.id,
                self.section.id,
                actor=self.captain,
                data=self._valid_service_payload(
                    title="Invalid structured location",
                    location_mode="STRUCTURED",
                    place=None,
                ),
            )

        self.assertFalse(
            TimelineActivity.objects.filter(title="Invalid structured location").exists()
        )

    def test_service_create_rejects_invalid_reminder_offsets_before_persisting(self):
        with self.assertRaises(ValidationError):
            create_timeline_activity(
                self.trip.id,
                self.section.id,
                actor=self.captain,
                data=self._valid_service_payload(
                    title="Invalid reminder",
                    reminder_offsets_minutes=[45],
                ),
            )

        self.assertFalse(TimelineActivity.objects.filter(title="Invalid reminder").exists())

    def test_create_planner_is_pure_and_returns_canonical_scoped_references(self):
        from trips.services import plan_timeline_activity_create

        custom_type = TimelineCustomType.objects.create(
            trip=self.trip,
            name="Planner custom",
            normalized_name="planner-custom",
        )
        activity_count = TimelineActivity.objects.filter(trip=self.trip).count()

        plan = plan_timeline_activity_create(
            trip=self.trip,
            section_id=str(self.section.id),
            data={
                "title": "Pure planner activity",
                "time_mode": "FLEXIBLE",
                "custom_type_id": str(custom_type.id),
                "assignee_user_id": str(self.member.id),
            },
        )

        self.assertEqual(plan.section, self.section)
        self.assertEqual(plan.data["custom_type_id"], str(custom_type.id))
        self.assertEqual(plan.data["assignee_user_id"], str(self.member.id))
        self.assertEqual(plan.data["assignee_scope"], "USER")
        self.assertEqual(plan.final_data["custom_type_label"], "Planner custom")
        self.assertEqual(
            plan.final_data["assignee_label"],
            self.member.display_name,
        )
        self.assertEqual(
            TimelineActivity.objects.filter(trip=self.trip).count(),
            activity_count,
        )

    # -------- Patch --------

    def test_patch_title(self):
        activity = make_timeline_activity(trip=self.trip, section=self.section, title="x")
        res = self.client.patch(
            self._detail_url(activity.id),
            {"title": "New title"},
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["activity"]["title"], "New title")

    def test_patch_assignee_to_everyone_clears_user(self):
        activity = make_timeline_activity(
            trip=self.trip,
            section=self.section,
            assignee_user=self.member,
        )

        res = self.client.patch(
            self._detail_url(activity.id),
            {"assignee_scope": "EVERYONE"},
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["activity"]["assignee_scope"], "EVERYONE")
        self.assertIsNone(res.data["activity"]["assignee"])
        activity.refresh_from_db()
        self.assertEqual(activity.assignee_scope, TimelineActivityAssigneeScope.EVERYONE)
        self.assertIsNone(activity.assignee_user_id)

    def test_patch_clears_place_when_switching_to_manual(self):
        activity = make_timeline_activity(
            trip=self.trip, section=self.section, location_mode="STRUCTURED"
        )
        activity.place_provider = "here"
        activity.place_provider_id = "x"
        activity.place_title = "x"
        activity.save()
        res = self.client.patch(
            self._detail_url(activity.id),
            {"location_mode": "MANUAL"},
            format="json",
            **_auth(self.captain),
        )
        self.assertEqual(res.status_code, 200)
        activity.refresh_from_db()
        self.assertEqual(activity.place_provider_id, "")
        self.assertIsNone(activity.place_lat)

    def test_patch_validation_failure_400(self):
        activity = make_timeline_activity(
            trip=self.trip, section=self.section, time_mode="AT_TIME"
        )
        res = self.client.patch(
            self._detail_url(activity.id),
            {"time_mode": "TIME_RANGE"},
            format="json",
            **_auth(self.captain),
        )
        # Existing activity has start_time but no end_time → invalid for TIME_RANGE
        self.assertEqual(res.status_code, 400)

    def test_patch_scheduled_to_flexible_clears_times(self):
        activity = make_timeline_activity(
            trip=self.trip,
            section=self.section,
            time_mode="AT_TIME",
        )

        res = self.client.patch(
            self._detail_url(activity.id),
            {"time_mode": "FLEXIBLE"},
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["activity"]["time_mode"], "FLEXIBLE")
        self.assertIsNone(res.data["activity"]["start_time"])
        self.assertIsNone(res.data["activity"]["end_time"])
        activity.refresh_from_db()
        self.assertIsNone(activity.start_time)
        self.assertIsNone(activity.end_time)

    def test_patch_planner_is_pure_and_returns_canonical_transition_data(self):
        from trips.services import plan_timeline_activity_patch

        activity = make_timeline_activity(
            trip=self.trip,
            section=self.section,
            time_mode="TIME_RANGE",
        )
        activity.start_time = time(8, 0)
        activity.end_time = time(10, 0)
        activity.save(update_fields=["start_time", "end_time"])

        plan = plan_timeline_activity_patch(
            trip=self.trip,
            activity=activity,
            data={"time_mode": "AT_TIME"},
        )

        self.assertEqual(plan.data["time_mode"], "AT_TIME")
        self.assertIn("end_time", plan.data)
        self.assertIsNone(plan.data["end_time"])
        self.assertEqual(plan.final_time_mode, "AT_TIME")
        self.assertEqual(plan.final_start_time, time(8, 0))
        self.assertIsNone(plan.final_end_time)
        activity.refresh_from_db()
        self.assertEqual(activity.time_mode, "TIME_RANGE")
        self.assertEqual(activity.end_time, time(10, 0))

    def test_patch_rejects_inactive_custom_type_assignment(self):
        activity = make_timeline_activity(trip=self.trip, section=self.section)
        ct = TimelineCustomType.objects.create(
            trip=self.trip, name="Coffee", normalized_name="coffee", is_active=False
        )

        res = self.client.patch(
            self._detail_url(activity.id),
            {"system_type": "", "custom_type_id": str(ct.id)},
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error_code"], "INVALID_CUSTOM_TYPE")

    def test_patch_preserves_existing_inactive_custom_type(self):
        ct = TimelineCustomType.objects.create(
            trip=self.trip, name="Coffee", normalized_name="coffee", is_active=False
        )
        activity = make_timeline_activity(trip=self.trip, section=self.section, custom_type=ct)

        res = self.client.patch(
            self._detail_url(activity.id),
            {"title": "Coffee stop", "system_type": "", "custom_type_id": str(ct.id)},
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["activity"]["title"], "Coffee stop")
        self.assertEqual(res.data["activity"]["activity_type"]["id"], str(ct.id))

    def test_patch_system_type_clears_existing_custom_type(self):
        ct = TimelineCustomType.objects.create(
            trip=self.trip, name="Coffee", normalized_name="coffee"
        )
        activity = make_timeline_activity(trip=self.trip, section=self.section, custom_type=ct)

        res = self.client.patch(
            self._detail_url(activity.id),
            {"system_type": "FOOD"},
            format="json",
            **_auth(self.captain),
        )

        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["activity"]["activity_type"]["code"], "FOOD")
        activity.refresh_from_db()
        self.assertEqual(activity.system_type, "FOOD")
        self.assertIsNone(activity.custom_type_id)

    # -------- Delete --------

    def test_delete_activity_200(self):
        activity = make_timeline_activity(trip=self.trip, section=self.section)
        res = self.client.delete(self._detail_url(activity.id), **_auth(self.captain))
        self.assertEqual(res.status_code, 200)
        self.assertFalse(TimelineActivity.objects.filter(pk=activity.id).exists())
