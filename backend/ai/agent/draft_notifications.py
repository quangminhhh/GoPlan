from __future__ import annotations

from django.db import transaction

from ai.action_types import TRANSFER_PAYER_ACTIONS, TRANSFER_RECIPIENT_ACTIONS
from ai.chat_changes import (
    lock_trip_for_ai_chat_change,
    mark_ai_response_message_changed,
)
from ai.models import AIActionDraft, AIActionDraftStatus
from chat.models import ChatMessage
from trips.models import Trip

TRANSFER_ACTIONS = TRANSFER_PAYER_ACTIONS | TRANSFER_RECIPIENT_ACTIONS
ACTIVE_DRAFT_STATUSES = {
    AIActionDraftStatus.NEEDS_INFO,
    AIActionDraftStatus.READY,
}


def refresh_transfer_action_draft_messages(*, trip_id, transfer_id) -> None:
    with transaction.atomic():
        try:
            locked_trip = lock_trip_for_ai_chat_change(trip_id=trip_id)
        except Trip.DoesNotExist:
            return

        message_ids = list(
            AIActionDraft.objects.filter(
                trip_id=trip_id,
                action_type__in=TRANSFER_ACTIONS,
                status__in=ACTIVE_DRAFT_STATUSES,
                payload__transfer_id=str(transfer_id),
                response_message_id__isnull=False,
            )
            .values_list("response_message_id", flat=True)
            .distinct()
        )
        if not message_ids:
            return

        messages = list(
            ChatMessage.objects
            .select_for_update(of=("self",))
            .select_related("sender")
            .filter(pk__in=message_ids, trip=locked_trip)
            .order_by("id")
        )
        for message in messages:
            mark_ai_response_message_changed(
                message=message,
                locked_trip=locked_trip,
            )
