from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework.throttling import ScopedRateThrottle

from accounts.tokens import AccessToken
from ai.action_types import AI_CONFIRMATION_CAPTAIN
from ai.models import (
    AIActionDraft,
    AIActionDraftStatus,
    AIInteraction,
    AIInteractionStatus,
)
from chat.models import ChatMessage, ChatMessageSenderKind
from chat.services import build_chat_message_payload
from test_helpers import create_completed_user
from trips.models import MemberStatus, Trip, TripMember, TripRole, TripStatus


def _auth(user):
    return {"HTTP_AUTHORIZATION": f"Bearer {AccessToken.for_user(user)}"}


def _make_trip(captain, *, status=TripStatus.PLANNING):
    trip = Trip.objects.create(
        created_by=captain,
        name="Chat API Trip",
        destination="Da Nang",
        start_date="2026-06-01",
        end_date="2026-06-05",
        status=status,
    )
    TripMember.objects.create(
        trip=trip,
        user=captain,
        role=TripRole.CAPTAIN,
        status=MemberStatus.ACTIVE,
    )
    return trip


def _add_member(trip, user):
    return TripMember.objects.create(
        trip=trip,
        user=user,
        role=TripRole.MEMBER,
        status=MemberStatus.ACTIVE,
    )


def _messages_url(trip_id):
    return f"/api/trips/{trip_id}/chat/messages"


class TripChatMessagesAPITests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("api-cap@example.com", "apicap", "ACA001")
        self.member = create_completed_user("api-mem@example.com", "apimem", "AME001")
        self.other = create_completed_user("api-other@example.com", "apiother", "AOT001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)

    def test_post_creates_message_201(self):
        client_message_id = uuid4()

        response = self.client.post(
            _messages_url(self.trip.id),
            {"content": "Hello API", "client_message_id": str(client_message_id)},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["message"]["content"], "Hello API")
        self.assertEqual(response.data["message"]["change_sequence"], 1)
        self.assertEqual(
            response.data["message"]["client_message_id"],
            str(client_message_id),
        )

    def test_post_idempotent_retry_returns_200(self):
        client_message_id = uuid4()
        payload = {"content": "Hello once", "client_message_id": str(client_message_id)}
        first = self.client.post(
            _messages_url(self.trip.id),
            payload,
            format="json",
            **_auth(self.member),
        )
        second = self.client.post(
            _messages_url(self.trip.id),
            {"content": "Hello twice", "client_message_id": str(client_message_id)},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.data["message"]["id"], second.data["message"]["id"])
        self.assertEqual(ChatMessage.objects.count(), 1)

    def test_post_non_member_returns_404(self):
        response = self.client.post(
            _messages_url(self.trip.id),
            {"content": "No access", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.other),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")

    def test_post_terminal_trip_returns_409(self):
        self.trip.status = TripStatus.CANCELLED
        self.trip.save(update_fields=["status"])

        response = self.client.post(
            _messages_url(self.trip.id),
            {"content": "Nope", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "TRIP_TERMINAL")

    def test_post_idempotent_retry_after_terminal_returns_existing_200(self):
        client_message_id = uuid4()
        payload = {
            "content": "Created before terminal",
            "client_message_id": str(client_message_id),
        }
        first = self.client.post(
            _messages_url(self.trip.id),
            payload,
            format="json",
            **_auth(self.member),
        )
        self.trip.status = TripStatus.COMPLETED
        self.trip.save(update_fields=["status"])

        second = self.client.post(
            _messages_url(self.trip.id),
            {
                "content": "Retry after terminal",
                "client_message_id": str(client_message_id),
            },
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.data["message"]["id"], second.data["message"]["id"])
        self.assertEqual(second.data["message"]["content"], "Created before terminal")
        self.assertEqual(ChatMessage.objects.count(), 1)

    def test_post_invalid_content_returns_400(self):
        response = self.client.post(
            _messages_url(self.trip.id),
            {"content": "   ", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "INVALID_CONTENT")

    def test_get_history_for_active_member(self):
        self.client.post(
            _messages_url(self.trip.id),
            {"content": "History", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )

        response = self.client.get(_messages_url(self.trip.id), **_auth(self.member))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["results"][0]["content"], "History")
        self.assertEqual(response.data["results"][0]["change_sequence"], 1)
        self.assertIn("next_cursor", response.data)

    def test_get_changed_since_uses_sequence_contract(self):
        self.client.post(
            _messages_url(self.trip.id),
            {"content": "Sequence one", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )
        self.client.post(
            _messages_url(self.trip.id),
            {"content": "Sequence two", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )

        response = self.client.get(
            f"{_messages_url(self.trip.id)}?changed_since=1",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [message["content"] for message in response.data["results"]],
            ["Sequence two"],
        )
        self.assertEqual(response.data["results"][0]["change_sequence"], 2)
        self.assertFalse(response.data["has_more"])

    def test_get_changed_since_id_forwards_tuple_cursor(self):
        messages = [
            ChatMessage.objects.create(
                trip=self.trip,
                sender=self.member,
                sender_display_name_snapshot=self.member.display_name,
                sender_identify_tag_snapshot=self.member.identify_tag,
                content=content,
                change_sequence=7,
            )
            for content in ("Legacy duplicate one", "Legacy duplicate two")
        ]
        ordered = sorted(messages, key=lambda message: message.id)

        response = self.client.get(
            (
                f"{_messages_url(self.trip.id)}?changed_since=7"
                f"&changed_since_id={ordered[0].id}"
            ),
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [message["id"] for message in response.data["results"]],
            [str(ordered[1].id)],
        )

    def test_get_terminal_trip_history_allowed(self):
        ChatMessage.objects.create(
            trip=self.trip,
            sender=self.member,
            sender_display_name_snapshot=self.member.display_name,
            sender_identify_tag_snapshot=self.member.identify_tag,
            content="Old",
            client_message_id=uuid4(),
        )
        self.trip.status = TripStatus.COMPLETED
        self.trip.save(update_fields=["status"])

        response = self.client.get(_messages_url(self.trip.id), **_auth(self.member))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["results"][0]["content"], "Old")

    def test_get_non_member_returns_404(self):
        response = self.client.get(_messages_url(self.trip.id), **_auth(self.other))

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")

    def test_get_invalid_query_returns_error_code(self):
        response = self.client.get(
            f"{_messages_url(self.trip.id)}?limit=0",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "INVALID_QUERY")

    def test_get_rejects_mixed_timestamp_and_sequence_sync_modes(self):
        response = self.client.get(
            (
                f"{_messages_url(self.trip.id)}?changed_since=0"
                f"&updated_since={timezone.now().isoformat()}"
            ),
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "INVALID_QUERY")

    def test_get_rejects_changed_since_id_without_sequence(self):
        response = self.client.get(
            f"{_messages_url(self.trip.id)}?changed_since_id={uuid4()}",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "INVALID_QUERY")

    def test_get_rejects_changed_since_outside_safe_integer_range(self):
        for changed_since in (-1, 9_007_199_254_740_992):
            with self.subTest(changed_since=changed_since):
                response = self.client.get(
                    (
                        f"{_messages_url(self.trip.id)}"
                        f"?changed_since={changed_since}"
                    ),
                    **_auth(self.member),
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data["error_code"], "INVALID_QUERY")


class TripChatThrottleTests(APITestCase):

    def test_chat_send_throttle_returns_error_code(self):
        original_rates = ScopedRateThrottle.THROTTLE_RATES
        ScopedRateThrottle.THROTTLE_RATES = {"chat_send": "2/minute"}
        self.addCleanup(setattr, ScopedRateThrottle, "THROTTLE_RATES", original_rates)

        captain = create_completed_user("throttle-cap@example.com", "thrcap", "TCA001")
        member = create_completed_user("throttle-mem@example.com", "thrmem", "TME001")
        trip = _make_trip(captain)
        _add_member(trip, member)

        for index in range(2):
            response = self.client.post(
                _messages_url(trip.id),
                {"content": f"Message {index}", "client_message_id": str(uuid4())},
                format="json",
                **_auth(member),
            )
            self.assertEqual(response.status_code, 201)

        throttled = self.client.post(
            _messages_url(trip.id),
            {"content": "Message 3", "client_message_id": str(uuid4())},
            format="json",
            **_auth(member),
        )

        self.assertEqual(throttled.status_code, 429)
        self.assertEqual(throttled.data["error_code"], "THROTTLED")


class TripChatAIPromptAPITests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("ai-api-cap@example.com", "aicap", "AAC001")
        self.member = create_completed_user("ai-api-mem@example.com", "aimem", "AAM001")
        self.trip = Trip.objects.create(
            created_by=self.captain,
            name="AI Prompt Trip",
            destination="Da Nang",
            start_date="2026-06-01",
            end_date="2026-06-05",
        )
        from trips.models import TripMember
        TripMember.objects.create(
            trip=self.trip,
            user=self.captain,
            role="CAPTAIN",
            status="ACTIVE",
        )
        TripMember.objects.create(
            trip=self.trip,
            user=self.member,
            role="MEMBER",
            status="ACTIVE",
        )

    @patch("chat.services.enqueue_ai_interaction_after_commit")
    def test_post_ai_prompt_creates_message_and_interaction(self, mock_enqueue):
        response = self.client.post(
            _messages_url(self.trip.id),
            {"content": "Plan day 1 @GoPlanAI", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["message"]["content"], "@GoPlanAI Plan day 1")
        interaction = AIInteraction.objects.get()
        self.assertEqual(interaction.prompt, "Plan day 1")
        self.assertEqual(
            str(interaction.prompt_message_id), response.data["message"]["id"]
        )
        mock_enqueue.assert_called_once()

    def test_post_empty_ai_prompt_returns_400_without_message(self):
        response = self.client.post(
            _messages_url(self.trip.id),
            {"content": "@GoPlanAI", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "INVALID_AI_PROMPT")
        self.assertEqual(ChatMessage.objects.count(), 0)

    @patch("chat.services.enqueue_ai_interaction_after_commit")
    def test_post_ai_busy_returns_409_without_prompt_message(self, mock_enqueue):
        first = self.client.post(
            _messages_url(self.trip.id),
            {"content": "@GoPlanAI first", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )
        self.assertEqual(first.status_code, 201)

        second = self.client.post(
            _messages_url(self.trip.id),
            {"content": "@GoPlanAI second", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.data["error_code"], "AI_BUSY")
        self.assertEqual(ChatMessage.objects.count(), 1)

    @patch("chat.services.enqueue_ai_interaction_after_commit")
    def test_post_ai_busy_does_not_block_normal_chat_message(self, mock_enqueue):
        first = self.client.post(
            _messages_url(self.trip.id),
            {"content": "@GoPlanAI first", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )
        self.assertEqual(first.status_code, 201)

        normal = self.client.post(
            _messages_url(self.trip.id),
            {"content": "normal message", "client_message_id": str(uuid4())},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(normal.status_code, 201)
        self.assertEqual(normal.data["message"]["content"], "normal message")
        self.assertEqual(ChatMessage.objects.count(), 2)

    @patch("chat.services.enqueue_ai_interaction_after_commit")
    def test_post_ai_prompt_idempotent_retry_returns_existing_message(self, mock_enqueue):
        client_message_id = str(uuid4())
        first = self.client.post(
            _messages_url(self.trip.id),
            {"content": "@GoPlanAI first", "client_message_id": client_message_id},
            format="json",
            **_auth(self.member),
        )
        second = self.client.post(
            _messages_url(self.trip.id),
            {"content": "@GoPlanAI first", "client_message_id": client_message_id},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.data["message"]["id"], first.data["message"]["id"])
        self.assertEqual(ChatMessage.objects.count(), 1)
        self.assertEqual(AIInteraction.objects.count(), 1)


class ChatMessageActionDraftPayloadTests(APITestCase):
    def test_ai_message_payload_includes_viewer_specific_action_drafts(self):
        captain = create_completed_user("draft-chat@example.com", "draftchat", "DRF001")
        trip = _make_trip(captain)
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
        draft = AIActionDraft.objects.create(
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

        payload = build_chat_message_payload(ai_message, viewer=captain)

        self.assertEqual(payload["action_drafts"][0]["id"], str(draft.id))
        self.assertTrue(payload["action_drafts"][0]["can_confirm"])
