from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from ai.action_types import (
    AI_ACTION_EXPENSE_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
    AI_ACTION_SETTLEMENT_TRANSFER_CONFIRM_RECEIVED,
    AI_CONFIRMATION_CAPTAIN,
    AI_CONFIRMATION_TIMELINE_ACTIVITY_STATUS,
    AI_CONFIRMATION_TRANSFER_PAYER,
    AI_CONFIRMATION_TRANSFER_RECIPIENT,
    CAPTAIN_MANAGED_ACTIONS,
    TIMELINE_ACTIVITY_STATUS_ACTIONS,
    TRANSFER_PAYER_ACTIONS,
    TRANSFER_RECIPIENT_ACTIONS,
)
from ai.agent.draft_fields import (
    build_missing_fields_for_action,
    normalize_missing_fields,
    normalize_missing_field_names,
)
from ai.agent.draft_presentation import build_action_draft_presentation
from ai.agent.payload_validation import missing_payload_field_names
from ai.agent.timeline_draft_validation import (
    plan_timeline_create_draft,
    plan_timeline_update_draft,
)
from ai.models import AIActionDraft, AIActionDraftStatus
from expenses.models import SettlementStatus, SettlementTransfer
from trips.models import (
    MemberStatus,
    TimelineActivity,
    TimelineActivityAssigneeScope,
    TimelineActivityStatus,
    TimelineActivityTimeMode,
    TimelineCustomType,
    TimelineLocationMode,
    TimelineSection,
    TimelineSystemType,
    Trip,
    TripMember,
    TripRole,
    TripStatus,
)
from trips.services import can_update_timeline_activity_status

FINAL_DRAFT_STATUSES = {
    AIActionDraftStatus.CONFIRMED,
    AIActionDraftStatus.CANCELLED,
    AIActionDraftStatus.EXPIRED,
    AIActionDraftStatus.FAILED,
}


def required_confirmation_for_action_type(action_type: str) -> str:
    if action_type in CAPTAIN_MANAGED_ACTIONS:
        return AI_CONFIRMATION_CAPTAIN
    if action_type in TIMELINE_ACTIVITY_STATUS_ACTIONS:
        return AI_CONFIRMATION_TIMELINE_ACTIVITY_STATUS
    if action_type in TRANSFER_PAYER_ACTIONS:
        return AI_CONFIRMATION_TRANSFER_PAYER
    if action_type in TRANSFER_RECIPIENT_ACTIONS:
        return AI_CONFIRMATION_TRANSFER_RECIPIENT
    return ""


def _effective_required_confirmation(draft: AIActionDraft) -> str:
    return draft.required_confirmation or required_confirmation_for_action_type(
        draft.action_type,
    )


def create_action_draft(
    *,
    trip,
    interaction,
    response_message=None,
    action_type: str,
    payload: dict,
    missing_fields: list | None = None,
    preconditions: dict | None = None,
    required_confirmation: str | None = None,
    status: str | None = None,
) -> AIActionDraft:
    """Persist a single AIActionDraft row from a tool handler."""
    from ai.lifecycle import summarize_draft  # avoid circular import at module level

    with transaction.atomic():
        # Keep the global AI/chat mutation order at Trip -> draft. The caller's
        # Trip instance may be stale while a worker is preparing provider output.
        locked_trip = Trip.objects.select_for_update().get(pk=trip.pk)
        payload = dict(payload)
        if action_type == AI_ACTION_EXPENSE_CREATE:
            # Expense persistence is trip-currency-only. Resolve provider input
            # before validation/display so confirmation restates the actual write.
            payload["currency_code"] = locked_trip.currency_code

        timeline_create_result = plan_timeline_create_draft(
            action_type=action_type,
            trip=locked_trip,
            payload=payload,
            lock_section=action_type == AI_ACTION_TIMELINE_ACTIVITY_CREATE,
        )
        payload = timeline_create_result.payload
        timeline_result = plan_timeline_update_draft(
            action_type=action_type,
            trip=locked_trip,
            payload=payload,
            lock_target=action_type == AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
        )
        payload = timeline_result.payload
        timeline_field_errors = {
            **timeline_create_result.field_errors,
            **timeline_result.field_errors,
        }

        if missing_fields is None:
            missing_names = missing_payload_field_names(
                action_type=action_type,
                payload=payload,
                currency_code=locked_trip.currency_code,
            )
            missing_names = list(
                dict.fromkeys(
                    [*missing_names, *timeline_field_errors.keys()]
                )
            )
            missing = build_missing_fields_for_action(
                action_type=action_type,
                payload=payload,
                missing=missing_names,
                trip_id=locked_trip.id,
            )
        else:
            missing = list(missing_fields)
            existing_missing_names = set(
                normalize_missing_field_names(missing, strict=False)
            )
            planner_missing_names = [
                name
                for name in timeline_field_errors
                if name not in existing_missing_names
            ]
            if planner_missing_names:
                missing.extend(
                    build_missing_fields_for_action(
                        action_type=action_type,
                        payload=payload,
                        missing=planner_missing_names,
                        trip_id=locked_trip.id,
                    )
                )
        if missing and status in {None, AIActionDraftStatus.READY}:
            effective_status = AIActionDraftStatus.NEEDS_INFO
        else:
            effective_status = status or AIActionDraftStatus.READY
        expires_at = timezone.now() + timedelta(
            seconds=settings.GOPLAN_AI_ACTION_DRAFT_TTL_SECONDS
        )
        preview, display = build_action_draft_presentation(
            action_type=action_type,
            payload=payload,
            trip=locked_trip,
            timeline_plan=timeline_result.plan,
            timeline_create_plan=timeline_create_result.plan,
        )
        return AIActionDraft.objects.create(
            trip=locked_trip,
            interaction=interaction,
            response_message=response_message,
            requested_by=interaction.requested_by,
            action_type=action_type,
            status=effective_status,
            payload=payload,
            preview=preview,
            display=display,
            summary=summarize_draft(
                action_type=action_type,
                payload=payload,
                status=effective_status,
            ),
            missing_fields=missing,
            preconditions=preconditions or {},
            required_confirmation=(
                required_confirmation
                or required_confirmation_for_action_type(action_type)
            ),
            expires_at=expires_at,
        )


def _effective_draft_status(draft: AIActionDraft) -> str:
    if (
        draft.status in {AIActionDraftStatus.NEEDS_INFO, AIActionDraftStatus.READY}
        and draft.expires_at <= timezone.now()
    ):
        return AIActionDraftStatus.EXPIRED
    return draft.status


def _is_active_captain(*, trip_id, user) -> bool:
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    return TripMember.objects.filter(
        trip_id=trip_id,
        user=user,
        role=TripRole.CAPTAIN,
        status=MemberStatus.ACTIVE,
    ).exists()


def _can_confirm_transfer(draft: AIActionDraft, viewer) -> bool:
    if viewer is None or not getattr(viewer, "is_authenticated", False):
        return False

    transfer = draft.preconditions.get("transfer", {})
    if not isinstance(transfer, dict):
        transfer = {}
    transfer_obj = None
    transfer_id = draft.payload.get("transfer_id")
    should_lookup_transfer = bool(transfer_id)
    if should_lookup_transfer and transfer_id:
        try:
            transfer_obj = SettlementTransfer.objects.get(
                pk=transfer_id,
                settlement__trip_id=draft.trip_id,
                settlement__status=SettlementStatus.FINALIZED,
            )
        except (
            SettlementTransfer.DoesNotExist,
            TypeError,
            ValueError,
            ValidationError,
        ):
            return False
        transfer = {
            "payer_id": str(transfer_obj.payer_id),
            "recipient_id": str(transfer_obj.recipient_id),
        }
    required_confirmation = _effective_required_confirmation(draft)
    if required_confirmation == AI_CONFIRMATION_TRANSFER_PAYER:
        return str(transfer.get("payer_id")) == str(viewer.id)
    if required_confirmation == AI_CONFIRMATION_TRANSFER_RECIPIENT:
        if (
            draft.action_type == AI_ACTION_SETTLEMENT_TRANSFER_CONFIRM_RECEIVED
            and transfer_obj is not None
            and transfer_obj.payer_marked_sent_at is None
        ):
            return False
        return str(transfer.get("recipient_id")) == str(viewer.id)
    return False


def can_confirm_action_draft(draft: AIActionDraft, *, viewer) -> bool:
    if _effective_draft_status(draft) != AIActionDraftStatus.READY:
        return False
    required_confirmation = _effective_required_confirmation(draft)
    if required_confirmation == AI_CONFIRMATION_CAPTAIN:
        return _is_active_captain(trip_id=draft.trip_id, user=viewer)
    if required_confirmation == AI_CONFIRMATION_TIMELINE_ACTIVITY_STATUS:
        return can_update_timeline_activity_status(
            trip_id=draft.trip_id,
            activity_id=draft.payload.get("activity_id"),
            actor=viewer,
            status=draft.payload.get("status"),
        )
    return _can_confirm_transfer(draft, viewer)


STATIC_CHOICE_LABELS = {
    "status": {
        "UPCOMING": "Upcoming",
        "IN_PROGRESS": "In Progress",
        "DONE": "Done",
        "CANCELLED": "Cancelled",
    },
    "time_mode": {
        "ALL_DAY": "All day",
        "FLEXIBLE": "Flexible",
        "AT_TIME": "At time",
        "TIME_RANGE": "Time range",
    },
    "location_mode": {
        "MANUAL": "Manual",
        "STRUCTURED": "Structured place",
    },
    "system_type": {
        "TRANSPORTATION": "Transportation",
        "ACCOMMODATION": "Accommodation",
        "FOOD": "Food",
        "SIGHTSEEING": "Sightseeing",
        "SHOPPING": "Shopping",
        "CHECKIN_OUT": "Check-in / Check-out",
        "FREE_TIME": "Free Time",
        "OTHER": "Other",
    },
}


def _choice_options(field_name: str, choices) -> list[dict]:
    return [
        {
            "value": value,
            "label": STATIC_CHOICE_LABELS.get(field_name, {}).get(value, str(label)),
        }
        for value, label in choices
    ]


STATIC_FIELD_OPTIONS = {
    "status": _choice_options("status", TimelineActivityStatus.choices),
    "time_mode": _choice_options("time_mode", TimelineActivityTimeMode.choices),
    "location_mode": _choice_options("location_mode", TimelineLocationMode.choices),
    "system_type": _choice_options("system_type", TimelineSystemType.choices),
}


def _member_label(member: TripMember) -> str:
    user = member.user
    display_name = user.display_name or user.email
    if user.identify_tag:
        return f"{display_name} ({user.identify_tag})"
    return display_name


def _active_member_options(*, trip_id) -> list[dict]:
    return [
        {"value": str(member.user_id), "label": _member_label(member)}
        for member in (
            TripMember.objects
            .select_related("user")
            .filter(trip_id=trip_id, status=MemberStatus.ACTIVE)
            .order_by("role", "joined_at")
        )
    ]


def _timeline_section_options(*, trip_id) -> list[dict]:
    return [
        {
            "value": str(section.id),
            "label": f"{section.label} ({section.section_date.isoformat()})",
        }
        for section in TimelineSection.objects.filter(trip_id=trip_id)
    ]


def _transfer_label(transfer: SettlementTransfer) -> str:
    return (
        f"{transfer.payer.display_name} → "
        f"{transfer.recipient.display_name}: {transfer.amount}"
    )


def _settlement_transfer_options(*, trip_id) -> list[dict]:
    return [
        {"value": str(transfer.id), "label": _transfer_label(transfer)}
        for transfer in (
            SettlementTransfer.objects
            .select_related("payer", "recipient")
            .filter(
                settlement__trip_id=trip_id,
                settlement__status=SettlementStatus.FINALIZED,
            )
        )
    ]


def _custom_type_options(*, trip_id) -> list[dict]:
    return [
        {"value": str(custom_type.id), "label": custom_type.name}
        for custom_type in TimelineCustomType.objects.filter(
            trip_id=trip_id,
            is_active=True,
        )
    ]


def _enrich_missing_field(field: dict, *, draft: AIActionDraft) -> dict:
    enriched = dict(field)
    name = enriched.get("name")
    if name in {"activity_id", "expense_id"}:
        enriched["type"] = "target"
        return enriched
    if name in STATIC_FIELD_OPTIONS:
        enriched["type"] = "select"
        enriched["options"] = STATIC_FIELD_OPTIONS[name]
        return enriched
    if name == "section_id":
        enriched["type"] = "select"
        enriched["options"] = _timeline_section_options(trip_id=draft.trip_id)
        return enriched
    if name in {"user_id", "collector_id", "payer_id", "assignee_user_id"}:
        enriched["type"] = "select"
        enriched["options"] = _active_member_options(trip_id=draft.trip_id)
        return enriched
    if name == "transfer_id":
        enriched["type"] = "select"
        enriched["options"] = _settlement_transfer_options(trip_id=draft.trip_id)
        return enriched
    if name == "custom_type_id":
        enriched["type"] = "select"
        enriched["options"] = _custom_type_options(trip_id=draft.trip_id)
        return enriched
    if name in {"data", "place"}:
        enriched["type"] = "json"
        return enriched
    return enriched


def can_cancel_action_draft(draft: AIActionDraft, *, viewer) -> bool:
    if _effective_draft_status(draft) in FINAL_DRAFT_STATUSES:
        return False
    if viewer is None or not getattr(viewer, "is_authenticated", False):
        return False
    if str(draft.requested_by_id) == str(viewer.id):
        return True
    required_confirmation = _effective_required_confirmation(draft)
    if required_confirmation == AI_CONFIRMATION_CAPTAIN:
        return _is_active_captain(trip_id=draft.trip_id, user=viewer)
    return can_confirm_action_draft(draft, viewer=viewer)


def _can_edit_timeline_status_draft(draft: AIActionDraft, viewer) -> bool:
    if viewer is None or not getattr(viewer, "is_authenticated", False):
        return False
    activity_id = draft.payload.get("activity_id")
    if not activity_id:
        return False
    try:
        activity = TimelineActivity.objects.select_related("trip").get(
            pk=activity_id,
            trip_id=draft.trip_id,
            trip__status__in={TripStatus.PLANNING, TripStatus.ONGOING},
        )
    except (
        TimelineActivity.DoesNotExist,
        TypeError,
        ValueError,
        ValidationError,
    ):
        return False
    if _is_active_captain(trip_id=draft.trip_id, user=viewer):
        return True
    if not TripMember.objects.filter(
        trip_id=draft.trip_id,
        user=viewer,
        status=MemberStatus.ACTIVE,
    ).exists():
        return False
    if activity.assignee_scope == TimelineActivityAssigneeScope.EVERYONE:
        return True
    return (
        activity.assignee_scope == TimelineActivityAssigneeScope.USER
        and activity.assignee_user_id == viewer.id
    )


def can_edit_action_draft(draft: AIActionDraft, *, viewer) -> bool:
    if _effective_draft_status(draft) != AIActionDraftStatus.NEEDS_INFO:
        return False
    if viewer is None or not getattr(viewer, "is_authenticated", False):
        return False
    if str(draft.requested_by_id) == str(viewer.id):
        return True
    required_confirmation = _effective_required_confirmation(draft)
    if required_confirmation == AI_CONFIRMATION_CAPTAIN:
        return _is_active_captain(trip_id=draft.trip_id, user=viewer)
    if required_confirmation == AI_CONFIRMATION_TIMELINE_ACTIVITY_STATUS:
        return _can_edit_timeline_status_draft(draft, viewer)
    return _can_confirm_transfer(draft, viewer)


def build_action_draft_payload(draft: AIActionDraft, *, viewer) -> dict:
    status = _effective_draft_status(draft)
    missing_fields = [
        _enrich_missing_field(field, draft=draft)
        for field in normalize_missing_fields(draft.missing_fields, strict=False)
    ]
    return {
        "id": str(draft.id),
        "action_type": draft.action_type,
        "status": status,
        "required_confirmation": _effective_required_confirmation(draft),
        "can_confirm": can_confirm_action_draft(draft, viewer=viewer),
        "can_cancel": can_cancel_action_draft(draft, viewer=viewer),
        "can_edit": can_edit_action_draft(draft, viewer=viewer),
        "display": draft.display,
        "summary": draft.summary,
        "preview": draft.preview,
        "missing_fields": missing_fields,
        "result": draft.result,
        "error_code": draft.error_code,
        "error_detail": draft.error_detail,
        "expires_at": draft.expires_at.isoformat(),
        "created_at": draft.created_at.isoformat(),
        "updated_at": draft.updated_at.isoformat(),
    }
