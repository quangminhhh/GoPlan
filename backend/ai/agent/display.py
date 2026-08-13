from __future__ import annotations

import logging
from datetime import datetime, time
from decimal import Decimal, InvalidOperation
from typing import Callable
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

SYSTEM_TYPE_LABELS = {
    "TRANSPORTATION": "Transportation",
    "FOOD": "Food",
    "CHECKIN_OUT": "Check-in / Check-out",
    "FREE_TIME": "Free Time",
    "SIGHTSEEING": "Sightseeing",
    "SHOPPING": "Shopping",
    "ACCOMMODATION": "Accommodation",
    "OTHER": "Other",
    "DINING": "Food",
    "NIGHTLIFE": "Nightlife",
    "TRANSPORT": "Transportation",
}

ASSIGNEE_LABELS = {
    "GROUP": "Whole group",
    "EVERYONE": "Whole group",
    "USER": "Assigned member",
    "NONE": "Unassigned",
}

STATUS_LABELS = {
    "UPCOMING": "Upcoming",
    "IN_PROGRESS": "In Progress",
    "DONE": "Done",
    "CANCELLED": "Cancelled",
}

TIMELINE_REVIEW_META_LABELS = {
    "Assigned member",
    "Booking reference",
    "Contact name",
    "Contact phone",
    "Custom type",
    "External link",
    "Location note",
    "Meeting point",
    "Note",
    "Reminders",
}


def _activity_payload(payload: dict) -> dict:
    resolved_data = payload.get("resolved_data")
    if isinstance(resolved_data, dict):
        return resolved_data
    data = payload.get("data")
    return data if isinstance(data, dict) else payload


def _activity_patch_payload(payload: dict) -> dict:
    data = payload.get("data")
    return data if isinstance(data, dict) else payload


def _non_empty_string(payload: dict, key: str) -> str | None:
    value = payload.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _fmt_clock(value, tz: str) -> str | None:
    if not value:
        return None
    if isinstance(value, time):
        return value.strftime("%H:%M")
    if isinstance(value, datetime):
        dt = value.astimezone(ZoneInfo(tz)) if value.tzinfo else value
        return dt.strftime("%H:%M")
    text = str(value).strip()
    if not text:
        return None
    try:
        if "T" in text:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if dt.tzinfo:
                dt = dt.astimezone(ZoneInfo(tz))
            return dt.strftime("%H:%M")
        parsed_time = time.fromisoformat(text)
        return parsed_time.strftime("%H:%M")
    except ValueError:
        return text[:5] if len(text) >= 5 else text


def _fmt_time_range(start, end, tz: str, time_mode: str | None = None) -> str | None:
    if not start:
        if time_mode == "ALL_DAY":
            return "All day"
        if time_mode == "FLEXIBLE":
            return "Flexible"
        return None
    label = _fmt_clock(start, tz)
    if not label:
        return None
    if end:
        end_label = _fmt_clock(end, tz)
        if end_label:
            label += " – " + end_label
    return label


def _fmt_amount(value: int | str | Decimal, currency: str) -> dict:
    amount = Decimal(str(value))
    formatted = f"{amount:,.0f}" if amount == amount.to_integral_value() else f"{amount:,}"
    return {"kind": "amount", "value": formatted, "currency": currency}


def _has_positive_amount(value) -> bool:
    if value in (None, ""):
        return False
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return amount.is_finite() and amount > 0


def _location_label(payload: dict) -> str | None:
    place = payload.get("place")
    if payload.get("location_mode") == "STRUCTURED":
        if not isinstance(place, dict):
            return None
        return _non_empty_string(place, "title") or _non_empty_string(
            place,
            "address",
        )
    label = _non_empty_string(payload, "location_label")
    if label:
        return label
    if not isinstance(place, dict):
        return None
    title = _non_empty_string(place, "title")
    if title:
        return title
    return _non_empty_string(place, "address")


def _activity_meta(payload: dict) -> list[dict]:
    meta = []
    status = payload.get("status")
    if status:
        meta.append({
            "label": "Status",
            "value": STATUS_LABELS.get(status, str(status)),
        })

    for label, field in (
        ("Meeting point", "meeting_point"),
        ("Location note", "location_note"),
        ("Note", "note"),
    ):
        value = _non_empty_string(payload, field)
        if value:
            meta.append({"label": label, "value": value})

    contact_name = _non_empty_string(payload, "contact_name")
    contact_phone = _non_empty_string(payload, "contact_phone")
    if contact_name and contact_phone:
        meta.append(
            {"label": "Contact", "value": f"{contact_name} · {contact_phone}"}
        )
    elif contact_name:
        meta.append({"label": "Contact", "value": contact_name})
    elif contact_phone:
        meta.append({"label": "Contact phone", "value": contact_phone})

    for label, field in (
        ("Booking", "booking_reference"),
        ("Link", "external_link"),
    ):
        value = _non_empty_string(payload, field)
        if value:
            meta.append({"label": label, "value": value})
    return meta


def _timeline_review_meta(
    *,
    payload: dict,
    activity_payload: dict,
    trip_context: dict,
    tone: str,
) -> list[dict]:
    meta = []
    target_title = _non_empty_string(payload, "target_title")
    if tone == "update" and target_title:
        meta.append({"label": "Target", "value": target_title})

    section_label = _non_empty_string(payload, "section_label")
    section_date = _non_empty_string(payload, "section_date")
    if section_label and section_date:
        meta.append({"label": "Date", "value": f"{section_label} · {section_date}"})
    elif section_date or section_label:
        meta.append({"label": "Date", "value": section_date or section_label})

    time_label = _fmt_time_range(
        activity_payload.get("start_time"),
        activity_payload.get("end_time"),
        trip_context.get("timezone", "UTC"),
        activity_payload.get("time_mode"),
    )
    meta.append({"label": "Time", "value": time_label or "Not set"})

    location_label = _location_label(activity_payload)
    if location_label:
        location_value = location_label
    else:
        patch_payload = _activity_patch_payload(payload)
        location_changed = any(
            field in patch_payload
            for field in ("location_mode", "location_label", "place")
        )
        location_value = "Cleared" if tone == "update" and location_changed else "Not set"
    meta.append({"label": "Location", "value": location_value})

    custom_type_label = _non_empty_string(activity_payload, "custom_type_label")
    system_type = _non_empty_string(activity_payload, "system_type")
    if custom_type_label:
        type_label = custom_type_label
    elif system_type:
        type_label = SYSTEM_TYPE_LABELS.get(system_type, system_type)
    else:
        type_label = "Not set"
    meta.append({"label": "Type", "value": type_label})

    assignee_label = _non_empty_string(activity_payload, "assignee_label")
    assignee_scope = _non_empty_string(activity_payload, "assignee_scope")
    meta.append(
        {
            "label": "Assignee",
            "value": (
                assignee_label
                or ASSIGNEE_LABELS.get(assignee_scope or "NONE", "Unassigned")
            ),
        }
    )

    review_meta = payload.get("review_meta")
    if isinstance(review_meta, list):
        for row in review_meta:
            if not isinstance(row, dict):
                continue
            label = row.get("label")
            value = row.get("value")
            if (
                label in TIMELINE_REVIEW_META_LABELS
                and isinstance(value, str)
                and value.strip()
            ):
                meta.append({"label": label, "value": value})
    else:
        # Preserve the standalone display-builder contract. Authoritative
        # presentation callers always supply review_meta, including an empty
        # list, so only legacy/direct callers use this safe text allowlist.
        meta.extend(_activity_meta(activity_payload))
    return meta


def _build_timeline_activity(
    *,
    payload: dict,
    trip_context: dict,
    tone: str,
    include_review_context: bool = True,
) -> dict:
    activity_payload = _activity_payload(payload)
    tz = trip_context.get("timezone", "UTC")
    custom_type_label = _non_empty_string(activity_payload, "custom_type_label")
    system_label = custom_type_label or SYSTEM_TYPE_LABELS.get(
        activity_payload.get("system_type", ""),
        "Activity",
    )
    chips = []
    time_label = _fmt_time_range(
        activity_payload.get("start_time"),
        activity_payload.get("end_time"),
        tz,
        activity_payload.get("time_mode"),
    )
    if time_label:
        chips.append({"icon": "clock", "label": time_label})
    location_label = _location_label(activity_payload)
    if location_label:
        chips.append({"icon": "map-pin", "label": location_label})
    assignee = _non_empty_string(activity_payload, "assignee_label") or (
        ASSIGNEE_LABELS.get(
            activity_payload.get("assignee_scope", "GROUP"),
            "Whole group",
        )
    )
    chips.append({"icon": "users", "label": assignee})
    meta = (
        _timeline_review_meta(
            payload=payload,
            activity_payload=activity_payload,
            trip_context=trip_context,
            tone=tone,
        )
        if include_review_context
        else []
    )
    if not include_review_context:
        meta.extend(_activity_meta(activity_payload))
    return {
        "icon": "activity",
        "tone": tone,
        "kicker": f"Activity · {system_label}",
        "title": activity_payload.get("title", ""),
        "chips": chips,
        "meta": meta,
    }


def _build_timeline_create(payload: dict, trip_context: dict) -> dict:
    return _build_timeline_activity(
        payload=payload,
        trip_context=trip_context,
        tone="create",
    )


def _build_timeline_update(payload: dict, trip_context: dict) -> dict:
    return _build_timeline_activity(
        payload=payload,
        trip_context=trip_context,
        tone="update",
    )


def _build_timeline_status(payload: dict, trip_context: dict) -> dict:
    return _build_timeline_activity(
        payload=payload,
        trip_context=trip_context,
        tone="update",
        include_review_context=False,
    )


def _build_timeline_delete(payload: dict, trip_context: dict) -> dict:
    return {
        "icon": "activity",
        "tone": "destroy",
        "kicker": "Delete activity",
        "title": payload.get("title", "Activity"),
    }


def _build_expense_create(payload: dict, trip_context: dict) -> dict:
    currency = payload.get("currency_code") or trip_context.get("currency_code", "USD")
    meta = []
    collector_name = _non_empty_string(payload, "collector_name")
    if collector_name:
        meta.append({"label": "Collector", "value": collector_name})
    description = _non_empty_string(payload, "description")
    if description:
        meta.append({"label": "Description", "value": description})
    display = {
        "icon": "expense",
        "tone": "create",
        "kicker": "Expense",
        "title": payload.get("title", ""),
        "meta": meta,
    }
    amount = payload.get("total_amount")
    if _has_positive_amount(amount):
        display["hero"] = _fmt_amount(amount, currency)
    return display


def _build_expense_update(payload: dict, trip_context: dict) -> dict:
    currency = payload.get("currency_code") or trip_context.get("currency_code", "USD")
    meta = []
    description = _non_empty_string(payload, "description")
    if description:
        meta.append({"label": "Description", "value": description})
    collector_name = _non_empty_string(payload, "collector_name")
    if collector_name:
        meta.append({"label": "Collector", "value": collector_name})
    out = {
        "icon": "expense",
        "tone": "update",
        "kicker": "Update expense",
        "title": payload.get("title") or payload.get("target_title") or "Expense",
        "meta": meta,
    }
    amount = payload.get("total_amount")
    if _has_positive_amount(amount):
        out["hero"] = _fmt_amount(amount, currency)
    return out


def _build_expense_contribution(payload: dict, trip_context: dict) -> dict:
    scope = str(payload.get("scope", "")).lower()
    is_all_paid = scope in {
        "all_participants_paid",
        "all_participants",
        "everyone_paid",
    }
    title = (
        "Mark all participants paid"
        if is_all_paid
        else "Update expense contributions"
    )
    meta = []
    contributions = payload.get("contributions")
    if isinstance(contributions, list) and contributions:
        meta.append({"label": "Contributions", "value": str(len(contributions))})
    return {
        "icon": "expense",
        "tone": "update",
        "kicker": "Expense contributions",
        "title": payload.get("title") or title,
        "meta": meta,
    }


def _build_expense_delete(payload: dict, trip_context: dict) -> dict:
    currency = payload.get("currency_code") or trip_context.get("currency_code", "USD")
    display = {
        "icon": "expense",
        "tone": "destroy",
        "kicker": "Delete expense",
        "title": payload.get("title", "Expense"),
    }
    amount = payload.get("total_amount")
    if _has_positive_amount(amount):
        display["hero"] = _fmt_amount(amount, currency)
    return display


def _build_settlement(payload: dict, trip_context: dict) -> dict:
    return {
        "icon": "settlement",
        "tone": "update",
        "kicker": "Settlement",
        "title": payload.get("title", "Trip settlement"),
    }


def _build_transfer(payload: dict, trip_context: dict) -> dict:
    currency = payload.get("currency_code") or trip_context.get("currency_code", "USD")
    display = {
        "icon": "transfer",
        "tone": "update",
        "kicker": "Transfer",
        "title": payload.get("title", "Money transfer"),
        "meta": [],
    }
    amount = payload.get("amount")
    if _has_positive_amount(amount):
        display["hero"] = _fmt_amount(amount, currency)
    for label, field in (("From", "from_name"), ("To", "to_name")):
        value = _non_empty_string(payload, field)
        if value:
            display["meta"].append({"label": label, "value": value})
    return display


def _build_generic(payload: dict, trip_context: dict) -> dict:
    return {
        "icon": "info",
        "tone": "neutral",
        "kicker": "AI action",
        "title": payload.get("title", ""),
    }


DISPLAY_BUILDERS: dict[str, Callable[[dict, dict], dict]] = {
    "timeline.activity.create": _build_timeline_create,
    "timeline.activity.update": _build_timeline_update,
    "timeline.activity.delete": _build_timeline_delete,
    "timeline.activity.status.update": _build_timeline_status,
    "expense.create": _build_expense_create,
    "expense.update": _build_expense_update,
    "expense.delete": _build_expense_delete,
    "expense.contribution.set": _build_expense_contribution,
    "settlement.finalize": _build_settlement,
    "settlement.reopen": _build_settlement,
    "settlement.transfer.mark_sent": _build_transfer,
    "settlement.transfer.confirm_received": _build_transfer,
}


def build_display(*, action_type: str, payload: dict, trip_context: dict) -> dict:
    builder = DISPLAY_BUILDERS.get(action_type)
    if builder is None:
        logger.warning("ai.display.unknown_action", extra={"action_type": action_type})
        return _build_generic(payload, trip_context)
    return builder(payload, trip_context)
