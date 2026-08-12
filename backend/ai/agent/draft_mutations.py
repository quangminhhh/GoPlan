from __future__ import annotations

from django.db import transaction
from django.utils import timezone

from ai.action_types import (
    AI_ACTION_EXPENSE_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
)
from ai.agent.draft_fields import (
    build_missing_fields_for_action,
    normalize_missing_fields,
    normalize_missing_field_names,
)
from ai.agent.draft_presentation import build_action_draft_presentation
from ai.agent.timeline_draft_validation import (
    plan_timeline_create_draft,
    plan_timeline_update_draft,
)
from ai.agent.drafts import (
    can_cancel_action_draft,
    can_edit_action_draft,
)
from ai.agent.draft_validation import (
    AIActionDraftFieldValidationError,
    validate_action_draft_patch_payload,
    validate_action_draft_patch_shape,
)
from ai.agent.executor import (
    AIActionDraftExpiredError,
    AIActionDraftForbiddenError,
    AIActionDraftNotReadyError,
)
from ai.agent.payload_validation import (
    TIMELINE_ACTIVITY_DATA_FIELDS,
    missing_payload_field_names,
)
from ai.agent.preconditions import (
    action_requires_stale_precondition,
    build_backend_preconditions,
)
from ai.chat_changes import (
    lock_active_trip_member_for_ai_action,
    lock_trip_for_ai_chat_change,
    mark_ai_response_message_changed,
)
from ai.models import AIActionDraft, AIActionDraftStatus
from trips.models import Trip, TripMember


class AIActionDraftPatchFieldNotAllowedError(Exception):
    error_code = "AI_DRAFT_PATCH_FIELD_NOT_ALLOWED"

    def __init__(self, fields: list[str]) -> None:
        self.fields = fields
        super().__init__(
            "Only fields currently requested by this draft can be updated. "
            f"Unsupported field(s): {', '.join(fields)}."
        )


class AIActionDraftTargetNotFoundError(Exception):
    error_code = "AI_DRAFT_TARGET_NOT_FOUND"


def _build_patch_preview(*, action_type: str, payload: dict) -> dict:
    preview = {
        key: value
        for key, value in payload.items()
        if key != "data"
    }
    data = payload.get("data")
    if isinstance(data, dict):
        preview.update(data)
    if action_type:
        preview["action_type"] = action_type
    return preview


def _apply_draft_patch_payload(draft: AIActionDraft, patch_payload: dict) -> dict:
    next_payload = dict(draft.payload)
    if draft.action_type in {
        AI_ACTION_TIMELINE_ACTIVITY_CREATE,
        AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
    }:
        existing_data = next_payload.get("data")
        legacy_data = {
            key: next_payload.pop(key)
            for key in tuple(next_payload)
            if key in TIMELINE_ACTIVITY_DATA_FIELDS
        }
        data = {
            **legacy_data,
            **(dict(existing_data) if isinstance(existing_data, dict) else {}),
        }
        data_overridden = False
        for key, value in patch_payload.items():
            if key == "data":
                continue
            if key in TIMELINE_ACTIVITY_DATA_FIELDS:
                data[key] = value
            else:
                next_payload[key] = value
        if "data" in patch_payload:
            nested_patch = patch_payload["data"]
            if isinstance(nested_patch, dict):
                # The canonical wrapper wins when a legacy client submits both
                # representations, independent of JSON object key order.
                data.update(nested_patch)
            else:
                next_payload["data"] = nested_patch
                data_overridden = True
        if not data_overridden:
            next_payload["data"] = data
        return next_payload
    return {**next_payload, **patch_payload}


def _allowed_patch_fields(draft: AIActionDraft) -> set[str]:
    allowed_fields = set(
        normalize_missing_field_names(
            draft.missing_fields,
            strict=False,
        )
    )
    for field in normalize_missing_fields(draft.missing_fields, strict=False):
        if field.get("name") != "time_range":
            continue
        constraints = field.get("constraints")
        pair = constraints.get("pair") if isinstance(constraints, dict) else None
        if isinstance(pair, list):
            allowed_fields.update(str(name) for name in pair if name)
        else:
            allowed_fields.update({"start_time", "end_time"})
    allowed_fields.difference_update({"activity_id", "expense_id"})
    return allowed_fields


def _disallowed_patch_fields(draft: AIActionDraft, patch_payload: dict) -> list[str]:
    allowed_fields = _allowed_patch_fields(draft)
    return sorted(
        field_name
        for field_name in patch_payload.keys()
        if field_name not in allowed_fields
    )


def _refresh_missing_fields(
    draft: AIActionDraft,
    payload: dict,
    *,
    currency_code: str,
) -> list[dict]:
    current_missing_names = normalize_missing_field_names(
        draft.missing_fields,
        strict=False,
    )
    missing_names = missing_payload_field_names(
        action_type=draft.action_type,
        payload=payload,
        provider_missing_names=current_missing_names,
        currency_code=currency_code,
    )
    return build_missing_fields_for_action(
        action_type=draft.action_type,
        payload=payload,
        missing=missing_names,
        trip_id=draft.trip_id,
    )


def _lock_trip_or_raise_draft_missing(*, trip_id) -> Trip:
    try:
        return lock_trip_for_ai_chat_change(trip_id=trip_id)
    except Trip.DoesNotExist as exc:
        raise AIActionDraft.DoesNotExist from exc


def _lock_actor_or_raise_draft_missing(*, locked_trip: Trip, actor) -> None:
    try:
        lock_active_trip_member_for_ai_action(
            locked_trip=locked_trip,
            actor=actor,
        )
    except TripMember.DoesNotExist as exc:
        raise AIActionDraft.DoesNotExist from exc


def _touch_response_message(*, draft: AIActionDraft, locked_trip: Trip) -> None:
    if draft.response_message_id is None:
        return
    mark_ai_response_message_changed(
        message=draft.response_message,
        locked_trip=locked_trip,
    )


def _expire_draft(*, draft: AIActionDraft, locked_trip: Trip) -> None:
    draft.status = AIActionDraftStatus.EXPIRED
    draft.save(update_fields=["status", "updated_at"])
    _touch_response_message(draft=draft, locked_trip=locked_trip)


def _timeline_activity_preconditions(activity) -> dict:
    return {
        "target": {
            "type": "timeline_activity",
            "id": str(activity.id),
            "updated_at": activity.updated_at.isoformat(),
            "title": activity.title,
            "status": activity.status,
        }
    }


def patch_action_draft(
    *,
    draft_id,
    trip_id,
    actor,
    patch_payload: dict,
) -> AIActionDraft:
    expired = False
    with transaction.atomic():
        locked_trip = _lock_trip_or_raise_draft_missing(trip_id=trip_id)
        _lock_actor_or_raise_draft_missing(
            locked_trip=locked_trip,
            actor=actor,
        )
        draft = (
            AIActionDraft.objects.select_for_update(of=("self",))
            .select_related("response_message")
            .get(pk=draft_id, trip_id=trip_id)
        )
        validate_action_draft_patch_shape(
            draft=draft,
            patch_payload=patch_payload,
        )
        next_payload = (
            _apply_draft_patch_payload(draft, patch_payload)
            if patch_payload
            else draft.payload
        )
        validate_action_draft_patch_payload(
            draft=draft,
            patch_payload=patch_payload,
            currency_code=locked_trip.currency_code,
            candidate_payload=next_payload,
        )

        if (
            draft.status in {AIActionDraftStatus.NEEDS_INFO, AIActionDraftStatus.READY}
            and draft.expires_at <= timezone.now()
        ):
            _expire_draft(draft=draft, locked_trip=locked_trip)
            expired = True
        elif draft.status != AIActionDraftStatus.NEEDS_INFO:
            raise AIActionDraftNotReadyError(
                "Draft is not waiting for more information."
            )
        else:
            if not can_edit_action_draft(draft, viewer=actor):
                raise AIActionDraftForbiddenError("You cannot update this draft.")

            disallowed_fields = _disallowed_patch_fields(draft, patch_payload)
            if disallowed_fields:
                raise AIActionDraftPatchFieldNotAllowedError(disallowed_fields)

            if not patch_payload:
                return draft

            expense_currency_changed = (
                draft.action_type == AI_ACTION_EXPENSE_CREATE
                and next_payload.get("currency_code")
                != locked_trip.currency_code
            )
            if draft.action_type == AI_ACTION_EXPENSE_CREATE:
                # Expense persistence is trip-currency-only. A draft can wait
                # for input while the trip currency changes, so restamp the
                # locked authoritative value on every explicit edit.
                next_payload["currency_code"] = locked_trip.currency_code

            if next_payload == draft.payload:
                return draft

            timeline_create_result = plan_timeline_create_draft(
                action_type=draft.action_type,
                trip=locked_trip,
                payload=next_payload,
                lock_section=True,
            )
            patched_field_names = set(patch_payload)
            nested_patch = patch_payload.get("data")
            if isinstance(nested_patch, dict):
                patched_field_names.update(nested_patch)
            blocking_create_errors = {
                field: message
                for field, message
                in timeline_create_result.blocking_field_errors.items()
                if field in patched_field_names
            }
            if blocking_create_errors:
                raise AIActionDraftFieldValidationError(
                    blocking_create_errors
                )
            next_payload = timeline_create_result.payload

            timeline_result = plan_timeline_update_draft(
                action_type=draft.action_type,
                trip=locked_trip,
                payload=next_payload,
                lock_target=True,
            )
            if timeline_result.field_errors:
                raise AIActionDraftFieldValidationError(
                    timeline_result.field_errors
                )
            next_payload = timeline_result.payload

            still_missing = _refresh_missing_fields(
                draft,
                next_payload,
                currency_code=locked_trip.currency_code,
            )
            existing_missing_names = set(
                normalize_missing_field_names(still_missing, strict=False)
            )
            create_planner_missing = [
                field
                for field in timeline_create_result.field_errors
                if field not in existing_missing_names
            ]
            if create_planner_missing:
                still_missing.extend(
                    build_missing_fields_for_action(
                        action_type=draft.action_type,
                        payload=next_payload,
                        missing=create_planner_missing,
                        trip_id=draft.trip_id,
                    )
                )
            try:
                if timeline_result.activity is not None:
                    next_preconditions = _timeline_activity_preconditions(
                        timeline_result.activity
                    )
                else:
                    next_preconditions = (
                        build_backend_preconditions(
                            action_type=draft.action_type,
                            trip_id=draft.trip_id,
                            payload=next_payload,
                            required=not still_missing,
                        )
                        if action_requires_stale_precondition(draft.action_type)
                        else {}
                    )
            except ValueError as exc:
                raise AIActionDraftTargetNotFoundError(
                    "Draft target could not be resolved."
                ) from exc
            next_preview, next_display = build_action_draft_presentation(
                action_type=draft.action_type,
                payload=next_payload,
                trip=locked_trip,
                preview_base=_build_patch_preview(
                    action_type=draft.action_type,
                    payload=next_payload,
                ),
                timeline_plan=timeline_result.plan,
                timeline_create_plan=timeline_create_result.plan,
            )
            draft.payload = next_payload
            draft.preview = next_preview
            if not still_missing or expense_currency_changed:
                draft.display = next_display
            draft.missing_fields = still_missing
            draft.preconditions = next_preconditions
            if not still_missing:
                draft.status = AIActionDraftStatus.READY
            draft.save(
                update_fields=[
                    "payload",
                    "preview",
                    "display",
                    "missing_fields",
                    "preconditions",
                    "status",
                    "updated_at",
                ]
            )
            _touch_response_message(draft=draft, locked_trip=locked_trip)

    if expired:
        raise AIActionDraftExpiredError("Draft expired.")
    return draft


def cancel_action_draft(*, draft_id, trip_id, actor) -> AIActionDraft:
    """Cancel a mutable draft and republish its response snapshot once."""
    expired = False
    with transaction.atomic():
        locked_trip = _lock_trip_or_raise_draft_missing(trip_id=trip_id)
        _lock_actor_or_raise_draft_missing(
            locked_trip=locked_trip,
            actor=actor,
        )
        draft = (
            AIActionDraft.objects.select_for_update(of=("self",))
            .select_related("response_message")
            .get(pk=draft_id, trip_id=trip_id)
        )

        if (
            draft.status in {
                AIActionDraftStatus.NEEDS_INFO,
                AIActionDraftStatus.READY,
            }
            and draft.expires_at <= timezone.now()
        ):
            _expire_draft(draft=draft, locked_trip=locked_trip)
            expired = True
        elif draft.status in {
            AIActionDraftStatus.CONFIRMED,
            AIActionDraftStatus.CANCELLED,
            AIActionDraftStatus.EXPIRED,
            AIActionDraftStatus.FAILED,
        }:
            return draft
        elif not can_cancel_action_draft(draft, viewer=actor):
            raise AIActionDraftForbiddenError("You cannot cancel this draft.")
        else:
            draft.status = AIActionDraftStatus.CANCELLED
            draft.cancelled_by = actor
            draft.cancelled_at = timezone.now()
            draft.save(
                update_fields=[
                    "status",
                    "cancelled_by",
                    "cancelled_at",
                    "updated_at",
                ]
            )
            _touch_response_message(draft=draft, locked_trip=locked_trip)

    if expired:
        raise AIActionDraftExpiredError("Draft expired.")
    return draft
