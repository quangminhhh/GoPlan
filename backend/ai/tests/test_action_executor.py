from __future__ import annotations

from datetime import date, time, timedelta
from decimal import Decimal
from unittest.mock import patch
from uuid import uuid4

from django.db import OperationalError
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from ai.action_types import (
    AI_CONFIRMATION_CAPTAIN,
    AI_CONFIRMATION_TRANSFER_PAYER,
    AI_CONFIRMATION_TRANSFER_RECIPIENT,
)
from ai.agent.executor import (
    AIActionDraftNotReadyError,
    AIActionDraftStaleError,
    _check_preconditions,
    confirm_action_draft,
    mark_action_draft_failed,
)
from ai.models import (
    AIActionDraft,
    AIActionDraftStatus,
    AIInteraction,
    AIInteractionStatus,
)
from chat.models import ChatMessage, ChatMessageSenderKind
from expenses.models import Expense, ExpenseContribution
from expenses.services import create_expense, finalize_settlement, set_contribution
from test_helpers import create_completed_user
from trips.models import (
    MemberStatus,
    TimelineActivity,
    TimelineLocationMode,
    TimelineSection,
    TimelineActivityTimeMode,
    TimelineSystemType,
    Trip,
    TripMember,
    TripRole,
    TripStatus,
)
from trips.services import create_trip


class ActionExecutorTests(TestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "exec-captain@example.com",
            "execcap",
            "EXE001",
        )
        self.trip = create_trip(
            captain=self.captain,
            name="Executor Trip",
            destination="Da Nang",
            start_date="2026-06-01",
            end_date="2026-06-02",
        )
        self.prompt = ChatMessage.objects.create(
            trip=self.trip,
            sender=self.captain,
            sender_display_name_snapshot=self.captain.display_name,
            sender_identify_tag_snapshot=self.captain.identify_tag,
            content="@GoPlanAI create dinner expense",
            client_message_id=uuid4(),
        )
        self.response = ChatMessage.objects.create(
            trip=self.trip,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            content="I prepared a draft.",
        )
        self.interaction = AIInteraction.objects.create(
            trip=self.trip,
            requested_by=self.captain,
            prompt_message=self.prompt,
            prompt="create dinner expense",
            status=AIInteractionStatus.SUCCEEDED,
            lock_expires_at=timezone.now() + timedelta(minutes=2),
        )

    def _expense_create_draft(self):
        return AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "title": "Dinner",
                "description": "",
                "total_amount": "1200000",
                "collector_id": str(self.captain.id),
            },
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

    def _expense_preconditions(self, expense: Expense) -> dict:
        return {
            "target": {
                "type": "expense",
                "id": str(expense.id),
                "updated_at": expense.updated_at.isoformat(),
            }
        }

    @patch("ai.chat_changes.push_chat_message")
    def test_terminal_trip_skips_failure_bookkeeping(self, push_chat_message):
        draft = self._expense_create_draft()

        for terminal_status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
            with self.subTest(trip_status=terminal_status):
                self.trip.status = terminal_status
                self.trip.save(update_fields=["status"])
                draft.refresh_from_db()
                self.response.refresh_from_db()
                self.trip.refresh_from_db()
                draft_updated_at = draft.updated_at
                response_updated_at = self.response.updated_at
                trip_sequence = self.trip.chat_change_sequence
                response_sequence = self.response.change_sequence

                with self.captureOnCommitCallbacks(execute=False) as callbacks:
                    returned = mark_action_draft_failed(
                        draft_id=draft.id,
                        trip_id=self.trip.id,
                        error_code="AI_DRAFT_STALE",
                        error_detail="Target changed.",
                    )

                self.assertIsNotNone(returned)
                self.assertEqual(returned.status, AIActionDraftStatus.READY)
                draft.refresh_from_db()
                self.response.refresh_from_db()
                self.trip.refresh_from_db()
                self.assertEqual(draft.status, AIActionDraftStatus.READY)
                self.assertEqual(draft.error_code, "")
                self.assertEqual(draft.error_detail, "")
                self.assertEqual(draft.updated_at, draft_updated_at)
                self.assertEqual(self.response.updated_at, response_updated_at)
                self.assertEqual(self.trip.chat_change_sequence, trip_sequence)
                self.assertEqual(self.response.change_sequence, response_sequence)
                self.assertEqual(callbacks, [])
                push_chat_message.assert_not_called()

    def test_confirm_expense_create_executes_once(self):
        draft = self._expense_create_draft()

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        self.assertEqual(confirmed.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(Expense.objects.count(), 1)
        self.assertEqual(confirmed.result["object_type"], "expense")

    def test_confirm_expense_create_rejects_legacy_currency_mismatch(self):
        draft = self._expense_create_draft()
        draft.payload = {**draft.payload, "currency_code": "USD"}
        draft.save(update_fields=["payload", "updated_at"])

        with self.assertRaisesMessage(
            AIActionDraftNotReadyError,
            "Draft currency does not match the trip currency.",
        ):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertFalse(Expense.objects.exists())

    def test_confirm_expense_create_rejects_legacy_invalid_amount(self):
        draft = self._expense_create_draft()
        draft.payload = {**draft.payload, "total_amount": "25.50"}
        draft.save(update_fields=["payload", "updated_at"])

        with self.assertRaisesMessage(
            AIActionDraftNotReadyError,
            "Draft is missing required field: total_amount.",
        ):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertFalse(Expense.objects.exists())

    def test_confirm_expense_contribution_set_accepts_batch_contributions(self):
        member = create_completed_user(
            "exec-batch-member@example.com",
            "execbatch",
            "EXE003",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.contribution.set",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "expense_id": str(expense.id),
                "contributions": [
                    {"member_id": str(self.captain.id), "amount": "600000"},
                    {"member_id": str(member.id), "amount": "600000"},
                ],
            },
            preview={"summary": "Everyone paid"},
            missing_fields=[],
            preconditions=self._expense_preconditions(expense),
            expires_at=timezone.now() + timedelta(hours=24),
        )

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        contributions = {
            contribution.user_id: contribution.amount
            for contribution in ExpenseContribution.objects.filter(expense=expense)
        }
        self.assertEqual(confirmed.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(contributions[self.captain.id], Decimal("600000"))
        self.assertEqual(contributions[member.id], Decimal("600000"))
        self.assertEqual(confirmed.result["object_type"], "expense_contribution_batch")
        self.assertEqual(confirmed.result["updated_count"], 2)

    def test_confirm_contribution_rejects_legacy_decimalfield_overflow(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.contribution.set",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "expense_id": str(expense.id),
                "contributions": [
                    {
                        "user_id": str(self.captain.id),
                        "amount": "1000000000000",
                    }
                ],
            },
            preview={"summary": "Captain paid"},
            missing_fields=[],
            preconditions=self._expense_preconditions(expense),
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.assertRaisesMessage(
            AIActionDraftNotReadyError,
            "Draft is missing required field: contributions.",
        ):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertFalse(ExpenseContribution.objects.exists())

    def test_confirm_expense_contribution_set_accepts_member_contributions_map(self):
        member = create_completed_user(
            "exec-map-member@example.com",
            "execmap",
            "EXE004",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.contribution.set",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "expense_id": str(expense.id),
                "member_contributions": {
                    str(self.captain.id): {
                        "member_id": str(self.captain.id),
                        "paid_amount": "600000",
                    },
                    str(member.id): {
                        "member_id": str(member.id),
                        "paid_amount": "600000",
                    },
                },
            },
            preview={"summary": "Everyone paid"},
            missing_fields=[],
            preconditions=self._expense_preconditions(expense),
            expires_at=timezone.now() + timedelta(hours=24),
        )

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        contributions = {
            contribution.user_id: contribution.amount
            for contribution in ExpenseContribution.objects.filter(expense=expense)
        }
        self.assertEqual(confirmed.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(contributions[self.captain.id], Decimal("600000"))
        self.assertEqual(contributions[member.id], Decimal("600000"))
        self.assertEqual(confirmed.result["updated_count"], 2)

    def test_confirm_expense_contribution_set_can_mark_all_participants_paid(self):
        member = create_completed_user(
            "exec-share-member@example.com",
            "execshare",
            "EXE005",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.contribution.set",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "expense_id": str(expense.id),
                "scope": "all_participants_paid",
            },
            preview={"summary": "Everyone paid"},
            missing_fields=[],
            preconditions=self._expense_preconditions(expense),
            expires_at=timezone.now() + timedelta(hours=24),
        )

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        contributions = {
            contribution.user_id: contribution.amount
            for contribution in ExpenseContribution.objects.filter(expense=expense)
        }
        self.assertEqual(contributions[self.captain.id], Decimal("600000"))
        self.assertEqual(contributions[member.id], Decimal("600000"))
        self.assertEqual(confirmed.result["updated_count"], 2)

    def test_mark_all_participants_paid_uses_exact_odd_shares(self):
        member = create_completed_user(
            "exec-share-odd-member@example.com",
            "execshareodd",
            "EXE006",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Odd Dinner",
            total_amount=Decimal("100003"),
            collector=self.captain,
        )
        shares = {
            participant.user_id: participant.share_amount
            for participant in expense.participants.all()
        }
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.contribution.set",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "expense_id": str(expense.id),
                "scope": "all_participants_paid",
            },
            preview={"summary": "Everyone paid"},
            missing_fields=[],
            preconditions=self._expense_preconditions(expense),
            expires_at=timezone.now() + timedelta(hours=24),
        )

        confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        contributions = {
            contribution.user_id: contribution.amount
            for contribution in ExpenseContribution.objects.filter(expense=expense)
        }
        self.assertEqual(contributions, shares)

    def test_stale_expense_contribution_set_draft_is_rejected(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        stale_preconditions = self._expense_preconditions(expense)
        expense.title = "Dinner updated elsewhere"
        expense.save(update_fields=["title", "updated_at"])
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.contribution.set",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "expense_id": str(expense.id),
                "user_id": str(self.captain.id),
                "amount": "1200000",
            },
            preview={"summary": "Captain paid"},
            missing_fields=[],
            preconditions=stale_preconditions,
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.assertRaises(AIActionDraftStaleError):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

    def test_double_confirm_does_not_create_duplicate_expense(self):
        draft = self._expense_create_draft()

        confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )
        confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        self.assertEqual(Expense.objects.count(), 1)

    def test_stale_expense_update_draft_is_rejected(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        stale_timestamp = expense.updated_at.isoformat()
        expense.title = "Dinner updated elsewhere"
        expense.save(update_fields=["title", "updated_at"])
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"expense_id": str(expense.id), "title": "Dinner from AI"},
            preview={"title": "Dinner from AI"},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "expense",
                    "id": str(expense.id),
                    "updated_at": stale_timestamp,
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.assertRaises(AIActionDraftStaleError):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

    def test_mismatched_stale_precondition_target_is_rejected(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        other_expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Lunch",
            total_amount=Decimal("500000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"expense_id": str(expense.id), "title": "Dinner from AI"},
            preview={"title": "Dinner from AI"},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "expense",
                    "id": str(other_expense.id),
                    "updated_at": other_expense.updated_at.isoformat(),
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.assertRaises(AIActionDraftStaleError):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

    def test_missing_required_stale_precondition_is_rejected(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"expense_id": str(expense.id), "title": "Dinner from AI"},
            preview={"title": "Dinner from AI"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.assertRaises(AIActionDraftStaleError):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

    def test_confirm_expense_update_without_changes_raises_not_ready(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"expense_id": str(expense.id)},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "expense",
                    "id": str(expense.id),
                    "updated_at": expense.updated_at.isoformat(),
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.assertRaises(AIActionDraftNotReadyError):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.result, {})

    def test_precondition_check_locks_expense_target(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"expense_id": str(expense.id), "title": "Dinner from AI"},
            preview={"title": "Dinner from AI"},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "expense",
                    "id": str(expense.id),
                    "updated_at": expense.updated_at.isoformat(),
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with patch.object(
            Expense.objects,
            "select_for_update",
            wraps=Expense.objects.select_for_update,
        ) as select_for_update:
            _check_preconditions(draft)

        select_for_update.assert_called_once()

    def test_confirm_locks_trip_context_before_expense_precondition_target(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"expense_id": str(expense.id), "title": "Dinner from AI"},
            preview={"title": "Dinner from AI"},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "expense",
                    "id": str(expense.id),
                    "updated_at": expense.updated_at.isoformat(),
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )
        lock_order = []
        trip_select_for_update = Trip.objects.select_for_update
        expense_select_for_update = Expense.objects.select_for_update

        def record_trip_lock(*args, **kwargs):
            lock_order.append("trip")
            return trip_select_for_update(*args, **kwargs)

        def record_expense_lock(*args, **kwargs):
            lock_order.append("expense")
            return expense_select_for_update(*args, **kwargs)

        with (
            patch.object(
                Trip.objects,
                "select_for_update",
                side_effect=record_trip_lock,
            ),
            patch.object(
                Expense.objects,
                "select_for_update",
                side_effect=record_expense_lock,
            ),
        ):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

        self.assertLess(lock_order.index("trip"), lock_order.index("expense"))

    def test_confirm_missing_required_payload_raises_not_ready(self):
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="timeline.activity.status.update",
            status=AIActionDraftStatus.READY,
            required_confirmation="TIMELINE_ACTIVITY_STATUS",
            payload={"activity_id": "activity-1"},
            preview={"title": "Status update"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.assertRaises(AIActionDraftNotReadyError):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

    def test_confirm_rejects_invalid_target_merged_timeline_patch_without_mutation(self):
        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Merged clock target",
            time_mode=TimelineActivityTimeMode.TIME_RANGE,
            start_time=time(10, 0),
            end_time=time(11, 0),
            system_type=TimelineSystemType.SIGHTSEEING,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="timeline.activity.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "activity_id": str(activity.id),
                "data": {"end_time": "09:00:00"},
            },
            preview={"title": activity.title},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "timeline_activity",
                    "id": str(activity.id),
                    "updated_at": activity.updated_at.isoformat(),
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )
        original_trip_sequence = self.trip.chat_change_sequence
        original_message_sequence = self.response.change_sequence

        with self.assertRaises(AIActionDraftNotReadyError):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

        activity.refresh_from_db()
        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.response.refresh_from_db()
        self.assertEqual(activity.start_time, time(10, 0))
        self.assertEqual(activity.end_time, time(11, 0))
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(self.trip.chat_change_sequence, original_trip_sequence)
        self.assertEqual(self.response.change_sequence, original_message_sequence)

    def test_stale_precondition_precedes_invalid_target_merged_timeline_patch(self):
        section = self.trip.timeline_sections.order_by("section_date").first()
        activity = section.activities.create(
            trip=self.trip,
            title="Stale merged target",
            time_mode=TimelineActivityTimeMode.TIME_RANGE,
            start_time=time(10, 0),
            end_time=time(11, 0),
            system_type=TimelineSystemType.SIGHTSEEING,
        )
        stale_updated_at = activity.updated_at.isoformat()
        activity.title = "Changed elsewhere"
        activity.save(update_fields=["title", "updated_at"])
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="timeline.activity.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "activity_id": str(activity.id),
                "data": {"end_time": "09:00:00"},
            },
            preview={"title": "Stale merged target"},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "timeline_activity",
                    "id": str(activity.id),
                    "updated_at": stale_updated_at,
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.assertRaises(AIActionDraftStaleError):
            confirm_action_draft(
                draft_id=draft.id,
                trip_id=self.trip.id,
                actor=self.captain,
            )

    def test_confirm_timeline_activity_create_uses_timeline_service(self):
        section = self.trip.timeline_sections.order_by("section_date").first()
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "section_id": str(section.id),
                "data": {
                    "title": "Museum",
                    "time_mode": TimelineActivityTimeMode.FLEXIBLE,
                    "system_type": TimelineSystemType.SIGHTSEEING,
                    "reminder_offsets_minutes": [],
                },
            },
            preview={"title": "Museum"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        self.assertEqual(confirmed.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(TimelineActivity.objects.count(), 1)
        self.assertEqual(confirmed.result["object_type"], "timeline_activity")

    def test_confirm_timeline_activity_create_rejects_legacy_untrusted_references(self):
        from trips.models import TimelineCustomType

        section = self.trip.timeline_sections.order_by("section_date").first()
        other_trip = create_trip(
            captain=self.captain,
            name="Executor Foreign Trip",
            destination="Hue",
            start_date="2026-08-01",
            end_date="2026-08-02",
        )
        foreign_section = other_trip.timeline_sections.order_by("section_date").first()
        foreign_custom = TimelineCustomType.objects.create(
            trip=other_trip,
            name="Executor foreign custom",
            normalized_name="executor-foreign-custom",
            created_by=self.captain,
        )
        left_assignee = create_completed_user(
            "exec-left-assignee@example.com",
            "execleftassignee",
            "EXE002",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=left_assignee,
            role=TripRole.MEMBER,
            status=MemberStatus.LEFT,
        )

        cases = (
            {
                "section_id": str(uuid4()),
                "data": {
                    "title": "Missing section",
                    "time_mode": "FLEXIBLE",
                    "system_type": "SIGHTSEEING",
                },
            },
            {
                "section_id": str(foreign_section.id),
                "data": {
                    "title": "Foreign section",
                    "time_mode": "FLEXIBLE",
                    "system_type": "SIGHTSEEING",
                },
            },
            {
                "section_id": str(section.id),
                "data": {
                    "title": "Foreign custom",
                    "time_mode": "FLEXIBLE",
                    "custom_type_id": str(foreign_custom.id),
                },
            },
            {
                "section_id": str(section.id),
                "data": {
                    "title": "Inactive assignee",
                    "time_mode": "FLEXIBLE",
                    "system_type": "SIGHTSEEING",
                    "assignee_scope": "USER",
                    "assignee_user_id": str(left_assignee.id),
                },
            },
        )
        original_trip_sequence = self.trip.chat_change_sequence
        original_message_sequence = self.response.change_sequence

        for payload in cases:
            with self.subTest(title=payload["data"]["title"]):
                draft = AIActionDraft.objects.create(
                    trip=self.trip,
                    interaction=self.interaction,
                    response_message=self.response,
                    requested_by=self.captain,
                    action_type="timeline.activity.create",
                    status=AIActionDraftStatus.READY,
                    required_confirmation=AI_CONFIRMATION_CAPTAIN,
                    payload=payload,
                    preview={"title": payload["data"]["title"]},
                    missing_fields=[],
                    preconditions={},
                    expires_at=timezone.now() + timedelta(hours=24),
                )

                with self.assertRaises(AIActionDraftNotReadyError):
                    confirm_action_draft(
                        draft_id=draft.id,
                        trip_id=self.trip.id,
                        actor=self.captain,
                    )

                draft.refresh_from_db()
                self.trip.refresh_from_db()
                self.response.refresh_from_db()
                self.assertEqual(draft.status, AIActionDraftStatus.READY)
                self.assertFalse(
                    TimelineActivity.objects.filter(
                        trip=self.trip,
                        title=payload["data"]["title"],
                    ).exists()
                )
                self.assertEqual(
                    self.trip.chat_change_sequence,
                    original_trip_sequence,
                )
                self.assertEqual(
                    self.response.change_sequence,
                    original_message_sequence,
                )

    def test_confirm_timeline_activity_create_creates_missing_section_date(self):
        trip = create_trip(
            captain=self.captain,
            name="Three Day Trip",
            destination="Da Lat",
            start_date=date(2026, 6, 1),
            end_date=date(2026, 6, 3),
        )
        prompt = ChatMessage.objects.create(
            trip=trip,
            sender=self.captain,
            sender_display_name_snapshot=self.captain.display_name,
            sender_identify_tag_snapshot=self.captain.identify_tag,
            content="@GoPlanAI add day three activity",
            client_message_id=uuid4(),
        )
        ai_response = ChatMessage.objects.create(
            trip=trip,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            content="I prepared a draft.",
        )
        interaction = AIInteraction.objects.create(
            trip=trip,
            requested_by=self.captain,
            prompt_message=prompt,
            prompt="add day three activity",
            status=AIInteractionStatus.SUCCEEDED,
            lock_expires_at=timezone.now() + timedelta(minutes=2),
        )
        draft = AIActionDraft.objects.create(
            trip=trip,
            interaction=interaction,
            response_message=ai_response,
            requested_by=self.captain,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "section_date": "2026-06-03",
                "data": {
                    "title": "Langfarm stop",
                    "system_type": "SHOPPING",
                    "time_mode": "FLEXIBLE",
                },
            },
            preview={"title": "Langfarm stop"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )
        self.assertFalse(
            TimelineSection.objects.filter(
                trip=trip,
                section_date=date(2026, 6, 3),
            ).exists()
        )

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=trip.id,
            actor=self.captain,
        )

        activity = TimelineActivity.objects.get(pk=confirmed.result["object_id"])
        self.assertEqual(activity.title, "Langfarm stop")
        self.assertEqual(activity.section.section_date, date(2026, 6, 3))

    def test_confirm_timeline_activity_create_accepts_legacy_top_level_payload(self):
        section = self.trip.timeline_sections.order_by("section_date").first()
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "section_id": str(section.id),
                "title": "Legacy museum",
                "time_mode": TimelineActivityTimeMode.TIME_RANGE,
                "start_time": "2026-04-20T15:45:00+07:00",
                "end_time": "2026-04-20T17:30:00+07:00",
                "system_type": "DINING",
                "assignee_scope": "GROUP",
                "reminder_offsets_minutes": [],
            },
            preview={"title": "Legacy museum"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        self.assertEqual(confirmed.status, AIActionDraftStatus.CONFIRMED)
        self.assertEqual(
            TimelineActivity.objects.get().title,
            "Legacy museum",
        )
        self.assertNotIn("title", confirmed.payload)
        self.assertEqual(confirmed.payload["data"]["title"], "Legacy museum")
        self.assertEqual(confirmed.payload["data"]["start_time"], "15:45:00")
        self.assertEqual(confirmed.payload["data"]["end_time"], "17:30:00")
        self.assertEqual(confirmed.payload["data"]["system_type"], TimelineSystemType.FOOD)
        self.assertEqual(confirmed.payload["data"]["assignee_scope"], "EVERYONE")

    def test_confirm_timeline_activity_create_accepts_structured_location_data(self):
        section = self.trip.timeline_sections.order_by("section_date").first()
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "section_id": str(section.id),
                "data": {
                    "title": "Beach walk",
                    "time_mode": TimelineActivityTimeMode.TIME_RANGE,
                    "start_time": "15:30",
                    "end_time": "17:00",
                    "system_type": TimelineSystemType.SIGHTSEEING,
                    "location_mode": TimelineLocationMode.STRUCTURED,
                    "location_label": "Bãi Sau, Vũng Tàu",
                    "place": {
                        "provider": "here",
                        "provider_id": "place-1",
                        "title": "Bãi Sau",
                        "address": "Vũng Tàu",
                        "lat": 10.345,
                        "lng": 107.085,
                    },
                    "reminder_offsets_minutes": [],
                },
            },
            preview={"title": "Beach walk"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        confirmed = confirm_action_draft(
            draft_id=draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        activity = TimelineActivity.objects.get(pk=confirmed.result["object_id"])
        self.assertEqual(activity.system_type, TimelineSystemType.SIGHTSEEING)
        self.assertEqual(activity.location_mode, TimelineLocationMode.STRUCTURED)
        self.assertEqual(activity.location_label, "Bãi Sau, Vũng Tàu")

    def test_confirm_settlement_finalize_and_reopen_use_expense_services(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.captain.id,
            actor=self.captain,
            amount=Decimal("1200000"),
        )
        finalize_draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="settlement.finalize",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={},
            preview={"title": "Finalize settlement"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        finalized = confirm_action_draft(
            draft_id=finalize_draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        self.assertEqual(finalized.result["object_type"], "settlement")

        reopen_draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="settlement.reopen",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={},
            preview={"title": "Reopen settlement"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        reopened = confirm_action_draft(
            draft_id=reopen_draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        self.assertEqual(reopened.result["status"], "REOPENED")

    def test_confirm_transfer_actions_use_transfer_party_permissions(self):
        member = create_completed_user(
            "exec-member@example.com",
            "execmem",
            "EXE002",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("100000"),
            collector=self.captain,
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.captain.id,
            actor=self.captain,
            amount=Decimal("100000"),
        )
        settlement = finalize_settlement(trip_id=self.trip.id, actor=self.captain)
        transfer = settlement.transfers.get()
        mark_sent_draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="settlement.transfer.mark_sent",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_TRANSFER_PAYER,
            payload={"transfer_id": str(transfer.id)},
            preview={"title": "Mark sent"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        marked = confirm_action_draft(
            draft_id=mark_sent_draft.id,
            trip_id=self.trip.id,
            actor=member,
        )

        self.assertEqual(marked.result["object_type"], "settlement_transfer")

        received_draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="settlement.transfer.confirm_received",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_TRANSFER_RECIPIENT,
            payload={"transfer_id": str(transfer.id)},
            preview={"title": "Confirm received"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        received = confirm_action_draft(
            draft_id=received_draft.id,
            trip_id=self.trip.id,
            actor=self.captain,
        )

        self.assertEqual(received.result["object_type"], "settlement_transfer")


class ActionDraftConfirmAPITests(APITestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "confirm-api-captain@example.com",
            "confirmapi",
            "CAP001",
        )
        self.trip = create_trip(
            captain=self.captain,
            name="Confirm API Trip",
            destination="Da Nang",
            start_date="2026-06-01",
            end_date="2026-06-02",
        )
        self.prompt = ChatMessage.objects.create(
            trip=self.trip,
            sender=self.captain,
            sender_display_name_snapshot=self.captain.display_name,
            sender_identify_tag_snapshot=self.captain.identify_tag,
            content="@GoPlanAI update dinner",
            client_message_id=uuid4(),
        )
        self.response = ChatMessage.objects.create(
            trip=self.trip,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            content="I prepared a draft.",
        )
        self.interaction = AIInteraction.objects.create(
            trip=self.trip,
            requested_by=self.captain,
            prompt_message=self.prompt,
            prompt="update dinner",
            status=AIInteractionStatus.SUCCEEDED,
            lock_expires_at=timezone.now() + timedelta(minutes=2),
        )

    def _confirm_url(self, draft_id):
        return f"/api/trips/{self.trip.id}/ai/action-drafts/{draft_id}/confirm"

    @patch("ai.chat_changes.push_chat_message")
    def test_terminal_trip_rejects_confirm_without_mutating_draft(
        self,
        push_chat_message,
    ):
        self.client.force_authenticate(self.captain)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"title": "Dinner", "total_amount": "1200000"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        for terminal_status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
            for expired in (False, True):
                with self.subTest(
                    trip_status=terminal_status,
                    expired=expired,
                ):
                    self.trip.status = terminal_status
                    self.trip.save(update_fields=["status"])
                    draft.expires_at = timezone.now() + (
                        -timedelta(seconds=1)
                        if expired
                        else timedelta(hours=24)
                    )
                    draft.save(update_fields=["expires_at"])
                    draft.refresh_from_db()
                    self.response.refresh_from_db()
                    self.trip.refresh_from_db()
                    draft_updated_at = draft.updated_at
                    response_updated_at = self.response.updated_at
                    trip_sequence = self.trip.chat_change_sequence
                    response_sequence = self.response.change_sequence

                    with self.captureOnCommitCallbacks(execute=False) as callbacks:
                        response = self.client.post(self._confirm_url(draft.id))

                    self.assertEqual(response.status_code, 409)
                    self.assertEqual(
                        response.data,
                        {
                            "detail": "Completed or cancelled trips are read-only.",
                            "error_code": "TRIP_TERMINAL",
                        },
                    )
                    draft.refresh_from_db()
                    self.response.refresh_from_db()
                    self.trip.refresh_from_db()
                    self.assertEqual(draft.status, AIActionDraftStatus.READY)
                    self.assertIsNone(draft.confirmed_by_id)
                    self.assertIsNone(draft.confirmed_at)
                    self.assertEqual(draft.result, {})
                    self.assertEqual(draft.error_code, "")
                    self.assertEqual(draft.error_detail, "")
                    self.assertEqual(draft.updated_at, draft_updated_at)
                    self.assertEqual(self.response.updated_at, response_updated_at)
                    self.assertEqual(self.trip.chat_change_sequence, trip_sequence)
                    self.assertEqual(self.response.change_sequence, response_sequence)
                    self.assertEqual(callbacks, [])
                    push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    @patch(
        "ai.views.confirm_action_draft",
        side_effect=OperationalError("deadlock detected"),
    )
    def test_transient_database_error_does_not_persist_failed_draft(
        self,
        confirm_action_draft_mock,
        push_chat_message,
    ):
        self.client.force_authenticate(self.captain)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"title": "Dinner", "total_amount": "1200000"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )
        draft_updated_at = draft.updated_at
        message_updated_at = self.response.updated_at

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.client.post(self._confirm_url(draft.id))

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.data,
            {
                "detail": "Draft execution failed.",
                "error_code": "AI_DRAFT_EXECUTION_FAILED",
            },
        )
        confirm_action_draft_mock.assert_called_once()
        draft.refresh_from_db()
        self.trip.refresh_from_db()
        self.response.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.error_code, "")
        self.assertEqual(draft.error_detail, "")
        self.assertEqual(draft.updated_at, draft_updated_at)
        self.assertEqual(self.trip.chat_change_sequence, 0)
        self.assertEqual(self.response.change_sequence, 0)
        self.assertEqual(self.response.updated_at, message_updated_at)
        self.assertEqual(callbacks, [])
        push_chat_message.assert_not_called()

    @patch("ai.chat_changes.push_chat_message")
    def test_confirm_timeline_activity_create_returns_confirmed_draft(
        self,
        push_chat_message,
    ):
        self.client.force_authenticate(self.captain)
        trip = create_trip(
            captain=self.captain,
            name="Confirm Timeline Trip",
            destination="Da Lat",
            start_date=date(2026, 6, 1),
            end_date=date(2026, 6, 3),
        )
        prompt = ChatMessage.objects.create(
            trip=trip,
            sender=self.captain,
            sender_display_name_snapshot=self.captain.display_name,
            sender_identify_tag_snapshot=self.captain.identify_tag,
            content="@GoPlanAI add day three activity",
            client_message_id=uuid4(),
        )
        ai_response = ChatMessage.objects.create(
            trip=trip,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            content="I prepared a draft.",
        )
        interaction = AIInteraction.objects.create(
            trip=trip,
            requested_by=self.captain,
            prompt_message=prompt,
            prompt="add day three activity",
            status=AIInteractionStatus.SUCCEEDED,
            lock_expires_at=timezone.now() + timedelta(minutes=2),
        )
        draft = AIActionDraft.objects.create(
            trip=trip,
            interaction=interaction,
            response_message=ai_response,
            requested_by=self.captain,
            action_type="timeline.activity.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "section_date": "2026-06-03",
                "data": {
                    "title": "Langfarm stop",
                    "system_type": "SHOPPING",
                    "time_mode": "FLEXIBLE",
                },
            },
            preview={"title": "Langfarm stop"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )
        self.assertFalse(
            TimelineSection.objects.filter(
                trip=trip,
                section_date=date(2026, 6, 3),
            ).exists()
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                f"/api/trips/{trip.id}/ai/action-drafts/{draft.id}/confirm"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["draft"]["status"],
            AIActionDraftStatus.CONFIRMED,
        )
        self.assertFalse(response.data["draft"]["can_confirm"])
        self.assertFalse(response.data["draft"]["can_cancel"])
        section = TimelineSection.objects.get(
            trip=trip,
            section_date=date(2026, 6, 3),
        )
        activity = TimelineActivity.objects.get(section=section)
        self.assertEqual(activity.title, "Langfarm stop")
        self.assertEqual(
            response.data["draft"]["result"],
            {
                "object_type": "timeline_activity",
                "object_id": str(activity.id),
            },
        )
        push_chat_message.assert_called_once_with(ai_response)

    def test_stale_confirm_failure_is_persisted_on_draft(self):
        self.client.force_authenticate(self.captain)
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        stale_timestamp = expense.updated_at.isoformat()
        expense.title = "Changed elsewhere"
        expense.save(update_fields=["title", "updated_at"])
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.update",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"expense_id": str(expense.id), "title": "Dinner from AI"},
            preview={"title": "Dinner from AI"},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "expense",
                    "id": str(expense.id),
                    "updated_at": stale_timestamp,
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(self._confirm_url(draft.id))

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["draft"]["status"], AIActionDraftStatus.FAILED)
        self.assertEqual(response.data["draft"]["error_code"], "AI_DRAFT_STALE")
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.FAILED)
        self.assertEqual(draft.error_code, "AI_DRAFT_STALE")
        self.assertIn("changed", draft.error_detail)

    @patch("ai.chat_changes.push_chat_message")
    def test_expired_confirm_response_includes_updated_draft(self, push_chat_message):
        self.client.force_authenticate(self.captain)
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.create",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={"title": "Dinner", "total_amount": "1200000"},
            preview={"title": "Dinner"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(self._confirm_url(draft.id))

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_EXPIRED")
        self.assertEqual(response.data["draft"]["status"], AIActionDraftStatus.EXPIRED)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.EXPIRED)
        push_chat_message.assert_called_once_with(self.response)

    def test_not_ready_confirm_failure_is_not_persisted_as_failed(self):
        self.client.force_authenticate(self.captain)
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("1200000"),
            collector=self.captain,
        )
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="expense.contribution.set",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_CAPTAIN,
            payload={
                "expense_id": str(expense.id),
                "contributions": [{"user_id": str(self.captain.id)}],
            },
            preview={"title": "Mark paid"},
            missing_fields=[],
            preconditions={
                "target": {
                    "type": "expense",
                    "id": str(expense.id),
                    "updated_at": expense.updated_at.isoformat(),
                }
            },
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.post(self._confirm_url(draft.id))

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "AI_DRAFT_NOT_READY")
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.error_code, "")

    def test_confirm_received_before_transfer_sent_does_not_fail_draft(self):
        self.client.force_authenticate(self.captain)
        member = create_completed_user(
            "confirm-api-member@example.com",
            "confirmmem",
            "CAP002",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("100000"),
            collector=self.captain,
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.captain.id,
            actor=self.captain,
            amount=Decimal("100000"),
        )
        settlement = finalize_settlement(trip_id=self.trip.id, actor=self.captain)
        transfer = settlement.transfers.get()
        draft = AIActionDraft.objects.create(
            trip=self.trip,
            interaction=self.interaction,
            response_message=self.response,
            requested_by=self.captain,
            action_type="settlement.transfer.confirm_received",
            status=AIActionDraftStatus.READY,
            required_confirmation=AI_CONFIRMATION_TRANSFER_RECIPIENT,
            payload={"transfer_id": str(transfer.id)},
            preview={"title": "Confirm received"},
            missing_fields=[],
            preconditions={},
            expires_at=timezone.now() + timedelta(hours=24),
        )

        response = self.client.post(self._confirm_url(draft.id))

        self.assertEqual(response.status_code, 403)
        draft.refresh_from_db()
        self.assertEqual(draft.status, AIActionDraftStatus.READY)
        self.assertEqual(draft.error_code, "")
