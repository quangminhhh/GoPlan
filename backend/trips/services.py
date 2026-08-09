from __future__ import annotations

from datetime import date, datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Count, Prefetch, Q, Subquery
from django.utils import timezone
from rest_framework import serializers as drf_serializers

from friends.models import Friendship
from notifications.models import NotificationType
from notifications.services import create_notification
from shared.utils.identity import canonical_pair
from trips.models import (
    InvitationStatus,
    MemberStatus,
    TimelineActivity,
    TimelineActivityAssigneeScope,
    TimelineActivityReminder,
    TimelineActivityStatus,
    TimelineActivityTimeMode,
    TimelineCustomType,
    TimelineLocationMode,
    TimelineSection,
    Trip,
    TripInvitation,
    TripMember,
    TripRole,
    TripStatus,
)

User = get_user_model()


# -------- Exceptions --------

class TripServiceError(Exception):
    """Base exception for trip service layer."""
    error_code: str = "TRIP_ERROR"


class TripNotFoundError(TripServiceError):
    error_code = "TRIP_NOT_FOUND"


class NotTripMemberError(TripServiceError):
    error_code = "NOT_TRIP_MEMBER"


class TripPermissionError(TripServiceError):
    error_code = "PERMISSION_DENIED"


class NotTripCaptainError(TripPermissionError):
    error_code = "NOT_CAPTAIN"


class CannotRemoveSelfError(TripServiceError):
    error_code = "CANNOT_REMOVE_SELF"


class CaptainCannotLeaveError(TripServiceError):
    error_code = "CAPTAIN_CANNOT_LEAVE"


class InviteError(TripServiceError):
    error_code = "INVITE_ERROR"


class NotFriendError(InviteError):
    error_code = "NOT_FRIEND"


class AlreadyMemberError(InviteError):
    error_code = "ALREADY_MEMBER"


class AlreadyInvitedError(InviteError):
    error_code = "ALREADY_INVITED"


class InvitationError(TripServiceError):
    error_code = "INVITATION_ERROR"


class AlreadyActiveTripMemberError(InvitationError):
    error_code = "ALREADY_MEMBER"


class StatusTransitionError(TripServiceError):
    error_code = "INVALID_STATUS_TRANSITION"


class TripTerminalError(StatusTransitionError):
    error_code = "TRIP_TERMINAL"


class TripCurrencyLockedError(TripServiceError):
    error_code = "TRIP_CURRENCY_LOCKED"


# Timeline-specific errors
class TimelineSectionNotFoundError(TripServiceError):
    error_code = "SECTION_NOT_FOUND"


class TimelineActivityNotFoundError(TripServiceError):
    error_code = "ACTIVITY_NOT_FOUND"


class TimelineCustomTypeNotFoundError(TripServiceError):
    error_code = "CUSTOM_TYPE_NOT_FOUND"


class TimelineSectionNotEmptyError(TripServiceError):
    error_code = "SECTION_NOT_EMPTY"


class TimelineCustomTypeInUseError(TripServiceError):
    error_code = "CUSTOM_TYPE_IN_USE"


class TimelineCustomTypeDuplicateError(TripServiceError):
    error_code = "CUSTOM_TYPE_DUPLICATE"


class TimelineSectionDateConflictError(TripServiceError):
    error_code = "SECTION_DATE_CONFLICT"


class TimelineInvalidAssigneeError(TripServiceError):
    error_code = "INVALID_ASSIGNEE"


class TimelineInvalidCustomTypeError(TripServiceError):
    error_code = "INVALID_CUSTOM_TYPE"


_CAPTAIN_ACTIVITY_STATUS_TARGETS = {
    TimelineActivityStatus.UPCOMING: {
        TimelineActivityStatus.IN_PROGRESS,
        TimelineActivityStatus.DONE,
        TimelineActivityStatus.CANCELLED,
    },
    TimelineActivityStatus.IN_PROGRESS: {
        TimelineActivityStatus.UPCOMING,
        TimelineActivityStatus.DONE,
        TimelineActivityStatus.CANCELLED,
    },
    TimelineActivityStatus.DONE: {
        TimelineActivityStatus.IN_PROGRESS,
        TimelineActivityStatus.UPCOMING,
        TimelineActivityStatus.CANCELLED,
    },
    TimelineActivityStatus.CANCELLED: {TimelineActivityStatus.UPCOMING},
}

_ASSIGNEE_ACTIVITY_STATUS_TARGETS = {
    TimelineActivityStatus.UPCOMING: {TimelineActivityStatus.IN_PROGRESS},
    TimelineActivityStatus.IN_PROGRESS: {
        TimelineActivityStatus.UPCOMING,
        TimelineActivityStatus.DONE,
    },
    TimelineActivityStatus.DONE: set(),
    TimelineActivityStatus.CANCELLED: set(),
}

_TIMELINE_REMINDER_DISPATCH_TRIP_STATUSES = {
    TripStatus.PLANNING,
    TripStatus.ONGOING,
}

_TIMELINE_STARTER_DAY_COUNT = 2


# -------- Services --------

def create_trip(
    *,
    captain,
    name: str,
    destination: str,
    destination_provider: str = "",
    destination_provider_id: str = "",
    destination_lat=None,
    destination_lng=None,
    destination_country_code: str = "",
    cover_image_url: str = "",
    start_date,
    end_date,
    description: str = "",
    currency_code: str = "VND",
    timezone: str = "Asia/Ho_Chi_Minh",
    budget_estimate=None,
) -> Trip:
    """Create a trip and add the creator as CAPTAIN. Auto-generates starter timeline days."""
    with transaction.atomic():
        trip = Trip.objects.create(
            name=name,
            destination=destination,
            destination_provider=destination_provider,
            destination_provider_id=destination_provider_id,
            destination_lat=destination_lat,
            destination_lng=destination_lng,
            destination_country_code=destination_country_code,
            cover_image_url=cover_image_url,
            start_date=start_date,
            end_date=end_date,
            description=description,
            currency_code=currency_code,
            timezone=timezone,
            budget_estimate=budget_estimate,
            status=TripStatus.PLANNING,
            created_by=captain,
        )
        TripMember.objects.create(
            trip=trip,
            user=captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )
        seed_starter_timeline_days(trip)
    return trip


# -------- Timeline day seed --------


def _ensure_section_date_available(
    trip: Trip,
    section_date,
    *,
    exclude_section_id=None,
) -> None:
    sections = TimelineSection.objects.filter(trip=trip, section_date=section_date)
    if exclude_section_id is not None:
        sections = sections.exclude(pk=exclude_section_id)
    if sections.exists():
        raise TimelineSectionDateConflictError("This date already has a timeline day.")


def _starter_timeline_dates(trip: Trip) -> list[date]:
    current = trip.start_date
    dates = []
    while current <= trip.end_date and len(dates) < _TIMELINE_STARTER_DAY_COUNT:
        dates.append(current)
        current = current + timedelta(days=1)
    return dates


def seed_starter_timeline_days(trip: Trip) -> None:
    """Create the initial starter days for a trip without mutating existing days."""
    with transaction.atomic():
        trip = Trip.objects.select_for_update().get(pk=trip.pk)
        if not trip.start_date or not trip.end_date:
            return

        existing_dates = set(
            TimelineSection.objects
            .select_for_update()
            .filter(trip=trip)
            .values_list("section_date", flat=True)
        )

        for index, current in enumerate(_starter_timeline_dates(trip), start=1):
            if current in existing_dates:
                continue
            try:
                TimelineSection.objects.create(
                    trip=trip,
                    section_date=current,
                    label=f"Day {index}",
                    is_label_custom=False,
                    position=0,
                )
                existing_dates.add(current)
            except IntegrityError as exc:
                raise TimelineSectionDateConflictError(
                    "This date already has a timeline day."
                ) from exc


def get_user_trips(user):
    """Return all trips where user has an ACTIVE membership."""
    active_memberships = TripMember.objects.filter(status=MemberStatus.ACTIVE)
    user_trip_ids = active_memberships.filter(user=user).values("trip_id")
    return (
        Trip.objects.filter(id__in=Subquery(user_trip_ids))
        .prefetch_related(Prefetch("memberships", queryset=active_memberships))
        .annotate(active_member_count=Count(
            "memberships",
            filter=Q(memberships__status=MemberStatus.ACTIVE),
            distinct=True,
        ))
        .order_by("-created_at")
        .distinct()
    )


def get_trip_detail(trip_id, requesting_user):
    """Return (trip, my_membership) or raise 404/403."""
    return _get_visible_trip_membership(trip_id, requesting_user)


_UNSET = object()


def update_trip(trip, *, name=_UNSET, destination=_UNSET,
                destination_provider=_UNSET, destination_provider_id=_UNSET, destination_lat=_UNSET,
                destination_lng=_UNSET, destination_country_code=_UNSET,
                cover_image_url=_UNSET,
                start_date=_UNSET, end_date=_UNSET,
                description=_UNSET, currency_code=_UNSET, timezone=_UNSET, budget_estimate=_UNSET):
    """Partially update trip fields. Only updates fields explicitly passed.
    Sentinel _UNSET distinguishes "not provided" from None (which clears a nullable field).
    """
    with transaction.atomic():
        trip = Trip.objects.select_for_update().get(pk=trip.pk)
        _assert_not_terminal(trip)
        old_timezone = trip.timezone

        if name is not _UNSET:                       trip.name = name
        if destination is not _UNSET:                trip.destination = destination
        if destination_provider is not _UNSET:       trip.destination_provider = destination_provider
        if destination_provider_id is not _UNSET:    trip.destination_provider_id = destination_provider_id
        if destination_lat is not _UNSET:            trip.destination_lat = destination_lat
        if destination_lng is not _UNSET:            trip.destination_lng = destination_lng
        if destination_country_code is not _UNSET:   trip.destination_country_code = destination_country_code
        if cover_image_url is not _UNSET:            trip.cover_image_url = cover_image_url
        if start_date is not _UNSET:                 trip.start_date = start_date
        if end_date is not _UNSET:                   trip.end_date = end_date
        if description is not _UNSET:                trip.description = description
        if currency_code is not _UNSET:
            if currency_code != trip.currency_code:
                # Currency code is the unit of every expense, contribution and
                # settlement transfer. Once the trip has any expense, changing
                # currency would silently mismatch existing rows against new ones.
                from expenses.models import Expense
                if Expense.objects.filter(trip=trip).exists():
                    raise TripCurrencyLockedError(
                        "Cannot change trip currency once expenses exist."
                    )
            trip.currency_code = currency_code
        if timezone is not _UNSET:                   trip.timezone = timezone
        if budget_estimate is not _UNSET:            trip.budget_estimate = budget_estimate

        timezone_changed = trip.timezone != old_timezone

        trip.save()
        if timezone_changed:
            regenerate_unsent_trip_reminders(trip)
    return trip


# -------- Timeline read --------

def get_trip_timeline(trip: Trip):
    """Return ordered timeline sections with prefetched activities for read-only rendering."""
    sections_qs = (
        trip.timeline_sections
        .all()
        .order_by("section_date", "position", "created_at")
        .prefetch_related(
            Prefetch(
                "activities",
                queryset=(
                    trip.timeline_activities.model.objects
                    .order_by("position", "created_at")
                    .select_related("custom_type", "assignee_user")
                    .prefetch_related("reminders")
                ),
            )
        )
    )
    custom_types = trip.timeline_custom_types.all().order_by("name", "created_at")
    return list(sections_qs), list(custom_types)


# -------- Invite helpers --------

def _are_friends(user_a, user_b) -> bool:
    """Check if two users are friends (canonical pair order)."""
    low, high = canonical_pair(user_a, user_b)
    return Friendship.objects.filter(user_low=low, user_high=high).exists()


def get_invitable_friends(trip, captain):
    """Return friends of captain who are not ACTIVE members and have no PENDING invitation."""
    active_member_ids = trip.memberships.filter(
        status=MemberStatus.ACTIVE
    ).values_list("user_id", flat=True)

    pending_invitee_ids = trip.invitations.filter(
        status=InvitationStatus.PENDING
    ).values_list("invitee_id", flat=True)

    excluded_ids = set(list(active_member_ids) + list(pending_invitee_ids))

    friend_ids = Friendship.objects.filter(
        Q(user_low=captain) | Q(user_high=captain)
    ).values_list("user_low_id", "user_high_id")

    eligible = []
    for low_id, high_id in friend_ids:
        fid = high_id if low_id == captain.pk else low_id
        if fid not in excluded_ids:
            eligible.append(fid)

    return User.objects.filter(pk__in=eligible, is_profile_completed=True)


def get_pending_invitations(trip):
    """Return PENDING invitations for a trip."""
    return trip.invitations.filter(status=InvitationStatus.PENDING).select_related("invitee")


def send_trip_invitations(trip, captain, invitee_ids: list) -> list:
    """Send invitations to a list of user IDs. Validates each and sends realtime notification."""
    if not invitee_ids:
        raise InviteError("No invitee IDs provided.")

    invitees = list(User.objects.filter(pk__in=invitee_ids, is_profile_completed=True))
    if len(invitees) != len(invitee_ids):
        raise InviteError("One or more users not found.")

    created = []
    with transaction.atomic():
        try:
            locked_trip = Trip.objects.select_for_update().get(pk=trip.pk)
        except Trip.DoesNotExist:
            raise TripNotFoundError("Trip not found.")

        if locked_trip.status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
            raise InviteError("Cannot invite members to a trip that is completed or cancelled.")

        for invitee in invitees:
            if invitee == captain:
                raise InviteError("Cannot invite yourself.")

            if not _are_friends(captain, invitee):
                raise NotFriendError("Cannot invite this user.")

            if locked_trip.memberships.filter(user=invitee, status=MemberStatus.ACTIVE).exists():
                raise AlreadyMemberError("Cannot invite this user.")

            if locked_trip.invitations.filter(invitee=invitee, status=InvitationStatus.PENDING).exists():
                raise AlreadyInvitedError("Cannot invite this user.")

            try:
                inv = TripInvitation.objects.create(
                    trip=locked_trip,
                    inviter=captain,
                    invitee=invitee,
                    status=InvitationStatus.PENDING,
                )
            except IntegrityError as exc:
                raise AlreadyInvitedError("Cannot invite this user.") from exc
            created.append(inv)

            create_notification(
                recipient=invitee,
                notification_type=NotificationType.TRIP_INVITATION,
                actor=captain,
                payload={
                    "trip_id": str(locked_trip.id),
                    "trip_name": locked_trip.name,
                    "destination": locked_trip.destination,
                    "start_date": str(locked_trip.start_date),
                    "end_date": str(locked_trip.end_date),
                    "invitation_id": str(inv.id),
                },
            )

    return created


def accept_invitation(invitation_id, actor) -> TripMember:
    """Accept a PENDING invitation. Creates ACTIVE TripMember for invitee."""
    with transaction.atomic():
        invitation_reference = (
            TripInvitation.objects.filter(pk=invitation_id, invitee=actor)
            .values("trip_id")
            .first()
        )
        if invitation_reference is None:
            raise TripNotFoundError("Invitation not found.")

        try:
            trip = Trip.objects.select_for_update().get(
                pk=invitation_reference["trip_id"]
            )
        except Trip.DoesNotExist:
            raise TripNotFoundError("Trip not found.")

        try:
            invitation = (
                TripInvitation.objects
                .select_related("inviter")
                .select_for_update()
                .get(pk=invitation_id, invitee=actor, trip=trip)
            )
        except TripInvitation.DoesNotExist:
            raise TripNotFoundError("Invitation not found.")

        if invitation.status != InvitationStatus.PENDING:
            raise InvitationError("This invitation is no longer pending.")

        if trip.status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
            raise InvitationError("This trip is no longer open to new members.")

        if TripMember.objects.filter(trip=trip, user=actor, status=MemberStatus.ACTIVE).exists():
            raise AlreadyActiveTripMemberError("You are already an active member of this trip.")

        invitation.status = InvitationStatus.ACCEPTED
        invitation.responded_at = timezone.now()
        invitation.save(update_fields=["status", "responded_at"])

        try:
            membership = TripMember.objects.create(
                trip=trip,
                user=actor,
                role=TripRole.MEMBER,
                status=MemberStatus.ACTIVE,
            )
        except IntegrityError as exc:
            raise AlreadyActiveTripMemberError(
                "You are already an active member of this trip."
            ) from exc

        create_notification(
            recipient=invitation.inviter,
            notification_type=NotificationType.TRIP_INVITATION_ACCEPTED,
            actor=actor,
            payload={
                "trip_id": str(trip.id),
                "trip_name": trip.name,
                "accepted_by_name": actor.display_name,
            },
        )

    return membership


def decline_invitation(invitation_id, actor) -> TripInvitation:
    """Decline a PENDING invitation."""
    with transaction.atomic():
        try:
            invitation = (
                TripInvitation.objects
                .select_related("inviter")
                .select_for_update()
                .get(pk=invitation_id, invitee=actor)
            )
        except TripInvitation.DoesNotExist:
            raise TripNotFoundError("Invitation not found.")

        if invitation.status != InvitationStatus.PENDING:
            raise InvitationError("This invitation is no longer pending.")

        invitation.status = InvitationStatus.DECLINED
        invitation.responded_at = timezone.now()
        invitation.save(update_fields=["status", "responded_at"])

        create_notification(
            recipient=invitation.inviter,
            notification_type=NotificationType.TRIP_INVITATION_DECLINED,
            actor=actor,
            payload={
                "trip_id": str(invitation.trip_id),
                "trip_name": invitation.trip.name,
                "declined_by_name": actor.display_name,
            },
        )

    return invitation


# -------- Captain action helpers --------

def _assert_captain(trip, actor):
    """Raise TripPermissionError if actor is not ACTIVE captain of trip."""
    membership = TripMember.objects.filter(
        trip=trip,
        user=actor,
        status=MemberStatus.ACTIVE,
    ).first()
    if membership is None:
        raise TripNotFoundError("Trip not found.")
    if membership.role != TripRole.CAPTAIN:
        raise TripPermissionError("Only the trip captain can perform this action.")


def _assert_not_terminal(trip):
    """Raise TripTerminalError if trip is in a terminal state."""
    if trip.status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
        raise TripTerminalError("This trip is in a terminal state. No further changes are allowed.")


def start_trip(trip_id, actor) -> Trip:
    """Transition PLANNING → ONGOING. Captain only."""
    with transaction.atomic():
        try:
            trip = Trip.objects.select_for_update().get(pk=trip_id)
        except Trip.DoesNotExist:
            raise TripNotFoundError("Trip not found.")

        _assert_captain(trip, actor)

        if trip.status != TripStatus.PLANNING:
            raise StatusTransitionError("Trip must be in PLANNING status to start.")

        trip.status = TripStatus.ONGOING
        trip.save(update_fields=["status", "updated_at"])

    return trip


def complete_trip(trip_id, actor) -> Trip:
    """Transition ONGOING → COMPLETED. Captain only.
    Auto-cancels any remaining PENDING invitations so a terminal trip
    cannot acquire new members through a stale invite.
    """
    with transaction.atomic():
        try:
            trip = Trip.objects.select_for_update().get(pk=trip_id)
        except Trip.DoesNotExist:
            raise TripNotFoundError("Trip not found.")

        _assert_captain(trip, actor)

        if trip.status != TripStatus.ONGOING:
            raise StatusTransitionError("Trip must be in ONGOING status to complete.")

        trip.status = TripStatus.COMPLETED
        trip.save(update_fields=["status", "updated_at"])

        TripInvitation.objects.filter(trip=trip, status=InvitationStatus.PENDING).update(
            status=InvitationStatus.CANCELLED
        )

    return trip


def cancel_trip(trip_id, actor) -> Trip:
    """Transition PLANNING/ONGOING → CANCELLED. Captain only.
    Auto-cancels all PENDING invitations.
    Sends TRIP_CANCELLED notification to all ACTIVE members (excluding captain).
    """
    with transaction.atomic():
        try:
            trip = Trip.objects.select_for_update().get(pk=trip_id)
        except Trip.DoesNotExist:
            raise TripNotFoundError("Trip not found.")

        _assert_captain(trip, actor)

        if trip.status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
            raise TripTerminalError("This trip is already in a terminal state and cannot be cancelled.")

        trip.status = TripStatus.CANCELLED
        trip.cancelled_at = timezone.now()
        trip.save(update_fields=["status", "cancelled_at", "updated_at"])

        # Auto-cancel pending invitations
        TripInvitation.objects.filter(trip=trip, status=InvitationStatus.PENDING).update(
            status=InvitationStatus.CANCELLED
        )

        # Notify all active members (except captain)
        active_members = TripMember.objects.filter(
            trip=trip, status=MemberStatus.ACTIVE
        ).exclude(user=actor).select_related("user")

        for membership in active_members:
            create_notification(
                recipient=membership.user,
                notification_type=NotificationType.TRIP_CANCELLED,
                actor=actor,
                payload={
                    "trip_id": str(trip.id),
                    "trip_name": trip.name,
                },
            )

    return trip


def remove_member(trip_id, target_user_id, actor) -> TripMember:
    """Captain removes an ACTIVE member. Sets status to REMOVED, records left_at.
    Sends TRIP_MEMBER_REMOVED notification to the removed user.
    """
    with transaction.atomic():
        try:
            trip = Trip.objects.select_for_update().get(pk=trip_id)
        except Trip.DoesNotExist:
            raise TripNotFoundError("Trip not found.")

        _assert_captain(trip, actor)
        _assert_not_terminal(trip)

        # Captain cannot remove themselves
        if str(target_user_id) == str(actor.id):
            raise CannotRemoveSelfError("You cannot remove yourself from the trip.")

        try:
            membership = TripMember.objects.select_for_update().get(
                trip=trip, user_id=target_user_id, status=MemberStatus.ACTIVE
            )
        except TripMember.DoesNotExist:
            raise TripNotFoundError("Active member not found.")

        membership.status = MemberStatus.REMOVED
        membership.left_at = timezone.now()
        membership.save(update_fields=["status", "left_at"])
        from chat.services import notify_trip_chat_member_removed

        notify_trip_chat_member_removed(
            trip_id=trip.id,
            user_id=target_user_id,
        )
        _clear_activity_assignees_for_user(
            trip=trip,
            user_id=target_user_id,
            updated_by=actor,
        )

        create_notification(
            recipient=membership.user,
            notification_type=NotificationType.TRIP_MEMBER_REMOVED,
            actor=actor,
            payload={
                "trip_id": str(trip.id),
                "trip_name": trip.name,
            },
        )

    return membership


# -------- Member leave helpers --------

def leave_trip(trip_id, actor) -> TripMember:
    """Actor voluntarily leaves the trip. Sets membership status to LEFT, records left_at.
    Captain cannot leave (no transfer mechanism in Phase 1).
    Only allowed when trip is PLANNING or ONGOING.
    Actor must be an ACTIVE member.
    """
    with transaction.atomic():
        trip, membership = _get_active_trip_membership_for_update(trip_id, actor)

        # Terminal state guard — checked first for consistent ordering with other services
        if trip.status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
            raise TripTerminalError("Cannot leave a trip that is completed or cancelled.")

        # Captain cannot leave
        if membership.role == TripRole.CAPTAIN:
            raise CaptainCannotLeaveError("Captain cannot leave the trip. Transfer captaincy first (not available in Phase 1).")

        membership.status = MemberStatus.LEFT
        membership.left_at = timezone.now()
        membership.save(update_fields=["status", "left_at"])
        from chat.services import notify_trip_chat_member_removed

        notify_trip_chat_member_removed(
            trip_id=trip.id,
            user_id=actor.id,
        )
        _clear_activity_assignees_for_user(
            trip=trip,
            user_id=actor.id,
            updated_by=actor,
        )

    return membership


def _get_active_trip_membership_for_update(trip_id, actor) -> tuple[Trip, TripMember]:
    try:
        trip = Trip.objects.select_for_update().get(pk=trip_id)
    except Trip.DoesNotExist:
        raise TripNotFoundError("Trip not found.")

    try:
        membership = TripMember.objects.select_for_update().get(
            trip=trip,
            user=actor,
            status=MemberStatus.ACTIVE,
        )
    except TripMember.DoesNotExist:
        raise TripNotFoundError("Trip not found.")

    return trip, membership


def _ensure_captain_can_mutate(trip, actor):
    membership = TripMember.objects.filter(
        trip=trip,
        user=actor,
        status=MemberStatus.ACTIVE,
    ).first()
    if membership is None:
        raise TripNotFoundError("Trip not found.")
    if membership.role != TripRole.CAPTAIN:
        raise NotTripCaptainError("Only the trip captain can perform this action.")
    _assert_not_terminal(trip)


def _get_visible_trip_membership(trip_id, actor, *, for_update: bool = False) -> tuple[Trip, TripMember]:
    queryset = TripMember.objects.select_related("trip").filter(
        trip_id=trip_id,
        user=actor,
        status=MemberStatus.ACTIVE,
    )
    if for_update:
        queryset = queryset.select_for_update()
    try:
        membership = queryset.get()
    except TripMember.DoesNotExist:
        raise TripNotFoundError("Trip not found.")
    return membership.trip, membership


def _get_locked_trip(trip_id, *, actor=None) -> Trip:
    if actor is not None:
        trip, _membership = _get_active_trip_membership_for_update(
            trip_id,
            actor,
        )
        return trip
    try:
        return Trip.objects.select_for_update().get(pk=trip_id)
    except Trip.DoesNotExist:
        raise TripNotFoundError("Trip not found.")


# -------- Section mutations --------

def create_timeline_day(trip_id, *, actor, section_date, label) -> tuple[Trip, TimelineSection]:
    """Create a custom timeline day. Captain only."""
    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)
        _ensure_section_date_available(trip, section_date)
        try:
            section = TimelineSection.objects.create(
                trip=trip,
                section_date=section_date,
                label=label,
                is_label_custom=True,
                position=0,
                created_by=actor,
                updated_by=actor,
            )
        except IntegrityError as exc:
            raise TimelineSectionDateConflictError(
                "This date already has a timeline day."
            ) from exc
    return trip, section


_UNSET_TIMELINE = object()


def patch_section(
    trip_id,
    section_id,
    *,
    actor,
    label=_UNSET_TIMELINE,
    section_date=_UNSET_TIMELINE,
) -> tuple[Trip, TimelineSection]:
    """Patch a timeline day date and/or label."""
    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)
        try:
            section = TimelineSection.objects.select_for_update().get(pk=section_id, trip=trip)
        except TimelineSection.DoesNotExist:
            raise TimelineSectionNotFoundError("Section not found.")

        old_date = section.section_date
        final_date = section.section_date if section_date is _UNSET_TIMELINE else section_date
        date_changed = final_date != old_date
        if date_changed:
            _ensure_section_date_available(
                trip,
                final_date,
                exclude_section_id=section.id,
            )

        final_label = section.label if label is _UNSET_TIMELINE else label
        section.section_date = final_date
        section.label = final_label
        section.is_label_custom = True
        section.updated_by = actor
        try:
            section.save(
                update_fields=[
                    "section_date",
                    "label",
                    "is_label_custom",
                    "updated_by",
                    "updated_at",
                ]
            )
        except IntegrityError as exc:
            raise TimelineSectionDateConflictError(
                "This date already has a timeline day."
            ) from exc
        if date_changed:
            regenerate_unsent_section_reminders(section)
    return trip, section


def delete_section(trip_id, section_id, *, actor) -> None:
    """Delete an empty timeline day. Captain only."""
    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)
        try:
            section = TimelineSection.objects.select_for_update().get(pk=section_id, trip=trip)
        except TimelineSection.DoesNotExist:
            raise TimelineSectionNotFoundError("Section not found.")
        if section.activities.count() > 0:
            raise TimelineSectionNotEmptyError("Cannot delete a section that still contains activities.")
        section.delete()


# -------- Activity mutations --------

def _assert_active_member(trip, user_id):
    if not TripMember.objects.filter(
        trip=trip, user_id=user_id, status=MemberStatus.ACTIVE
    ).exists():
        raise TimelineInvalidAssigneeError("Assignee must be an active member of this trip.")


def _clear_activity_assignees_for_user(*, trip: Trip, user_id, updated_by) -> None:
    TimelineActivity.objects.filter(
        trip=trip,
        assignee_scope=TimelineActivityAssigneeScope.USER,
        assignee_user_id=user_id,
    ).update(
        assignee_scope=TimelineActivityAssigneeScope.NONE,
        assignee_user_id=None,
        updated_by_id=updated_by.id,
        updated_at=timezone.now(),
    )


def _resolve_custom_type(trip, custom_type_id, *, require_active: bool = True) -> TimelineCustomType:
    try:
        ct = TimelineCustomType.objects.get(pk=custom_type_id, trip=trip)
    except TimelineCustomType.DoesNotExist:
        raise TimelineInvalidCustomTypeError("Custom type does not belong to this trip.")
    if require_active and not ct.is_active:
        raise TimelineInvalidCustomTypeError("Inactive custom types cannot be assigned to activities.")
    return ct


# -------- Timeline reminder helpers --------

def _activity_supports_reminders(activity: TimelineActivity) -> bool:
    return activity.time_mode in (
        TimelineActivityTimeMode.AT_TIME,
        TimelineActivityTimeMode.TIME_RANGE,
    ) and activity.start_time is not None


def _validate_activity_reminder_offsets_allowed(time_mode: str, offsets) -> None:
    if time_mode in (
        TimelineActivityTimeMode.ALL_DAY,
        TimelineActivityTimeMode.FLEXIBLE,
    ) and offsets:
        raise drf_serializers.ValidationError(
            {"reminder_offsets_minutes": f"{time_mode} activities cannot have reminders."}
        )


def _activity_start_utc(activity: TimelineActivity):
    if not _activity_supports_reminders(activity):
        return None
    local_start = datetime.combine(
        activity.section.section_date,
        activity.start_time,
        tzinfo=ZoneInfo(activity.trip.timezone),
    )
    return local_start.astimezone(dt_timezone.utc)


def _configured_reminder_offsets(activity: TimelineActivity) -> list[int]:
    return sorted(
        set(
            activity.reminders
            .filter(sent_at__isnull=True)
            .values_list("offset_minutes_before", flat=True)
        ),
        reverse=True,
    )


def replace_unsent_activity_reminders(activity: TimelineActivity, offsets: list[int]) -> None:
    """Replace unsent reminder rows for an activity, preserving sent history."""
    activity.reminders.filter(sent_at__isnull=True).delete()
    if not offsets or not _activity_supports_reminders(activity):
        return

    activity_start_utc = _activity_start_utc(activity)
    if activity_start_utc is None:
        return

    now = timezone.now()
    for offset in sorted(set(offsets), reverse=True):
        due_at_utc = activity_start_utc - timedelta(minutes=offset)
        if due_at_utc <= now:
            continue
        TimelineActivityReminder.objects.get_or_create(
            activity=activity,
            offset_minutes_before=offset,
            due_at_utc=due_at_utc,
        )


def regenerate_unsent_activity_reminders(activity: TimelineActivity) -> None:
    replace_unsent_activity_reminders(activity, _configured_reminder_offsets(activity))


def regenerate_unsent_section_reminders(section: TimelineSection) -> None:
    activities = (
        section.activities
        .select_related("trip", "section")
        .prefetch_related("reminders")
    )
    for activity in activities:
        regenerate_unsent_activity_reminders(activity)


def regenerate_unsent_trip_reminders(trip: Trip) -> None:
    activities = (
        trip.timeline_activities
        .select_related("trip", "section")
        .prefetch_related("reminders")
    )
    for activity in activities:
        regenerate_unsent_activity_reminders(activity)


def _timeline_reminder_payload(reminder: TimelineActivityReminder) -> dict[str, str]:
    activity = reminder.activity
    return {
        "trip_id": str(activity.trip_id),
        "trip_name": activity.trip.name,
        "activity_id": str(activity.id),
        "activity_title": activity.title,
        "section_label": activity.section.label,
        "activity_date": activity.section.section_date.isoformat(),
        "activity_time": activity.start_time.strftime("%H:%M") if activity.start_time else "",
        "location_label": activity.location_label,
    }


def dispatch_due_timeline_reminders(*, now=None) -> int:
    """Send due timeline reminders to active trip members and mark rows sent."""
    now = now or timezone.now()
    dispatched = 0
    with transaction.atomic():
        reminders = list(
            TimelineActivityReminder.objects
            .select_for_update()
            .select_related("activity", "activity__trip", "activity__section")
            .filter(
                sent_at__isnull=True,
                due_at_utc__lte=now,
                activity__status__in=[
                    TimelineActivityStatus.UPCOMING,
                    TimelineActivityStatus.IN_PROGRESS,
                ],
                activity__trip__status__in=_TIMELINE_REMINDER_DISPATCH_TRIP_STATUSES,
            )
            .order_by("due_at_utc", "created_at")
        )
        for reminder in reminders:
            recipients = (
                reminder.activity.trip.memberships
                .filter(status=MemberStatus.ACTIVE)
                .select_related("user")
            )
            payload = _timeline_reminder_payload(reminder)
            for membership in recipients:
                create_notification(
                    recipient=membership.user,
                    notification_type=NotificationType.TRIP_TIMELINE_REMINDER,
                    payload=payload,
                )
                dispatched += 1
            reminder.sent_at = now
            reminder.save(update_fields=["sent_at"])
    return dispatched


def create_timeline_activity(trip_id, section_id, *, actor, data: dict) -> TimelineActivity:
    """Create an activity in the given section. Captain only."""
    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)
        try:
            section = TimelineSection.objects.select_for_update().get(pk=section_id, trip=trip)
        except TimelineSection.DoesNotExist:
            raise TimelineSectionNotFoundError("Section not found.")

        _apply_activity_create_invariants(data)

        custom_type = None
        if data.get("custom_type_id") is not None:
            custom_type = _resolve_custom_type(trip, data["custom_type_id"])

        assignee_scope = data.get(
            "assignee_scope",
            TimelineActivityAssigneeScope.USER
            if data.get("assignee_user_id") is not None
            else TimelineActivityAssigneeScope.NONE,
        )
        assignee_user_id = (
            data.get("assignee_user_id")
            if assignee_scope == TimelineActivityAssigneeScope.USER
            else None
        )

        if assignee_user_id is not None:
            _assert_active_member(trip, assignee_user_id)

        place = data.get("place") or {}
        location_mode = data.get("location_mode", TimelineLocationMode.MANUAL)
        _validate_activity_reminder_offsets_allowed(
            data["time_mode"],
            data.get("reminder_offsets_minutes"),
        )

        activity = TimelineActivity.objects.create(
            trip=trip,
            section=section,
            title=data["title"],
            time_mode=data["time_mode"],
            start_time=data.get("start_time"),
            end_time=data.get("end_time"),
            system_type=data.get("system_type", "") if custom_type is None else "",
            custom_type=custom_type,
            position=section.activities.count(),
            assignee_scope=assignee_scope,
            assignee_user_id=assignee_user_id,
            location_mode=location_mode,
            location_label=data.get("location_label", ""),
            location_note=data.get("location_note", ""),
            place_provider=place.get("provider", "") if location_mode == TimelineLocationMode.STRUCTURED else "",
            place_provider_id=place.get("provider_id", "") if location_mode == TimelineLocationMode.STRUCTURED else "",
            place_title=place.get("title", "") if location_mode == TimelineLocationMode.STRUCTURED else "",
            place_address=place.get("address", "") if location_mode == TimelineLocationMode.STRUCTURED else "",
            place_lat=place.get("lat") if location_mode == TimelineLocationMode.STRUCTURED else None,
            place_lng=place.get("lng") if location_mode == TimelineLocationMode.STRUCTURED else None,
            note=data.get("note", ""),
            meeting_point=data.get("meeting_point", ""),
            contact_name=data.get("contact_name", ""),
            contact_phone=data.get("contact_phone", ""),
            booking_reference=data.get("booking_reference", ""),
            external_link=data.get("external_link", ""),
            created_by=actor,
            updated_by=actor,
        )
        replace_unsent_activity_reminders(
            activity,
            data.get("reminder_offsets_minutes", []),
        )
    return activity


def _validate_activity_final_invariants(
    *,
    time_mode: str,
    start_time,
    end_time,
    system_type: str,
    custom_type_id,
    location_mode: str,
    place,
    reminder_offsets,
) -> None:
    from trips.serializers import (
        _validate_activity_location,
        _validate_activity_time_fields,
        _validate_activity_type_selection,
        _validate_reminder_offsets,
    )

    if time_mode not in TimelineActivityTimeMode.values:
        raise drf_serializers.ValidationError({"time_mode": "Unknown time_mode."})
    if location_mode not in TimelineLocationMode.values:
        raise drf_serializers.ValidationError({"location_mode": "Unknown location_mode."})
    _validate_activity_time_fields(time_mode, start_time, end_time)
    _validate_reminder_offsets(reminder_offsets)
    _validate_activity_reminder_offsets_allowed(time_mode, reminder_offsets)
    _validate_activity_type_selection(system_type, custom_type_id)
    _validate_activity_location(location_mode, place)


def _apply_activity_create_invariants(data: dict) -> None:
    """Validate service-level create invariants before persistence."""
    _validate_activity_final_invariants(
        time_mode=data.get("time_mode"),
        start_time=data.get("start_time"),
        end_time=data.get("end_time"),
        system_type=data.get("system_type", ""),
        custom_type_id=data.get("custom_type_id"),
        location_mode=data.get("location_mode", TimelineLocationMode.MANUAL),
        place=data.get("place"),
        reminder_offsets=data.get("reminder_offsets_minutes", []),
    )


def _apply_activity_patch_invariants(activity: TimelineActivity, data: dict) -> None:
    """Validate that the merged final state still satisfies cross-field invariants."""
    final_time_mode = data.get("time_mode", activity.time_mode)
    if final_time_mode in (
        TimelineActivityTimeMode.ALL_DAY,
        TimelineActivityTimeMode.FLEXIBLE,
    ):
        final_start = data["start_time"] if "start_time" in data else None
        final_end = data["end_time"] if "end_time" in data else None
    else:
        final_start = data["start_time"] if "start_time" in data else activity.start_time
        final_end = data["end_time"] if "end_time" in data else activity.end_time

    explicit_system_type = "system_type" in data
    final_system_type = data.get("system_type", activity.system_type)
    if "custom_type_id" in data:
        final_custom_type_id = data["custom_type_id"]
    elif explicit_system_type and final_system_type:
        final_custom_type_id = None
    else:
        final_custom_type_id = activity.custom_type_id
    if final_custom_type_id is not None and not (explicit_system_type and final_system_type):
        final_system_type = ""

    final_location_mode = data.get("location_mode", activity.location_mode)
    if final_location_mode == TimelineLocationMode.MANUAL:
        # Switching to or staying in MANUAL implicitly clears any existing place.
        final_place = data.get("place")
    elif "place" in data:
        final_place = data["place"]
    else:
        if activity.place_provider_id:
            final_place = {
                "provider": activity.place_provider,
                "provider_id": activity.place_provider_id,
                "title": activity.place_title,
            }
        else:
            final_place = None

    _validate_activity_final_invariants(
        time_mode=final_time_mode,
        start_time=final_start,
        end_time=final_end,
        system_type=final_system_type,
        custom_type_id=final_custom_type_id,
        location_mode=final_location_mode,
        place=final_place,
        reminder_offsets=data.get("reminder_offsets_minutes"),
    )


def patch_timeline_activity(trip_id, activity_id, *, actor, data: dict) -> TimelineActivity:
    """Partial update of activity content fields. Captain only."""
    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)
        try:
            activity = TimelineActivity.objects.select_for_update().get(pk=activity_id, trip=trip)
        except TimelineActivity.DoesNotExist:
            raise TimelineActivityNotFoundError("Activity not found.")

        existing_offsets = _configured_reminder_offsets(activity)
        should_regenerate_reminders = bool(
            {"time_mode", "start_time", "reminder_offsets_minutes"} & set(data.keys())
        )

        try:
            _apply_activity_patch_invariants(activity, data)
        except drf_serializers.ValidationError:
            raise

        if "custom_type_id" in data:
            if data["custom_type_id"] is None:
                activity.custom_type = None
            else:
                preserves_existing_custom_type = (
                    activity.custom_type_id is not None
                    and str(activity.custom_type_id) == str(data["custom_type_id"])
                )
                if not preserves_existing_custom_type:
                    activity.custom_type = _resolve_custom_type(trip, data["custom_type_id"])
                activity.system_type = ""

        if "system_type" in data:
            if data["system_type"]:
                activity.custom_type = None
                activity.system_type = data["system_type"]
            elif activity.custom_type_id is None:
                activity.system_type = data["system_type"]

        if "assignee_scope" in data or "assignee_user_id" in data:
            assignee_scope = data.get("assignee_scope", activity.assignee_scope)
            if assignee_scope == TimelineActivityAssigneeScope.USER:
                assignee_user_id = data.get("assignee_user_id", activity.assignee_user_id)
                _assert_active_member(trip, assignee_user_id)
                activity.assignee_user_id = assignee_user_id
            else:
                activity.assignee_user_id = None
            activity.assignee_scope = assignee_scope

        simple_fields = (
            "title", "time_mode", "start_time", "end_time",
            "location_mode", "location_label", "location_note",
            "note", "meeting_point", "contact_name", "contact_phone",
            "booking_reference", "external_link",
        )
        for f in simple_fields:
            if f in data:
                setattr(activity, f, data[f])

        if activity.time_mode in (
            TimelineActivityTimeMode.ALL_DAY,
            TimelineActivityTimeMode.FLEXIBLE,
        ):
            activity.start_time = None
            activity.end_time = None

        if "place" in data:
            place = data["place"] or {}
            location_mode = data.get("location_mode", activity.location_mode)
            if location_mode == TimelineLocationMode.STRUCTURED and place:
                activity.place_provider = place.get("provider", "")
                activity.place_provider_id = place.get("provider_id", "")
                activity.place_title = place.get("title", "")
                activity.place_address = place.get("address", "")
                activity.place_lat = place.get("lat")
                activity.place_lng = place.get("lng")
            else:
                activity.place_provider = ""
                activity.place_provider_id = ""
                activity.place_title = ""
                activity.place_address = ""
                activity.place_lat = None
                activity.place_lng = None
        elif "location_mode" in data and data["location_mode"] == TimelineLocationMode.MANUAL:
            activity.place_provider = ""
            activity.place_provider_id = ""
            activity.place_title = ""
            activity.place_address = ""
            activity.place_lat = None
            activity.place_lng = None

        activity.updated_by = actor
        activity.save()
        if should_regenerate_reminders:
            offsets = data.get("reminder_offsets_minutes", existing_offsets)
            replace_unsent_activity_reminders(activity, offsets)
    return activity


def delete_timeline_activity(trip_id, activity_id, *, actor) -> None:
    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)
        try:
            activity = TimelineActivity.objects.select_for_update().get(pk=activity_id, trip=trip)
        except TimelineActivity.DoesNotExist:
            raise TimelineActivityNotFoundError("Activity not found.")
        activity.delete()


def _assert_activity_status_update_allowed(
    activity: TimelineActivity,
    *,
    membership: TripMember,
    actor,
    status: str,
) -> None:
    if membership.role == TripRole.CAPTAIN:
        if status == activity.status:
            return
        allowed_targets = _CAPTAIN_ACTIVITY_STATUS_TARGETS.get(activity.status, set())
        if status not in allowed_targets:
            raise StatusTransitionError("This activity status transition is not allowed.")
        return

    actor_is_assigned = (
        activity.assignee_scope == TimelineActivityAssigneeScope.EVERYONE
        or (
            activity.assignee_scope == TimelineActivityAssigneeScope.USER
            and activity.assignee_user_id == actor.id
        )
    )
    if not actor_is_assigned:
        raise TripPermissionError(
            "Only the captain or assigned member can update this activity status."
        )
    if status == activity.status:
        return
    allowed_targets = _ASSIGNEE_ACTIVITY_STATUS_TARGETS.get(activity.status, set())
    if status not in allowed_targets:
        raise TripPermissionError(
            "Assigned members cannot perform this activity status transition."
        )


def can_update_timeline_activity_status(
    *,
    trip_id,
    activity_id,
    actor,
    status: str,
) -> bool:
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if not activity_id or not status:
        return False

    try:
        trip, membership = _get_visible_trip_membership(trip_id, actor)
    except TripNotFoundError:
        return False

    if trip.status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
        return False

    try:
        activity = TimelineActivity.objects.get(pk=activity_id, trip=trip)
    except (TimelineActivity.DoesNotExist, TypeError, ValueError, ValidationError):
        return False

    try:
        _assert_activity_status_update_allowed(
            activity,
            membership=membership,
            actor=actor,
            status=status,
        )
    except TripServiceError:
        return False
    return True


def update_timeline_activity_status(trip_id, activity_id, *, actor, status: str) -> TimelineActivity:
    """Update operational activity status. Captain follows full state machine; assignee has limited transitions."""
    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        try:
            membership = TripMember.objects.get(
                trip=trip, user=actor, status=MemberStatus.ACTIVE
            )
        except TripMember.DoesNotExist:
            raise NotTripMemberError("You are not an active member of this trip.")

        _assert_not_terminal(trip)
        try:
            activity = TimelineActivity.objects.select_for_update().get(pk=activity_id, trip=trip)
        except TimelineActivity.DoesNotExist:
            raise TimelineActivityNotFoundError("Activity not found.")

        _assert_activity_status_update_allowed(
            activity,
            membership=membership,
            actor=actor,
            status=status,
        )

        if status == activity.status:
            return activity

        activity.status = status
        activity.updated_by = actor
        activity.save(update_fields=["status", "updated_by", "updated_at"])
    return activity


# -------- Custom type mutations --------

def create_custom_type(trip_id, *, actor, name, color_token="slate", icon_key="tag") -> TimelineCustomType:
    from trips.serializers import normalize_custom_type_name

    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)

        normalized = normalize_custom_type_name(name)
        if TimelineCustomType.objects.filter(trip=trip, normalized_name=normalized).exists():
            raise TimelineCustomTypeDuplicateError("A custom type with this name already exists for this trip.")

        try:
            ct = TimelineCustomType.objects.create(
                trip=trip,
                name=name,
                normalized_name=normalized,
                color_token=color_token,
                icon_key=icon_key,
                created_by=actor,
            )
        except IntegrityError:
            raise TimelineCustomTypeDuplicateError("A custom type with this name already exists for this trip.")
    return ct


def patch_custom_type(trip_id, type_id, *, actor, data: dict) -> TimelineCustomType:
    from trips.serializers import normalize_custom_type_name

    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)
        try:
            ct = TimelineCustomType.objects.select_for_update().get(pk=type_id, trip=trip)
        except TimelineCustomType.DoesNotExist:
            raise TimelineCustomTypeNotFoundError("Custom type not found.")

        if "name" in data:
            new_name = data["name"]
            new_normalized = normalize_custom_type_name(new_name)
            if new_normalized != ct.normalized_name and TimelineCustomType.objects.filter(
                trip=trip, normalized_name=new_normalized
            ).exclude(pk=ct.pk).exists():
                raise TimelineCustomTypeDuplicateError("A custom type with this name already exists for this trip.")
            ct.name = new_name
            ct.normalized_name = new_normalized
        if "color_token" in data:
            ct.color_token = data["color_token"]
        if "icon_key" in data:
            ct.icon_key = data["icon_key"]
        if "is_active" in data:
            ct.is_active = data["is_active"]
        ct.save()
    return ct


def delete_custom_type(trip_id, type_id, *, actor) -> None:
    with transaction.atomic():
        trip = _get_locked_trip(trip_id, actor=actor)
        _ensure_captain_can_mutate(trip, actor)
        try:
            ct = TimelineCustomType.objects.select_for_update().get(pk=type_id, trip=trip)
        except TimelineCustomType.DoesNotExist:
            raise TimelineCustomTypeNotFoundError("Custom type not found.")
        if TimelineActivity.objects.filter(custom_type=ct).exists():
            raise TimelineCustomTypeInUseError("Custom type is still used by timeline activities.")
        ct.delete()
