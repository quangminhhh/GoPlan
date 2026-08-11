from __future__ import annotations

from datetime import date, time

from django.core.exceptions import ValidationError
from django.utils.dateparse import parse_date

from ai.action_types import (
    AI_ACTION_TIMELINE_ACTIVITY_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
)
from ai.agent.display import build_display
from trips.models import (
    MemberStatus,
    TimelineActivity,
    TimelineActivityAssigneeScope,
    TimelineActivityTimeMode,
    TimelineCustomType,
    TimelineLocationMode,
    TimelineSection,
    Trip,
    TripMember,
)
from trips.services import (
    TimelineActivityCreatePlan,
    TimelineActivityPatchPlan,
)

TIMELINE_PRESENTATION_ACTIONS = {
    AI_ACTION_TIMELINE_ACTIVITY_CREATE,
    AI_ACTION_TIMELINE_ACTIVITY_UPDATE,
}


def _clock_value(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, time):
        return value.replace(microsecond=0).isoformat()
    if isinstance(value, str):
        return value
    return None


def _safe_place(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    place = {
        key: text.strip()
        for key in ("title", "address")
        if isinstance((text := value.get(key)), str) and text.strip()
    }
    return place or None


def _safe_preview_patch_data(data: dict) -> dict:
    safe = {
        key: value
        for key, value in data.items()
        if key not in {"custom_type_id", "assignee_user_id"}
    }
    if "place" in safe:
        safe["place"] = _safe_place(safe["place"])
    return safe


def _activity_place(activity: TimelineActivity) -> dict | None:
    if (
        activity.location_mode != TimelineLocationMode.STRUCTURED
        or not activity.place_provider_id
    ):
        return None
    return {
        key: value
        for key, value in {
            "title": activity.place_title,
            "address": activity.place_address,
        }.items()
        if value
    }


def _user_label(user) -> str | None:
    if user is None:
        return None
    return user.display_name or user.identify_tag or None


def _safe_final_data(data: dict) -> dict:
    safe = {
        key: value
        for key, value in data.items()
        if key
        in {
            "title",
            "system_type",
            "custom_type_label",
            "time_mode",
            "start_time",
            "end_time",
            "assignee_scope",
            "assignee_label",
            "location_mode",
            "location_label",
            "location_note",
            "note",
            "meeting_point",
            "contact_name",
            "contact_phone",
            "booking_reference",
            "external_link",
            "reminder_offsets_minutes",
        }
    }
    safe["start_time"] = _clock_value(safe.get("start_time"))
    safe["end_time"] = _clock_value(safe.get("end_time"))
    safe["place"] = _safe_place(data.get("place"))
    return safe


def _activity_snapshot(activity: TimelineActivity) -> dict:
    return _safe_final_data({
        "title": activity.title,
        "system_type": activity.system_type,
        "custom_type_label": (
            activity.custom_type.name
            if activity.custom_type_id is not None
            else None
        ),
        "time_mode": activity.time_mode,
        "start_time": activity.start_time,
        "end_time": activity.end_time,
        "assignee_scope": activity.assignee_scope,
        "assignee_label": _user_label(activity.assignee_user),
        "location_mode": activity.location_mode,
        "location_label": activity.location_label,
        "place": _activity_place(activity),
        "location_note": activity.location_note,
        "note": activity.note,
        "meeting_point": activity.meeting_point,
        "contact_name": activity.contact_name,
        "contact_phone": activity.contact_phone,
        "booking_reference": activity.booking_reference,
        "external_link": activity.external_link,
    })


def _create_snapshot(
    *,
    trip: Trip,
    data: dict,
    timeline_create_plan: TimelineActivityCreatePlan | None,
) -> dict:
    if timeline_create_plan is not None:
        return _safe_final_data(timeline_create_plan.final_data)

    custom_type = None
    custom_type_id = data.get("custom_type_id")
    if custom_type_id:
        custom_type = TimelineCustomType.objects.filter(
            pk=custom_type_id,
            trip=trip,
            is_active=True,
        ).first()

    assignee = None
    if (
        data.get("assignee_scope") == TimelineActivityAssigneeScope.USER
        and data.get("assignee_user_id")
    ):
        membership = (
            TripMember.objects.select_related("user")
            .filter(
                trip=trip,
                user_id=data["assignee_user_id"],
                status=MemberStatus.ACTIVE,
            )
            .first()
        )
        assignee = membership.user if membership is not None else None

    time_mode = data.get("time_mode")
    clears_time = time_mode in {
        TimelineActivityTimeMode.ALL_DAY,
        TimelineActivityTimeMode.FLEXIBLE,
    }
    location_mode = data.get("location_mode", TimelineLocationMode.MANUAL)
    return _safe_final_data({
        "title": data.get("title", ""),
        "system_type": "" if custom_type is not None else data.get("system_type", ""),
        "custom_type_label": custom_type.name if custom_type is not None else None,
        "time_mode": time_mode,
        "start_time": None if clears_time else data.get("start_time"),
        "end_time": None if clears_time else data.get("end_time"),
        "assignee_scope": data.get("assignee_scope", "EVERYONE"),
        "assignee_label": _user_label(assignee),
        "location_mode": location_mode,
        "location_label": data.get("location_label", ""),
        "place": (
            data.get("place")
            if location_mode == TimelineLocationMode.STRUCTURED
            else None
        ),
        "location_note": data.get("location_note", ""),
        "note": data.get("note", ""),
        "meeting_point": data.get("meeting_point", ""),
        "contact_name": data.get("contact_name", ""),
        "contact_phone": data.get("contact_phone", ""),
        "booking_reference": data.get("booking_reference", ""),
        "external_link": data.get("external_link", ""),
        "reminder_offsets_minutes": data.get("reminder_offsets_minutes", []),
    })


def _resolved_update_snapshot(activity: TimelineActivity, data: dict) -> dict:
    resolved = _activity_snapshot(activity)
    for field in (
        "title",
        "system_type",
        "time_mode",
        "start_time",
        "end_time",
        "assignee_scope",
        "location_mode",
        "location_label",
    ):
        if field in data:
            value = data[field]
            resolved[field] = (
                _clock_value(value)
                if field in {"start_time", "end_time"}
                else value
            )

    if resolved.get("time_mode") in {
        TimelineActivityTimeMode.ALL_DAY,
        TimelineActivityTimeMode.FLEXIBLE,
    }:
        resolved["start_time"] = None
        resolved["end_time"] = None

    if "place" in data:
        resolved["place"] = _safe_place(data.get("place"))
    elif (
        "location_mode" in data
        and data["location_mode"] == TimelineLocationMode.MANUAL
    ):
        resolved["place"] = None
    return resolved


def _reminder_label(offset: int) -> str:
    if offset % 10080 == 0:
        count = offset // 10080
        unit = "week" if count == 1 else "weeks"
    elif offset % 1440 == 0:
        count = offset // 1440
        unit = "day" if count == 1 else "days"
    elif offset % 60 == 0:
        count = offset // 60
        unit = "hour" if count == 1 else "hours"
    else:
        count = offset
        unit = "minute" if count == 1 else "minutes"
    return f"{count} {unit} before"


def _review_value(value) -> str | None:
    if value is None or value == []:
        return "Cleared"
    if isinstance(value, str):
        return value if value.strip() else "Cleared"
    return None


def _hidden_review_meta(
    *,
    data: dict,
    resolved_data: dict,
) -> list[dict]:
    meta = []
    custom_type_label = resolved_data.get("custom_type_label")
    if "custom_type_id" in data:
        if data.get("custom_type_id") is None:
            meta.append({"label": "Custom type", "value": "Cleared"})
        elif isinstance(custom_type_label, str) and custom_type_label.strip():
            meta.append(
                {"label": "Custom type", "value": custom_type_label.strip()}
            )

    if "assignee_user_id" in data:
        assignee_label = resolved_data.get("assignee_label")
        if data.get("assignee_user_id") is None:
            meta.append({"label": "Assigned member", "value": "Cleared"})
        elif isinstance(assignee_label, str) and assignee_label.strip():
            meta.append(
                {"label": "Assigned member", "value": assignee_label.strip()}
            )

    for field, label in (
        ("booking_reference", "Booking reference"),
        ("contact_name", "Contact name"),
        ("contact_phone", "Contact phone"),
        ("external_link", "External link"),
        ("location_note", "Location note"),
        ("meeting_point", "Meeting point"),
        ("note", "Note"),
    ):
        if field not in data:
            continue
        value = _review_value(data[field])
        if value is not None:
            meta.append({"label": label, "value": value})

    if "reminder_offsets_minutes" in data:
        offsets = data.get("reminder_offsets_minutes")
        if not offsets:
            value = "Cleared"
        elif isinstance(offsets, list) and all(
            isinstance(offset, int) and not isinstance(offset, bool)
            for offset in offsets
        ):
            value = " · ".join(_reminder_label(offset) for offset in offsets)
        else:
            value = None
        if value is not None:
            meta.append({"label": "Reminders", "value": value})
    return meta


def _section_label_for_date(*, trip: Trip, section_date: date) -> str:
    if trip.start_date:
        return f"Day {(section_date - trip.start_date).days + 1}"
    return section_date.isoformat()


def _create_section_context(
    *,
    trip: Trip,
    payload: dict,
    timeline_create_plan: TimelineActivityCreatePlan | None,
) -> dict:
    if (
        timeline_create_plan is not None
        and timeline_create_plan.section is not None
    ):
        section = timeline_create_plan.section
        return {
            "section_label": section.label,
            "section_date": section.section_date.isoformat(),
        }

    section_id = payload.get("section_id")
    if section_id:
        try:
            section = TimelineSection.objects.get(pk=section_id, trip=trip)
        except (
            TimelineSection.DoesNotExist,
            TypeError,
            ValueError,
            ValidationError,
        ):
            return {}
        return {
            "section_label": section.label,
            "section_date": section.section_date.isoformat(),
        }

    raw_date = payload.get("section_date")
    section_date = raw_date if isinstance(raw_date, date) else parse_date(str(raw_date))
    if section_date is None:
        return {}
    section = TimelineSection.objects.filter(
        trip=trip,
        section_date=section_date,
    ).first()
    return {
        "section_label": (
            section.label
            if section is not None
            else _section_label_for_date(trip=trip, section_date=section_date)
        ),
        "section_date": section_date.isoformat(),
    }


def _update_context(
    *,
    trip: Trip,
    payload: dict,
    timeline_plan: TimelineActivityPatchPlan | None,
) -> dict:
    try:
        activity = TimelineActivity.objects.select_related(
            "section",
            "custom_type",
            "assignee_user",
        ).get(
            pk=payload.get("activity_id"),
            trip=trip,
        )
    except (
        TimelineActivity.DoesNotExist,
        TypeError,
        ValueError,
        ValidationError,
    ):
        return {}
    data = payload.get("data")
    patch_data = data if isinstance(data, dict) else {}
    resolved_data = (
        _safe_final_data(timeline_plan.final_data)
        if timeline_plan is not None
        else _resolved_update_snapshot(activity, patch_data)
    )
    return {
        "target_title": activity.title,
        "section_label": activity.section.label,
        "section_date": activity.section.section_date.isoformat(),
        "resolved_data": resolved_data,
        "review_meta": _hidden_review_meta(
            data=patch_data,
            resolved_data=resolved_data,
        ),
    }


def build_action_draft_presentation(
    *,
    action_type: str,
    payload: dict,
    trip: Trip,
    preview_base: dict | None = None,
    timeline_plan: TimelineActivityPatchPlan | None = None,
    timeline_create_plan: TimelineActivityCreatePlan | None = None,
) -> tuple[dict, dict]:
    """Build additive, display-only context without changing execution payloads."""
    preview = dict(payload if preview_base is None else preview_base)
    display_payload = dict(payload)

    if action_type in TIMELINE_PRESENTATION_ACTIONS:
        data = payload.get("data")
        if isinstance(data, dict):
            # Presentation is human-facing. Keep executor-only identifiers and
            # coordinates in the persisted payload, never in the review envelope.
            preview.pop("custom_type_id", None)
            preview.pop("assignee_user_id", None)
            if "place" in preview:
                preview["place"] = _safe_place(preview["place"])
            preview["data"] = _safe_preview_patch_data(data)

        if action_type == AI_ACTION_TIMELINE_ACTIVITY_CREATE:
            preview.pop("section_id", None)
            context = _create_section_context(
                trip=trip,
                payload=payload,
                timeline_create_plan=timeline_create_plan,
            )
            if isinstance(data, dict):
                resolved_data = _create_snapshot(
                    trip=trip,
                    data=data,
                    timeline_create_plan=timeline_create_plan,
                )
                context["resolved_data"] = resolved_data
                context["review_meta"] = _hidden_review_meta(
                    data=data,
                    resolved_data=resolved_data,
                )
        else:
            context = _update_context(
                trip=trip,
                payload=payload,
                timeline_plan=timeline_plan,
            )

        preview.update(context)
        display_payload.update(context)

    trip_context = {
        "timezone": trip.timezone,
        "currency_code": trip.currency_code,
    }
    display = build_display(
        action_type=action_type,
        payload=display_payload,
        trip_context=trip_context,
    )
    return preview, display
