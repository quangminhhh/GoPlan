from __future__ import annotations

from functools import partial

from django.db import transaction

from chat.models import ChatMessage
from chat.services import allocate_chat_change_sequence, push_chat_message
from trips.models import MemberStatus, Trip, TripMember


def lock_trip_for_ai_chat_change(*, trip_id) -> Trip:
    """Lock the trip row that owns an AI chat snapshot mutation.

    All AI response-message creates and mutations use the global lock order
    ``Trip -> draft/message`` so they serialize with ordinary chat changes.
    The caller must be inside ``transaction.atomic()``.
    """
    return Trip.objects.select_for_update().get(pk=trip_id)


def lock_active_trip_member_for_ai_action(*, locked_trip: Trip, actor) -> TripMember:
    """Lock the active actor membership after its owning Trip row."""
    return TripMember.objects.select_for_update().get(
        trip=locked_trip,
        user=actor,
        status=MemberStatus.ACTIVE,
    )


def schedule_chat_message_push(message: ChatMessage) -> None:
    """Publish a committed message snapshot, never an in-flight mutation."""
    transaction.on_commit(partial(push_chat_message, message))


def mark_ai_response_message_changed(
    *,
    message: ChatMessage | None,
    locked_trip: Trip,
) -> ChatMessage | None:
    """Allocate and persist the next sequence for an existing AI response.

    ``locked_trip`` must be locked with ``select_for_update()`` in the same
    transaction as the action-draft mutation that changes the message payload.
    A null response is valid while a worker is still assembling a new reply.
    """
    if message is None or message.pk is None:
        return None
    if message.trip_id != locked_trip.pk:
        raise ValueError("AI response message must belong to the locked trip.")

    locked_message = (
        ChatMessage.objects
        .select_for_update(of=("self",))
        .select_related("sender")
        .get(pk=message.pk, trip=locked_trip)
    )
    # Nested AI/domain mutations can hold multiple Python instances for the
    # same already-locked Trip row. Reload the authoritative counter so a
    # stale outer instance can never reuse a sequence allocated by an inner
    # savepoint in this transaction.
    locked_trip.refresh_from_db(fields=["chat_change_sequence"])
    locked_message.change_sequence = allocate_chat_change_sequence(
        locked_trip=locked_trip
    )
    locked_message.save(update_fields=["change_sequence", "updated_at"])

    # Keep the related object already cached on a returned draft coherent with
    # the committed row and with the object captured by the on-commit callback.
    message.change_sequence = locked_message.change_sequence
    message.updated_at = locked_message.updated_at
    schedule_chat_message_push(locked_message)
    return locked_message
