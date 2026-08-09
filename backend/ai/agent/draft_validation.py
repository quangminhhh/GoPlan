from __future__ import annotations

from pydantic import ValidationError as PydanticValidationError

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


def validate_action_draft_patch_payload(
    *,
    draft: AIActionDraft,
    patch_payload: dict,
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

    merged_payload = {**(draft.payload or {}), **non_blank_patch}
    try:
        schema.model_validate(merged_payload)
    except PydanticValidationError as exc:
        field_errors = _field_errors_from_pydantic(
            exc,
            relevant_fields=set(non_blank_patch),
        )
        if field_errors:
            raise AIActionDraftFieldValidationError(field_errors) from exc
