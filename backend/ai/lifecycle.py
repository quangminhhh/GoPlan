from __future__ import annotations

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from ai.chat_changes import (
    lock_trip_for_ai_chat_change,
    schedule_chat_message_push,
)
from ai.models import AIActionDraft, AIInteraction, AIInteractionStatus
from ai.services import (
    AI_LOCK_TTL,
    has_active_ai_interaction,
    message_for_error_code,
)
from chat.models import ChatMessage, ChatMessageAIStatus, ChatMessageSenderKind
from chat.services import allocate_chat_change_sequence
from trips.models import Trip


def summarize_draft(*, action_type: str, payload: dict, status: str) -> str:
    title = payload.get("title") or action_type
    return f"[{status}] {action_type}: {title[:160]}"


class InteractionAlreadyRunningError(Exception):
    """Raised when another worker still owns this interaction's active lock."""


def claim_interaction_for_run(interaction_id):
    now = timezone.now()
    trip_id = (
        AIInteraction.objects.filter(pk=interaction_id)
        .values_list("trip_id", flat=True)
        .first()
    )
    if trip_id is None:
        return None

    with transaction.atomic():
        try:
            Trip.objects.select_for_update().get(pk=trip_id)
        except Trip.DoesNotExist:
            return None

        try:
            interaction = AIInteraction.objects.select_for_update().get(
                pk=interaction_id
            )
        except AIInteraction.DoesNotExist:
            return None

        if interaction.response_message_id is not None:
            return None
        if interaction.status in (
            AIInteractionStatus.SUCCEEDED,
            AIInteractionStatus.FAILED,
        ):
            return None
        if (
            interaction.status == AIInteractionStatus.RUNNING
            and interaction.lock_expires_at > now
        ):
            raise InteractionAlreadyRunningError(str(interaction.id))
        if has_active_ai_interaction(
            trip_id=interaction.trip_id,
            now=now,
            exclude_interaction_id=interaction.id,
        ):
            raise InteractionAlreadyRunningError(str(interaction.id))

        interaction.status = AIInteractionStatus.RUNNING
        interaction.started_at = interaction.started_at or now
        interaction.last_attempted_at = now
        interaction.attempt_count += 1
        interaction.lock_expires_at = now + AI_LOCK_TTL
        interaction.save(
            update_fields=[
                "status",
                "started_at",
                "last_attempted_at",
                "attempt_count",
                "lock_expires_at",
                "updated_at",
            ]
        )
    return interaction


def finish_interaction_success(*, interaction, message_text: str) -> ChatMessage:
    """Create the AI ChatMessage and attach drafts already persisted by tools."""
    now = timezone.now()
    with transaction.atomic():
        locked_trip = lock_trip_for_ai_chat_change(trip_id=interaction.trip_id)
        interaction = AIInteraction.objects.select_for_update().get(
            pk=interaction.pk,
            trip=locked_trip,
        )
        if interaction.response_message_id is not None:
            return interaction.response_message

        content = (message_text or "").strip() or "GoPlanAI"
        change_sequence = allocate_chat_change_sequence(locked_trip=locked_trip)
        message = ChatMessage.objects.create(
            trip=locked_trip,
            sender=None,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            sender_identify_tag_snapshot=None,
            content=content,
            ai_status=ChatMessageAIStatus.SUCCESS,
            change_sequence=change_sequence,
        )
        AIActionDraft.objects.filter(
            interaction=interaction, response_message__isnull=True
        ).update(response_message=message)

        interaction.response_message = message
        interaction.status = AIInteractionStatus.SUCCEEDED
        interaction.error_code = None
        interaction.completed_at = now
        interaction.lock_expires_at = now
        interaction.save(
            update_fields=[
                "response_message",
                "status",
                "error_code",
                "completed_at",
                "lock_expires_at",
            ]
        )
        schedule_chat_message_push(message)
    return message


def release_interaction_for_retry(
    *,
    interaction,
    error_code: str,
    retry_after_seconds: int,
) -> None:
    now = timezone.now()
    with transaction.atomic():
        interaction = AIInteraction.objects.select_for_update().get(pk=interaction.pk)
        if interaction.response_message_id is not None:
            return
        if interaction.status in (
            AIInteractionStatus.SUCCEEDED,
            AIInteractionStatus.FAILED,
        ):
            return
        interaction.status = AIInteractionStatus.PENDING
        interaction.error_code = error_code
        interaction.lock_expires_at = now + timedelta(seconds=retry_after_seconds)
        interaction.save(
            update_fields=[
                "status",
                "error_code",
                "lock_expires_at",
                "updated_at",
            ]
        )


def finish_interaction_failure(*, interaction, error_code: str) -> ChatMessage:
    now = timezone.now()
    with transaction.atomic():
        locked_trip = lock_trip_for_ai_chat_change(trip_id=interaction.trip_id)
        interaction = AIInteraction.objects.select_for_update().get(
            pk=interaction.pk,
            trip=locked_trip,
        )
        if interaction.response_message_id is not None:
            return interaction.response_message
        change_sequence = allocate_chat_change_sequence(locked_trip=locked_trip)
        message = ChatMessage.objects.create(
            trip=locked_trip,
            sender=None,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            sender_identify_tag_snapshot=None,
            content=message_for_error_code(error_code),
            ai_status=ChatMessageAIStatus.ERROR,
            change_sequence=change_sequence,
        )
        interaction.response_message = message
        interaction.status = AIInteractionStatus.FAILED
        interaction.error_code = error_code
        interaction.completed_at = now
        interaction.lock_expires_at = now
        interaction.save()
        schedule_chat_message_push(message)
    return message
