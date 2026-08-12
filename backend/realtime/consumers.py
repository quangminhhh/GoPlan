from __future__ import annotations

import logging
from uuid import UUID

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings

from chat.services import (
    build_personalized_chat_event_payload_for_viewer,
    ensure_user_can_access_trip_chat,
    is_chat_message_hidden_for_user,
    personalize_chat_event_payload_for_viewer,
)
from realtime.services import is_ws_user_session_valid
from trips.services import TripNotFoundError

logger = logging.getLogger(__name__)


class BaseConsumer(AsyncJsonWebsocketConsumer):
    """Abstract base consumer — auth check, heartbeat pong.

    Subclasses (RealtimeConsumer, etc.) inherit auth enforcement and
    ping/pong handling.

    Auth rejection flow (accept-then-close trade-off):
        If the user is anonymous, we accept() first then send an auth_error
        message and close with the appropriate code. This ensures the browser
        reliably receives the close code (closing before accept yields generic
        1006 in most browsers). The connection lives for only a few milliseconds,
        does not join any group, and does not exchange any data.
    """

    async def connect(self):
        selected_subprotocol = self.scope.get("ws_subprotocol")

        if self.scope["user"].is_anonymous:
            await self.accept(subprotocol=selected_subprotocol)
            auth_error = self.scope.get("auth_error", "auth_failed")
            close_code = settings.WS_CLOSE_CODES.get(
                'TOKEN_EXPIRED' if auth_error == 'token_expired' else 'AUTH_FAILED'
            )
            await self.send_json({"type": "auth_error", "code": auth_error})
            await self.close(code=close_code)
            return

        self.user = self.scope["user"]
        await self.accept(subprotocol=selected_subprotocol)

    async def receive_json(self, content, **kwargs):
        if self.scope["user"].is_anonymous:
            return
        # Heartbeat fast path: answer ping without the session DB check so a
        # busy backend never stalls pong past the client timeout. Session
        # validity is still enforced on business messages and push handlers.
        if content.get("type") == "ping":
            await self.send_json({"type": "pong"})
            return
        if not await self._ensure_current_session():
            return
        await self.handle_message(content)

    async def handle_message(self, content):
        """Override in subclasses for domain-specific messages."""
        pass

    async def _ensure_current_session(self):
        is_valid = await database_sync_to_async(is_ws_user_session_valid)(
            self.scope["user"]
        )
        if is_valid:
            return True

        await self.send_json({"type": "auth_error", "code": "auth_failed"})
        await self.close(code=settings.WS_CLOSE_CODES["AUTH_FAILED"])
        return False


class RealtimeConsumer(BaseConsumer):
    """Multiplexed consumer at /ws/realtime — notifications + future features.

    Joins user-specific notification group on connect so the service layer
    can push notifications via channel_layer.group_send().
    """

    async def connect(self):
        self._chat_groups = set()
        await super().connect()

        if self.scope["user"].is_anonymous:
            return

        self.notification_group = f"notifications_{self.user.id}"
        try:
            await self.channel_layer.group_add(
                self.notification_group, self.channel_name
            )
        except Exception:
            logger.exception(
                "Failed to join notification group for user %s", self.user.id
            )
            self.notification_group = None

    async def disconnect(self, close_code):
        for group_name in getattr(self, "_chat_groups", set()).copy():
            try:
                await self.channel_layer.group_discard(group_name, self.channel_name)
            except Exception:
                logger.exception("Failed to leave chat group %s", group_name)
        self._chat_groups = set()

        if getattr(self, "notification_group", None):
            try:
                await self.channel_layer.group_discard(
                    self.notification_group, self.channel_name
                )
            except Exception:
                logger.exception("Failed to leave notification group")
        await super().disconnect(close_code)

    async def notification_push(self, event):
        """Channel layer handler — forward notification to WebSocket client."""
        if not await self._ensure_current_session():
            return

        data = event.get("data")
        if data is None:
            logger.warning("notification_push received event without 'data' key")
            return
        await self.send_json(data)

    async def handle_message(self, content):
        message_type = content.get("type")
        if message_type == "chat.subscribe":
            await self._handle_chat_subscribe(content)
            return
        if message_type == "chat.unsubscribe":
            await self._handle_chat_unsubscribe(content)
            return

    async def _handle_chat_subscribe(self, content):
        trip_id = content.get("trip_id")
        if not isinstance(trip_id, str) or not trip_id:
            await self._send_chat_error(
                trip_id or "",
                "TRIP_NOT_FOUND",
                "Trip not found.",
            )
            return

        try:
            canonical_trip_id = str(UUID(trip_id))
        except (TypeError, ValueError):
            await self._send_chat_error(trip_id, "TRIP_NOT_FOUND", "Trip not found.")
            return

        group_name = self._chat_group_name(canonical_trip_id)
        if group_name in self._chat_groups:
            await self.send_json({"type": "chat.subscribed", "trip_id": canonical_trip_id})
            return

        max_chat_subscriptions = settings.WS_MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION
        if len(self._chat_groups) >= max_chat_subscriptions:
            await self._send_chat_error(
                canonical_trip_id,
                "SUBSCRIPTION_LIMIT_REACHED",
                "Too many chat subscriptions.",
            )
            return

        try:
            await database_sync_to_async(ensure_user_can_access_trip_chat)(
                self.user,
                canonical_trip_id,
            )
        except TripNotFoundError:
            await self._send_chat_error(
                canonical_trip_id,
                "TRIP_NOT_FOUND",
                "Trip not found.",
            )
            return
        except Exception:
            logger.exception("Failed to verify chat access for trip %s", canonical_trip_id)
            await self._send_chat_error(
                canonical_trip_id,
                "SERVER_ERROR",
                "Could not join chat.",
            )
            return

        try:
            await self.channel_layer.group_add(group_name, self.channel_name)
        except Exception:
            logger.exception("Failed to join chat group %s", group_name)
            await self._send_chat_error(
                canonical_trip_id,
                "SERVER_ERROR",
                "Could not join chat.",
            )
            return

        self._chat_groups.add(group_name)
        await self.send_json({"type": "chat.subscribed", "trip_id": canonical_trip_id})

    async def _handle_chat_unsubscribe(self, content):
        trip_id = content.get("trip_id")
        if not isinstance(trip_id, str) or not trip_id:
            return

        try:
            canonical_trip_id = str(UUID(trip_id))
        except (TypeError, ValueError):
            return

        group_name = self._chat_group_name(canonical_trip_id)
        if group_name in self._chat_groups:
            try:
                await self.channel_layer.group_discard(group_name, self.channel_name)
            except Exception:
                logger.exception("Failed to leave chat group %s", group_name)
            self._chat_groups.discard(group_name)

        await self.send_json(
            {"type": "chat.unsubscribed", "trip_id": canonical_trip_id}
        )

    async def chat_message_push(self, event):
        if not await self._ensure_current_session():
            return

        data = event.get("data")
        if not isinstance(data, dict):
            logger.warning("chat_message_push received event without dict data")
            return

        trip_id = data.get("trip_id")
        if not isinstance(trip_id, str) or not trip_id:
            logger.warning("chat_message_push received event without trip_id")
            return

        try:
            await database_sync_to_async(ensure_user_can_access_trip_chat)(
                self.user,
                trip_id,
            )
        except TripNotFoundError:
            await self._discard_chat_group(trip_id)
            await self.send_json({"type": "chat.kicked", "trip_id": trip_id})
            return
        except Exception:
            logger.exception("Failed to verify chat access before push")
            return

        message = data.get("message")
        message_id = message.get("id") if isinstance(message, dict) else None
        if await database_sync_to_async(is_chat_message_hidden_for_user)(
            user=self.user,
            trip_id=trip_id,
            message_id=message_id,
        ):
            return

        personalized = await database_sync_to_async(
            build_personalized_chat_event_payload_for_viewer
        )(data, self.user)
        await self.send_json(personalized)

    async def chat_message_deleted_push(self, event):
        if not await self._ensure_current_session():
            return

        data = event.get("data")
        if not isinstance(data, dict):
            logger.warning("chat_message_deleted_push received event without dict data")
            return

        trip_id = data.get("trip_id")
        if not isinstance(trip_id, str) or not trip_id:
            logger.warning("chat_message_deleted_push received event without trip_id")
            return

        try:
            await database_sync_to_async(ensure_user_can_access_trip_chat)(
                self.user,
                trip_id,
            )
        except TripNotFoundError:
            await self._discard_chat_group(trip_id)
            await self.send_json({"type": "chat.kicked", "trip_id": trip_id})
            return
        except Exception:
            logger.exception("Failed to verify chat access before deleted-message push")
            return

        message = data.get("message")
        message_id = message.get("id") if isinstance(message, dict) else None
        if await database_sync_to_async(is_chat_message_hidden_for_user)(
            user=self.user,
            trip_id=trip_id,
            message_id=message_id,
        ):
            return

        await self.send_json(
            personalize_chat_event_payload_for_viewer(data, self.user)
        )

    async def chat_reaction_update_push(self, event):
        if not await self._ensure_current_session():
            return

        data = event.get("data")
        if not isinstance(data, dict):
            logger.warning("chat_reaction_update_push received event without dict data")
            return

        trip_id = data.get("trip_id")
        if not isinstance(trip_id, str) or not trip_id:
            logger.warning("chat_reaction_update_push received event without trip_id")
            return

        try:
            await database_sync_to_async(ensure_user_can_access_trip_chat)(
                self.user,
                trip_id,
            )
        except TripNotFoundError:
            await self._discard_chat_group(trip_id)
            await self.send_json({"type": "chat.kicked", "trip_id": trip_id})
            return
        except Exception:
            logger.exception("Failed to verify chat access before reaction push")
            return

        message_id = data.get("message_id")
        if await database_sync_to_async(is_chat_message_hidden_for_user)(
            user=self.user,
            trip_id=trip_id,
            message_id=message_id,
        ):
            return

        await self.send_json(data)

    async def chat_ai_typing_started_push(self, event):
        await self._forward_chat_event_if_authorized(event, "AI typing started")

    async def chat_ai_typing_stopped_push(self, event):
        await self._forward_chat_event_if_authorized(event, "AI typing stopped")

    async def _forward_chat_event_if_authorized(self, event, label: str):
        if not await self._ensure_current_session():
            return
        data = event.get("data")
        if not isinstance(data, dict):
            logger.warning("%s event received without dict data", label)
            return
        trip_id = data.get("trip_id")
        if not isinstance(trip_id, str) or not trip_id:
            logger.warning("%s event received without trip_id", label)
            return
        try:
            await database_sync_to_async(ensure_user_can_access_trip_chat)(
                self.user,
                trip_id,
            )
        except TripNotFoundError:
            await self._discard_chat_group(trip_id)
            await self.send_json({"type": "chat.kicked", "trip_id": trip_id})
            return
        except Exception:
            logger.exception("Failed to verify chat access before %s push", label)
            return
        await self.send_json(data)

    async def chat_kicked_push(self, event):
        if not await self._ensure_current_session():
            return

        data = event.get("data")
        if not isinstance(data, dict):
            logger.warning("chat_kicked_push received event without dict data")
            return

        user_id = data.get("user_id")
        trip_id = data.get("trip_id")
        if str(user_id) != str(self.user.id) or not isinstance(trip_id, str):
            return

        await self._discard_chat_group(trip_id)
        await self.send_json({"type": "chat.kicked", "trip_id": trip_id})

    async def _discard_chat_group(self, trip_id):
        group_name = self._chat_group_name(trip_id)
        if group_name not in self._chat_groups:
            return
        try:
            await self.channel_layer.group_discard(group_name, self.channel_name)
        except Exception:
            logger.exception("Failed to discard chat group %s", group_name)
        self._chat_groups.discard(group_name)

    async def _send_chat_error(self, trip_id, error_code, detail):
        await self.send_json(
            {
                "type": "chat.error",
                "trip_id": trip_id,
                "error_code": error_code,
                "detail": detail,
            }
        )

    @staticmethod
    def _chat_group_name(trip_id):
        return f"trip_chat_{trip_id}"
