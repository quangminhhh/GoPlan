from __future__ import annotations

import uuid

from django.conf import settings
from django.core.validators import MaxValueValidator
from django.db import models
from django.db.models import Q

from trips.models import CHAT_CHANGE_SEQUENCE_MAX

ALLOWED_REACTION_EMOJIS = ["❤️", "😂", "😮", "😢", "😡", "👍", "👎"]


class ChatMessageSenderKind(models.TextChoices):
    USER = "USER", "User"
    AI = "AI", "AI"


class ChatMessageAIStatus(models.TextChoices):
    SUCCESS = "SUCCESS", "Success"
    ERROR = "ERROR", "Error"


class ChatMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    trip = models.ForeignKey(
        "trips.Trip",
        on_delete=models.CASCADE,
        related_name="chat_messages",
    )
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="sent_chat_messages",
    )
    sender_display_name_snapshot = models.CharField(
        max_length=161,
        blank=True,
        default="",
    )
    sender_identify_tag_snapshot = models.CharField(
        max_length=31,
        null=True,
        blank=True,
        default=None,
    )
    sender_kind = models.CharField(
        max_length=8,
        choices=ChatMessageSenderKind.choices,
        default=ChatMessageSenderKind.USER,
    )
    ai_status = models.CharField(
        max_length=8,
        choices=ChatMessageAIStatus.choices,
        null=True,
        blank=True,
    )
    content = models.TextField()
    client_message_id = models.UUIDField(null=True, blank=True)
    change_sequence = models.PositiveBigIntegerField(
        default=0,
        validators=[MaxValueValidator(CHAT_CHANGE_SEQUENCE_MAX)],
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True, db_index=True)
    deleted_for_everyone_at = models.DateTimeField(null=True, blank=True)
    deleted_for_everyone_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="deleted_chat_messages_for_everyone",
    )

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(
                fields=["trip", "-created_at", "-id"],
                name="chat_chatme_trip_id_854021_idx",
            ),
            models.Index(
                fields=["trip", "updated_at", "id"],
                name="chat_chatme_trip_id_d13dbb_idx",
            ),
            models.Index(
                fields=["trip", "change_sequence", "id"],
                name="chat_msg_trip_change_seq_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["trip", "sender", "client_message_id"],
                condition=Q(client_message_id__isnull=False),
                name="chat_unique_client_message",
            ),
            models.CheckConstraint(
                condition=(
                    Q(change_sequence__gte=0)
                    & Q(change_sequence__lte=CHAT_CHANGE_SEQUENCE_MAX)
                ),
                name="chat_message_change_sequence_safe",
            ),
        ]

    def __str__(self) -> str:
        return f"ChatMessage {self.id} in trip={self.trip_id}"


class ChatMessageHiddenForUser(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(
        ChatMessage,
        on_delete=models.CASCADE,
        related_name="hidden_for_users",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="hidden_chat_messages",
    )
    hidden_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["user", "message"]),
            models.Index(fields=["message", "user"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["message", "user"],
                name="chat_unique_hidden_message_user",
            )
        ]

    def __str__(self) -> str:
        return f"ChatMessageHiddenForUser message={self.message_id} user={self.user_id}"


class MessageReaction(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(
        ChatMessage,
        on_delete=models.CASCADE,
        related_name="reactions",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="chat_reactions",
    )
    # max_length=8: emoji (up to 4 bytes) + variation selector (up to 3 bytes) + ZWJ sequences
    emoji = models.CharField(max_length=8)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["message", "user"],
                name="chat_unique_message_user_reaction",
            )
        ]

    def __str__(self) -> str:
        return f"MessageReaction {self.emoji} by user={self.user_id} on message={self.message_id}"
