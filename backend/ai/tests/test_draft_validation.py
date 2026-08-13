from types import SimpleNamespace
from uuid import uuid4

from django.test import SimpleTestCase

from ai.action_types import (
    AI_ACTION_EXPENSE_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
)
from ai.agent.draft_mutations import _apply_draft_patch_payload
from ai.agent.draft_validation import (
    AIActionDraftFieldValidationError,
    validate_action_draft_patch_payload,
    validate_action_draft_patch_shape,
)


class AIActionDraftPatchPayloadValidationTests(SimpleTestCase):
    def _draft(self, data: dict) -> SimpleNamespace:
        return SimpleNamespace(
            action_type=AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
            payload={"activity_id": str(uuid4()), "data": data},
        )

    def _validate(self, *, draft: SimpleNamespace, patch_payload: dict) -> dict:
        validate_action_draft_patch_shape(
            draft=draft,
            patch_payload=patch_payload,
        )
        candidate_payload = _apply_draft_patch_payload(draft, patch_payload)
        validate_action_draft_patch_payload(
            draft=draft,
            patch_payload=patch_payload,
            candidate_payload=candidate_payload,
            currency_code="VND",
        )
        return candidate_payload

    def test_nested_patch_validates_against_existing_nested_start_time(self):
        draft = self._draft({"start_time": "10:00"})
        patch_payload = {"data": {"end_time": "08:00"}}

        with self.assertRaises(AIActionDraftFieldValidationError) as context:
            self._validate(draft=draft, patch_payload=patch_payload)

        self.assertEqual(
            set(context.exception.field_errors),
            {"data"},
        )
        self.assertEqual(draft.payload["data"], {"start_time": "10:00"})

    def test_direct_patch_validates_against_existing_nested_end_time(self):
        draft = self._draft({"end_time": "08:00"})
        patch_payload = {"start_time": "10:00"}

        with self.assertRaises(AIActionDraftFieldValidationError) as context:
            self._validate(draft=draft, patch_payload=patch_payload)

        self.assertEqual(
            set(context.exception.field_errors),
            {"start_time"},
        )
        self.assertEqual(draft.payload["data"], {"end_time": "08:00"})

    def test_valid_one_sided_patch_returns_exact_persistence_candidate(self):
        draft = self._draft({"start_time": "08:00"})

        candidate_payload = self._validate(
            draft=draft,
            patch_payload={"end_time": "10:00"},
        )

        self.assertEqual(
            candidate_payload,
            {
                "activity_id": draft.payload["activity_id"],
                "data": {"start_time": "08:00", "end_time": "10:00"},
            },
        )
        self.assertEqual(draft.payload["data"], {"start_time": "08:00"})

    def test_valid_nested_one_sided_patch_returns_exact_persistence_candidate(self):
        draft = self._draft({"start_time": "08:00"})

        candidate_payload = self._validate(
            draft=draft,
            patch_payload={"data": {"end_time": "10:00"}},
        )

        self.assertEqual(
            candidate_payload["data"],
            {"start_time": "08:00", "end_time": "10:00"},
        )

    def test_explicit_non_dict_data_is_rejected_before_candidate_application(self):
        for malformed_data in (
            "not-an-object",
            "",
            "   ",
            1,
            True,
            ["not", "an", "object"],
            None,
        ):
            with self.subTest(data=malformed_data):
                draft = self._draft({"start_time": "08:00"})

                with self.assertRaises(AIActionDraftFieldValidationError) as context:
                    self._validate(
                        draft=draft,
                        patch_payload={"data": malformed_data},
                    )

                self.assertEqual(
                    context.exception.field_errors,
                    {"data": "Input should be a valid object."},
                )
                self.assertEqual(
                    draft.payload["data"],
                    {"start_time": "08:00"},
                )

    def test_empty_data_object_is_accepted_as_candidate_noop(self):
        draft = self._draft({"start_time": "08:00"})

        candidate_payload = self._validate(
            draft=draft,
            patch_payload={"data": {}},
        )

        self.assertEqual(candidate_payload, draft.payload)

    def test_valid_direct_leaf_patch_recovers_legacy_non_dict_data(self):
        for malformed_data in ("legacy", 1, True, ["legacy"], None):
            with self.subTest(data=malformed_data):
                draft = self._draft({})
                draft.payload["data"] = malformed_data

                candidate_payload = self._validate(
                    draft=draft,
                    patch_payload={"title": "Recovered activity"},
                )

                self.assertEqual(
                    candidate_payload["data"],
                    {"title": "Recovered activity"},
                )

    def test_valid_nested_patch_recovers_legacy_non_dict_data(self):
        draft = self._draft({})
        draft.payload["data"] = "legacy"

        candidate_payload = self._validate(
            draft=draft,
            patch_payload={"data": {"title": "Recovered activity"}},
        )

        self.assertEqual(
            candidate_payload["data"],
            {"title": "Recovered activity"},
        )

    def test_unknown_nested_fields_do_not_hide_known_leaf_validation(self):
        draft = self._draft({"start_time": "10:00"})

        with self.assertRaises(AIActionDraftFieldValidationError) as context:
            self._validate(
                draft=draft,
                patch_payload={
                    "data": {
                        "future_field": "preserved",
                        "end_time": "08:00",
                    }
                },
            )

        self.assertEqual(set(context.exception.field_errors), {"data"})

    def test_nested_field_errors_keep_first_pydantic_message_for_data_wrapper(self):
        draft = self._draft({})

        with self.assertRaises(AIActionDraftFieldValidationError) as context:
            self._validate(
                draft=draft,
                patch_payload={
                    "data": {
                        "start_time": "not-a-time",
                        "end_time": "also-not-a-time",
                    }
                },
            )

        self.assertEqual(set(context.exception.field_errors), {"data"})
        self.assertIn("time", context.exception.field_errors["data"].lower())

    def test_nested_structural_error_collapses_deep_location_to_data_wrapper(self):
        draft = self._draft({})

        with self.assertRaises(AIActionDraftFieldValidationError) as context:
            self._validate(
                draft=draft,
                patch_payload={
                    "data": {
                        "place": {
                            "provider": "",
                            "provider_id": "here:123",
                            "title": "Museum",
                        }
                    }
                },
            )

        self.assertEqual(set(context.exception.field_errors), {"data"})

    def test_direct_structural_error_collapses_to_json_editor_field(self):
        draft = self._draft({})

        with self.assertRaises(AIActionDraftFieldValidationError) as context:
            self._validate(
                draft=draft,
                patch_payload={
                    "place": {
                        "provider": "",
                        "provider_id": "here:123",
                        "title": "Museum",
                    }
                },
            )

        self.assertEqual(
            set(context.exception.field_errors),
            {"place"},
        )

    def test_empty_nested_object_recovers_legacy_non_dict_data(self):
        draft = self._draft({})
        draft.payload["data"] = "legacy"

        candidate_payload = self._validate(
            draft=draft,
            patch_payload={"data": {}},
        )

        self.assertEqual(candidate_payload["data"], {})

    def test_blank_timeline_leaf_keeps_existing_no_field_error_semantics(self):
        draft = self._draft({"start_time": "10:00"})

        candidate_payload = self._validate(
            draft=draft,
            patch_payload={"data": {"end_time": ""}},
        )

        self.assertEqual(candidate_payload["data"]["end_time"], "")

    def test_non_timeline_validation_contract_is_unchanged(self):
        draft = SimpleNamespace(
            action_type=AI_ACTION_EXPENSE_CREATE,
            payload={"title": "Dinner"},
        )

        with self.assertRaises(AIActionDraftFieldValidationError) as context:
            validate_action_draft_patch_payload(
                draft=draft,
                patch_payload={"total_amount": "invalid"},
                candidate_payload={
                    "title": "Dinner",
                    "total_amount": "invalid",
                },
                currency_code="VND",
            )

        self.assertEqual(set(context.exception.field_errors), {"total_amount"})
