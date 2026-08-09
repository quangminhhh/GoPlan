from __future__ import annotations

import threading
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch
from uuid import uuid4

from django.db import close_old_connections, connections, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from ai.agent.draft_mutations import (
    cancel_action_draft,
    patch_action_draft,
)
from ai.agent.executor import (
    AIActionDraftExpiredError,
    confirm_action_draft,
    mark_action_draft_failed,
)
from ai.chat_changes import (
    lock_trip_for_ai_chat_change,
    mark_ai_response_message_changed,
)
from ai.lifecycle import finish_interaction_failure, finish_interaction_success
from ai.models import (
    AIActionDraft,
    AIActionDraftStatus,
    AIInteraction,
    AIInteractionStatus,
)
from ai.views import (
    AIActionDraftCancelAPIView,
    AIActionDraftConfirmAPIView,
    AIActionDraftDetailAPIView,
)
from chat.models import ChatMessage, ChatMessageAIStatus, ChatMessageSenderKind
from chat.services import build_chat_message_ws_payload
from expenses.models import Expense
from expenses.services import (
    create_expense,
    finalize_settlement,
    mark_transfer_sent,
    set_contribution,
)
from test_helpers import create_completed_user
from trips.models import (
    MemberStatus,
    TimelineActivity,
    TimelineSection,
    Trip,
    TripMember,
    TripRole,
)
from trips.services import create_timeline_activity


def _create_trip(*, user, sequence: int = 0) -> Trip:
    trip = Trip.objects.create(
        created_by=user,
        name="AI sequence trip",
        destination="Da Nang",
        start_date="2026-06-01",
        end_date="2026-06-05",
        chat_change_sequence=sequence,
    )
    TripMember.objects.create(
        trip=trip,
        user=user,
        role=TripRole.CAPTAIN,
        status=MemberStatus.ACTIVE,
    )
    return trip


def _create_interaction(*, trip, user, prompt_sequence: int = 0) -> AIInteraction:
    prompt = ChatMessage.objects.create(
        trip=trip,
        sender=user,
        sender_display_name_snapshot=user.display_name,
        sender_identify_tag_snapshot=user.identify_tag,
        content="@GoPlanAI help",
        client_message_id=uuid4(),
        change_sequence=prompt_sequence,
    )
    return AIInteraction.objects.create(
        trip=trip,
        requested_by=user,
        prompt_message=prompt,
        prompt="help",
        status=AIInteractionStatus.RUNNING,
        lock_expires_at=timezone.now() + timedelta(minutes=2),
    )


def _create_ai_response(*, trip, sequence: int) -> ChatMessage:
    return ChatMessage.objects.create(
        trip=trip,
        sender=None,
        sender_kind=ChatMessageSenderKind.AI,
        sender_display_name_snapshot="GoPlanAI",
        content="Review this action",
        ai_status=ChatMessageAIStatus.SUCCESS,
        change_sequence=sequence,
    )


def _create_draft(
    *,
    trip,
    interaction,
    response_message,
    user,
    status=AIActionDraftStatus.READY,
    expires_at=None,
    payload=None,
    missing_fields=None,
) -> AIActionDraft:
    return AIActionDraft.objects.create(
        trip=trip,
        interaction=interaction,
        response_message=response_message,
        requested_by=user,
        action_type="expense.create",
        status=status,
        payload=payload or {"title": "Dinner", "total_amount": "100000"},
        preview=payload or {"title": "Dinner", "total_amount": "100000"},
        display={"title": "Dinner"},
        summary="Create Dinner expense",
        missing_fields=missing_fields or [],
        preconditions={},
        required_confirmation="CAPTAIN",
        expires_at=expires_at or timezone.now() + timedelta(hours=24),
    )


class AIResponseChangeSequenceTests(TestCase):
    def setUp(self):
        self.user = create_completed_user(
            "ai-sequence@example.com",
            "aisequence",
            "AIS001",
        )
        self.trip = _create_trip(user=self.user, sequence=7)
        self.interaction = _create_interaction(
            trip=self.trip,
            user=self.user,
            prompt_sequence=7,
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_success_allocates_sequence_and_publishes_proposed_draft_after_commit(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=None,
            user=self.user,
        )

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            message = finish_interaction_success(
                interaction=self.interaction,
                message_text="I drafted an expense.",
            )
            push_chat_message.assert_not_called()

        self.assertEqual(message.change_sequence, 8)
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 8)
        draft.refresh_from_db()
        self.assertEqual(draft.response_message_id, message.id)
        ws_payload = build_chat_message_ws_payload(message)
        self.assertEqual(ws_payload["message"]["change_sequence"], 8)
        self.assertEqual(
            ws_payload["message"]["action_drafts"][0]["id"],
            str(draft.id),
        )
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        push_chat_message.assert_called_once()
        self.assertEqual(push_chat_message.call_args.args[0].change_sequence, 8)

    @patch("ai.chat_changes.push_chat_message")
    def test_failure_allocates_sequence_and_publishes_after_commit(
        self,
        push_chat_message,
    ):
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            message = finish_interaction_failure(
                interaction=self.interaction,
                error_code="INTERNAL_ERROR",
            )
            push_chat_message.assert_not_called()

        self.assertEqual(message.ai_status, ChatMessageAIStatus.ERROR)
        self.assertEqual(message.change_sequence, 8)
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 8)
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        push_chat_message.assert_called_once_with(message)

    @patch("ai.chat_changes.push_chat_message")
    def test_redelivery_is_idempotent_without_allocating_or_republishing(
        self,
        push_chat_message,
    ):
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            first = finish_interaction_success(
                interaction=self.interaction,
                message_text="First response",
            )
            second = finish_interaction_success(
                interaction=self.interaction,
                message_text="Duplicate response",
            )

        self.assertEqual(first.id, second.id)
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 8)
        self.assertEqual(
            ChatMessage.objects.filter(
                trip=self.trip,
                sender_kind=ChatMessageSenderKind.AI,
            ).count(),
            1,
        )
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        push_chat_message.assert_called_once()

    @patch("ai.chat_changes.push_chat_message")
    def test_rollback_does_not_consume_sequence_or_publish(
        self,
        push_chat_message,
    ):
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            with patch.object(
                AIInteraction,
                "save",
                side_effect=RuntimeError("forced rollback"),
            ):
                with self.assertRaisesRegex(RuntimeError, "forced rollback"):
                    finish_interaction_success(
                        interaction=self.interaction,
                        message_text="Rolled back",
                    )

        self.trip.refresh_from_db()
        self.interaction.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 7)
        self.assertIsNone(self.interaction.response_message_id)
        self.assertFalse(
            ChatMessage.objects.filter(
                trip=self.trip,
                sender_kind=ChatMessageSenderKind.AI,
            ).exists()
        )
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

        with self.captureOnCommitCallbacks(execute=False) as retry_callbacks:
            message = finish_interaction_success(
                interaction=self.interaction,
                message_text="Committed",
            )

        self.assertEqual(message.change_sequence, 8)
        self.assertEqual(len(retry_callbacks), 1)


class AIActionDraftChangeSequenceTests(TestCase):
    def setUp(self):
        self.user = create_completed_user(
            "ai-draft-sequence@example.com",
            "aidraftsequence",
            "AID001",
        )
        self.trip = _create_trip(user=self.user, sequence=11)
        self.interaction = _create_interaction(
            trip=self.trip,
            user=self.user,
            prompt_sequence=10,
        )
        self.response_message = _create_ai_response(trip=self.trip, sequence=11)

    @patch("ai.chat_changes.push_chat_message")
    def test_patch_allocates_sequence_and_publishes_ready_snapshot_after_commit(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
            status=AIActionDraftStatus.NEEDS_INFO,
            payload={"total_amount": "100000"},
            missing_fields=[{"name": "title", "type": "text", "required": True}],
        )

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            updated = patch_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
                patch_payload={"title": "Dinner"},
            )
            push_chat_message.assert_not_called()

        self.assertEqual(updated.status, AIActionDraftStatus.READY)
        updated.response_message.refresh_from_db()
        self.assertEqual(updated.response_message.change_sequence, 12)
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 12)
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        pushed = push_chat_message.call_args.args[0]
        self.assertEqual(pushed.change_sequence, 12)
        ws_payload = build_chat_message_ws_payload(pushed)
        self.assertEqual(ws_payload["message"]["change_sequence"], 12)
        self.assertEqual(
            ws_payload["message"]["action_drafts"][0]["status"],
            AIActionDraftStatus.READY,
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_empty_patch_is_a_true_noop_without_timestamp_sequence_or_push(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
            status=AIActionDraftStatus.NEEDS_INFO,
            payload={"title": "Lunch", "total_amount": ""},
            missing_fields=[
                {"name": "total_amount", "label": "Amount", "type": "money"}
            ],
        )
        draft_updated_at = draft.updated_at
        message_updated_at = self.response_message.updated_at

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            updated = patch_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
                patch_payload={},
            )

        draft.refresh_from_db()
        self.response_message.refresh_from_db()
        self.trip.refresh_from_db()
        self.assertEqual(updated.id, draft.id)
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.updated_at, draft_updated_at)
        self.assertEqual(self.response_message.updated_at, message_updated_at)
        self.assertEqual(self.response_message.change_sequence, 11)
        self.assertEqual(self.trip.chat_change_sequence, 11)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_effectively_unchanged_top_level_patch_is_a_true_noop(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
            status=AIActionDraftStatus.NEEDS_INFO,
            payload={"title": "Lunch", "total_amount": "500000"},
            missing_fields=[
                {"name": "total_amount", "label": "Amount", "type": "money"}
            ],
        )
        draft_updated_at = draft.updated_at
        message_updated_at = self.response_message.updated_at

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            updated = patch_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
                patch_payload={"total_amount": "500000"},
            )

        draft.refresh_from_db()
        self.response_message.refresh_from_db()
        self.trip.refresh_from_db()
        self.assertEqual(updated.id, draft.id)
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.updated_at, draft_updated_at)
        self.assertEqual(self.response_message.updated_at, message_updated_at)
        self.assertEqual(self.response_message.change_sequence, 11)
        self.assertEqual(self.trip.chat_change_sequence, 11)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_effectively_unchanged_nested_timeline_patch_is_a_true_noop(
        self,
        push_chat_message,
    ):
        section = TimelineSection.objects.create(
            trip=self.trip,
            section_date="2026-06-01",
            label="Day 1",
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            requested_by=self.user,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.NEEDS_INFO,
            payload={
                "section_id": str(section.id),
                "data": {
                    "title": "Museum",
                    "system_type": "SIGHTSEEING",
                    "time_mode": "FLEXIBLE",
                },
            },
            preview={"title": "Museum"},
            display={"title": "Museum"},
            summary="Create Museum activity",
            missing_fields=[{"name": "title", "label": "Title", "type": "text"}],
            preconditions={},
            required_confirmation="CAPTAIN",
            expires_at=timezone.now() + timedelta(hours=24),
        )
        draft_updated_at = draft.updated_at
        message_updated_at = self.response_message.updated_at

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            updated = patch_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
                patch_payload={"title": "Museum"},
            )

        draft.refresh_from_db()
        self.response_message.refresh_from_db()
        self.trip.refresh_from_db()
        self.assertEqual(updated.id, draft.id)
        self.assertEqual(draft.status, AIActionDraftStatus.NEEDS_INFO)
        self.assertEqual(draft.updated_at, draft_updated_at)
        self.assertEqual(self.response_message.updated_at, message_updated_at)
        self.assertEqual(self.response_message.change_sequence, 11)
        self.assertEqual(self.trip.chat_change_sequence, 11)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_cancel_allocates_once_and_terminal_replay_is_a_noop(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
        )

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            first = cancel_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
            )
            second = cancel_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
            )

        self.assertEqual(first.status, AIActionDraftStatus.CANCELLED)
        self.assertEqual(second.status, AIActionDraftStatus.CANCELLED)
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 12)
        self.assertEqual(self.response_message.change_sequence, 12)
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        push_chat_message.assert_called_once()

    @patch("ai.chat_changes.push_chat_message")
    def test_confirm_executes_once_and_terminal_replay_does_not_republish(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
        )

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            first = confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
            )
            second = confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
            )

        self.assertEqual(first.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(second.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(Expense.objects.filter(trip=self.trip).count(), 1)
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 12)
        self.assertEqual(self.response_message.change_sequence, 12)
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        push_chat_message.assert_called_once()

    @patch("ai.chat_changes.push_chat_message")
    def test_expired_confirm_allocates_sequence_and_publishes_expired_snapshot(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            with self.assertRaises(AIActionDraftExpiredError):
                confirm_action_draft(
                    draft_id=draft.id,
                    trip_id=self.trip.id,
                    actor=self.user,
                )

        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.EXPIRED)
        self.assertEqual(self.trip.chat_change_sequence, 12)
        self.assertEqual(self.response_message.change_sequence, 12)
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        push_chat_message.assert_called_once()

    @patch("ai.chat_changes.push_chat_message")
    def test_failed_mutation_allocates_once_and_non_ready_replay_is_a_noop(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
        )

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            first = mark_action_draft_failed(
                draft_id=draft.id,
                trip_id=self.trip.id,
                error_code="AI_DRAFT_STALE",
                error_detail="Target changed.",
            )
            second = mark_action_draft_failed(
                draft_id=draft.id,
                trip_id=self.trip.id,
                error_code="AI_DRAFT_STALE",
                error_detail="Target changed again.",
            )

        self.assertEqual(first.status, AIActionDraftStatus.FAILED)
        self.assertEqual(second.status, AIActionDraftStatus.FAILED)
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 12)
        self.assertEqual(self.response_message.change_sequence, 12)
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        push_chat_message.assert_called_once()

    @patch("ai.chat_changes.push_chat_message")
    def test_rollback_restores_draft_message_and_counter_without_sequence_gap(
        self,
        push_chat_message,
    ):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
        )

        with patch(
            "ai.chat_changes.transaction.on_commit",
            side_effect=RuntimeError("forced rollback"),
        ):
            with self.assertRaisesRegex(RuntimeError, "forced rollback"):
                cancel_action_draft(
                    draft_id=draft.id,
                    trip_id=self.trip.id,
                    actor=self.user,
                )

        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(self.trip.chat_change_sequence, 11)
        self.assertEqual(self.response_message.change_sequence, 11)
        push_chat_message.assert_not_called()

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            cancel_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
            )

        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 12)
        self.assertEqual(len(callbacks), 1)

    @patch("ai.chat_changes.push_chat_message")
    def test_committed_pushes_follow_allocated_sequence_order(
        self,
        push_chat_message,
    ):
        first_draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
        )
        second_response = _create_ai_response(trip=self.trip, sequence=11)
        second_draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=second_response,
            user=self.user,
        )

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            cancel_action_draft(
                draft_id=first_draft.id,
                trip_id=self.trip.id,
                actor=self.user,
            )
            cancel_action_draft(
                draft_id=second_draft.id,
                trip_id=self.trip.id,
                actor=self.user,
            )
            push_chat_message.assert_not_called()

        self.assertEqual(len(callbacks), 2)
        for callback in callbacks:
            callback()

        pushed_sequences = [
            call.args[0].change_sequence
            for call in push_chat_message.call_args_list
        ]
        self.assertEqual(pushed_sequences, [12, 13])

    def test_confirm_locks_trip_then_membership_then_draft_then_message(self):
        draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.user,
        )
        lock_order = []
        trip_select_for_update = Trip.objects.select_for_update
        membership_select_for_update = TripMember.objects.select_for_update
        draft_select_for_update = AIActionDraft.objects.select_for_update
        message_select_for_update = ChatMessage.objects.select_for_update

        def record_lock(name, select_for_update):
            def recorder(*args, **kwargs):
                lock_order.append(name)
                return select_for_update(*args, **kwargs)

            return recorder

        with (
            patch.object(
                Trip.objects,
                "select_for_update",
                side_effect=record_lock("trip", trip_select_for_update),
            ),
            patch.object(
                TripMember.objects,
                "select_for_update",
                side_effect=record_lock(
                    "membership",
                    membership_select_for_update,
                ),
            ),
            patch.object(
                AIActionDraft.objects,
                "select_for_update",
                side_effect=record_lock("draft", draft_select_for_update),
            ),
            patch.object(
                ChatMessage.objects,
                "select_for_update",
                side_effect=record_lock("message", message_select_for_update),
            ),
        ):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.user,
            )

        self.assertEqual(lock_order[:3], ["trip", "membership", "draft"])
        self.assertLess(lock_order.index("draft"), lock_order.index("message"))

    @patch("ai.chat_changes.push_chat_message")
    def test_nested_trip_instances_allocate_distinct_committed_sequences(
        self,
        push_chat_message,
    ):
        second_response = _create_ai_response(trip=self.trip, sequence=11)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            with transaction.atomic():
                outer_trip = lock_trip_for_ai_chat_change(trip_id=self.trip.id)
                inner_trip = lock_trip_for_ai_chat_change(trip_id=self.trip.id)
                mark_ai_response_message_changed(
                    message=self.response_message,
                    locked_trip=inner_trip,
                )
                mark_ai_response_message_changed(
                    message=second_response,
                    locked_trip=outer_trip,
                )
                push_chat_message.assert_not_called()

        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        second_response.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 13)
        self.assertEqual(
            [
                self.response_message.change_sequence,
                second_response.change_sequence,
            ],
            [12, 13],
        )
        self.assertEqual(len(callbacks), 2)
        for callback in callbacks:
            callback()

        committed_by_id = {
            str(message.id): message.change_sequence
            for message in ChatMessage.objects.filter(
                id__in=[self.response_message.id, second_response.id],
            )
        }
        pushed_messages = [
            call.args[0]
            for call in push_chat_message.call_args_list
        ]
        self.assertEqual(
            [message.change_sequence for message in pushed_messages],
            [12, 13],
        )
        for message in pushed_messages:
            self.assertEqual(
                message.change_sequence,
                committed_by_id[str(message.id)],
            )
            self.assertEqual(
                build_chat_message_ws_payload(message)["message"]["change_sequence"],
                committed_by_id[str(message.id)],
            )

    @patch("ai.chat_changes.push_chat_message")
    def test_nested_allocations_rollback_counter_messages_and_both_pushes(
        self,
        push_chat_message,
    ):
        second_response = _create_ai_response(trip=self.trip, sequence=11)

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            with self.assertRaisesRegex(RuntimeError, "forced nested rollback"):
                with transaction.atomic():
                    outer_trip = lock_trip_for_ai_chat_change(trip_id=self.trip.id)
                    inner_trip = lock_trip_for_ai_chat_change(trip_id=self.trip.id)
                    mark_ai_response_message_changed(
                        message=self.response_message,
                        locked_trip=inner_trip,
                    )
                    mark_ai_response_message_changed(
                        message=second_response,
                        locked_trip=outer_trip,
                    )
                    raise RuntimeError("forced nested rollback")

        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        second_response.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 11)
        self.assertEqual(self.response_message.change_sequence, 11)
        self.assertEqual(second_response.change_sequence, 11)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()


class AIActionDraftSequenceAccessTests(APITestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "ai-access-captain@example.com",
            "aiaccesscaptain",
            "AAC001",
        )
        self.outsider = create_completed_user(
            "ai-access-outsider@example.com",
            "aiaccessoutsider",
            "AAO001",
        )
        self.trip = _create_trip(user=self.captain, sequence=3)
        self.interaction = _create_interaction(
            trip=self.trip,
            user=self.captain,
            prompt_sequence=2,
        )
        self.response_message = _create_ai_response(trip=self.trip, sequence=3)
        self.draft = _create_draft(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response_message,
            user=self.captain,
        )
        self.cancel_url = (
            f"/api/trips/{self.trip.id}/ai/action-drafts/{self.draft.id}/cancel"
        )

    @patch("ai.chat_changes.push_chat_message")
    def test_outsider_cannot_mutate_or_allocate_sequence(self, push_chat_message):
        self.client.force_authenticate(self.outsider)

        response = self.client.post(self.cancel_url, {}, format="json")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_NOT_FOUND")
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.draft.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 3)
        self.assertEqual(self.response_message.change_sequence, 3)
        self.assertEqual(self.draft.status, AIActionDraftStatus.READY)
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_unauthenticated_request_does_not_mutate_or_allocate(
        self,
        push_chat_message,
    ):
        response = self.client.post(self.cancel_url, {}, format="json")

        self.assertEqual(response.status_code, 401)
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 3)
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_active_member_without_action_permission_is_forbidden_without_mutation(
        self,
        push_chat_message,
    ):
        member = create_completed_user(
            "ai-access-member@example.com",
            "aiaccessmember",
            "AAM001",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        self.client.force_authenticate(member)

        response = self.client.post(self.cancel_url, {}, format="json")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_FORBIDDEN")
        self.trip.refresh_from_db()
        self.response_message.refresh_from_db()
        self.draft.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 3)
        self.assertEqual(self.response_message.change_sequence, 3)
        self.assertEqual(self.draft.status, AIActionDraftStatus.READY)
        push_chat_message.assert_not_called()


class AIActionDraftEndpointContractTests(TestCase):
    def test_permissions_and_scoped_throttles_remain_explicit(self):
        expected_permissions = ["IsAuthenticated", "IsProfileCompleted"]

        self.assertEqual(
            AIActionDraftDetailAPIView.throttle_scope,
            "ai_action_draft",
        )
        self.assertEqual(
            AIActionDraftCancelAPIView.throttle_scope,
            "ai_action_draft",
        )
        self.assertEqual(
            AIActionDraftConfirmAPIView.throttle_scope,
            "ai_action_confirm",
        )
        for view_class in (
            AIActionDraftDetailAPIView,
            AIActionDraftCancelAPIView,
            AIActionDraftConfirmAPIView,
        ):
            self.assertEqual(
                [
                    permission_class.__name__
                    for permission_class in view_class.permission_classes
                ],
                expected_permissions,
            )


class AIChangeSequenceConcurrencyTests(TransactionTestCase):
    def test_concurrent_response_and_cancel_allocate_distinct_sequences(self):
        user = create_completed_user(
            "ai-concurrency@example.com",
            "aiconcurrency",
            "AIC001",
        )
        trip = _create_trip(user=user, sequence=1)
        response_message = _create_ai_response(trip=trip, sequence=1)
        draft_interaction = _create_interaction(
            trip=trip,
            user=user,
            prompt_sequence=1,
        )
        draft = _create_draft(
            trip=trip,
            interaction=draft_interaction,
            response_message=response_message,
            user=user,
        )
        response_interaction = _create_interaction(
            trip=trip,
            user=user,
            prompt_sequence=1,
        )
        barrier = threading.Barrier(3)
        outcomes = []
        outcome_lock = threading.Lock()

        def finish_failure():
            close_old_connections()
            try:
                interaction = AIInteraction.objects.get(pk=response_interaction.id)
                barrier.wait(timeout=5)
                message = finish_interaction_failure(
                    interaction=interaction,
                    error_code="INTERNAL_ERROR",
                )
                outcome = ("response", message.change_sequence, None)
            except Exception as exc:  # pragma: no cover - asserted below
                outcome = ("response", None, exc)
            finally:
                close_old_connections()
                connections.close_all()
            with outcome_lock:
                outcomes.append(outcome)

        def cancel_draft():
            close_old_connections()
            try:
                actor = type(user).objects.get(pk=user.id)
                barrier.wait(timeout=5)
                cancelled = cancel_action_draft(
                    draft_id=draft.id,
                    trip_id=trip.id,
                    actor=actor,
                )
                cancelled.response_message.refresh_from_db()
                outcome = (
                    "cancel",
                    cancelled.response_message.change_sequence,
                    None,
                )
            except Exception as exc:  # pragma: no cover - asserted below
                outcome = ("cancel", None, exc)
            finally:
                close_old_connections()
                connections.close_all()
            with outcome_lock:
                outcomes.append(outcome)

        with patch("ai.chat_changes.push_chat_message"):
            threads = [
                threading.Thread(target=finish_failure),
                threading.Thread(target=cancel_draft),
            ]
            for thread in threads:
                thread.start()
            barrier.wait(timeout=5)
            for thread in threads:
                thread.join(timeout=5)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual([error for _, _, error in outcomes], [None, None])
        self.assertEqual(sorted(sequence for _, sequence, _ in outcomes), [2, 3])
        trip.refresh_from_db()
        response_interaction.refresh_from_db()
        self.assertEqual(trip.chat_change_sequence, 3)
        committed_sequences = sorted(
            ChatMessage.objects.filter(
                id__in=[response_message.id, response_interaction.response_message_id],
            ).values_list("change_sequence", flat=True)
        )
        self.assertEqual(committed_sequences, [2, 3])


class TimelineTripLockOrderTests(TestCase):
    def test_actor_timeline_mutation_locks_trip_before_membership(self):
        user = create_completed_user(
            "timeline-lock-order@example.com",
            "timelinelockorder",
            "TLO001",
        )
        trip = _create_trip(user=user)
        section = TimelineSection.objects.create(
            trip=trip,
            section_date="2026-06-01",
            label="Day 1",
        )
        lock_order = []
        trip_select_for_update = Trip.objects.select_for_update
        membership_select_for_update = TripMember.objects.select_for_update

        def record_trip_lock(*args, **kwargs):
            lock_order.append("trip")
            return trip_select_for_update(*args, **kwargs)

        def record_membership_lock(*args, **kwargs):
            lock_order.append("membership")
            return membership_select_for_update(*args, **kwargs)

        with (
            patch.object(
                Trip.objects,
                "select_for_update",
                side_effect=record_trip_lock,
            ),
            patch.object(
                TripMember.objects,
                "select_for_update",
                side_effect=record_membership_lock,
            ),
        ):
            create_timeline_activity(
                trip.id,
                section.id,
                actor=user,
                data={
                    "title": "Manual museum",
                    "system_type": "SIGHTSEEING",
                    "time_mode": "FLEXIBLE",
                },
            )

        self.assertEqual(lock_order[:2], ["trip", "membership"])


class AITimelineConfirmationConcurrencyTests(TransactionTestCase):
    def test_manual_timeline_create_and_ai_confirm_do_not_deadlock(self):
        captain = create_completed_user(
            "timeline-concurrency-captain@example.com",
            "timelineconcurrency",
            "TCC001",
        )
        trip = _create_trip(user=captain)
        section = TimelineSection.objects.create(
            trip=trip,
            section_date="2026-06-01",
            label="Day 1",
        )
        interaction = _create_interaction(
            trip=trip,
            user=captain,
            prompt_sequence=0,
        )
        response_message = _create_ai_response(trip=trip, sequence=0)
        draft = AIActionDraft.objects.create(
            trip=trip,
            interaction=interaction,
            response_message=response_message,
            requested_by=captain,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.READY,
            payload={
                "section_id": str(section.id),
                "data": {
                    "title": "AI museum",
                    "system_type": "SIGHTSEEING",
                    "time_mode": "FLEXIBLE",
                },
            },
            preview={"title": "AI museum"},
            display={"title": "AI museum"},
            summary="Create AI museum activity",
            missing_fields=[],
            preconditions={},
            required_confirmation="CAPTAIN",
            expires_at=timezone.now() + timedelta(hours=24),
        )
        barrier = threading.Barrier(3)
        outcomes = []
        outcome_lock = threading.Lock()

        def run_manual_create():
            close_old_connections()
            try:
                actor = type(captain).objects.get(pk=captain.id)
                barrier.wait(timeout=5)
                activity = create_timeline_activity(
                    trip.id,
                    section.id,
                    actor=actor,
                    data={
                        "title": "Manual museum",
                        "system_type": "SIGHTSEEING",
                        "time_mode": "FLEXIBLE",
                    },
                )
                outcome = ("manual", activity.id, None)
            except Exception as exc:  # pragma: no cover - asserted below
                outcome = ("manual", None, exc)
            finally:
                close_old_connections()
                connections.close_all()
            with outcome_lock:
                outcomes.append(outcome)

        def run_ai_confirm():
            close_old_connections()
            try:
                actor = type(captain).objects.get(pk=captain.id)
                barrier.wait(timeout=5)
                confirmed = confirm_action_draft(
                    draft_id=draft.id,
                    trip_id=trip.id,
                    actor=actor,
                )
                outcome = ("ai", confirmed.result["object_id"], None)
            except Exception as exc:  # pragma: no cover - asserted below
                outcome = ("ai", None, exc)
            finally:
                close_old_connections()
                connections.close_all()
            with outcome_lock:
                outcomes.append(outcome)

        with patch("ai.chat_changes.push_chat_message") as push_chat_message:
            threads = [
                threading.Thread(target=run_manual_create),
                threading.Thread(target=run_ai_confirm),
            ]
            for thread in threads:
                thread.start()
            barrier.wait(timeout=5)
            for thread in threads:
                thread.join(timeout=15)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(len(outcomes), 2)
        self.assertEqual(
            {name: error for name, _object_id, error in outcomes},
            {"manual": None, "ai": None},
        )
        draft.refresh_from_db()
        trip.refresh_from_db()
        response_message.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(
            set(
                TimelineActivity.objects.filter(trip=trip).values_list(
                    "title",
                    flat=True,
                )
            ),
            {"Manual museum", "AI museum"},
        )
        self.assertEqual(trip.chat_change_sequence, 1)
        self.assertEqual(response_message.change_sequence, 1)
        push_chat_message.assert_called_once()
        self.assertEqual(
            push_chat_message.call_args.args[0].change_sequence,
            response_message.change_sequence,
        )


class ExpenseTripLockOrderTests(TestCase):
    def test_expense_mutation_locks_trip_before_membership(self):
        user = create_completed_user(
            "expense-lock-order@example.com",
            "expenselockorder",
            "ELO001",
        )
        trip = _create_trip(user=user)
        lock_order = []
        trip_select_for_update = Trip.objects.select_for_update
        membership_select_for_update = TripMember.objects.select_for_update

        def record_trip_lock(*args, **kwargs):
            lock_order.append("trip")
            return trip_select_for_update(*args, **kwargs)

        def record_membership_lock(*args, **kwargs):
            lock_order.append("membership")
            return membership_select_for_update(*args, **kwargs)

        with (
            patch.object(
                Trip.objects,
                "select_for_update",
                side_effect=record_trip_lock,
            ),
            patch.object(
                TripMember.objects,
                "select_for_update",
                side_effect=record_membership_lock,
            ),
        ):
            create_expense(
                trip_id=trip.id,
                actor=user,
                title="Dinner",
                total_amount=Decimal("100000"),
                collector=user,
            )

        self.assertLess(
            lock_order.index("trip"),
            lock_order.index("membership"),
        )


class AITransferConfirmationConcurrencyTests(TransactionTestCase):
    def test_manual_transfer_and_ai_confirm_share_lock_order_without_deadlock(self):
        captain = create_completed_user(
            "transfer-lock-captain@example.com",
            "transferlockcaptain",
            "TLC001",
        )
        payer = create_completed_user(
            "transfer-lock-payer@example.com",
            "transferlockpayer",
            "TLP001",
        )
        trip = _create_trip(user=captain)
        TripMember.objects.create(
            trip=trip,
            user=payer,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=trip.id,
            actor=captain,
            title="Dinner",
            total_amount=Decimal("100000"),
            collector=captain,
        )
        set_contribution(
            trip_id=trip.id,
            expense_id=expense.id,
            target_user_id=captain.id,
            actor=captain,
            amount=Decimal("100000"),
        )
        settlement = finalize_settlement(trip_id=trip.id, actor=captain)
        transfer = settlement.transfers.get()
        self.assertEqual(transfer.payer_id, payer.id)

        interaction = _create_interaction(
            trip=trip,
            user=payer,
            prompt_sequence=0,
        )
        response_message = _create_ai_response(trip=trip, sequence=0)
        draft = AIActionDraft.objects.create(
            trip=trip,
            interaction=interaction,
            response_message=response_message,
            requested_by=payer,
            action_type="settlement.transfer.mark_sent",
            status=AIActionDraftStatus.READY,
            payload={"transfer_id": str(transfer.id)},
            preview={"title": "Mark transfer sent"},
            display={"title": "Mark transfer sent"},
            summary="Mark transfer sent",
            missing_fields=[],
            preconditions={},
            required_confirmation="TRANSFER_PAYER",
            expires_at=timezone.now() + timedelta(hours=24),
        )
        barrier = threading.Barrier(3)
        outcomes = []
        outcome_lock = threading.Lock()

        def run_manual_mark():
            close_old_connections()
            try:
                actor = type(payer).objects.get(pk=payer.id)
                barrier.wait(timeout=5)
                mark_transfer_sent(
                    trip_id=trip.id,
                    transfer_id=transfer.id,
                    actor=actor,
                )
                outcome = ("manual", None)
            except Exception as exc:  # pragma: no cover - asserted below
                outcome = ("manual", exc)
            finally:
                close_old_connections()
                connections.close_all()
            with outcome_lock:
                outcomes.append(outcome)

        def run_ai_confirm():
            close_old_connections()
            try:
                actor = type(payer).objects.get(pk=payer.id)
                barrier.wait(timeout=5)
                confirm_action_draft(
                    draft_id=draft.id,
                    trip_id=trip.id,
                    actor=actor,
                )
                outcome = ("ai", None)
            except Exception as exc:  # pragma: no cover - asserted below
                outcome = ("ai", exc)
            finally:
                close_old_connections()
                connections.close_all()
            with outcome_lock:
                outcomes.append(outcome)

        with patch("ai.chat_changes.push_chat_message"):
            threads = [
                threading.Thread(target=run_manual_mark),
                threading.Thread(target=run_ai_confirm),
            ]
            for thread in threads:
                thread.start()
            barrier.wait(timeout=5)
            for thread in threads:
                thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual([error for _, error in outcomes], [None, None])
        draft.refresh_from_db()
        transfer.refresh_from_db()
        trip.refresh_from_db()
        response_message.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.CONFIRMED)
        self.assertIsNotNone(transfer.payer_marked_sent_at)
        self.assertEqual(trip.chat_change_sequence, 2)
        self.assertEqual(response_message.change_sequence, 2)
