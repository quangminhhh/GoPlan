from __future__ import annotations

from pydantic import ValidationError as PydanticValidationError

from ai.action_types import (
    AI_ACTION_EXPENSE_CONTRIBUTION_SET,
    AI_ACTION_EXPENSE_CREATE,
    AI_ACTION_EXPENSE_UPDATE,
)
from ai.agent.payload_validation import (
    EXPENSE_CONTRIBUTION_AMOUNT_FIELDS,
    currency_amount_validation_error,
)
from ai.agent.schemas import (
    ConfirmTransferReceivedArgs,
    CreateExpenseArgs,
    CreateTimelineActivityArgs,
    DeleteExpenseArgs,
    DeleteTimelineActivityArgs,
    FinalizeSettlementArgs,
    MarkTransferSentArgs,
    ReopenSettlementArgs,
    SetExpenseContributionArgs,
    UpdateExpenseArgs,
    UpdateTimelineActivityArgs,
    UpdateTimelineActivityStatusArgs,
)
from ai.models import AIActionDraft

SCHEMA_BY_ACTION = {
    "timeline.activity.create": CreateTimelineActivityArgs,
    "timeline.activity.update": UpdateTimelineActivityArgs,
    "timeline.activity.delete": DeleteTimelineActivityArgs,
    "timeline.activity.status.update": UpdateTimelineActivityStatusArgs,
    "expense.create": CreateExpenseArgs,
    "expense.update": UpdateExpenseArgs,
    "expense.delete": DeleteExpenseArgs,
    "expense.contribution.set": SetExpenseContributionArgs,
    "settlement.finalize": FinalizeSettlementArgs,
    "settlement.reopen": ReopenSettlementArgs,
    "settlement.transfer.mark_sent": MarkTransferSentArgs,
    "settlement.transfer.confirm_received": ConfirmTransferReceivedArgs,
}


class AIActionDraftFieldValidationError(Exception):
    error_code = "FIELD_VALIDATION_FAILED"

    def __init__(self, field_errors: dict[str, str]) -> None:
        self.field_errors = field_errors
        super().__init__("Field validation failed.")


def _field_errors_from_pydantic(
    exc: PydanticValidationError,
    *,
    relevant_fields: set[str],
) -> dict[str, str]:
    errors = {}
    for error in exc.errors(include_url=False):
        location = error["loc"]
        message = error["msg"]
        if location:
            path = ".".join(str(part) for part in location)
            if str(location[0]) not in relevant_fields:
                continue
            errors[path] = message
            continue

        # Attribute cross-field validator errors only to fields in this patch.
        for field in relevant_fields:
            if field in message:
                errors[field] = message
    return errors


def _append_currency_amount_field_error(
    errors: dict[str, str],
    *,
    path: str,
    value,
    currency_code: str,
    allow_zero: bool,
) -> None:
    error = currency_amount_validation_error(
        value,
        currency_code=currency_code,
        allow_zero=allow_zero,
    )
    if error:
        errors[path] = error


def _expense_contribution_currency_field_errors(
    patch_payload: dict,
    *,
    currency_code: str,
) -> dict[str, str]:
    errors: dict[str, str] = {}

    for field in EXPENSE_CONTRIBUTION_AMOUNT_FIELDS:
        if field in patch_payload:
            _append_currency_amount_field_error(
                errors,
                path=field,
                value=patch_payload[field],
                currency_code=currency_code,
                allow_zero=True,
            )

    contributions = patch_payload.get("contributions")
    if isinstance(contributions, list):
        for index, contribution in enumerate(contributions):
            if not isinstance(contribution, dict) or "amount" not in contribution:
                continue
            _append_currency_amount_field_error(
                errors,
                path=f"contributions.{index}.amount",
                value=contribution["amount"],
                currency_code=currency_code,
                allow_zero=True,
            )

    member_contributions = patch_payload.get("member_contributions")
    if isinstance(member_contributions, dict):
        for member_id, contribution in member_contributions.items():
            base_path = f"member_contributions.{member_id}"
            if not isinstance(contribution, dict):
                _append_currency_amount_field_error(
                    errors,
                    path=base_path,
                    value=contribution,
                    currency_code=currency_code,
                    allow_zero=True,
                )
                continue
            for field in EXPENSE_CONTRIBUTION_AMOUNT_FIELDS:
                if field not in contribution:
                    continue
                _append_currency_amount_field_error(
                    errors,
                    path=f"{base_path}.{field}",
                    value=contribution[field],
                    currency_code=currency_code,
                    allow_zero=True,
                )

    return errors


def validate_action_draft_patch_payload(
    *,
    draft: AIActionDraft,
    patch_payload: dict,
    currency_code: str,
) -> None:
    """Validate patch fields against the action schema without changing wire behavior."""
    schema = SCHEMA_BY_ACTION.get(draft.action_type)
    if schema is None or not patch_payload:
        return

    non_blank_patch = {
        key: value
        for key, value in patch_payload.items()
        if value not in (None, "")
        and not (isinstance(value, str) and not value.strip())
    }
    if not non_blank_patch:
        return

    merged_payload = dict(draft.payload or {})
    if draft.action_type == AI_ACTION_EXPENSE_CREATE:
        # Validate against the locked current trip currency, not a snapshot
        # captured while this draft was waiting for user input.
        merged_payload["currency_code"] = currency_code
    merged_payload.update(non_blank_patch)
    try:
        schema.model_validate(merged_payload)
    except PydanticValidationError as exc:
        field_errors = _field_errors_from_pydantic(
            exc,
            relevant_fields=set(non_blank_patch),
        )
        if field_errors:
            raise AIActionDraftFieldValidationError(field_errors) from exc

    currency_field_errors: dict[str, str] = {}
    if (
        draft.action_type in {AI_ACTION_EXPENSE_CREATE, AI_ACTION_EXPENSE_UPDATE}
        and "total_amount" in non_blank_patch
    ):
        _append_currency_amount_field_error(
            currency_field_errors,
            path="total_amount",
            value=non_blank_patch["total_amount"],
            currency_code=currency_code,
            allow_zero=False,
        )
    elif draft.action_type == AI_ACTION_EXPENSE_CONTRIBUTION_SET:
        currency_field_errors.update(
            _expense_contribution_currency_field_errors(
                non_blank_patch,
                currency_code=currency_code,
            )
        )

    if currency_field_errors:
        raise AIActionDraftFieldValidationError(currency_field_errors)
