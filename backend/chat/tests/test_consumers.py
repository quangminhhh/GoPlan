from __future__ import annotations

from datetime import timedelta
from uuid import UUID, uuid4

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.test import TransactionTestCase, override_settings
from django.urls import re_path
from django.utils import timezone

from realtime.consumers import RealtimeConsumer
from realtime.middleware import WebSocketAuthMiddleware
from realtime.services import issue_ws_ticket
from test_helpers import create_completed_user, create_verified_user
from ai.action_types import AI_CONFIRMATION_CAPTAIN
from ai.models import (
    AIActionDraft,
    AIActionDraftStatus,
    AIInteraction,
    AIInteractionStatus,
)
from chat.models import ChatMessage, ChatMessageHiddenForUser, ChatMessageSenderKind
from trips.models import MemberStatus, Trip, TripMember, TripRole, TripStatus

TEST_CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer",
    },
}


def _build_application():
    return WebSocketAuthMiddleware(
        URLRouter([
            re_path(r"ws/realtime$", RealtimeConsumer.as_asgi()),
        ])
    )


@database_sync_to_async
def _create_user(email, identify_name, identify_code):
    return create_completed_user(email, identify_name, identify_code)


@database_sync_to_async
def _create_verified_incomplete_user(email):
    return create_verified_user(email=email)


@database_sync_to_async
def _make_trip(captain):
    trip = Trip.objects.create(
        created_by=captain,
        name="Consumer Trip",
        destination="Da Nang",
        start_date="2026-06-01",
        end_date="2026-06-05",
        status=TripStatus.PLANNING,
    )
    TripMember.objects.create(
        trip=trip,
        user=captain,
        role=TripRole.CAPTAIN,
        status=MemberStatus.ACTIVE,
    )
    return trip


@database_sync_to_async
def _add_member(trip, user):
    return TripMember.objects.create(
        trip=trip,
        user=user,
        role=TripRole.MEMBER,
        status=MemberStatus.ACTIVE,
    )


@database_sync_to_async
def _remove_member(trip, user):
    TripMember.objects.filter(
        trip=trip,
        user=user,
        status=MemberStatus.ACTIVE,
    ).update(status=MemberStatus.REMOVED)


@database_sync_to_async
def _make_chat_message(trip, sender, content="Hidden content"):
    return ChatMessage.objects.create(
        trip=trip,
        sender=sender,
        sender_display_name_snapshot=sender.display_name,
        sender_identify_tag_snapshot=sender.identify_tag,
        content=content,
    )


@database_sync_to_async
def _hide_chat_message_for_user(message, user):
    return ChatMessageHiddenForUser.objects.create(message=message, user=user)


@database_sync_to_async
def _make_ai_message_with_draft(trip, captain):
    prompt = ChatMessage.objects.create(
        trip=trip,
        sender=captain,
        sender_display_name_snapshot=captain.display_name,
        sender_identify_tag_snapshot=captain.identify_tag,
        content="@GoPlanAI create dinner expense",
        client_message_id=uuid4(),
    )
    ai_message = ChatMessage.objects.create(
        trip=trip,
        sender_kind=ChatMessageSenderKind.AI,
        sender_display_name_snapshot="GoPlanAI",
        content="I prepared a draft.",
    )
    interaction = AIInteraction.objects.create(
        trip=trip,
        requested_by=captain,
        prompt_message=prompt,
        prompt="create dinner expense",
        status=AIInteractionStatus.SUCCEEDED,
        lock_expires_at=timezone.now() + timedelta(minutes=2),
    )
    AIActionDraft.objects.create(
        trip=trip,
        interaction=interaction,
        response_message=ai_message,
        requested_by=captain,
        action_type="expense.create",
        status=AIActionDraftStatus.READY,
        required_confirmation=AI_CONFIRMATION_CAPTAIN,
        payload={"title": "Dinner"},
        preview={"title": "Dinner"},
        missing_fields=[],
        preconditions={},
        expires_at=timezone.now() + timedelta(hours=24),
    )
    return ai_message


async def _connect(user):
    ticket = await database_sync_to_async(issue_ws_ticket)(user)
    communicator = WebsocketCommunicator(
        _build_application(),
        "ws/realtime",
        subprotocols=[settings.WS_SUBPROTOCOL, ticket],
    )
    connected, _ = await communicator.connect()
    return communicator, connected


@override_settings(CHANNEL_LAYERS=TEST_CHANNEL_LAYERS)
class ChatConsumerTests(TransactionTestCase):

    async def test_subscribe_unsubscribe_ack(self):
        captain = await _create_user("ws-chat-cap@example.com", "wscap", "WCA001")
        trip = await _make_trip(captain)
        communicator, connected = await _connect(captain)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        subscribed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(subscribed, {"type": "chat.subscribed", "trip_id": str(trip.id)})

        await communicator.send_json_to(
            {"type": "chat.unsubscribe", "trip_id": str(trip.id)}
        )
        unsubscribed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(
            unsubscribed,
            {"type": "chat.unsubscribed", "trip_id": str(trip.id)},
        )

        await communicator.disconnect()

    async def test_subscribe_uses_canonical_trip_id_for_group(self):
        captain = await _create_user("ws-canon-cap@example.com", "wscan", "WCN001")
        trip = await _make_trip(captain)
        communicator, connected = await _connect(captain)
        self.assertTrue(connected)

        uppercase_trip_id = str(trip.id).upper()
        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": uppercase_trip_id}
        )
        subscribed = await communicator.receive_json_from(timeout=1)
        canonical_trip_id = str(UUID(str(trip.id)))
        self.assertEqual(
            subscribed,
            {"type": "chat.subscribed", "trip_id": canonical_trip_id},
        )

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{canonical_trip_id}",
            {
                "type": "chat_message_push",
                "data": {
                    "type": "chat.message",
                    "trip_id": canonical_trip_id,
                    "message": {"id": "canonical-message"},
                },
            },
        )

        pushed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(pushed["type"], "chat.message")
        self.assertEqual(pushed["message"]["id"], "canonical-message")

        await communicator.send_json_to(
            {"type": "chat.unsubscribe", "trip_id": uppercase_trip_id}
        )
        unsubscribed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(
            unsubscribed,
            {"type": "chat.unsubscribed", "trip_id": canonical_trip_id},
        )

        await channel_layer.group_send(
            f"trip_chat_{canonical_trip_id}",
            {
                "type": "chat_message_push",
                "data": {
                    "type": "chat.message",
                    "trip_id": canonical_trip_id,
                    "message": {"id": "after-canonical-unsubscribe"},
                },
            },
        )
        self.assertTrue(await communicator.receive_nothing(timeout=0.2))

        await communicator.disconnect()

    @override_settings(WS_MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION=1)
    async def test_subscribe_enforces_per_connection_cap(self):
        captain = await _create_user("ws-cap-limit@example.com", "wslimc", "WLC001")
        member = await _create_user("ws-mem-limit@example.com", "wslimm", "WLM001")
        trip_one = await _make_trip(captain)
        trip_two = await _make_trip(captain)
        await _add_member(trip_one, member)
        await _add_member(trip_two, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip_one.id)}
        )
        subscribed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(subscribed["type"], "chat.subscribed")

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip_two.id)}
        )
        error = await communicator.receive_json_from(timeout=1)
        self.assertEqual(error["type"], "chat.error")
        self.assertEqual(error["error_code"], "SUBSCRIPTION_LIMIT_REACHED")

        await communicator.disconnect()

    async def test_subscribe_non_member_returns_error_without_closing(self):
        captain = await _create_user("ws-owner@example.com", "wsowner", "WON001")
        other = await _create_user("ws-other@example.com", "wsother", "WOT001")
        trip = await _make_trip(captain)
        communicator, connected = await _connect(other)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        error = await communicator.receive_json_from(timeout=1)

        self.assertEqual(error["type"], "chat.error")
        self.assertEqual(error["error_code"], "TRIP_NOT_FOUND")
        self.assertTrue(await communicator.receive_nothing(timeout=0.1))

        await communicator.disconnect()

    async def test_subscribe_incomplete_profile_member_returns_error_without_closing(self):
        captain = await _create_user("ws-profile-cap@example.com", "wspcap", "WPP001")
        member = await _create_verified_incomplete_user("ws-profile-mem@example.com")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        error = await communicator.receive_json_from(timeout=1)

        self.assertEqual(error["type"], "chat.error")
        self.assertEqual(error["error_code"], "TRIP_NOT_FOUND")
        self.assertTrue(await communicator.receive_nothing(timeout=0.1))

        await communicator.disconnect()

    async def test_chat_message_push_reaches_subscribed_member(self):
        captain = await _create_user("ws-push-cap@example.com", "wspcap", "WPC001")
        member = await _create_user("ws-push-mem@example.com", "wspmem", "WPM001")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_message_push",
                "data": {
                    "type": "chat.message",
                    "trip_id": str(trip.id),
                    "message": {"id": "message-1"},
                },
            },
        )

        pushed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(pushed["type"], "chat.message")
        self.assertEqual(pushed["message"]["id"], "message-1")

        await communicator.disconnect()

    async def test_message_push_personalizes_delete_eligibility_for_receiver(self):
        captain = await _create_user("ws-can-cap@example.com", "wsccap", "WCC001")
        member = await _create_user("ws-can-mem@example.com", "wscmem", "WCM001")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        communicator, connected = await _connect(captain)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_message_push",
                "data": {
                    "type": "chat.message",
                    "trip_id": str(trip.id),
                    "message": {
                        "id": "message-from-member",
                        "sender": {"id": str(member.id)},
                        "is_deleted_for_everyone": False,
                        "delete_for_everyone_until": (
                            timezone.now() + timedelta(minutes=5)
                        ).isoformat(),
                        "can_delete_for_everyone": True,
                    },
                },
            },
        )

        pushed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(pushed["type"], "chat.message")
        self.assertFalse(pushed["message"]["can_delete_for_everyone"])

        await communicator.disconnect()

    async def test_message_push_personalizes_action_draft_permissions(self):
        captain = await _create_user("ws-ai-cap@example.com", "wsaicap", "WAC001")
        member = await _create_user("ws-ai-mem@example.com", "wsaimem", "WAM001")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        ai_message = await _make_ai_message_with_draft(trip, captain)
        captain_socket, captain_connected = await _connect(captain)
        member_socket, member_connected = await _connect(member)
        self.assertTrue(captain_connected)
        self.assertTrue(member_connected)

        for communicator in (captain_socket, member_socket):
            await communicator.send_json_to(
                {"type": "chat.subscribe", "trip_id": str(trip.id)}
            )
            await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_message_push",
                "data": {
                    "type": "chat.message",
                    "trip_id": str(trip.id),
                    "message": {"id": str(ai_message.id)},
                },
            },
        )

        captain_push = await captain_socket.receive_json_from(timeout=1)
        member_push = await member_socket.receive_json_from(timeout=1)
        self.assertTrue(captain_push["message"]["action_drafts"][0]["can_confirm"])
        self.assertFalse(member_push["message"]["action_drafts"][0]["can_confirm"])

        await captain_socket.disconnect()
        await member_socket.disconnect()

    async def test_chat_message_deleted_push_reaches_subscribed_member(self):
        captain = await _create_user("ws-del-cap@example.com", "wsdcap", "WDC001")
        member = await _create_user("ws-del-mem@example.com", "wsdmem", "WDM001")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_message_deleted_push",
                "data": {
                    "type": "chat.message_deleted",
                    "trip_id": str(trip.id),
                    "message": {"id": "message-1", "is_deleted_for_everyone": True},
                },
            },
        )

        pushed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(pushed["type"], "chat.message_deleted")
        self.assertEqual(pushed["message"]["id"], "message-1")
        self.assertTrue(pushed["message"]["is_deleted_for_everyone"])

        await communicator.disconnect()

    async def test_deleted_push_does_not_resurface_message_hidden_for_viewer(self):
        captain = await _create_user("ws-hide-cap@example.com", "wshcap", "WHC001")
        member = await _create_user("ws-hide-mem@example.com", "wshmem", "WHM001")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        message = await _make_chat_message(trip, captain)
        await _hide_chat_message_for_user(message, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_message_deleted_push",
                "data": {
                    "type": "chat.message_deleted",
                    "trip_id": str(trip.id),
                    "message": {
                        "id": str(message.id),
                        "is_deleted_for_everyone": True,
                    },
                },
            },
        )

        self.assertTrue(await communicator.receive_nothing(timeout=0.2))

        await communicator.disconnect()

    async def test_message_push_does_not_resurface_message_hidden_for_viewer(self):
        captain = await _create_user("ws-push-hide-cap@example.com", "wsphcap", "WPH001")
        member = await _create_user("ws-push-hide-mem@example.com", "wsphmem", "WPH002")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        message = await _make_chat_message(trip, captain)
        await _hide_chat_message_for_user(message, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_message_push",
                "data": {
                    "type": "chat.message",
                    "trip_id": str(trip.id),
                    "message": {"id": str(message.id)},
                },
            },
        )

        self.assertTrue(await communicator.receive_nothing(timeout=0.2))

        await communicator.disconnect()

    async def test_kicked_event_discards_group(self):
        captain = await _create_user("ws-kick-cap@example.com", "wskcap", "WKC001")
        member = await _create_user("ws-kick-mem@example.com", "wskmem", "WKM001")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_kicked_push",
                "data": {"trip_id": str(trip.id), "user_id": str(member.id)},
            },
        )
        kicked = await communicator.receive_json_from(timeout=1)
        self.assertEqual(kicked, {"type": "chat.kicked", "trip_id": str(trip.id)})

        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_message_push",
                "data": {
                    "type": "chat.message",
                    "trip_id": str(trip.id),
                    "message": {"id": "after-kick"},
                },
            },
        )
        self.assertTrue(await communicator.receive_nothing(timeout=0.2))

        await communicator.disconnect()

    async def test_message_push_rechecks_membership_before_forwarding(self):
        captain = await _create_user("ws-recheck-cap@example.com", "wsrcap", "WRC001")
        member = await _create_user("ws-recheck-mem@example.com", "wsrmem", "WRM001")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)

        await communicator.send_json_to(
            {"type": "chat.subscribe", "trip_id": str(trip.id)}
        )
        await communicator.receive_json_from(timeout=1)
        await _remove_member(trip, member)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_message_push",
                "data": {
                    "type": "chat.message",
                    "trip_id": str(trip.id),
                    "message": {"id": "should-not-leak"},
                },
            },
        )

        response = await communicator.receive_json_from(timeout=1)
        self.assertEqual(response, {"type": "chat.kicked", "trip_id": str(trip.id)})
        self.assertTrue(await communicator.receive_nothing(timeout=0.2))

        await communicator.disconnect()

    async def test_ai_typing_started_reaches_subscribed_member(self):
        captain = await _create_user("ws-ai-cap@example.com", "wsaicap", "WAI001")
        member = await _create_user("ws-ai-mem@example.com", "wsaimem", "WAI002")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)
        await communicator.send_json_to({"type": "chat.subscribe", "trip_id": str(trip.id)})
        await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_ai_typing_started_push",
                "data": {
                    "type": "chat.ai_typing_started",
                    "trip_id": str(trip.id),
                    "interaction_id": "11111111-1111-1111-1111-111111111111",
                    "requested_by_user_id": str(member.id),
                },
            },
        )

        pushed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(pushed["type"], "chat.ai_typing_started")
        self.assertEqual(pushed["trip_id"], str(trip.id))

        await communicator.disconnect()

    async def test_ai_typing_stopped_reaches_subscribed_member(self):
        captain = await _create_user("ws-ai-cap2@example.com", "wsaicap2", "WAI003")
        member = await _create_user("ws-ai-mem2@example.com", "wsaimem2", "WAI004")
        trip = await _make_trip(captain)
        await _add_member(trip, member)
        communicator, connected = await _connect(member)
        self.assertTrue(connected)
        await communicator.send_json_to({"type": "chat.subscribe", "trip_id": str(trip.id)})
        await communicator.receive_json_from(timeout=1)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"trip_chat_{trip.id}",
            {
                "type": "chat_ai_typing_stopped_push",
                "data": {
                    "type": "chat.ai_typing_stopped",
                    "trip_id": str(trip.id),
                    "interaction_id": "11111111-1111-1111-1111-111111111111",
                },
            },
        )

        pushed = await communicator.receive_json_from(timeout=1)
        self.assertEqual(pushed["type"], "chat.ai_typing_stopped")
        self.assertEqual(pushed["trip_id"], str(trip.id))

        await communicator.disconnect()
