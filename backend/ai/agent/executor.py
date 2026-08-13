from __future__ import annotations

from datetime import datetime, time
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime, parse_time

from ai.action_types import (
    AI_ACTION_EXPENSE_CONTRIBUTION_SET,
    AI_ACTION_EXPENSE_CREATE,
    AI_ACTION_EXPENSE_DELETE,
    AI_ACTION_EXPENSE_UPDATE,
    AI_ACTION_SETTLEMENT_FINALIZE,
    AI_ACTION_SETTLEMENT_REOPEN,
    AI_ACTION_SETTLEMENT_TRANSFER_CONFIRM_RECEIVED,
    AI_ACTION_SETTLEMENT_TRANSFER_MARK_SENT,
    AI_ACTION_TIMELINE_ACTIVITY_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_DELETE,
    AI_ACTION_TIMELINE_ACTIVITY_STATUS_UPDATE,
    AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
)
from ai.agent.drafts import can_confirm_action_draft
from ai.agent.timeline_draft_validation import (
    plan_timeline_create_draft,
    plan_timeline_update_draft,
)
from ai.agent.payload_validation import (
    TIMELINE_ACTIVITY_DATA_FIELDS,
    missing_payload_field_names,
)
from ai.agent.preconditions import expected_precondition_target
from ai.chat_changes import (
    lock_active_trip_member_for_ai_action,
    lock_trip_for_ai_chat_change,
    mark_ai_response_message_changed,
)
from ai.models import AIActionDraft, AIActionDraftStatus
from expenses.models import Expense
from expenses.services import (
    confirm_transfer_received,
    create_expense,
    delete_expense,
    finalize_settlement,
    mark_transfer_sent,
    reopen_settlement,
    set_contribution,
    update_expense,
)
from trips.models import (
    TimelineActivity,
    TimelineSection,
    Trip,
    TripMember,
    TripStatus,
)
from trips.services import (
    TimelineSectionDateConflictError,
    TripTerminalError,
    create_timeline_activity,
    create_timeline_day,
    delete_timeline_activity,
    patch_timeline_activity,
    update_timeline_activity_status,
)


class AIActionDraftError(Exception):
    error_code = "AI_DRAFT_ERROR"


class AIActionDraftForbiddenError(AIActionDraftError):
    error_code = "AI_DRAFT_FORBIDDEN"


class AIActionDraftNotReadyError(AIActionDraftError):
    error_code = "AI_DRAFT_NOT_READY"


class AIActionDraftExpiredError(AIActionDraftError):
    error_code = "AI_DRAFT_EXPIRED"


class AIActionDraftStaleError(AIActionDraftError):
    error_code = "AI_DRAFT_STALE"


def _parse_aware_datetime(value: str):
    parsed = parse_datetime(value)
    if parsed is None:
        return None
    if timezone.is_naive(parsed):
        return timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _check_object_precondition(*, current_updated_at, expected_updated_at) -> None:
    expected = _parse_aware_datetime(str(expected_updated_at))
    if expected is None:
        raise AIActionDraftStaleError("Draft precondition is invalid.")
    if current_updated_at > expected:
        raise AIActionDraftStaleError(
            "Draft target changed. Ask GoPlanAI to regenerate it."
        )


def _check_preconditions(draft: AIActionDraft):
    expected_target = expected_precondition_target(
        action_type=draft.action_type,
        payload=draft.payload,
    )
    if expected_target is None:
        return

    target = draft.preconditions.get("target", {})
    if not isinstance(target, dict) or not target:
        raise AIActionDraftStaleError("Draft target precondition is missing.")

    target_type = target.get("type")
    target_id = target.get("id")
    expected_updated_at = target.get("updated_at")
    if (
        target_type != expected_target.target_type
        or str(target_id) != str(expected_target.target_id)
        or not expected_updated_at
    ):
        raise AIActionDraftStaleError(
            "Draft target precondition does not match payload."
        )

    if target_type == "expense":
        try:
            expense = Expense.objects.select_for_update().get(
                pk=expected_target.target_id,
                trip_id=draft.trip_id,
            )
        except Expense.DoesNotExist as exc:
            raise AIActionDraftStaleError("Draft target no longer exists.") from exc
        _check_object_precondition(
            current_updated_at=expense.updated_at,
            expected_updated_at=expected_updated_at,
        )
        return expense

    if target_type == "timeline_activity":
        try:
            activity = (
                TimelineActivity.objects.select_for_update(of=("self",))
                .select_related("section", "custom_type", "assignee_user")
                .prefetch_related("reminders")
                .get(
                    pk=expected_target.target_id,
                    trip_id=draft.trip_id,
                )
            )
        except TimelineActivity.DoesNotExist as exc:
            raise AIActionDraftStaleError("Draft target no longer exists.") from exc
        _check_object_precondition(
            current_updated_at=activity.updated_at,
            expected_updated_at=expected_updated_at,
        )
        return activity

    raise AIActionDraftStaleError("Draft target precondition is unsupported.")


def _validate_action_payload_ready(draft: AIActionDraft) -> None:
    if draft.action_type == AI_ACTION_EXPENSE_CREATE:
        payload_currency = str(draft.payload.get("currency_code") or "").upper()
        trip_currency = str(draft.trip.currency_code).upper()
        if payload_currency and payload_currency != trip_currency:
            raise AIActionDraftNotReadyError(
                "Draft currency does not match the trip currency."
            )

    missing_names = missing_payload_field_names(
        action_type=draft.action_type,
        payload=draft.payload,
        currency_code=draft.trip.currency_code,
    )
    if missing_names:
        raise AIActionDraftNotReadyError(
            f"Draft is missing required field: {missing_names[0]}."
        )


LEGACY_TIMELINE_SYSTEM_TYPES = {
    "DINING": "FOOD",
    "TRANSPORT": "TRANSPORTATION",
    "NIGHTLIFE": "OTHER",
}

LEGACY_TIMELINE_TIME_MODES = {
    "ANCHOR": "AT_TIME",
}

LEGACY_TIMELINE_ASSIGNEE_SCOPES = {
    "GROUP": "EVERYONE",
}


def _normalize_clock_time(value):
    if value is None:
        return value
    if isinstance(value, datetime):
        return value.time().replace(tzinfo=None, microsecond=0).isoformat()
    if isinstance(value, time):
        return value.replace(tzinfo=None, microsecond=0).isoformat()
    if not isinstance(value, str):
        return value

    parsed_datetime = parse_datetime(value)
    if parsed_datetime is not None:
        return parsed_datetime.time().replace(tzinfo=None, microsecond=0).isoformat()

    parsed_time = parse_time(value)
    if parsed_time is not None:
        return parsed_time.replace(tzinfo=None, microsecond=0).isoformat()

    return value


def _normalize_timeline_activity_data(data: dict) -> dict:
    normalized = dict(data)
    system_type = normalized.get("system_type")
    if system_type in LEGACY_TIMELINE_SYSTEM_TYPES:
        normalized["system_type"] = LEGACY_TIMELINE_SYSTEM_TYPES[system_type]

    time_mode = normalized.get("time_mode")
    if time_mode in LEGACY_TIMELINE_TIME_MODES:
        normalized["time_mode"] = LEGACY_TIMELINE_TIME_MODES[time_mode]

    assignee_scope = normalized.get("assignee_scope")
    if assignee_scope in LEGACY_TIMELINE_ASSIGNEE_SCOPES:
        normalized["assignee_scope"] = LEGACY_TIMELINE_ASSIGNEE_SCOPES[assignee_scope]

    for field in ("start_time", "end_time"):
        if field in normalized:
            normalized[field] = _normalize_clock_time(normalized[field])

    return normalized


def _normalized_timeline_activity_payload(*, action_type: str, payload: dict) -> dict:
    if action_type not in {
        AI_ACTION_TIMELINE_ACTIVITY_CREATE,
        AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
    }:
        return payload
    if isinstance(payload.get("data"), dict):
        normalized_data = _normalize_timeline_activity_data(payload["data"])
        if normalized_data == payload["data"]:
            return payload
        return {**payload, "data": normalized_data}

    data = {
        field: payload[field]
        for field in TIMELINE_ACTIVITY_DATA_FIELDS
        if field in payload
    }
    if not data:
        return payload
    data = _normalize_timeline_activity_data(data)

    normalized = {
        key: value
        for key, value in payload.items()
        if key not in TIMELINE_ACTIVITY_DATA_FIELDS
    }
    normalized["data"] = data
    return normalized


def _resolve_contribution_user_id(*, trip_id, payload: dict):
    target_id = (
        payload.get("user_id")
        or payload.get("target_user_id")
        or payload.get("member_id")
        or payload.get("payer_id")
        or payload.get("collector_id")
    )
    if not target_id:
        raise AIActionDraftNotReadyError("Contribution target user is required.")

    if TripMember.objects.filter(trip_id=trip_id, user_id=target_id).exists():
        return target_id

    membership = TripMember.objects.filter(pk=target_id, trip_id=trip_id).first()
    if membership is not None:
        return membership.user_id

    return target_id


def _contribution_amount(payload: dict):
    for field in ("amount", "paid_amount", "contribution_amount"):
        if field in payload:
            return payload[field]
    raise AIActionDraftNotReadyError("Contribution amount is required.")


def _normalize_contribution_payload(
    raw_payload,
    *,
    expense_id,
    fallback_user_id=None,
) -> dict:
    if isinstance(raw_payload, dict):
        return {
            **raw_payload,
            "expense_id": expense_id,
            "user_id": (
                raw_payload.get("user_id")
                or raw_payload.get("target_user_id")
                or raw_payload.get("member_id")
                or fallback_user_id
            ),
            "amount": _contribution_amount(raw_payload),
        }
    return {
        "expense_id": expense_id,
        "user_id": fallback_user_id,
        "amount": raw_payload,
    }


def _extract_explicit_contribution_payloads(payload: dict) -> list[dict]:
    expense_id = payload["expense_id"]
    contributions = payload.get("contributions")
    if isinstance(contributions, list) and contributions:
        return [
            _normalize_contribution_payload(
                contribution_payload,
                expense_id=expense_id,
            )
            for contribution_payload in contributions
        ]

    member_contributions = payload.get("member_contributions")
    if isinstance(member_contributions, dict) and member_contributions:
        return [
            _normalize_contribution_payload(
                contribution_payload,
                expense_id=expense_id,
                fallback_user_id=member_id,
            )
            for member_id, contribution_payload in member_contributions.items()
        ]

    return []


def _should_mark_all_participants_paid(payload: dict) -> bool:
    return str(payload.get("scope", "")).lower() in {
        "all_participants_paid",
        "all_participants",
        "everyone_paid",
    }


def _build_all_participant_share_payloads(*, draft: AIActionDraft, payload: dict) -> list[dict]:
    try:
        expense = (
            Expense.objects
            .prefetch_related("participants")
            .get(pk=payload["expense_id"], trip_id=draft.trip_id)
        )
    except Expense.DoesNotExist as exc:
        raise AIActionDraftStaleError("Draft target no longer exists.") from exc

    return [
        {
            "expense_id": payload["expense_id"],
            "user_id": str(participant.user_id),
            "amount": str(participant.share_amount),
        }
        for participant in expense.participants.all()
    ]


def _set_single_contribution(*, draft: AIActionDraft, actor, payload: dict):
    return set_contribution(
        trip_id=draft.trip_id,
        expense_id=payload["expense_id"],
        target_user_id=_resolve_contribution_user_id(
            trip_id=draft.trip_id,
            payload=payload,
        ),
        actor=actor,
        amount=Decimal(str(_contribution_amount(payload))),
    )


def _parse_section_date(value):
    if value is None:
        return None
    parsed = parse_date(str(value))
    if parsed is None:
        raise AIActionDraftNotReadyError("Timeline day date is required.")
    return parsed


def _timeline_section_label_for_date(*, trip: Trip, section_date) -> str:
    if trip.start_date:
        day_number = (section_date - trip.start_date).days + 1
        return f"Day {day_number}"
    return section_date.isoformat()


def _resolve_timeline_activity_section_id(
    *,
    draft: AIActionDraft,
    actor,
    payload: dict,
):
    if payload.get("section_id"):
        return payload["section_id"]

    section_date = _parse_section_date(payload.get("section_date"))
    if section_date is None:
        raise AIActionDraftNotReadyError("Timeline day is required.")

    section = TimelineSection.objects.filter(
        trip_id=draft.trip_id,
        section_date=section_date,
    ).first()
    if section is not None:
        return section.id

    label = _timeline_section_label_for_date(
        trip=draft.trip,
        section_date=section_date,
    )
    try:
        _, section = create_timeline_day(
            draft.trip_id,
            actor=actor,
            section_date=section_date,
            label=label,
        )
    except TimelineSectionDateConflictError:
        section = TimelineSection.objects.get(
            trip_id=draft.trip_id,
            section_date=section_date,
        )
    return section.id


def _execute(draft: AIActionDraft, *, actor) -> dict:
    payload = draft.payload
    if draft.action_type == AI_ACTION_EXPENSE_CREATE:
        expense = create_expense(
            trip_id=draft.trip_id,
            actor=actor,
            title=payload["title"],
            description=payload.get("description", ""),
            total_amount=Decimal(str(payload["total_amount"])),
            collector_id=payload.get("collector_id"),
        )
        return {"object_type": "expense", "object_id": str(expense.id)}

    if draft.action_type == AI_ACTION_EXPENSE_UPDATE:
        expense = update_expense(
            trip_id=draft.trip_id,
            expense_id=payload["expense_id"],
            actor=actor,
            title=payload.get("title"),
            description=payload.get("description"),
            total_amount=(
                Decimal(str(payload["total_amount"]))
                if "total_amount" in payload
                else None
            ),
            collector_id=payload.get("collector_id"),
            update_collector="collector_id" in payload,
        )
        return {"object_type": "expense", "object_id": str(expense.id)}

    if draft.action_type == AI_ACTION_EXPENSE_DELETE:
        delete_expense(
            trip_id=draft.trip_id,
            expense_id=payload["expense_id"],
            actor=actor,
        )
        return {
            "object_type": "expense",
            "object_id": payload["expense_id"],
            "deleted": True,
        }

    if draft.action_type == AI_ACTION_EXPENSE_CONTRIBUTION_SET:
        contribution_payloads = _extract_explicit_contribution_payloads(payload)
        if not contribution_payloads and _should_mark_all_participants_paid(payload):
            contribution_payloads = _build_all_participant_share_payloads(
                draft=draft,
                payload=payload,
            )

        if contribution_payloads:
            updated = []
            for contribution_payload in contribution_payloads:
                contribution = _set_single_contribution(
                    draft=draft,
                    actor=actor,
                    payload=contribution_payload,
                )
                updated.append(str(contribution.id))
            return {
                "object_type": "expense_contribution_batch",
                "object_ids": updated,
                "updated_count": len(updated),
            }

        contribution = _set_single_contribution(
            draft=draft,
            actor=actor,
            payload=payload,
        )
        return {
            "object_type": "expense_contribution",
            "object_id": str(contribution.id),
        }

    if draft.action_type == AI_ACTION_TIMELINE_ACTIVITY_CREATE:
        section_id = _resolve_timeline_activity_section_id(
            draft=draft,
            actor=actor,
            payload=payload,
        )
        activity = create_timeline_activity(
            draft.trip_id,
            section_id,
            actor=actor,
            data=payload["data"],
        )
        return {"object_type": "timeline_activity", "object_id": str(activity.id)}

    if draft.action_type == AI_ACTION_TIMELINE_ACTIVITY_UPDATE:
        activity = patch_timeline_activity(
            draft.trip_id,
            payload["activity_id"],
            actor=actor,
            data=payload["data"],
        )
        return {"object_type": "timeline_activity", "object_id": str(activity.id)}

    if draft.action_type == AI_ACTION_TIMELINE_ACTIVITY_DELETE:
        delete_timeline_activity(
            draft.trip_id,
            payload["activity_id"],
            actor=actor,
        )
        return {
            "object_type": "timeline_activity",
            "object_id": payload["activity_id"],
            "deleted": True,
        }

    if draft.action_type == AI_ACTION_TIMELINE_ACTIVITY_STATUS_UPDATE:
        activity = update_timeline_activity_status(
            draft.trip_id,
            payload["activity_id"],
            actor=actor,
            status=payload["status"],
        )
        return {
            "object_type": "timeline_activity",
            "object_id": str(activity.id),
            "status": activity.status,
        }

    if draft.action_type == AI_ACTION_SETTLEMENT_FINALIZE:
        settlement = finalize_settlement(trip_id=draft.trip_id, actor=actor)
        return {"object_type": "settlement", "object_id": str(settlement.id)}

    if draft.action_type == AI_ACTION_SETTLEMENT_REOPEN:
        settlement = reopen_settlement(trip_id=draft.trip_id, actor=actor)
        return {
            "object_type": "settlement",
            "object_id": str(settlement.id),
            "status": settlement.status,
        }

    if draft.action_type == AI_ACTION_SETTLEMENT_TRANSFER_MARK_SENT:
        transfer = mark_transfer_sent(
            trip_id=draft.trip_id,
            transfer_id=payload["transfer_id"],
            actor=actor,
        )
        return {"object_type": "settlement_transfer", "object_id": str(transfer.id)}

    if draft.action_type == AI_ACTION_SETTLEMENT_TRANSFER_CONFIRM_RECEIVED:
        transfer = confirm_transfer_received(
            trip_id=draft.trip_id,
            transfer_id=payload["transfer_id"],
            actor=actor,
        )
        return {"object_type": "settlement_transfer", "object_id": str(transfer.id)}

    raise AIActionDraftNotReadyError("Unsupported draft action.")


def mark_action_draft_failed(
    *,
    draft_id,
    trip_id,
    error_code: str,
    error_detail: str,
) -> AIActionDraft | None:
    with transaction.atomic():
        try:
            locked_trip = lock_trip_for_ai_chat_change(trip_id=trip_id)
        except Trip.DoesNotExist:
            return None
        try:
            draft = (
                AIActionDraft.objects
                .select_for_update(of=("self",))
                .select_related("response_message")
                .get(pk=draft_id, trip_id=trip_id)
            )
        except AIActionDraft.DoesNotExist:
            return None
        if locked_trip.status in {TripStatus.COMPLETED, TripStatus.CANCELLED}:
            return draft
        if draft.status != AIActionDraftStatus.READY:
            return draft
        draft.status = AIActionDraftStatus.FAILED
        draft.error_code = error_code[:64]
        draft.error_detail = error_detail[:255]
        draft.save(
            update_fields=[
                "status",
                "error_code",
                "error_detail",
                "updated_at",
            ]
        )
        if draft.response_message_id is not None:
            mark_ai_response_message_changed(
                message=draft.response_message,
                locked_trip=locked_trip,
            )
        return draft


def confirm_action_draft(*, draft_id, trip_id, actor) -> AIActionDraft:
    expired = False
    with transaction.atomic():
        try:
            locked_trip = lock_trip_for_ai_chat_change(trip_id=trip_id)
        except Trip.DoesNotExist as exc:
            raise AIActionDraft.DoesNotExist from exc
        try:
            lock_active_trip_member_for_ai_action(
                locked_trip=locked_trip,
                actor=actor,
            )
        except TripMember.DoesNotExist as exc:
            raise AIActionDraft.DoesNotExist from exc
        draft = (
            AIActionDraft.objects
            .select_for_update(of=("self",))
            .select_related("response_message")
            .get(pk=draft_id, trip_id=trip_id)
        )
        draft.trip = locked_trip
        if draft.status == AIActionDraftStatus.CONFIRMED:
            return draft
        if locked_trip.status in {TripStatus.COMPLETED, TripStatus.CANCELLED}:
            raise TripTerminalError("Completed or cancelled trips are read-only.")
        if draft.status != AIActionDraftStatus.READY:
            raise AIActionDraftNotReadyError("Draft is not ready.")
        if draft.expires_at <= timezone.now():
            expired = True
            draft.status = AIActionDraftStatus.EXPIRED
            draft.save(update_fields=["status", "updated_at"])
            if draft.response_message_id is not None:
                mark_ai_response_message_changed(
                    message=draft.response_message,
                    locked_trip=locked_trip,
                )
        else:
            original_payload = draft.payload
            normalized_payload = _normalized_timeline_activity_payload(
                action_type=draft.action_type,
                payload=draft.payload,
            )
            if normalized_payload != draft.payload:
                draft.payload = normalized_payload
            _validate_action_payload_ready(draft)
            if not can_confirm_action_draft(draft, viewer=actor):
                raise AIActionDraftForbiddenError("You cannot confirm this draft.")

            locked_target = _check_preconditions(draft)
            timeline_create_result = plan_timeline_create_draft(
                action_type=draft.action_type,
                trip=locked_trip,
                payload=draft.payload,
                lock_section=True,
            )
            if timeline_create_result.field_errors:
                first_error = next(
                    iter(timeline_create_result.field_errors.values())
                )
                raise AIActionDraftNotReadyError(first_error)
            draft.payload = timeline_create_result.payload
            timeline_result = plan_timeline_update_draft(
                action_type=draft.action_type,
                trip=locked_trip,
                payload=draft.payload,
                lock_target=False,
                activity=(
                    locked_target
                    if isinstance(locked_target, TimelineActivity)
                    else None
                ),
            )
            if timeline_result.field_errors:
                first_error = next(iter(timeline_result.field_errors.values()))
                raise AIActionDraftNotReadyError(first_error)
            draft.payload = timeline_result.payload
            payload_normalized = draft.payload != original_payload
            result = _execute(draft, actor=actor)
            draft.status = AIActionDraftStatus.CONFIRMED
            draft.confirmed_by = actor
            draft.confirmed_at = timezone.now()
            draft.result = result
            update_fields = [
                "status",
                "confirmed_by",
                "confirmed_at",
                "result",
                "updated_at",
            ]
            if payload_normalized:
                update_fields.append("payload")
            draft.save(update_fields=update_fields)
            if draft.response_message_id is not None:
                mark_ai_response_message_changed(
                    message=draft.response_message,
                    locked_trip=locked_trip,
                )
    if expired:
        raise AIActionDraftExpiredError("Draft expired.")
    return draft
