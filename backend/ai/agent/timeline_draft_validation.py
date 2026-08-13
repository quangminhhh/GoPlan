from __future__ import annotations

from dataclasses import dataclass

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers as drf_serializers

from ai.action_types import (
    AI_ACTION_TIMELINE_ACTIVITY_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
)
from ai.agent.payload_validation import missing_payload_field_names
from trips.models import TimelineActivity, TimelineActivityTimeMode, Trip
from trips.services import (
    TimelineActivityCreatePlan,
    TimelineActivityNotFoundError,
    TimelineActivityPatchPlan,
    TimelineInvalidAssigneeError,
    TimelineInvalidCustomTypeError,
    TimelineSectionNotFoundError,
    normalize_timeline_activity_input,
    plan_timeline_activity_create,
    plan_timeline_activity_patch,
    resolve_timeline_activity_create_references,
    timeline_json_value,
)


@dataclass(frozen=True)
class TimelineDraftCreateResult:
    payload: dict
    plan: TimelineActivityCreatePlan | None
    field_errors: dict[str, str]
    blocking_field_errors: dict[str, str]


@dataclass(frozen=True)
class TimelineDraftPatchResult:
    payload: dict
    activity: TimelineActivity | None
    plan: TimelineActivityPatchPlan | None
    field_errors: dict[str, str]


def _first_error_text(value) -> str:
    if isinstance(value, dict):
        for nested in value.values():
            return _first_error_text(nested)
    if isinstance(value, (list, tuple)):
        for nested in value:
            return _first_error_text(nested)
    return str(value)


def _drf_field_errors(detail) -> dict[str, str]:
    if not isinstance(detail, dict):
        return {"data": _first_error_text(detail)}
    errors: dict[str, str] = {}
    for raw_field, value in detail.items():
        field = str(raw_field)
        if field == "non_field_errors":
            field = "data"
        errors[field] = _first_error_text(value)
    return errors


def _complete_time_range_errors(
    *,
    activity: TimelineActivity,
    data: dict,
    errors: dict[str, str],
) -> dict[str, str]:
    final_time_mode = data.get("time_mode", activity.time_mode)
    if final_time_mode != TimelineActivityTimeMode.TIME_RANGE:
        return errors
    final_start_time = data.get("start_time", activity.start_time)
    final_end_time = data.get("end_time", activity.end_time)
    completed = dict(errors)
    if final_start_time is None:
        completed.setdefault("start_time", "This field is required.")
    if final_end_time is None:
        completed.setdefault("end_time", "This field is required.")
    return completed


def _activity_queryset(*, lock_target: bool):
    queryset = TimelineActivity.objects.select_related(
        "section",
        "custom_type",
        "assignee_user",
    ).prefetch_related("reminders")
    return queryset.select_for_update(of=("self",)) if lock_target else queryset


def plan_timeline_create_draft(
    *,
    action_type: str,
    trip: Trip,
    payload: dict,
    lock_section: bool,
) -> TimelineDraftCreateResult:
    if action_type != AI_ACTION_TIMELINE_ACTIVITY_CREATE:
        return TimelineDraftCreateResult(
            payload=payload,
            plan=None,
            field_errors={},
            blocking_field_errors={},
        )

    data = payload.get("data")
    if not isinstance(data, dict):
        return TimelineDraftCreateResult(
            payload=payload,
            plan=None,
            field_errors={"data": "Activity data must be an object."},
            blocking_field_errors={"data": "Activity data must be an object."},
        )

    normalized_data = normalize_timeline_activity_input(data)
    normalized_payload = {
        **payload,
        "data": timeline_json_value(normalized_data),
    }
    missing_names = missing_payload_field_names(
        action_type=action_type,
        payload=normalized_payload,
        currency_code=trip.currency_code,
    )
    field_errors = {
        name: "This field is required or invalid."
        for name in missing_names
    }
    blocking_field_errors = {}
    section_id = payload.get("section_id")
    has_section_date = bool(payload.get("section_date"))
    references = None
    has_section_id = (
        bool(str(section_id).strip())
        if section_id is not None
        else False
    )
    if not has_section_id and not has_section_date:
        field_errors.setdefault("section_id", "Timeline day is required.")
    else:
        try:
            references = resolve_timeline_activity_create_references(
                trip=trip,
                data=normalized_data,
                section_id=section_id,
                lock_section=lock_section,
                require_section=not has_section_date,
            )
        except TimelineSectionNotFoundError:
            message = "Timeline day could not be resolved."
            field_errors["section_id"] = message
            blocking_field_errors["section_id"] = message
        except TimelineInvalidCustomTypeError as exc:
            field_errors["custom_type_id"] = str(exc)
            blocking_field_errors["custom_type_id"] = str(exc)
        except TimelineInvalidAssigneeError as exc:
            field_errors["assignee_user_id"] = str(exc)
            blocking_field_errors["assignee_user_id"] = str(exc)

    if field_errors:
        return TimelineDraftCreateResult(
            payload=normalized_payload,
            plan=None,
            field_errors=field_errors,
            blocking_field_errors=blocking_field_errors,
        )

    try:
        plan = plan_timeline_activity_create(
            trip=trip,
            data=normalized_data,
            section_id=section_id,
            section=(references.section if references is not None else None),
            lock_section=False,
            require_section=not has_section_date,
        )
    except drf_serializers.ValidationError as exc:
        return TimelineDraftCreateResult(
            payload=payload,
            plan=None,
            field_errors=_drf_field_errors(exc.detail),
            blocking_field_errors=_drf_field_errors(exc.detail),
        )
    except TimelineSectionNotFoundError:
        return TimelineDraftCreateResult(
            payload=payload,
            plan=None,
            field_errors={"section_id": "Timeline day could not be resolved."},
            blocking_field_errors={
                "section_id": "Timeline day could not be resolved."
            },
        )
    except TimelineInvalidCustomTypeError as exc:
        return TimelineDraftCreateResult(
            payload=payload,
            plan=None,
            field_errors={"custom_type_id": str(exc)},
            blocking_field_errors={"custom_type_id": str(exc)},
        )
    except TimelineInvalidAssigneeError as exc:
        return TimelineDraftCreateResult(
            payload=payload,
            plan=None,
            field_errors={"assignee_user_id": str(exc)},
            blocking_field_errors={"assignee_user_id": str(exc)},
        )

    canonical_payload = {**normalized_payload, "data": plan.data}
    if plan.section is not None:
        canonical_payload["section_id"] = str(plan.section.id)
    return TimelineDraftCreateResult(
        payload=canonical_payload,
        plan=plan,
        field_errors={},
        blocking_field_errors={},
    )


def plan_timeline_update_draft(
    *,
    action_type: str,
    trip: Trip,
    payload: dict,
    lock_target: bool,
    activity: TimelineActivity | None = None,
) -> TimelineDraftPatchResult:
    if action_type != AI_ACTION_TIMELINE_ACTIVITY_UPDATE:
        return TimelineDraftPatchResult(
            payload=payload,
            activity=None,
            plan=None,
            field_errors={},
        )

    if activity is None:
        try:
            activity = _activity_queryset(lock_target=lock_target).get(
                pk=payload.get("activity_id"),
                trip=trip,
            )
        except (
            TimelineActivity.DoesNotExist,
            TypeError,
            ValueError,
            DjangoValidationError,
        ):
            return TimelineDraftPatchResult(
                payload=payload,
                activity=None,
                plan=None,
                field_errors={"activity_id": "Activity could not be resolved."},
            )

    data = payload.get("data")
    if not isinstance(data, dict):
        return TimelineDraftPatchResult(
            payload=payload,
            activity=activity,
            plan=None,
            field_errors={"data": "Activity patch must be an object."},
        )

    try:
        plan = plan_timeline_activity_patch(
            trip=trip,
            activity=activity,
            data=data,
        )
    except drf_serializers.ValidationError as exc:
        field_errors = _complete_time_range_errors(
            activity=activity,
            data=data,
            errors=_drf_field_errors(exc.detail),
        )
        return TimelineDraftPatchResult(
            payload=payload,
            activity=activity,
            plan=None,
            field_errors=field_errors,
        )
    except TimelineInvalidCustomTypeError as exc:
        return TimelineDraftPatchResult(
            payload=payload,
            activity=activity,
            plan=None,
            field_errors={"custom_type_id": str(exc)},
        )
    except TimelineInvalidAssigneeError as exc:
        return TimelineDraftPatchResult(
            payload=payload,
            activity=activity,
            plan=None,
            field_errors={"assignee_user_id": str(exc)},
        )
    except TimelineActivityNotFoundError:
        return TimelineDraftPatchResult(
            payload=payload,
            activity=None,
            plan=None,
            field_errors={"activity_id": "Activity could not be resolved."},
        )

    return TimelineDraftPatchResult(
        payload={**payload, "data": plan.data},
        activity=activity,
        plan=plan,
        field_errors={},
    )
