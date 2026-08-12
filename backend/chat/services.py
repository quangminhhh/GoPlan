from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timedelta
from uuid import UUID

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from accounts.services import resolve_avatar_url
from ai.agent.drafts import build_action_draft_payload
from ai.services import (
    AIInvalidPromptError,
    create_pending_interaction,
    enqueue_ai_interaction_after_commit,
    ensure_ai_prompt_available,
)
from chat.mentions import extract_goplan_ai_prompt
from chat.models import (
    ALLOWED_REACTION_EMOJIS,
    ChatMessage,
    ChatMessageHiddenForUser,
    ChatMessageSenderKind,
    MessageReaction,
)
from trips.models import (
    CHAT_CHANGE_SEQUENCE_MAX,
    MemberStatus,
    Trip,
    TripMember,
    TripStatus,
)
from trips.services import TripNotFoundError, TripTerminalError

logger = logging.getLogger(__name__)

HISTORY_DEFAULT_LIMIT = 30
HISTORY_MAX_LIMIT = 100
GAP_FILL_DEFAULT_LIMIT = 100
GAP_FILL_MAX_LIMIT = 200
CHAT_MESSAGE_MAX_LENGTH = 2000
MESSAGE_DELETE_FOR_EVERYONE_WINDOW = timedelta(minutes=5)


class ChatServiceError(Exception):
    error_code: str = "CHAT_ERROR"


class ChatInvalidContentError(ChatServiceError):
    error_code = "INVALID_CONTENT"


class ChatInvalidCursorError(ChatServiceError):
    error_code = "INVALID_CURSOR"


class ChatReactionError(ChatServiceError):
    error_code = "REACTION_ERROR"


class ChatReactionDuplicateError(ChatReactionError):
    error_code = "REACTION_DUPLICATE"


class ChatReactionNotFoundError(ChatReactionError):
    error_code = "REACTION_NOT_FOUND"


class ChatReactionInvalidEmojiError(ChatReactionError):
    error_code = "INVALID_EMOJI"


class ChatMessageDeletedError(ChatServiceError):
    error_code = "MESSAGE_DELETED"


class ChatDeleteError(ChatServiceError):
    error_code = "MESSAGE_DELETE_ERROR"


class ChatDeleteForbiddenError(ChatDeleteError):
    error_code = "MESSAGE_DELETE_FORBIDDEN"


class ChatDeleteWindowExpiredError(ChatDeleteError):
    error_code = "MESSAGE_DELETE_WINDOW_EXPIRED"


class ChatDeleteInvalidModeError(ChatDeleteError):
    error_code = "INVALID_DELETE_MODE"


class ChatChangeSequenceExhaustedError(ChatServiceError):
    error_code = "CHANGE_SEQUENCE_EXHAUSTED"


def _chat_group_name(trip_id) -> str:
    return f"trip_chat_{trip_id}"


def _normalize_content(content: str) -> str:
    if not isinstance(content, str):
        raise ChatInvalidContentError("Message content is required.")
    normalized = content.strip()
    if not normalized:
        raise ChatInvalidContentError("Message content cannot be empty.")
    if len(normalized) > CHAT_MESSAGE_MAX_LENGTH:
        raise ChatInvalidContentError("Message content is too long.")
    return normalized


def _ensure_trip_is_mutable(trip: Trip) -> None:
    if trip.status in (TripStatus.COMPLETED, TripStatus.CANCELLED):
        raise TripTerminalError("Completed or cancelled trips are read-only.")


def _delete_for_everyone_until(message: ChatMessage) -> datetime:
    return message.created_at + MESSAGE_DELETE_FOR_EVERYONE_WINDOW


def _is_profile_completed_for_chat(user) -> bool:
    return bool(
        getattr(user, "email_verified", False)
        and getattr(user, "is_profile_completed", False)
    )


def _ensure_message_accepts_reactions(message: ChatMessage) -> None:
    if message.deleted_for_everyone_at is not None:
        raise ChatMessageDeletedError("Deleted messages cannot be reacted to.")


def _ensure_message_visible_to_user(message: ChatMessage, user) -> None:
    if ChatMessageHiddenForUser.objects.filter(message=message, user=user).exists():
        raise TripNotFoundError("Trip not found.")


def is_chat_message_hidden_for_user(*, user, trip_id, message_id) -> bool:
    try:
        normalized_message_id = UUID(str(message_id))
    except (TypeError, ValueError):
        return False

    return ChatMessageHiddenForUser.objects.filter(
        message_id=normalized_message_id,
        message__trip_id=trip_id,
        user=user,
    ).exists()


def _get_active_chat_trip(trip_id, user, *, for_update: bool = False) -> Trip:
    if not _is_profile_completed_for_chat(user):
        raise TripNotFoundError("Trip not found.")

    try:
        normalized_trip_id = UUID(str(trip_id))
    except (TypeError, ValueError) as exc:
        raise TripNotFoundError("Trip not found.") from exc

    if for_update:
        # Keep lock order aligned with trip membership mutations
        # (Trip -> TripMember) to avoid deadlocks during send/remove races.
        try:
            trip = Trip.objects.select_for_update().get(pk=normalized_trip_id)
        except Trip.DoesNotExist as exc:
            raise TripNotFoundError("Trip not found.") from exc

        try:
            TripMember.objects.select_for_update().get(
                trip=trip,
                user=user,
                status=MemberStatus.ACTIVE,
            )
        except TripMember.DoesNotExist as exc:
            raise TripNotFoundError("Trip not found.") from exc
        return trip

    membership_queryset = TripMember.objects.filter(
        trip_id=normalized_trip_id,
        user=user,
        status=MemberStatus.ACTIVE,
    )

    try:
        membership = membership_queryset.get()
    except TripMember.DoesNotExist as exc:
        raise TripNotFoundError("Trip not found.") from exc

    try:
        return Trip.objects.get(pk=membership.trip_id)
    except Trip.DoesNotExist as exc:
        raise TripNotFoundError("Trip not found.") from exc


def ensure_user_can_access_trip_chat(user, trip_id) -> None:
    _get_active_chat_trip(trip_id, user)


def allocate_chat_change_sequence(*, locked_trip: Trip) -> int:
    """Allocate the next per-trip chat change sequence.

    The caller must hold a ``select_for_update()`` lock on ``locked_trip`` and
    run inside the same transaction as the ChatMessage creation or mutation.
    This helper is intentionally reusable by the AI message lifecycle.
    """
    current_sequence = locked_trip.chat_change_sequence
    if current_sequence < 0 or current_sequence >= CHAT_CHANGE_SEQUENCE_MAX:
        raise ChatChangeSequenceExhaustedError(
            "Chat change sequence is exhausted."
        )

    next_sequence = current_sequence + 1
    locked_trip.chat_change_sequence = next_sequence
    locked_trip.save(update_fields=["chat_change_sequence"])
    return next_sequence


def build_reactions_payload(message: ChatMessage) -> list[dict]:
    """Aggregate reactions for a message grouped by emoji.

    Uses the Django prefetch cache when available (set by prefetch_related in
    list queries) to avoid N+1. Falls back to a direct query for single-message
    mutations where prefetch is not present.
    """
    prefetch_cache = getattr(message, "_prefetched_objects_cache", {})
    if "reactions" in prefetch_cache:
        reactions_iter = prefetch_cache["reactions"]
    else:
        reactions_iter = MessageReaction.objects.filter(message=message)

    grouped: dict[str, list[str]] = {}
    for reaction in reactions_iter:
        grouped.setdefault(reaction.emoji, []).append(str(reaction.user_id))

    return [
        {"emoji": emoji, "count": len(ids), "reacted_by_ids": ids}
        for emoji, ids in grouped.items()
    ]


def build_action_drafts_payload(message: ChatMessage, *, viewer=None) -> list[dict]:
    prefetch_cache = getattr(message, "_prefetched_objects_cache", {})
    if "ai_action_drafts" in prefetch_cache:
        drafts_iter = prefetch_cache["ai_action_drafts"]
    else:
        drafts_iter = message.ai_action_drafts.all().order_by("created_at", "id")

    return [
        build_action_draft_payload(draft, viewer=viewer)
        for draft in drafts_iter
    ]


def _fresh_reactions_payload(message_id) -> list[dict]:
    """Query reactions fresh from DB for use inside atomic mutations."""
    grouped: dict[str, list[str]] = {}
    for reaction in MessageReaction.objects.filter(message_id=message_id):
        grouped.setdefault(reaction.emoji, []).append(str(reaction.user_id))
    return [
        {"emoji": emoji, "count": len(ids), "reacted_by_ids": ids}
        for emoji, ids in grouped.items()
    ]


def _can_viewer_delete_for_everyone(message: ChatMessage, viewer) -> bool:
    if viewer is None:
        return False
    if message.sender_kind != ChatMessageSenderKind.USER:
        return False
    if message.sender_id != getattr(viewer, "id", None):
        return False
    if message.deleted_for_everyone_at is not None:
        return False
    return timezone.now() <= _delete_for_everyone_until(message)


def build_chat_message_payload(message: ChatMessage, *, viewer=None) -> dict:
    is_deleted = message.deleted_for_everyone_at is not None
    delete_for_everyone_until = (
        None if is_deleted else _delete_for_everyone_until(message)
    )
    return {
        "id": str(message.id),
        "trip_id": str(message.trip_id),
        "sender": {
            "id": str(message.sender_id) if message.sender_id else None,
            "display_name": message.sender_display_name_snapshot,
            "identify_tag": message.sender_identify_tag_snapshot,
            "avatar_url": (
                resolve_avatar_url(message.sender)
                if message.sender_id and message.sender
                else None
            ),
        },
        "content": "" if is_deleted else message.content,
        "client_message_id": (
            str(message.client_message_id) if message.client_message_id else None
        ),
        "change_sequence": message.change_sequence,
        "created_at": message.created_at.isoformat(),
        "updated_at": message.updated_at.isoformat(),
        "is_deleted_for_everyone": is_deleted,
        "deleted_for_everyone_at": (
            message.deleted_for_everyone_at.isoformat()
            if message.deleted_for_everyone_at
            else None
        ),
        "deleted_for_everyone_by_id": (
            str(message.deleted_for_everyone_by_id)
            if message.deleted_for_everyone_by_id
            else None
        ),
        "delete_for_everyone_until": (
            delete_for_everyone_until.isoformat()
            if delete_for_everyone_until is not None
            else None
        ),
        "can_delete_for_everyone": _can_viewer_delete_for_everyone(message, viewer),
        "reactions": [] if is_deleted else build_reactions_payload(message),
        "action_drafts": (
            [] if is_deleted else build_action_drafts_payload(message, viewer=viewer)
        ),
        "sender_kind": message.sender_kind,
        "ai_status": message.ai_status,
    }


def personalize_chat_message_payload_for_viewer(message_payload: dict, viewer) -> dict:
    """Return a per-viewer copy of a ChatMessage payload.

    Channel-layer chat events fan out one server-built payload to many sockets.
    This helper keeps viewer-specific fields, currently delete eligibility,
    accurate without mutating the shared event data.
    """
    personalized = {**message_payload}
    sender = personalized.get("sender")
    sender_id = sender.get("id") if isinstance(sender, dict) else None
    delete_until_raw = personalized.get("delete_for_everyone_until")
    can_delete = False

    if (
        not personalized.get("is_deleted_for_everyone")
        and sender_id is not None
        and str(sender_id) == str(getattr(viewer, "id", None))
        and isinstance(delete_until_raw, str)
    ):
        delete_until = parse_datetime(delete_until_raw)
        if delete_until is not None and timezone.is_naive(delete_until):
            delete_until = timezone.make_aware(
                delete_until,
                timezone.get_current_timezone(),
            )
        can_delete = delete_until is not None and timezone.now() <= delete_until

    personalized["can_delete_for_everyone"] = can_delete
    return personalized


def personalize_chat_event_payload_for_viewer(event_payload: dict, viewer) -> dict:
    personalized = {**event_payload}
    message = personalized.get("message")
    if isinstance(message, dict):
        personalized["message"] = personalize_chat_message_payload_for_viewer(
            message,
            viewer,
        )
    return personalized


def build_personalized_chat_event_payload_for_viewer(
    event_payload: dict,
    viewer,
) -> dict:
    message = event_payload.get("message")
    if not isinstance(message, dict):
        return event_payload

    message_id = message.get("id")
    if not message_id:
        return personalize_chat_event_payload_for_viewer(event_payload, viewer)

    try:
        chat_message = (
            ChatMessage.objects
            .select_related("sender")
            .prefetch_related("reactions", "ai_action_drafts")
            .get(pk=message_id)
        )
    except (ChatMessage.DoesNotExist, TypeError, ValueError, ValidationError):
        return personalize_chat_event_payload_for_viewer(event_payload, viewer)

    return {
        **event_payload,
        "message": build_chat_message_payload(chat_message, viewer=viewer),
    }


def build_chat_message_ws_payload(message: ChatMessage) -> dict:
    return {
        "type": "chat.message",
        "trip_id": str(message.trip_id),
        "message": build_chat_message_payload(message),
    }


def build_message_deleted_ws_payload(message: ChatMessage) -> dict:
    return {
        "type": "chat.message_deleted",
        "trip_id": str(message.trip_id),
        "message": build_chat_message_payload(message),
    }


def push_chat_message(message: ChatMessage) -> None:
    try:
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            _chat_group_name(message.trip_id),
            {
                "type": "chat_message_push",
                "data": build_chat_message_ws_payload(message),
            },
        )
    except Exception:
        logger.error(
            "Failed to push chat message %s via WebSocket",
            message.id,
            exc_info=True,
        )


def _push_message_deleted(message: ChatMessage) -> None:
    try:
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            _chat_group_name(message.trip_id),
            {
                "type": "chat_message_deleted_push",
                "data": build_message_deleted_ws_payload(message),
            },
        )
    except Exception:
        logger.error(
            "Failed to push deleted chat message %s via WebSocket",
            message.id,
            exc_info=True,
        )


def _push_chat_kicked(*, trip_id, user_id) -> None:
    try:
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            _chat_group_name(trip_id),
            {
                "type": "chat_kicked_push",
                "data": {
                    "trip_id": str(trip_id),
                    "user_id": str(user_id),
                },
            },
        )
    except Exception:
        logger.error(
            "Failed to push chat kicked event for user %s in trip %s",
            user_id,
            trip_id,
            exc_info=True,
        )


def send_chat_message(
    *,
    user,
    trip_id,
    content: str,
    client_message_id,
) -> tuple[ChatMessage, bool]:
    normalized_content = _normalize_content(content)

    with transaction.atomic():
        trip = _get_active_chat_trip(trip_id, user, for_update=True)

        existing_message = ChatMessage.objects.filter(
            trip=trip,
            sender=user,
            client_message_id=client_message_id,
        ).select_related("sender").first()
        if existing_message is not None:
            return existing_message, False

        _ensure_trip_is_mutable(trip)

        has_ai_mention, ai_prompt, display_content = extract_goplan_ai_prompt(
            normalized_content
        )
        if has_ai_mention:
            if not ai_prompt:
                raise AIInvalidPromptError("AI prompt is required.")
            ensure_ai_prompt_available(trip)

        try:
            with transaction.atomic():
                change_sequence = allocate_chat_change_sequence(locked_trip=trip)
                message = ChatMessage.objects.create(
                    trip=trip,
                    sender=user,
                    sender_display_name_snapshot=user.display_name,
                    sender_identify_tag_snapshot=user.identify_tag,
                    content=display_content if has_ai_mention else normalized_content,
                    client_message_id=client_message_id,
                    change_sequence=change_sequence,
                )

                if has_ai_mention:
                    interaction = create_pending_interaction(
                        trip=trip,
                        requested_by=user,
                        prompt_message=message,
                        prompt=ai_prompt,
                    )
                    enqueue_ai_interaction_after_commit(interaction)
        except IntegrityError:
            existing_message = ChatMessage.objects.filter(
                trip=trip,
                sender=user,
                client_message_id=client_message_id,
            ).select_related("sender").get()
            return existing_message, False

        transaction.on_commit(lambda: push_chat_message(message))
        return message, True


def _encode_cursor(message: ChatMessage) -> str:
    raw = json.dumps(
        {
            "created_at": message.created_at.isoformat(),
            "id": str(message.id),
        },
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str):
    try:
        decoded = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        payload = json.loads(decoded)
        created_at = parse_datetime(payload["created_at"])
        message_id = UUID(str(payload["id"]))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ChatInvalidCursorError("Invalid chat cursor.") from exc

    if created_at is None:
        raise ChatInvalidCursorError("Invalid chat cursor.")
    return created_at, message_id


def _history_page(trip: Trip, *, user, cursor: str | None, limit: int) -> dict:
    queryset = (
        ChatMessage.objects.filter(trip=trip)
        .exclude(hidden_for_users__user=user)
        .select_related("sender")
        .prefetch_related("reactions", "ai_action_drafts")
    )
    if cursor:
        created_at, message_id = _decode_cursor(cursor)
        queryset = queryset.filter(
            Q(created_at__lt=created_at)
            | Q(created_at=created_at, id__lt=message_id)
        )

    rows = list(queryset.order_by("-created_at", "-id")[: limit + 1])
    page = rows[:limit]
    return {
        "results": [
            build_chat_message_payload(message, viewer=user) for message in page
        ],
        "next_cursor": _encode_cursor(page[-1]) if len(rows) > limit and page else None,
    }


def _gap_fill_page(trip: Trip, *, user, since, limit: int) -> dict:
    try:
        anchor = ChatMessage.objects.get(pk=since, trip=trip)
    except ChatMessage.DoesNotExist:
        return {"results": [], "has_more": False}

    rows = list(
        ChatMessage.objects
        .filter(trip=trip)
        .exclude(hidden_for_users__user=user)
        .filter(
            Q(created_at__gt=anchor.created_at)
            | Q(created_at=anchor.created_at, id__gt=anchor.id)
        )
        .select_related("sender")
        .prefetch_related("reactions", "ai_action_drafts")
        .order_by("created_at", "id")[: limit + 1]
    )
    page = rows[:limit]
    return {
        "results": [
            build_chat_message_payload(message, viewer=user) for message in page
        ],
        "has_more": len(rows) > limit,
    }


def _updated_since_page(
    trip: Trip,
    *,
    user,
    updated_since,
    updated_since_id=None,
    limit: int,
) -> dict:
    queryset = (
        ChatMessage.objects
        .filter(trip=trip)
        .exclude(hidden_for_users__user=user)
    )
    if updated_since_id is not None:
        queryset = queryset.filter(
            Q(updated_at__gt=updated_since)
            | Q(updated_at=updated_since, id__gt=updated_since_id)
        )
    else:
        queryset = queryset.filter(updated_at__gt=updated_since)

    rows = list(
        queryset
        .select_related("sender")
        .prefetch_related("reactions", "ai_action_drafts")
        .order_by("updated_at", "id")[: limit + 1]
    )
    page = rows[:limit]
    return {
        "results": [
            build_chat_message_payload(message, viewer=user) for message in page
        ],
        "has_more": len(rows) > limit,
    }


def _changed_since_page(
    trip: Trip,
    *,
    user,
    changed_since: int,
    changed_since_id=None,
    limit: int,
) -> dict:
    queryset = (
        ChatMessage.objects
        .filter(trip=trip)
        .exclude(hidden_for_users__user=user)
    )
    if changed_since_id is not None:
        queryset = queryset.filter(
            Q(change_sequence__gt=changed_since)
            | Q(change_sequence=changed_since, id__gt=changed_since_id)
        )
    else:
        queryset = queryset.filter(change_sequence__gt=changed_since)

    rows = list(
        queryset
        .select_related("sender")
        .prefetch_related("reactions", "ai_action_drafts")
        .order_by("change_sequence", "id")[: limit + 1]
    )
    page = rows[:limit]
    return {
        "results": [
            build_chat_message_payload(message, viewer=user) for message in page
        ],
        "has_more": len(rows) > limit,
    }


def list_chat_messages(
    *,
    user,
    trip_id,
    cursor: str | None = None,
    limit: int | None = None,
    since=None,
    updated_since=None,
    updated_since_id=None,
    changed_since: int | None = None,
    changed_since_id=None,
) -> dict:
    trip = _get_active_chat_trip(trip_id, user)
    if changed_since is not None:
        resolved_limit = min(limit or GAP_FILL_DEFAULT_LIMIT, GAP_FILL_MAX_LIMIT)
        return _changed_since_page(
            trip,
            user=user,
            changed_since=changed_since,
            changed_since_id=changed_since_id,
            limit=resolved_limit,
        )
    if updated_since is not None:
        resolved_limit = min(limit or GAP_FILL_DEFAULT_LIMIT, GAP_FILL_MAX_LIMIT)
        return _updated_since_page(
            trip,
            user=user,
            updated_since=updated_since,
            updated_since_id=updated_since_id,
            limit=resolved_limit,
        )
    if since is not None:
        resolved_limit = min(limit or GAP_FILL_DEFAULT_LIMIT, GAP_FILL_MAX_LIMIT)
        return _gap_fill_page(trip, user=user, since=since, limit=resolved_limit)

    resolved_limit = min(limit or HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT)
    return _history_page(trip, user=user, cursor=cursor, limit=resolved_limit)


def notify_trip_chat_member_removed(*, trip_id, user_id) -> None:
    transaction.on_commit(lambda: _push_chat_kicked(trip_id=trip_id, user_id=user_id))


# -------- Deletions --------

def _normalize_message_id(message_id) -> UUID:
    try:
        return UUID(str(message_id))
    except (TypeError, ValueError) as exc:
        raise TripNotFoundError("Trip not found.") from exc


def hide_messages_for_user(*, user, trip_id, message_ids) -> list[str]:
    normalized_ids: list[UUID] = []
    seen: set[UUID] = set()
    for raw_id in message_ids:
        message_id = _normalize_message_id(raw_id)
        if message_id in seen:
            continue
        seen.add(message_id)
        normalized_ids.append(message_id)

    if not normalized_ids:
        return []

    with transaction.atomic():
        trip = _get_active_chat_trip(trip_id, user, for_update=True)
        _ensure_trip_is_mutable(trip)
        messages = list(
            ChatMessage.objects.select_for_update()
            .filter(trip=trip, id__in=normalized_ids)
            .only("id")
        )
        found_ids = {message.id for message in messages}
        if found_ids != set(normalized_ids):
            raise TripNotFoundError("Trip not found.")

        ChatMessageHiddenForUser.objects.bulk_create(
            [
                ChatMessageHiddenForUser(message_id=message_id, user=user)
                for message_id in normalized_ids
            ],
            ignore_conflicts=True,
        )

    return [str(message_id) for message_id in normalized_ids]


def delete_message_for_everyone(*, user, trip_id, message_id) -> ChatMessage:
    normalized_message_id = _normalize_message_id(message_id)

    with transaction.atomic():
        trip = _get_active_chat_trip(trip_id, user, for_update=True)
        _ensure_trip_is_mutable(trip)
        try:
            message = (
                ChatMessage.objects.select_for_update(of=("self",))
                .select_related("sender")
                .get(pk=normalized_message_id, trip=trip)
            )
        except ChatMessage.DoesNotExist as exc:
            raise TripNotFoundError("Trip not found.") from exc

        if message.sender_kind != ChatMessageSenderKind.USER:
            raise ChatDeleteForbiddenError("You can only remove your own message.")

        if message.sender_id != user.id:
            raise ChatDeleteForbiddenError("You can only remove your own message.")

        if message.deleted_for_everyone_at is not None:
            return message

        if timezone.now() - message.created_at > MESSAGE_DELETE_FOR_EVERYONE_WINDOW:
            raise ChatDeleteWindowExpiredError(
                "This message can no longer be removed for everyone."
            )

        MessageReaction.objects.filter(message=message).delete()
        deleted_at = timezone.now()
        change_sequence = allocate_chat_change_sequence(locked_trip=trip)
        message.content = ""
        message.deleted_for_everyone_at = deleted_at
        message.deleted_for_everyone_by = user
        message.updated_at = deleted_at
        message.change_sequence = change_sequence
        message.save(
            update_fields=[
                "content",
                "deleted_for_everyone_at",
                "deleted_for_everyone_by",
                "updated_at",
                "change_sequence",
            ]
        )
        transaction.on_commit(lambda: _push_message_deleted(message))
        return message


# -------- Reactions --------

def _build_reaction_mutation_payload(
    *,
    message: ChatMessage,
    reactions: list[dict],
) -> dict:
    return {
        "reactions": reactions,
        "change_sequence": message.change_sequence,
        "updated_at": message.updated_at.isoformat(),
    }


def _push_reaction_update(*, message: ChatMessage, payload: dict) -> None:
    try:
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            _chat_group_name(message.trip_id),
            {
                "type": "chat_reaction_update_push",
                "data": {
                    "type": "chat.reaction_update",
                    "trip_id": str(message.trip_id),
                    "message_id": str(message.id),
                    **payload,
                },
            },
        )
    except Exception:
        logger.error(
            "Failed to push reaction update for message %s via WebSocket",
            message.id,
            exc_info=True,
        )


def _mark_message_changed(*, message: ChatMessage, locked_trip: Trip) -> None:
    message.updated_at = timezone.now()
    message.change_sequence = allocate_chat_change_sequence(locked_trip=locked_trip)
    ChatMessage.objects.filter(pk=message.pk).update(
        updated_at=message.updated_at,
        change_sequence=message.change_sequence,
    )


def add_reaction(*, user, trip_id, message_id, emoji: str) -> dict:
    if emoji not in ALLOWED_REACTION_EMOJIS:
        raise ChatReactionInvalidEmojiError("Unsupported emoji.")

    with transaction.atomic():
        trip = _get_active_chat_trip(trip_id, user, for_update=True)
        _ensure_trip_is_mutable(trip)
        try:
            # Lock message row to serialize concurrent reaction mutations and
            # ensure the payload snapshot is consistent with what we push.
            message = ChatMessage.objects.select_for_update().get(
                pk=message_id, trip=trip
            )
        except ChatMessage.DoesNotExist as exc:
            raise TripNotFoundError("Trip not found.") from exc
        _ensure_message_visible_to_user(message, user)
        _ensure_message_accepts_reactions(message)

        # Enforce one reaction per user per message: atomically replace any
        # existing reaction with a different emoji before creating the new one.
        MessageReaction.objects.filter(
            message=message,
            user=user,
        ).exclude(emoji=emoji).delete()

        try:
            MessageReaction.objects.create(message=message, user=user, emoji=emoji)
        except IntegrityError:
            raise ChatReactionDuplicateError("You already reacted with this emoji.")

        _mark_message_changed(message=message, locked_trip=trip)
        reactions = _fresh_reactions_payload(message.id)
        payload = _build_reaction_mutation_payload(
            message=message,
            reactions=reactions,
        )
        transaction.on_commit(
            lambda: _push_reaction_update(message=message, payload=payload)
        )

    return payload


def remove_reaction(*, user, trip_id, message_id, emoji: str) -> dict:
    if emoji not in ALLOWED_REACTION_EMOJIS:
        raise ChatReactionInvalidEmojiError("Unsupported emoji.")

    with transaction.atomic():
        trip = _get_active_chat_trip(trip_id, user, for_update=True)
        _ensure_trip_is_mutable(trip)
        try:
            message = ChatMessage.objects.select_for_update().get(
                pk=message_id, trip=trip
            )
        except ChatMessage.DoesNotExist as exc:
            raise TripNotFoundError("Trip not found.") from exc
        _ensure_message_visible_to_user(message, user)
        _ensure_message_accepts_reactions(message)

        deleted_count, _ = MessageReaction.objects.filter(
            message=message, user=user, emoji=emoji
        ).delete()

        if deleted_count == 0:
            raise ChatReactionNotFoundError("Reaction not found.")

        _mark_message_changed(message=message, locked_trip=trip)
        reactions = _fresh_reactions_payload(message.id)
        payload = _build_reaction_mutation_payload(
            message=message,
            reactions=reactions,
        )
        transaction.on_commit(
            lambda: _push_reaction_update(message=message, payload=payload)
        )

    return payload
