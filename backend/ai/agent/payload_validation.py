from __future__ import annotations

from decimal import Decimal, InvalidOperation

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
from expenses.services import (
    ExpenseServiceError,
    normalize_currency_amount,
    normalize_non_negative_currency_amount,
)
from trips.models import (
    TimelineActivityStatus,
    TimelineActivityTimeMode,
    TimelineLocationMode,
    TimelineSystemType,
)

EXPENSE_CONTRIBUTION_USER_FIELDS = (
    "user_id",
    "target_user_id",
    "member_id",
    "payer_id",
    "collector_id",
)

EXPENSE_CONTRIBUTION_AMOUNT_FIELDS = (
    "amount",
    "paid_amount",
    "contribution_amount",
)

EXPENSE_UPDATE_FIELDS = (
    "title",
    "description",
    "total_amount",
    "collector_id",
)

TIMELINE_ACTIVITY_DATA_FIELDS = {
    "assignee_scope",
    "assignee_user_id",
    "booking_reference",
    "contact_name",
    "contact_phone",
    "custom_type_id",
    "end_time",
    "external_link",
    "location_label",
    "location_mode",
    "location_note",
    "meeting_point",
    "note",
    "place",
    "reminder_offsets_minutes",
    "start_time",
    "system_type",
    "time_mode",
    "title",
}


def is_blank(value) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return False


def is_missing_value(value) -> bool:
    if isinstance(value, (dict, list, tuple, set)):
        return not value
    return is_blank(value)


def _has_any_value(payload: dict, fields: tuple[str, ...]) -> bool:
    return any(not is_missing_value(payload.get(field)) for field in fields)


def _has_any_expense_update_field(payload: dict) -> bool:
    for field in EXPENSE_UPDATE_FIELDS:
        if field not in payload:
            continue
        if field == "description":
            return payload.get(field) is not None
        if not is_missing_value(payload.get(field)):
            return True
    return False


def _should_mark_all_participants_paid(payload: dict) -> bool:
    return str(payload.get("scope", "")).lower() in {
        "all_participants_paid",
        "all_participants",
        "everyone_paid",
    }


def _has_explicit_contributions(payload: dict) -> bool:
    contributions = payload.get("contributions")
    if isinstance(contributions, list) and bool(contributions):
        return True
    member_contributions = payload.get("member_contributions")
    return isinstance(member_contributions, dict) and bool(member_contributions)


def _with_provider_missing(
    provider_missing_names: list[str],
    *,
    allowed_names: set[str],
    payload: dict,
    data: dict | None = None,
) -> list[str]:
    names = []
    for name in provider_missing_names:
        if name not in allowed_names:
            continue
        value = (
            data.get(name)
            if data is not None and name in data
            else payload.get(name)
        )
        if is_missing_value(value):
            names.append(name)
    return names


def _require_field(names: list[str], payload: dict, field: str) -> None:
    if is_missing_value(payload.get(field)) and field not in names:
        names.append(field)


def _append_once(names: list[str], field: str) -> None:
    if field not in names:
        names.append(field)


def currency_amount_validation_error(
    value,
    *,
    currency_code: str,
    allow_zero: bool = False,
) -> str | None:
    """Return the expense-domain error for a currency-incompatible amount."""
    if is_missing_value(value):
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return "Enter a valid amount."
    if not amount.is_finite():
        return "Enter a valid amount."

    normalize = (
        normalize_non_negative_currency_amount
        if allow_zero
        else normalize_currency_amount
    )
    try:
        normalize(amount, currency_code)
    except ExpenseServiceError as exc:
        return str(exc)
    return None


def _is_invalid_money_value(
    value,
    *,
    allow_zero: bool = False,
    currency_code: str | None = None,
) -> bool:
    if currency_code:
        return (
            currency_amount_validation_error(
                value,
                currency_code=currency_code,
                allow_zero=allow_zero,
            )
            is not None
        )
    if is_missing_value(value):
        return False
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return True
    if not amount.is_finite():
        return True
    return amount < 0 if allow_zero else amount <= 0


def _append_invalid_money_field(
    names: list[str],
    payload: dict,
    field: str,
    *,
    allow_zero: bool = False,
    currency_code: str | None = None,
) -> None:
    if field in payload and _is_invalid_money_value(
        payload.get(field),
        allow_zero=allow_zero,
        currency_code=currency_code,
    ):
        _append_once(names, field)


def _append_invalid_contribution_amounts(
    names: list[str],
    payload: dict,
    *,
    currency_code: str | None = None,
) -> None:
    for field in EXPENSE_CONTRIBUTION_AMOUNT_FIELDS:
        _append_invalid_money_field(
            names,
            payload,
            field,
            allow_zero=True,
            currency_code=currency_code,
        )

    contributions = payload.get("contributions")
    if isinstance(contributions, list):
        for contribution in contributions:
            if not isinstance(contribution, dict):
                continue
            if any(
                _is_invalid_money_value(
                    contribution.get(field),
                    allow_zero=True,
                    currency_code=currency_code,
                )
                for field in EXPENSE_CONTRIBUTION_AMOUNT_FIELDS
                if field in contribution
            ):
                _append_once(names, "amount")

    member_contributions = payload.get("member_contributions")
    if isinstance(member_contributions, dict):
        for contribution in member_contributions.values():
            if not isinstance(contribution, dict):
                if _is_invalid_money_value(
                    contribution,
                    allow_zero=True,
                    currency_code=currency_code,
                ):
                    _append_once(names, "amount")
                continue
            if any(
                _is_invalid_money_value(
                    contribution.get(field),
                    allow_zero=True,
                    currency_code=currency_code,
                )
                for field in EXPENSE_CONTRIBUTION_AMOUNT_FIELDS
                if field in contribution
            ):
                _append_once(names, "amount")


def _has_valid_contribution_amount(
    payload: dict,
    *,
    currency_code: str | None = None,
) -> bool:
    for field in EXPENSE_CONTRIBUTION_AMOUNT_FIELDS:
        if field not in payload:
            continue
        value = payload.get(field)
        if is_missing_value(value):
            continue
        return not _is_invalid_money_value(
            value,
            allow_zero=True,
            currency_code=currency_code,
        )
    return False


def _has_valid_member_contribution_amount(
    value,
    *,
    currency_code: str | None = None,
) -> bool:
    if isinstance(value, dict):
        return _has_valid_contribution_amount(
            value,
            currency_code=currency_code,
        )
    if is_missing_value(value):
        return False
    return not _is_invalid_money_value(
        value,
        allow_zero=True,
        currency_code=currency_code,
    )


def _append_invalid_explicit_contribution_payloads(
    names: list[str],
    payload: dict,
    *,
    currency_code: str | None = None,
) -> None:
    contributions = payload.get("contributions")
    if isinstance(contributions, list) and contributions:
        has_invalid_item = any(
            not isinstance(contribution, dict)
            or not _has_any_value(contribution, EXPENSE_CONTRIBUTION_USER_FIELDS)
            or not _has_valid_contribution_amount(
                contribution,
                currency_code=currency_code,
            )
            for contribution in contributions
        )
        if has_invalid_item:
            _append_once(names, "contributions")

    member_contributions = payload.get("member_contributions")
    if isinstance(member_contributions, dict) and member_contributions:
        has_invalid_item = any(
            is_missing_value(member_id)
            or not _has_valid_member_contribution_amount(
                contribution,
                currency_code=currency_code,
            )
            for member_id, contribution in member_contributions.items()
        )
        if has_invalid_item:
            _append_once(names, "member_contributions")


def _serializer_error_field_names(errors, *, allowed_names: set[str]) -> list[str]:
    if not isinstance(errors, dict):
        return []
    names = []
    for raw_name in errors.keys():
        name = str(raw_name)
        if name == "non_field_errors":
            continue
        if name in allowed_names:
            names.append(name)
    return list(dict.fromkeys(names))


def _timeline_create_serializer_invalid_field_names(data: dict) -> list[str]:
    from trips.serializers import CreateTimelineActivitySerializer

    serializer = CreateTimelineActivitySerializer(data=data)
    if serializer.is_valid():
        return []
    return _serializer_error_field_names(
        serializer.errors,
        allowed_names=TIMELINE_ACTIVITY_DATA_FIELDS,
    )


def _timeline_update_serializer_invalid_field_names(data: dict) -> list[str]:
    from trips.serializers import PatchTimelineActivitySerializer

    serializer = PatchTimelineActivitySerializer(data=data)
    if serializer.is_valid():
        return []
    return _serializer_error_field_names(
        serializer.errors,
        allowed_names=TIMELINE_ACTIVITY_DATA_FIELDS,
    )


def _timeline_status_serializer_invalid_field_names(payload: dict) -> list[str]:
    from trips.serializers import UpdateTimelineActivityStatusSerializer

    serializer = UpdateTimelineActivityStatusSerializer(data=payload)
    if serializer.is_valid():
        return []
    return _serializer_error_field_names(
        serializer.errors,
        allowed_names={"status"},
    )


def _timeline_create_missing_names(
    payload: dict,
    provider_missing_names: list[str],
) -> list[str]:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    required_fields = ["title", "time_mode"]
    time_mode = data.get("time_mode")
    system_type = data.get("system_type")
    custom_type_id = data.get("custom_type_id")
    if not system_type and custom_type_id is None:
        required_fields.append("system_type")
    if system_type and custom_type_id is not None:
        required_fields.append("system_type")
    if time_mode == TimelineActivityTimeMode.AT_TIME:
        required_fields.append("start_time")
    if time_mode == TimelineActivityTimeMode.TIME_RANGE:
        required_fields.extend(["start_time", "end_time"])

    names = _with_provider_missing(
        provider_missing_names,
        allowed_names={*required_fields, "section_id", "section_date"},
        payload=payload,
        data=data,
    )
    if (
        is_blank(payload.get("section_id"))
        and is_blank(payload.get("section_date"))
        and "section_id" not in names
        and "section_date" not in names
    ):
        names.append("section_id")
    for field in required_fields:
        value = data.get(field)
        if is_blank(value) and field not in names:
            names.append(field)
    if time_mode and time_mode not in TimelineActivityTimeMode.values:
        _append_once(names, "time_mode")
    if system_type and system_type not in TimelineSystemType.values:
        _append_once(names, "system_type")
    location_mode = data.get("location_mode")
    if location_mode and location_mode not in TimelineLocationMode.values:
        _append_once(names, "location_mode")
    if location_mode == TimelineLocationMode.STRUCTURED:
        place = data.get("place")
        if not isinstance(place, dict) or not all(
            place.get(field) for field in ("provider", "provider_id", "title")
        ):
            _append_once(names, "place")
    names.extend(_timeline_create_serializer_invalid_field_names(data))
    return list(dict.fromkeys(names))


def _has_known_timeline_activity_patch_field(data: dict) -> bool:
    return any(field in TIMELINE_ACTIVITY_DATA_FIELDS for field in data)


def _timeline_update_invalid_field_names(data: dict) -> list[str]:
    names = []
    time_mode = data.get("time_mode")
    system_type = data.get("system_type")
    location_mode = data.get("location_mode")
    if time_mode and time_mode not in TimelineActivityTimeMode.values:
        names.append("time_mode")
    if system_type and system_type not in TimelineSystemType.values:
        names.append("system_type")
    if location_mode and location_mode not in TimelineLocationMode.values:
        names.append("location_mode")
    return names


def missing_payload_field_names(
    *,
    action_type: str,
    payload: dict,
    provider_missing_names: list[str] | None = None,
    currency_code: str | None = None,
) -> list[str]:
    provider_missing_names = provider_missing_names or []

    if action_type == AI_ACTION_EXPENSE_CREATE:
        names = _with_provider_missing(
            provider_missing_names,
            allowed_names={"title", "total_amount"},
            payload=payload,
        )
        _require_field(names, payload, "title")
        _require_field(names, payload, "total_amount")
        _append_invalid_money_field(
            names,
            payload,
            "total_amount",
            currency_code=currency_code,
        )
        return names

    if action_type == AI_ACTION_EXPENSE_UPDATE:
        names = _with_provider_missing(
            provider_missing_names,
            allowed_names={"expense_id", *EXPENSE_UPDATE_FIELDS},
            payload=payload,
        )
        _require_field(names, payload, "expense_id")
        if not _has_any_expense_update_field(payload):
            _append_once(names, "title")
        _append_invalid_money_field(
            names,
            payload,
            "total_amount",
            currency_code=currency_code,
        )
        return names

    if action_type == AI_ACTION_EXPENSE_DELETE:
        names = _with_provider_missing(
            provider_missing_names,
            allowed_names={"expense_id"},
            payload=payload,
        )
        _require_field(names, payload, "expense_id")
        return names

    if action_type == AI_ACTION_EXPENSE_CONTRIBUTION_SET:
        names = _with_provider_missing(
            provider_missing_names,
            allowed_names={
                "expense_id",
                "user_id",
                "amount",
                "contributions",
                "member_contributions",
                "scope",
            },
            payload=payload,
        )
        _require_field(names, payload, "expense_id")
        has_explicit_contributions = _has_explicit_contributions(payload)
        if has_explicit_contributions:
            _append_invalid_explicit_contribution_payloads(
                names,
                payload,
                currency_code=currency_code,
            )
        elif not _should_mark_all_participants_paid(payload):
            if not _has_any_value(payload, EXPENSE_CONTRIBUTION_USER_FIELDS):
                names.append("user_id")
            if not _has_any_value(payload, EXPENSE_CONTRIBUTION_AMOUNT_FIELDS):
                names.append("amount")
        _append_invalid_contribution_amounts(
            names,
            payload,
            currency_code=currency_code,
        )
        return list(dict.fromkeys(names))

    if action_type == AI_ACTION_TIMELINE_ACTIVITY_CREATE:
        return _timeline_create_missing_names(payload, provider_missing_names)

    if action_type == AI_ACTION_TIMELINE_ACTIVITY_UPDATE:
        names = _with_provider_missing(
            provider_missing_names,
            allowed_names={"activity_id", "data", *TIMELINE_ACTIVITY_DATA_FIELDS},
            payload=payload,
            data=payload.get("data") if isinstance(payload.get("data"), dict) else None,
        )
        _require_field(names, payload, "activity_id")
        data = payload.get("data")
        if (
            not isinstance(data, dict)
            or not data
            or not _has_known_timeline_activity_patch_field(data)
        ) and "data" not in names:
            names.append("data")
        if isinstance(data, dict):
            names.extend(_timeline_update_invalid_field_names(data))
            names.extend(_timeline_update_serializer_invalid_field_names(data))
        return list(dict.fromkeys(names))

    if action_type == AI_ACTION_TIMELINE_ACTIVITY_DELETE:
        names = _with_provider_missing(
            provider_missing_names,
            allowed_names={"activity_id"},
            payload=payload,
        )
        _require_field(names, payload, "activity_id")
        return names

    if action_type == AI_ACTION_TIMELINE_ACTIVITY_STATUS_UPDATE:
        names = _with_provider_missing(
            provider_missing_names,
            allowed_names={"activity_id", "status"},
            payload=payload,
        )
        _require_field(names, payload, "activity_id")
        _require_field(names, payload, "status")
        draft_status = payload.get("status")
        if draft_status and draft_status not in TimelineActivityStatus.values:
            _append_once(names, "status")
        names.extend(_timeline_status_serializer_invalid_field_names(payload))
        return names

    if action_type in {
        AI_ACTION_SETTLEMENT_TRANSFER_MARK_SENT,
        AI_ACTION_SETTLEMENT_TRANSFER_CONFIRM_RECEIVED,
    }:
        names = _with_provider_missing(
            provider_missing_names,
            allowed_names={"transfer_id"},
            payload=payload,
        )
        _require_field(names, payload, "transfer_id")
        return names

    if action_type in {AI_ACTION_SETTLEMENT_FINALIZE, AI_ACTION_SETTLEMENT_REOPEN}:
        return []

    return list(dict.fromkeys(provider_missing_names))
