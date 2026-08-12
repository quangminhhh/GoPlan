from __future__ import annotations

import math

from rest_framework import permissions, status
from rest_framework.exceptions import Throttled
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsProfileCompleted
from ai.services import AIBusyError, AIInvalidPromptError
from chat.mentions import extract_goplan_ai_prompt
from chat.serializers import (
    AddReactionSerializer,
    BulkHideChatMessagesSerializer,
    ChatMessageListQuerySerializer,
    DeleteChatMessageSerializer,
    SendChatMessageSerializer,
)
from chat.services import (
    ChatChangeSequenceExhaustedError,
    ChatDeleteForbiddenError,
    ChatDeleteInvalidModeError,
    ChatDeleteWindowExpiredError,
    ChatInvalidContentError,
    ChatInvalidCursorError,
    ChatMessageDeletedError,
    ChatReactionDuplicateError,
    ChatReactionInvalidEmojiError,
    ChatReactionNotFoundError,
    ChatServiceError,
    add_reaction,
    build_chat_message_payload,
    delete_message_for_everyone,
    hide_messages_for_user,
    list_chat_messages,
    remove_reaction,
    send_chat_message,
)
from trips.services import TripNotFoundError, TripServiceError, TripTerminalError

CHAT_PERMISSIONS = [permissions.IsAuthenticated, IsProfileCompleted]


def _error_response(detail: str, error_code: str, status_code: int) -> Response:
    return Response(
        {"detail": detail, "error_code": error_code},
        status=status_code,
    )


def _map_service_error(exc: Exception) -> tuple[str, int] | None:
    if isinstance(exc, AIBusyError):
        return exc.error_code, status.HTTP_409_CONFLICT
    if isinstance(exc, AIInvalidPromptError):
        return exc.error_code, status.HTTP_400_BAD_REQUEST
    if isinstance(exc, TripNotFoundError):
        return exc.error_code, status.HTTP_404_NOT_FOUND
    if isinstance(exc, TripTerminalError):
        return exc.error_code, status.HTTP_409_CONFLICT
    if isinstance(exc, ChatReactionDuplicateError):
        return exc.error_code, status.HTTP_409_CONFLICT
    if isinstance(exc, ChatReactionNotFoundError):
        return exc.error_code, status.HTTP_404_NOT_FOUND
    if isinstance(exc, ChatDeleteForbiddenError):
        return exc.error_code, status.HTTP_403_FORBIDDEN
    if isinstance(exc, ChatDeleteWindowExpiredError):
        return exc.error_code, status.HTTP_409_CONFLICT
    if isinstance(exc, ChatChangeSequenceExhaustedError):
        return exc.error_code, status.HTTP_409_CONFLICT
    if isinstance(exc, ChatMessageDeletedError):
        return exc.error_code, status.HTTP_409_CONFLICT
    if isinstance(exc, (ChatInvalidContentError, ChatInvalidCursorError, ChatReactionInvalidEmojiError)):
        return exc.error_code, status.HTTP_400_BAD_REQUEST
    if isinstance(exc, ChatDeleteInvalidModeError):
        return exc.error_code, status.HTTP_400_BAD_REQUEST
    if isinstance(exc, (TripServiceError, ChatServiceError)):
        return exc.error_code, status.HTTP_400_BAD_REQUEST
    return None


class ChatAPIView(APIView):
    def handle_exception(self, exc):
        if isinstance(exc, Throttled):
            response = _error_response(
                str(exc.detail),
                "THROTTLED",
                status.HTTP_429_TOO_MANY_REQUESTS,
            )
            if exc.wait is not None:
                response["Retry-After"] = str(math.ceil(exc.wait))
            return response
        return super().handle_exception(exc)


class TripChatMessagesAPIView(ChatAPIView):
    permission_classes = CHAT_PERMISSIONS

    def get_throttles(self):
        if self.request.method == "POST":
            content = ""
            try:
                request_data = self.request.data
            except Exception:
                request_data = {}
            if isinstance(request_data, dict):
                content = str(request_data.get("content", ""))
            has_ai_mention, _, _ = extract_goplan_ai_prompt(content)
            self.throttle_scope = "chat_ai_prompt" if has_ai_mention else "chat_send"
        return super().get_throttles()

    def get(self, request, trip_id):
        serializer = ChatMessageListQuerySerializer(data=request.query_params)
        if not serializer.is_valid():
            return _error_response(
                "Chat query is invalid.",
                "INVALID_QUERY",
                status.HTTP_400_BAD_REQUEST,
            )
        data = serializer.validated_data

        try:
            payload = list_chat_messages(
                user=request.user,
                trip_id=trip_id,
                cursor=data.get("cursor"),
                limit=data.get("limit"),
                since=data.get("since"),
                updated_since=data.get("updated_since"),
                updated_since_id=data.get("updated_since_id"),
                changed_since=data.get("changed_since"),
                changed_since_id=data.get("changed_since_id"),
            )
        except Exception as exc:
            mapped = _map_service_error(exc)
            if mapped is None:
                raise
            error_code, status_code = mapped
            return _error_response(str(exc), error_code, status_code)

        return Response(payload, status=status.HTTP_200_OK)

    def post(self, request, trip_id):
        serializer = SendChatMessageSerializer(data=request.data)
        if not serializer.is_valid():
            return _error_response(
                "Message content is invalid.",
                "INVALID_CONTENT",
                status.HTTP_400_BAD_REQUEST,
            )
        data = serializer.validated_data

        try:
            message, created = send_chat_message(
                user=request.user,
                trip_id=trip_id,
                content=data["content"],
                client_message_id=data["client_message_id"],
            )
        except Exception as exc:
            mapped = _map_service_error(exc)
            if mapped is None:
                raise
            error_code, status_code = mapped
            return _error_response(str(exc), error_code, status_code)

        return Response(
            {
                "message": build_chat_message_payload(
                    message,
                    viewer=request.user,
                )
            },
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class ChatMessageDeletionAPIView(ChatAPIView):
    permission_classes = CHAT_PERMISSIONS

    def get_throttles(self):
        if self.request.method == "DELETE":
            self.throttle_scope = "chat_delete"
        return super().get_throttles()

    def delete(self, request, trip_id, message_id):
        serializer = DeleteChatMessageSerializer(data=request.data)
        if not serializer.is_valid():
            return _error_response(
                "Delete request is invalid.",
                "INVALID_DELETE_MODE",
                status.HTTP_400_BAD_REQUEST,
            )

        mode = serializer.validated_data["mode"]
        try:
            if mode == "for_me":
                hidden_ids = hide_messages_for_user(
                    user=request.user,
                    trip_id=trip_id,
                    message_ids=[message_id],
                )
                return Response(
                    {"hidden_message_ids": hidden_ids},
                    status=status.HTTP_200_OK,
                )

            if mode == "for_everyone":
                message = delete_message_for_everyone(
                    user=request.user,
                    trip_id=trip_id,
                    message_id=message_id,
                )
                return Response(
                    {
                        "message": build_chat_message_payload(
                            message,
                            viewer=request.user,
                        )
                    },
                    status=status.HTTP_200_OK,
                )

            raise ChatDeleteInvalidModeError("Delete mode is invalid.")
        except Exception as exc:
            mapped = _map_service_error(exc)
            if mapped is None:
                raise
            error_code, status_code = mapped
            return _error_response(str(exc), error_code, status_code)


class ChatMessagesBulkHideAPIView(ChatAPIView):
    permission_classes = CHAT_PERMISSIONS
    throttle_scope = "chat_delete"

    def post(self, request, trip_id):
        serializer = BulkHideChatMessagesSerializer(data=request.data)
        if not serializer.is_valid():
            return _error_response(
                "Bulk hide request is invalid.",
                "INVALID_MESSAGE_IDS",
                status.HTTP_400_BAD_REQUEST,
            )

        try:
            hidden_ids = hide_messages_for_user(
                user=request.user,
                trip_id=trip_id,
                message_ids=serializer.validated_data["message_ids"],
            )
        except Exception as exc:
            mapped = _map_service_error(exc)
            if mapped is None:
                raise
            error_code, status_code = mapped
            return _error_response(str(exc), error_code, status_code)

        return Response(
            {"hidden_message_ids": hidden_ids},
            status=status.HTTP_200_OK,
        )


class MessageReactionCreateAPIView(ChatAPIView):
    permission_classes = CHAT_PERMISSIONS

    def get_throttles(self):
        if self.request.method == "POST":
            self.throttle_scope = "chat_reaction"
        return super().get_throttles()

    def post(self, request, trip_id, message_id):
        serializer = AddReactionSerializer(data=request.data)
        if not serializer.is_valid():
            return _error_response(
                "Invalid reaction.",
                "INVALID_EMOJI",
                status.HTTP_400_BAD_REQUEST,
            )

        try:
            payload = add_reaction(
                user=request.user,
                trip_id=trip_id,
                message_id=message_id,
                emoji=serializer.validated_data["emoji"],
            )
        except Exception as exc:
            mapped = _map_service_error(exc)
            if mapped is None:
                raise
            error_code, status_code = mapped
            return _error_response(str(exc), error_code, status_code)

        return Response(payload, status=status.HTTP_201_CREATED)


class MessageReactionDetailAPIView(ChatAPIView):
    permission_classes = CHAT_PERMISSIONS

    def get_throttles(self):
        if self.request.method == "DELETE":
            self.throttle_scope = "chat_reaction"
        return super().get_throttles()

    def delete(self, request, trip_id, message_id, emoji):
        try:
            payload = remove_reaction(
                user=request.user,
                trip_id=trip_id,
                message_id=message_id,
                emoji=emoji,
            )
        except Exception as exc:
            mapped = _map_service_error(exc)
            if mapped is None:
                raise
            error_code, status_code = mapped
            return _error_response(str(exc), error_code, status_code)

        return Response(payload, status=status.HTTP_200_OK)
