from __future__ import annotations

from collections.abc import Iterable

from ai.action_types import AI_ACTION_TIMELINE_ACTIVITY_CREATE
from ai.agent.presets import presets_for

MISSING_FIELD_DEFINITIONS = {
    "activity_id": {"label": "Activity"},
    "amount": {"label": "Amount", "type": "money"},
    "assignee_user_id": {"label": "Assigned member"},
    "collector_id": {"label": "Collector", "type": "select"},
    "contributions": {"label": "Contributions", "type": "json"},
    "custom_type_id": {"label": "Custom activity type", "type": "select"},
    "data": {"label": "Activity details", "type": "json"},
    "end_time": {"label": "End time"},
    "expense_id": {"label": "Expense"},
    "location_mode": {"label": "Location mode", "type": "select"},
    "member_contributions": {"label": "Member contributions", "type": "json"},
    "place": {"label": "Place", "type": "json"},
    "section_date": {"label": "Timeline date", "type": "date"},
    "section_id": {"label": "Timeline day"},
    "start_time": {"label": "Start time"},
    "status": {"label": "Status", "type": "select"},
    "system_type": {"label": "Activity type", "type": "select"},
    "time_range": {"label": "Time", "type": "time_range"},
    "time_mode": {"label": "Time mode", "type": "select"},
    "title": {"label": "Title"},
    "total_amount": {"label": "Amount", "type": "money"},
    "transfer_id": {"label": "Transfer"},
    "user_id": {"label": "Member"},
}

PRESERVED_MISSING_FIELD_KEYS = ("required", "constraints", "options", "presets")


def missing_field_name(field) -> str:
    if isinstance(field, dict):
        return str(field.get("name") or "").strip()
    return str(field or "").strip()


def normalize_missing_field_names(value, *, strict: bool = True) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise ValueError("Agent draft missing_fields must be a list.")
        return []

    names = []
    for item in value:
        name = missing_field_name(item)
        if not name:
            if strict:
                raise ValueError("Agent draft missing field must include a name.")
            continue
        names.append(name)
    return list(dict.fromkeys(names))


def build_missing_field(name: str, *, source: dict | None = None) -> dict:
    definition = MISSING_FIELD_DEFINITIONS.get(name, {})
    label = ""
    field_type = None
    if source:
        raw_label = source.get("label")
        raw_type = source.get("type")
        label = str(raw_label).strip() if raw_label else ""
        field_type = str(raw_type).strip() if raw_type else None
    if definition.get("label"):
        label = definition["label"]
    if not label:
        label = definition.get("label") or name.replace("_", " ").title()
    if field_type is None:
        field_type = definition.get("type")

    field = {"name": name, "label": label}
    if field_type:
        field["type"] = field_type
    if source:
        for key in PRESERVED_MISSING_FIELD_KEYS:
            if key in source:
                field[key] = source[key]
    return field


def normalize_missing_fields(value, *, strict: bool = True) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise ValueError("Agent draft missing_fields must be a list.")
        return []

    sources = {}
    ordered_names = []
    for item in value:
        name = missing_field_name(item)
        if not name:
            if strict:
                raise ValueError("Agent draft missing field must include a name.")
            continue
        if name not in ordered_names:
            ordered_names.append(name)
        if isinstance(item, dict):
            sources[name] = item

    return [
        build_missing_field(name, source=sources.get(name))
        for name in ordered_names
    ]


def build_missing_fields(names: Iterable[str]) -> list[dict]:
    return [build_missing_field(name) for name in list(dict.fromkeys(names))]


def build_missing_fields_for_action(
    *,
    action_type: str,
    payload: dict,
    missing: Iterable[str],
    trip_id=None,
) -> list[dict]:
    missing_names = list(dict.fromkeys(missing))
    if action_type != AI_ACTION_TIMELINE_ACTIVITY_CREATE:
        return build_missing_fields(missing_names)

    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    return build_missing_fields_for_create_activity(
        section_id=payload.get("section_id"),
        time_mode=str(data.get("time_mode") or ""),
        missing=missing_names,
        system_type=data.get("system_type"),
        trip_id=trip_id,
    )


# -------- Section Context Resolver --------

def _resolve_section_context(section_id, *, trip_id=None) -> dict:
    from trips.models import TimelineSection

    try:
        sections = TimelineSection.objects.select_related("trip")
        if trip_id is not None:
            sections = sections.filter(trip_id=trip_id)
        section = sections.get(pk=section_id)
    except (TimelineSection.DoesNotExist, ValueError, TypeError):
        return {}
    sections = list(
        TimelineSection.objects.filter(trip=section.trip)
        .order_by("section_date", "position", "created_at")
        .values_list("id", flat=True)
    )
    try:
        index_one_based = sections.index(section.id) + 1
    except ValueError:
        index_one_based = 1
    return {
        "section_id": str(section.id),
        "section_index": index_one_based,
        "section_date": section.section_date.isoformat(),
    }


# -------- Activity Create Missing Fields Builder --------

def build_missing_fields_for_create_activity(
    *,
    section_id,
    time_mode: str,
    missing: list[str],
    system_type: str | None = None,
    trip_id=None,
) -> list[dict]:
    """Build missing_fields list for a timeline.activity.create draft,
    pairing start_time/end_time into a synthetic time_range field with
    section context + presets when applicable.
    """
    missing_set = set(missing)
    fields: list[dict] = []

    if time_mode == "TIME_RANGE" and {"start_time", "end_time"} <= missing_set:
        section_ctx = _resolve_section_context(section_id, trip_id=trip_id)
        fields.append({
            "name": "time_range",
            "label": "Time",
            "type": "time_range",
            "required": True,
            "constraints": {
                **section_ctx,
                "pair": ["start_time", "end_time"],
            },
            "presets": [p.as_dict() for p in presets_for(system_type or "OTHER")],
        })
        missing_set.discard("start_time")
        missing_set.discard("end_time")

    # Preserve other missing fields using the existing single-field builder.
    for name in missing:
        if name in missing_set:
            fields.append(build_missing_field(name))

    return fields
