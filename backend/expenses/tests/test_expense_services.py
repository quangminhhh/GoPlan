from __future__ import annotations

import uuid
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from expenses.models import (
    Expense,
    ExpenseContribution,
    ExpenseLedgerEntry,
    ExpenseLedgerEventType,
    ExpenseParticipant,
)
from expenses.services import (
    _get_member_trip,
    CollectorNotParticipantError,
    ContributionUserNotParticipantError,
    ExpenseLockedError,
    ExpenseServiceError,
    SettlementAlreadyFinalizedError,
    build_expense_dashboard,
    create_expense,
    delete_expense,
    finalize_settlement,
    reopen_settlement,
    set_contribution,
    update_expense,
)
from test_helpers import create_completed_user
from trips.models import MemberStatus, Trip, TripMember, TripRole, TripStatus
from trips.services import TripCurrencyLockedError, TripNotFoundError, TripPermissionError, update_trip


def _make_trip(created_by, **kwargs):
    defaults = {
        "name": "Expense Trip",
        "destination": "Da Lat",
        "start_date": "2026-06-01",
        "end_date": "2026-06-05",
        "currency_code": "VND",
        "status": TripStatus.PLANNING,
    }
    defaults.update(kwargs)
    return Trip.objects.create(created_by=created_by, **defaults)


class ExpenseCreationServiceTests(TestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "captain@example.com",
            "captain",
            "CAP001",
            display_name="Captain E",
        )
        self.member = create_completed_user(
            "member@example.com",
            "member",
            "MEM001",
            display_name="Member E",
        )
        self.trip = _make_trip(self.captain)
        TripMember.objects.create(
            trip=self.trip,
            user=self.captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )
        TripMember.objects.create(
            trip=self.trip,
            user=self.member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

    def test_non_locking_member_trip_lookup_remains_a_single_query(self):
        with self.assertNumQueries(1):
            trip, membership = _get_member_trip(
                self.trip.id,
                self.captain,
                for_update=False,
            )

        self.assertEqual(trip.id, self.trip.id)
        self.assertEqual(membership.user_id, self.captain.id)

    def test_create_expense_snapshots_active_members_and_even_shares(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("600000"),
        )

        self.assertEqual(Expense.objects.count(), 1)
        self.assertEqual(expense.collector, self.captain)

        participants = list(ExpenseParticipant.objects.order_by("created_at"))
        self.assertEqual(len(participants), 2)
        self.assertEqual(
            [participant.share_amount for participant in participants],
            [Decimal("300000"), Decimal("300000")],
        )
        self.assertEqual(participants[0].display_name_snapshot, "Captain E")

    def test_rejects_vnd_fractional_minor_unit_without_creating_expense(self):
        with self.assertRaises(ExpenseServiceError):
            create_expense(
                trip_id=self.trip.id,
                actor=self.captain,
                title="Fractional Dinner",
                total_amount=Decimal("100.50"),
            )

        self.assertEqual(Expense.objects.count(), 0)
        self.assertEqual(ExpenseParticipant.objects.count(), 0)


    def test_vnd_remainder_split_is_deterministic(self):
        third_member = create_completed_user(
            "third@example.com",
            "third",
            "THD001",
            display_name="Third E",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=third_member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

        create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Shared Booking",
            total_amount=Decimal("1000000"),
        )

        participants = list(ExpenseParticipant.objects.order_by("created_at"))
        self.assertEqual(
            [participant.share_amount for participant in participants],
            [Decimal("333334"), Decimal("333333"), Decimal("333333")],
        )
        self.assertEqual(
            sum(participant.share_amount for participant in participants),
            Decimal("1000000"),
        )

    def test_departed_member_is_not_included_in_new_expense_snapshot(self):
        departed = create_completed_user(
            "departed@example.com",
            "departed",
            "DEP001",
            display_name="Departed E",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=departed,
            role=TripRole.MEMBER,
            status=MemberStatus.LEFT,
        )

        create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Active Members Only",
            total_amount=Decimal("600000"),
        )

        self.assertEqual(ExpenseParticipant.objects.count(), 2)
        self.assertFalse(ExpenseParticipant.objects.filter(user=departed).exists())

    def test_rejects_invalid_collector(self):
        outsider = create_completed_user(
            "outsider@example.com",
            "outsider",
            "OUT001",
            display_name="Outsider E",
        )

        with self.assertRaises(ExpenseServiceError):
            create_expense(
                trip_id=self.trip.id,
                actor=self.captain,
                title="Outsider Collector",
                total_amount=Decimal("600000"),
                collector=outsider,
            )

        self.assertEqual(Expense.objects.count(), 0)

    def test_rejects_departed_collector(self):
        departed = create_completed_user(
            "departed@example.com",
            "departed",
            "DEP001",
            display_name="Departed E",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=departed,
            role=TripRole.MEMBER,
            status=MemberStatus.LEFT,
        )

        with self.assertRaises(ExpenseServiceError):
            create_expense(
                trip_id=self.trip.id,
                actor=self.captain,
                title="Departed Collector",
                total_amount=Decimal("600000"),
                collector=departed,
            )

        self.assertEqual(Expense.objects.count(), 0)

    def test_creates_ledger_entry_for_expense_created(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("600000"),
        )

        ledger_entry = ExpenseLedgerEntry.objects.get()
        self.assertEqual(ledger_entry.trip, self.trip)
        self.assertEqual(ledger_entry.expense, expense)
        self.assertEqual(ledger_entry.actor, self.captain)
        self.assertEqual(ledger_entry.event_type, ExpenseLedgerEventType.EXPENSE_CREATED)

    def test_create_expense_with_explicit_active_member_collector(self):
        captain = create_completed_user(
            "second-captain@example.com",
            "secondcaptain",
            "SCAP01",
        )
        member = create_completed_user(
            "second-member@example.com",
            "secondmember",
            "SMEM01",
        )
        trip = _make_trip(captain, name="Second Expense Trip")
        TripMember.objects.create(
            trip=trip,
            user=captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )
        TripMember.objects.create(
            trip=trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

        expense = create_expense(
            trip_id=trip.id,
            actor=captain,
            title="Dinner",
            total_amount=Decimal("600000"),
            collector=member,
        )

        self.assertEqual(expense.collector, member)

    def test_create_expense_for_missing_trip_raises_trip_not_found(self):
        with self.assertRaises(TripNotFoundError):
            create_expense(
                trip_id=uuid.uuid4(),
                actor=self.captain,
                title="Missing Trip",
                total_amount=Decimal("600000"),
            )

        self.assertEqual(Expense.objects.count(), 0)

    def test_create_expense_after_finalize_raises_settlement_already_finalized(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Dinner",
            total_amount=Decimal("600000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.captain.id,
            actor=self.captain,
            amount=Decimal("600000"),
        )
        finalize_settlement(trip_id=self.trip.id, actor=self.captain)

        with self.assertRaises(SettlementAlreadyFinalizedError):
            create_expense(
                trip_id=self.trip.id,
                actor=self.captain,
                title="Late Booking",
                total_amount=Decimal("300000"),
            )

        self.assertEqual(Expense.objects.count(), 1)


class ExpenseContributionServiceTests(TestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "captain-contrib@example.com",
            "captaincontrib",
            "CCO001",
            display_name="Captain C",
        )
        self.member = create_completed_user(
            "member-contrib@example.com",
            "membercontrib",
            "MCO001",
            display_name="Member C",
        )
        self.trip = _make_trip(self.captain, name="Contribution Trip")
        TripMember.objects.create(
            trip=self.trip,
            user=self.captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )
        TripMember.objects.create(
            trip=self.trip,
            user=self.member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        self.expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Shared Dinner",
            total_amount=Decimal("600000"),
        )
        ExpenseLedgerEntry.objects.all().delete()

    def test_set_contribution_records_amount_and_ledger_entry(self):
        contribution = set_contribution(
            trip_id=self.trip.id,
            expense_id=self.expense.id,
            target_user_id=self.member.id,
            actor=self.captain,
            amount=Decimal("250000"),
        )

        self.assertEqual(contribution.expense, self.expense)
        self.assertEqual(contribution.user, self.member)
        self.assertEqual(contribution.amount, Decimal("250000"))
        self.assertEqual(contribution.updated_by, self.captain)

        ledger_entry = ExpenseLedgerEntry.objects.get()
        self.assertEqual(ledger_entry.trip, self.trip)
        self.assertEqual(ledger_entry.expense, self.expense)
        self.assertEqual(ledger_entry.actor, self.captain)
        self.assertEqual(ledger_entry.event_type, ExpenseLedgerEventType.CONTRIBUTION_SET)
        self.assertEqual(
            ledger_entry.payload,
            {"user_id": str(self.member.id), "amount": "250000"},
        )

    def test_updating_existing_contribution_replaces_amount_and_writes_ledger_event(self):
        first_contribution = set_contribution(
            trip_id=self.trip.id,
            expense_id=self.expense.id,
            target_user_id=self.member.id,
            actor=self.captain,
            amount=Decimal("250000"),
        )

        updated_contribution = set_contribution(
            trip_id=self.trip.id,
            expense_id=self.expense.id,
            target_user_id=self.member.id,
            actor=self.captain,
            amount=Decimal("400000"),
        )

        self.assertEqual(updated_contribution.id, first_contribution.id)
        self.assertEqual(ExpenseContribution.objects.count(), 1)
        self.assertEqual(updated_contribution.amount, Decimal("400000"))
        self.assertEqual(ExpenseLedgerEntry.objects.count(), 2)
        latest_entry = ExpenseLedgerEntry.objects.order_by("-created_at").first()
        self.assertEqual(latest_entry.event_type, ExpenseLedgerEventType.CONTRIBUTION_SET)
        self.assertEqual(
            latest_entry.payload,
            {"user_id": str(self.member.id), "amount": "400000"},
        )

    def test_set_contribution_allows_zero_amount(self):
        contribution = set_contribution(
            trip_id=self.trip.id,
            expense_id=self.expense.id,
            target_user_id=self.member.id,
            actor=self.captain,
            amount=Decimal("0"),
        )

        self.assertEqual(contribution.amount, Decimal("0"))

    def test_set_contribution_rejects_invalid_vnd_fractional_amount(self):
        with self.assertRaises(ExpenseServiceError):
            set_contribution(
                trip_id=self.trip.id,
                expense_id=self.expense.id,
                target_user_id=self.member.id,
                actor=self.captain,
                amount=Decimal("100.50"),
            )

        self.assertEqual(ExpenseContribution.objects.count(), 0)

    def test_set_contribution_rejects_negative_amount(self):
        with self.assertRaises(ExpenseServiceError):
            set_contribution(
                trip_id=self.trip.id,
                expense_id=self.expense.id,
                target_user_id=self.member.id,
                actor=self.captain,
                amount=Decimal("-1"),
            )

        self.assertEqual(ExpenseContribution.objects.count(), 0)

    def test_non_captain_active_member_cannot_set_contribution(self):
        with self.assertRaises(TripPermissionError):
            set_contribution(
                trip_id=self.trip.id,
                expense_id=self.expense.id,
                target_user_id=self.member.id,
                actor=self.member,
                amount=Decimal("250000"),
            )

        self.assertEqual(ExpenseContribution.objects.count(), 0)

    def test_contribution_user_must_be_in_expense_participant_snapshot(self):
        late_member = create_completed_user(
            "late-contrib@example.com",
            "latecontrib",
            "LCO001",
            display_name="Late C",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=late_member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

        with self.assertRaises(ContributionUserNotParticipantError):
            set_contribution(
                trip_id=self.trip.id,
                expense_id=self.expense.id,
                target_user_id=late_member.id,
                actor=self.captain,
                amount=Decimal("250000"),
            )

        self.assertEqual(ExpenseContribution.objects.count(), 0)

    def test_locked_expense_rejects_contribution_changes(self):
        self.expense.locked_at = timezone.now()
        self.expense.save(update_fields=["locked_at"])

        with self.assertRaises(ExpenseLockedError):
            set_contribution(
                trip_id=self.trip.id,
                expense_id=self.expense.id,
                target_user_id=self.member.id,
                actor=self.captain,
                amount=Decimal("250000"),
            )

        self.assertEqual(ExpenseContribution.objects.count(), 0)


class ExpenseDashboardServiceTests(TestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "captain-dashboard@example.com",
            "captaindashboard",
            "CDA001",
            display_name="Captain D",
        )
        self.member_a = create_completed_user(
            "member-a-dashboard@example.com",
            "memberadashboard",
            "MDA001",
            display_name="Member A",
        )
        self.member_b = create_completed_user(
            "member-b-dashboard@example.com",
            "memberbdashboard",
            "MDB001",
            display_name="Member B",
        )
        self.trip = _make_trip(self.captain, name="Dashboard Trip")
        TripMember.objects.create(
            trip=self.trip,
            user=self.captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )
        TripMember.objects.create(
            trip=self.trip,
            user=self.member_a,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        TripMember.objects.create(
            trip=self.trip,
            user=self.member_b,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

    def test_dashboard_includes_departed_member_balances_from_old_expense_snapshot(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Old Shared Booking",
            total_amount=Decimal("900000"),
        )
        TripMember.objects.filter(trip=self.trip, user=self.member_a).update(
            status=MemberStatus.LEFT,
        )

        dashboard = build_expense_dashboard(trip_id=self.trip.id, actor=self.captain)

        self.assertEqual(
            dashboard["member_balances"][str(self.member_a.id)]["balance"],
            Decimal("-300000"),
        )
        self.assertEqual(dashboard["expenses"][0]["expense"], expense)

    def test_overfunding_reduces_collector_balance(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Overfunded Booking",
            total_amount=Decimal("900000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.member_a.id,
            actor=self.captain,
            amount=Decimal("600000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.member_b.id,
            actor=self.captain,
            amount=Decimal("600000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.captain.id,
            actor=self.captain,
            amount=Decimal("300000"),
        )

        dashboard = build_expense_dashboard(trip_id=self.trip.id, actor=self.captain)

        self.assertEqual(dashboard["summary"]["surplus_amount"], Decimal("600000"))
        self.assertEqual(
            dashboard["member_balances"][str(self.captain.id)]["balance"],
            Decimal("-600000"),
        )

    def test_dashboard_summary_totals_paid_surplus_and_missing_amounts(self):
        first_expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Underfunded Booking",
            total_amount=Decimal("900000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=first_expense.id,
            target_user_id=self.captain.id,
            actor=self.captain,
            amount=Decimal("300000"),
        )
        second_expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Overfunded Snacks",
            total_amount=Decimal("300000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=second_expense.id,
            target_user_id=self.member_a.id,
            actor=self.captain,
            amount=Decimal("500000"),
        )

        dashboard = build_expense_dashboard(trip_id=self.trip.id, actor=self.captain)

        self.assertEqual(dashboard["summary"]["total_amount"], Decimal("1200000"))
        self.assertEqual(dashboard["summary"]["paid_amount"], Decimal("800000"))
        self.assertEqual(dashboard["summary"]["surplus_amount"], Decimal("200000"))
        self.assertEqual(dashboard["summary"]["missing_amount"], Decimal("600000"))

    def test_dashboard_permissions_are_true_for_captain_and_false_for_active_member(self):
        captain_dashboard = build_expense_dashboard(trip_id=self.trip.id, actor=self.captain)
        member_dashboard = build_expense_dashboard(trip_id=self.trip.id, actor=self.member_a)

        self.assertTrue(captain_dashboard["permissions"]["can_manage_expenses"])
        self.assertFalse(member_dashboard["permissions"]["can_manage_expenses"])

    def test_dashboard_missing_trip_raises_trip_not_found(self):
        with self.assertRaises(TripNotFoundError):
            build_expense_dashboard(trip_id=uuid.uuid4(), actor=self.captain)

    def test_dashboard_non_member_raises_trip_not_found(self):
        outsider = create_completed_user(
            "dashboard-outsider@example.com",
            "dashboardoutsider",
            "DAO001",
            display_name="Dashboard Outsider",
        )

        with self.assertRaises(TripNotFoundError):
            build_expense_dashboard(trip_id=self.trip.id, actor=outsider)


class TripCurrencyLockServiceTests(TestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "currency-lock-captain@example.com",
            "currencylockcaptain",
            "CLC001",
            display_name="Currency Captain",
        )
        self.trip = _make_trip(self.captain)
        TripMember.objects.create(
            trip=self.trip,
            user=self.captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )

    def test_currency_can_be_changed_when_no_expense_exists(self):
        update_trip(self.trip, currency_code="USD")

        self.trip.refresh_from_db()
        self.assertEqual(self.trip.currency_code, "USD")

    def test_currency_cannot_change_after_first_expense(self):
        create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Hotel",
            total_amount=Decimal("600000"),
        )

        with self.assertRaises(TripCurrencyLockedError):
            update_trip(self.trip, currency_code="USD")

        self.trip.refresh_from_db()
        self.assertEqual(self.trip.currency_code, "VND")

    def test_setting_same_currency_does_not_raise(self):
        create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Hotel",
            total_amount=Decimal("600000"),
        )

        update_trip(self.trip, currency_code="VND")

        self.trip.refresh_from_db()
        self.assertEqual(self.trip.currency_code, "VND")


class CollectorReassignServiceTests(TestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "collector-captain@example.com",
            "collectorcaptain",
            "COC001",
            display_name="Collector Captain",
        )
        self.member = create_completed_user(
            "collector-member@example.com",
            "collectormember",
            "COM001",
            display_name="Collector Member",
        )
        self.late_joiner = create_completed_user(
            "collector-late@example.com",
            "collectorlate",
            "COL001",
            display_name="Late Joiner",
        )
        self.trip = _make_trip(self.captain)
        TripMember.objects.create(
            trip=self.trip,
            user=self.captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )
        TripMember.objects.create(
            trip=self.trip,
            user=self.member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        self.expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Hotel",
            total_amount=Decimal("600000"),
        )
        # late_joiner becomes an active member only AFTER the expense was created,
        # so they are not in the participant snapshot of self.expense.
        TripMember.objects.create(
            trip=self.trip,
            user=self.late_joiner,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

    def test_reassigning_collector_to_non_participant_is_rejected(self):
        with self.assertRaises(CollectorNotParticipantError):
            update_expense(
                trip_id=self.trip.id,
                expense_id=self.expense.id,
                actor=self.captain,
                collector_id=self.late_joiner.id,
                update_collector=True,
            )

        self.expense.refresh_from_db()
        self.assertEqual(self.expense.collector_id, self.captain.id)

    def test_reassigning_collector_to_participant_succeeds(self):
        update_expense(
            trip_id=self.trip.id,
            expense_id=self.expense.id,
            actor=self.captain,
            collector_id=self.member.id,
            update_collector=True,
        )

        self.expense.refresh_from_db()
        self.assertEqual(self.expense.collector_id, self.member.id)


class ExpenseDeleteAuditServiceTests(TestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "delete-captain@example.com",
            "deletecaptain",
            "DEC001",
            display_name="Delete Captain",
        )
        self.member = create_completed_user(
            "delete-member@example.com",
            "deletemember",
            "DEM001",
            display_name="Delete Member",
        )
        self.trip = _make_trip(self.captain)
        TripMember.objects.create(
            trip=self.trip,
            user=self.captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )
        TripMember.objects.create(
            trip=self.trip,
            user=self.member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

    def test_delete_expense_ledger_includes_contribution_snapshot(self):
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Hotel",
            total_amount=Decimal("600000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.member.id,
            actor=self.captain,
            amount=Decimal("250000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.captain.id,
            actor=self.captain,
            amount=Decimal("350000"),
        )
        ExpenseLedgerEntry.objects.filter(
            event_type=ExpenseLedgerEventType.EXPENSE_DELETED
        ).delete()

        delete_expense(
            trip_id=self.trip.id,
            expense_id=expense.id,
            actor=self.captain,
        )

        ledger = ExpenseLedgerEntry.objects.get(
            event_type=ExpenseLedgerEventType.EXPENSE_DELETED,
        )
        contributions = ledger.payload.get("contributions")
        self.assertIsInstance(contributions, list)
        self.assertEqual(len(contributions), 2)
        amounts_by_user = {item["user_id"]: item["amount"] for item in contributions}
        self.assertEqual(amounts_by_user[str(self.member.id)], "250000")
        self.assertEqual(amounts_by_user[str(self.captain.id)], "350000")


class ReopenSettlementAuditServiceTests(TestCase):
    def setUp(self):
        self.captain = create_completed_user(
            "reopen-captain@example.com",
            "reopencaptain",
            "REC001",
            display_name="Reopen Captain",
        )
        self.member_a = create_completed_user(
            "reopen-member-a@example.com",
            "reopenmembera",
            "REA001",
            display_name="Reopen A",
        )
        self.member_b = create_completed_user(
            "reopen-member-b@example.com",
            "reopenmemberb",
            "REB001",
            display_name="Reopen B",
        )
        self.trip = _make_trip(self.captain)
        for user, role in (
            (self.captain, TripRole.CAPTAIN),
            (self.member_a, TripRole.MEMBER),
            (self.member_b, TripRole.MEMBER),
        ):
            TripMember.objects.create(
                trip=self.trip,
                user=user,
                role=role,
                status=MemberStatus.ACTIVE,
            )
        expense = create_expense(
            trip_id=self.trip.id,
            actor=self.captain,
            title="Group Hotel",
            total_amount=Decimal("900000"),
        )
        set_contribution(
            trip_id=self.trip.id,
            expense_id=expense.id,
            target_user_id=self.captain.id,
            actor=self.captain,
            amount=Decimal("900000"),
        )
        finalize_settlement(trip_id=self.trip.id, actor=self.captain)

    def test_reopen_payload_snapshots_in_flight_transfers(self):
        from expenses.services import mark_transfer_sent

        from expenses.models import SettlementTransfer

        sent_transfer = SettlementTransfer.objects.filter(
            payer=self.member_a
        ).first()
        mark_transfer_sent(
            trip_id=self.trip.id,
            transfer_id=sent_transfer.id,
            actor=self.member_a,
        )

        reopen_settlement(trip_id=self.trip.id, actor=self.captain)

        ledger = ExpenseLedgerEntry.objects.filter(
            event_type=ExpenseLedgerEventType.SETTLEMENT_REOPENED,
        ).latest("created_at")
        snapshot = ledger.payload.get("in_flight_transfers")
        self.assertIsInstance(snapshot, list)
        self.assertEqual(len(snapshot), 1)
        self.assertEqual(snapshot[0]["transfer_id"], str(sent_transfer.id))
        self.assertIsNotNone(snapshot[0]["payer_marked_sent_at"])
        self.assertIsNone(snapshot[0]["recipient_confirmed_at"])

    def test_reopen_payload_is_empty_list_when_no_transfers_were_in_flight(self):
        reopen_settlement(trip_id=self.trip.id, actor=self.captain)

        ledger = ExpenseLedgerEntry.objects.filter(
            event_type=ExpenseLedgerEventType.SETTLEMENT_REOPENED,
        ).latest("created_at")
        self.assertEqual(ledger.payload.get("in_flight_transfers"), [])
