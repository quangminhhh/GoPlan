from __future__ import annotations

from rest_framework import serializers

from chat.models import ALLOWED_REACTION_EMOJIS
from trips.models import CHAT_CHANGE_SEQUENCE_MAX


class SendChatMessageSerializer(serializers.Serializer):
    content = serializers.CharField(
        max_length=2000,
        trim_whitespace=True,
    )
    client_message_id = serializers.UUIDField()


class AddReactionSerializer(serializers.Serializer):
    emoji = serializers.CharField(max_length=8)

    def validate_emoji(self, value):
        if value not in ALLOWED_REACTION_EMOJIS:
            raise serializers.ValidationError("Unsupported emoji.")
        return value


class DeleteChatMessageSerializer(serializers.Serializer):
    mode = serializers.ChoiceField(choices=("for_me", "for_everyone"))


class BulkHideChatMessagesSerializer(serializers.Serializer):
    message_ids = serializers.ListField(
        child=serializers.UUIDField(),
        allow_empty=False,
        max_length=100,
    )


class ChatMessageListQuerySerializer(serializers.Serializer):
    cursor = serializers.CharField(required=False)
    since = serializers.UUIDField(required=False)
    updated_since = serializers.DateTimeField(required=False)
    updated_since_id = serializers.UUIDField(required=False)
    changed_since = serializers.IntegerField(
        required=False,
        min_value=0,
        max_value=CHAT_CHANGE_SEQUENCE_MAX,
    )
    changed_since_id = serializers.UUIDField(required=False)
    limit = serializers.IntegerField(required=False)

    def validate(self, attrs):
        pagination_modes = [
            name
            for name in ("cursor", "since", "updated_since", "changed_since")
            if name in attrs
        ]
        if len(pagination_modes) > 1:
            raise serializers.ValidationError(
                {
                    "detail": (
                        "cursor, since, updated_since, and changed_since are "
                        "mutually exclusive."
                    )
                }
            )
        if "updated_since_id" in attrs and "updated_since" not in attrs:
            raise serializers.ValidationError(
                {"detail": "updated_since_id requires updated_since."}
            )
        if "changed_since_id" in attrs and "changed_since" not in attrs:
            raise serializers.ValidationError(
                {"detail": "changed_since_id requires changed_since."}
            )

        limit = attrs.get("limit")
        if limit is None:
            return attrs

        if limit < 1:
            raise serializers.ValidationError({"limit": "Limit must be at least 1."})

        max_limit = (
            200
            if any(
                name in attrs
                for name in ("since", "updated_since", "changed_since")
            )
            else 100
        )
        if limit > max_limit:
            raise serializers.ValidationError(
                {"limit": f"Limit must be less than or equal to {max_limit}."}
            )
        return attrs
