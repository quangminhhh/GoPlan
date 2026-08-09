from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework.throttling import ScopedRateThrottle

from accounts.tokens import AccessToken
from chat.models import (
    ALLOWED_REACTION_EMOJIS,
    ChatMessage,
    ChatMessageHiddenForUser,
    MessageReaction,
)
from chat.services import (
    ChatReactionDuplicateError,
    ChatServiceError,
    ChatReactionInvalidEmojiError,
    ChatReactionNotFoundError,
    add_reaction,
    build_reactions_payload,
    remove_reaction,
    _push_reaction_update,
)
from test_helpers import create_completed_user
from trips.models import MemberStatus, Trip, TripMember, TripRole, TripStatus
from trips.services import TripNotFoundError, TripTerminalError


def _auth(user):
    return {"HTTP_AUTHORIZATION": f"Bearer {AccessToken.for_user(user)}"}


def _make_trip(captain, *, status=TripStatus.PLANNING):
    trip = Trip.objects.create(
        created_by=captain,
        name="Reaction Test Trip",
        destination="Hoi An",
        start_date="2026-07-01",
        end_date="2026-07-05",
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


def _make_message(trip, sender):
    return ChatMessage.objects.create(
        trip=trip,
        sender=sender,
        sender_display_name_snapshot=sender.display_name,
        sender_identify_tag_snapshot=sender.identify_tag,
        content="Hello reactions",
    )


def _reactions_url(trip_id, message_id):
    return f"/api/trips/{trip_id}/chat/messages/{message_id}/reactions"


def _reaction_detail_url(trip_id, message_id, emoji):
    from urllib.parse import quote
    return f"/api/trips/{trip_id}/chat/messages/{message_id}/reactions/{quote(emoji, safe='')}"


# -------- Service-layer unit tests --------

class BuildReactionsPayloadTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("react-svc-cap@example.com", "rxcap", "RXC001")
        self.member = create_completed_user("react-svc-mem@example.com", "rxmem", "RXM001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)
        self.message = _make_message(self.trip, self.captain)

    def test_empty_reactions(self):
        payload = build_reactions_payload(self.message)
        self.assertEqual(payload, [])

    def test_single_reaction(self):
        MessageReaction.objects.create(
            message=self.message,
            user=self.captain,
            emoji="❤️",
        )
        payload = build_reactions_payload(self.message)
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["emoji"], "❤️")
        self.assertEqual(payload[0]["count"], 1)
        self.assertIn(str(self.captain.id), payload[0]["reacted_by_ids"])

    def test_multiple_users_same_emoji(self):
        MessageReaction.objects.create(message=self.message, user=self.captain, emoji="👍")
        MessageReaction.objects.create(message=self.message, user=self.member, emoji="👍")
        payload = build_reactions_payload(self.message)
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["emoji"], "👍")
        self.assertEqual(payload[0]["count"], 2)
        self.assertIn(str(self.captain.id), payload[0]["reacted_by_ids"])
        self.assertIn(str(self.member.id), payload[0]["reacted_by_ids"])

    def test_multiple_emojis(self):
        MessageReaction.objects.create(message=self.message, user=self.captain, emoji="❤️")
        MessageReaction.objects.create(message=self.message, user=self.member, emoji="😂")
        payload = build_reactions_payload(self.message)
        emojis = {r["emoji"] for r in payload}
        self.assertEqual(emojis, {"❤️", "😂"})

    def test_one_user_can_have_only_one_reaction_per_message_at_db_level(self):
        MessageReaction.objects.create(
            message=self.message,
            user=self.member,
            emoji="❤️",
        )

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                MessageReaction.objects.create(
                    message=self.message,
                    user=self.member,
                    emoji="😂",
                )


class AddReactionServiceTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("add-svc-cap@example.com", "adcap", "ADC001")
        self.member = create_completed_user("add-svc-mem@example.com", "admem", "ADM001")
        self.outsider = create_completed_user("add-svc-out@example.com", "adout", "ADO001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)
        self.message = _make_message(self.trip, self.captain)

    @patch("chat.services._push_reaction_update")
    def test_add_reaction_happy_path(self, mock_push):
        payload = add_reaction(
            user=self.member,
            trip_id=self.trip.id,
            message_id=self.message.id,
            emoji="❤️",
        )
        self.assertTrue(MessageReaction.objects.filter(
            message=self.message, user=self.member, emoji="❤️"
        ).exists())
        self.assertEqual(len(payload["reactions"]), 1)
        self.assertEqual(payload["reactions"][0]["emoji"], "❤️")
        self.assertEqual(payload["change_sequence"], 1)
        self.assertIsInstance(payload["updated_at"], str)

    def test_add_invalid_emoji_raises(self):
        with self.assertRaises(ChatReactionInvalidEmojiError):
            add_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="🦄",
            )

    def test_add_duplicate_raises(self):
        MessageReaction.objects.create(
            message=self.message, user=self.member, emoji="❤️"
        )
        with self.assertRaises(ChatReactionDuplicateError):
            add_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="❤️",
            )
        self.trip.refresh_from_db()
        self.message.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 0)
        self.assertEqual(self.message.change_sequence, 0)

    def test_add_non_member_raises(self):
        with self.assertRaises(TripNotFoundError):
            add_reaction(
                user=self.outsider,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="👍",
            )

    @patch("chat.services._push_reaction_update")
    def test_replace_reaction_replaces_existing(self, mock_push):
        """Adding a different emoji atomically replaces the user's existing reaction."""
        add_reaction(
            user=self.member,
            trip_id=self.trip.id,
            message_id=self.message.id,
            emoji="❤️",
        )
        payload = add_reaction(
            user=self.member,
            trip_id=self.trip.id,
            message_id=self.message.id,
            emoji="😂",
        )
        self.assertFalse(MessageReaction.objects.filter(
            message=self.message, user=self.member, emoji="❤️"
        ).exists())
        self.assertTrue(MessageReaction.objects.filter(
            message=self.message, user=self.member, emoji="😂"
        ).exists())
        self.assertEqual(len(payload["reactions"]), 1)
        self.assertEqual(payload["reactions"][0]["emoji"], "😂")
        self.assertEqual(payload["change_sequence"], 2)

    def test_add_wrong_trip_message_raises(self):
        other_captain = create_completed_user("other-cap@example.com", "othcap", "OTC001")
        other_trip = _make_trip(other_captain)
        other_msg = _make_message(other_trip, other_captain)

        with self.assertRaises(TripNotFoundError):
            add_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=other_msg.id,
                emoji="👍",
            )

    def test_add_reaction_rejects_terminal_trip(self):
        self.trip.status = TripStatus.COMPLETED
        self.trip.save(update_fields=["status"])

        with self.assertRaises(TripTerminalError):
            add_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="👍",
            )

    def test_add_reaction_rejects_deleted_message(self):
        self.message.deleted_for_everyone_at = timezone.now()
        self.message.deleted_for_everyone_by = self.captain
        self.message.save(
            update_fields=["deleted_for_everyone_at", "deleted_for_everyone_by"]
        )

        with self.assertRaises(ChatServiceError) as ctx:
            add_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="👍",
            )

        self.assertEqual(ctx.exception.error_code, "MESSAGE_DELETED")

    def test_add_reaction_rejects_message_hidden_for_user(self):
        ChatMessageHiddenForUser.objects.create(
            message=self.message,
            user=self.member,
        )

        with self.assertRaises(TripNotFoundError):
            add_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="👍",
            )


class RemoveReactionServiceTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("rm-svc-cap@example.com", "rmcap", "RMC001")
        self.member = create_completed_user("rm-svc-mem@example.com", "rmmem", "RMM001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)
        self.message = _make_message(self.trip, self.captain)

    @patch("chat.services._push_reaction_update")
    def test_remove_reaction_happy_path(self, mock_push):
        MessageReaction.objects.create(
            message=self.message, user=self.member, emoji="😂"
        )
        payload = remove_reaction(
            user=self.member,
            trip_id=self.trip.id,
            message_id=self.message.id,
            emoji="😂",
        )
        self.assertFalse(MessageReaction.objects.filter(
            message=self.message, user=self.member, emoji="😂"
        ).exists())
        self.assertEqual(payload["reactions"], [])
        self.assertEqual(payload["change_sequence"], 1)

    def test_remove_nonexistent_raises(self):
        with self.assertRaises(ChatReactionNotFoundError):
            remove_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="😂",
            )

    def test_remove_invalid_emoji_raises(self):
        with self.assertRaises(ChatReactionInvalidEmojiError):
            remove_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="🐉",
            )

    def test_remove_other_users_reaction_raises(self):
        MessageReaction.objects.create(
            message=self.message, user=self.captain, emoji="❤️"
        )
        with self.assertRaises(ChatReactionNotFoundError):
            remove_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="❤️",
            )

    def test_remove_reaction_rejects_terminal_trip(self):
        MessageReaction.objects.create(
            message=self.message, user=self.member, emoji="👍"
        )
        self.trip.status = TripStatus.CANCELLED
        self.trip.save(update_fields=["status"])

        with self.assertRaises(TripTerminalError):
            remove_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="👍",
            )

    def test_remove_reaction_rejects_deleted_message(self):
        MessageReaction.objects.create(
            message=self.message, user=self.member, emoji="👍"
        )
        self.message.deleted_for_everyone_at = timezone.now()
        self.message.deleted_for_everyone_by = self.captain
        self.message.save(
            update_fields=["deleted_for_everyone_at", "deleted_for_everyone_by"]
        )

        with self.assertRaises(ChatServiceError) as ctx:
            remove_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="👍",
            )

        self.assertEqual(ctx.exception.error_code, "MESSAGE_DELETED")

    def test_remove_reaction_rejects_message_hidden_for_user(self):
        MessageReaction.objects.create(
            message=self.message,
            user=self.member,
            emoji="👍",
        )
        ChatMessageHiddenForUser.objects.create(
            message=self.message,
            user=self.member,
        )

        with self.assertRaises(TripNotFoundError):
            remove_reaction(
                user=self.member,
                trip_id=self.trip.id,
                message_id=self.message.id,
                emoji="👍",
            )


# -------- API (view) tests --------

class MessageReactionAPIAddTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("api-add-cap@example.com", "aacap", "AAC001")
        self.member = create_completed_user("api-add-mem@example.com", "aamem", "AAM001")
        self.outsider = create_completed_user("api-add-out@example.com", "aaout", "AAO001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)
        self.message = _make_message(self.trip, self.captain)
        self.url = _reactions_url(self.trip.id, self.message.id)

    def test_add_reaction_201(self):
        response = self.client.post(
            self.url,
            {"emoji": "❤️"},
            format="json",
            **_auth(self.member),
        )
        self.assertEqual(response.status_code, 201)
        self.assertIn("reactions", response.data)
        self.assertEqual(len(response.data["reactions"]), 1)
        self.assertEqual(response.data["reactions"][0]["emoji"], "❤️")
        self.assertEqual(response.data["reactions"][0]["count"], 1)
        self.assertEqual(response.data["change_sequence"], 1)
        self.assertIsInstance(response.data["updated_at"], str)

    def test_add_invalid_emoji_400(self):
        response = self.client.post(
            self.url,
            {"emoji": "🦄"},
            format="json",
            **_auth(self.member),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "INVALID_EMOJI")

    def test_add_duplicate_reaction_409(self):
        self.client.post(self.url, {"emoji": "👍"}, format="json", **_auth(self.member))
        response = self.client.post(
            self.url,
            {"emoji": "👍"},
            format="json",
            **_auth(self.member),
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "REACTION_DUPLICATE")

    def test_post_to_reaction_detail_url_returns_405(self):
        response = self.client.post(
            _reaction_detail_url(self.trip.id, self.message.id, "👍"),
            {"emoji": "👍"},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 405)

    def test_non_member_cannot_react_404(self):
        response = self.client.post(
            self.url,
            {"emoji": "❤️"},
            format="json",
            **_auth(self.outsider),
        )
        self.assertEqual(response.status_code, 404)

    def test_unauthenticated_401(self):
        response = self.client.post(self.url, {"emoji": "❤️"}, format="json")
        self.assertEqual(response.status_code, 401)

    def test_message_from_wrong_trip_404(self):
        other_captain = create_completed_user("wrng-cap@example.com", "wrngcap", "WRG001")
        other_trip = _make_trip(other_captain)
        other_msg = _make_message(other_trip, other_captain)

        response = self.client.post(
            _reactions_url(self.trip.id, other_msg.id),
            {"emoji": "❤️"},
            format="json",
            **_auth(self.member),
        )
        self.assertEqual(response.status_code, 404)

    def test_add_reaction_terminal_trip_returns_409(self):
        self.trip.status = TripStatus.COMPLETED
        self.trip.save(update_fields=["status"])

        response = self.client.post(
            self.url,
            {"emoji": "👍"},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "TRIP_TERMINAL")

    def test_add_reaction_deleted_message_returns_409(self):
        self.message.deleted_for_everyone_at = timezone.now()
        self.message.deleted_for_everyone_by = self.captain
        self.message.save(
            update_fields=["deleted_for_everyone_at", "deleted_for_everyone_by"]
        )

        response = self.client.post(
            self.url,
            {"emoji": "👍"},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "MESSAGE_DELETED")

    def test_add_reaction_hidden_message_returns_404(self):
        ChatMessageHiddenForUser.objects.create(
            message=self.message,
            user=self.member,
        )

        response = self.client.post(
            self.url,
            {"emoji": "👍"},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")

    def test_all_allowed_emojis_accepted(self):
        # Each emoji from a different user or same user sequentially
        for emoji in ALLOWED_REACTION_EMOJIS:
            response = self.client.post(
                self.url,
                {"emoji": emoji},
                format="json",
                **_auth(self.member),
            )
            self.assertEqual(response.status_code, 201, f"Failed for emoji {emoji!r}")
            # Remove so same user can add next one (would conflict otherwise)
            self.client.delete(
                _reaction_detail_url(self.trip.id, self.message.id, emoji),
                **_auth(self.member),
            )

    def test_reaction_throttle_returns_error_code(self):
        original_rates = ScopedRateThrottle.THROTTLE_RATES
        ScopedRateThrottle.THROTTLE_RATES = {"chat_reaction": "1/minute"}
        self.addCleanup(setattr, ScopedRateThrottle, "THROTTLE_RATES", original_rates)
        second_message = _make_message(self.trip, self.captain)

        first = self.client.post(
            self.url,
            {"emoji": "👍"},
            format="json",
            **_auth(self.member),
        )
        throttled = self.client.post(
            _reactions_url(self.trip.id, second_message.id),
            {"emoji": "😂"},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(throttled.status_code, 429)
        self.assertEqual(throttled.data["error_code"], "THROTTLED")


class MessageReactionAPIRemoveTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("api-rm-cap@example.com", "rmacap", "RMV001")
        self.member = create_completed_user("api-rm-mem@example.com", "rmamem", "RMV002")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)
        self.message = _make_message(self.trip, self.captain)

    def _add_reaction(self, user, emoji):
        MessageReaction.objects.create(message=self.message, user=user, emoji=emoji)

    def test_remove_reaction_200(self):
        self._add_reaction(self.member, "😂")
        url = _reaction_detail_url(self.trip.id, self.message.id, "😂")
        response = self.client.delete(url, **_auth(self.member))
        self.assertEqual(response.status_code, 200)
        self.assertIn("reactions", response.data)
        self.assertEqual(response.data["reactions"], [])
        self.assertEqual(response.data["change_sequence"], 1)
        self.assertIsInstance(response.data["updated_at"], str)

    def test_delete_to_reaction_collection_url_returns_405(self):
        response = self.client.delete(
            _reactions_url(self.trip.id, self.message.id),
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 405)

    def test_remove_nonexistent_404(self):
        url = _reaction_detail_url(self.trip.id, self.message.id, "❤️")
        response = self.client.delete(url, **_auth(self.member))
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "REACTION_NOT_FOUND")

    def test_cannot_remove_others_reaction_404(self):
        self._add_reaction(self.captain, "❤️")
        url = _reaction_detail_url(self.trip.id, self.message.id, "❤️")
        response = self.client.delete(url, **_auth(self.member))
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "REACTION_NOT_FOUND")
        # Captain's reaction must still exist
        self.assertTrue(MessageReaction.objects.filter(
            message=self.message, user=self.captain, emoji="❤️"
        ).exists())

    def test_invalid_emoji_in_delete_400(self):
        url = _reaction_detail_url(self.trip.id, self.message.id, "🦄")
        response = self.client.delete(url, **_auth(self.member))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "INVALID_EMOJI")

    def test_unauthenticated_401(self):
        url = _reaction_detail_url(self.trip.id, self.message.id, "❤️")
        response = self.client.delete(url)
        self.assertEqual(response.status_code, 401)

    def test_remove_reaction_terminal_trip_returns_409(self):
        self._add_reaction(self.member, "👍")
        self.trip.status = TripStatus.CANCELLED
        self.trip.save(update_fields=["status"])

        url = _reaction_detail_url(self.trip.id, self.message.id, "👍")
        response = self.client.delete(url, **_auth(self.member))

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "TRIP_TERMINAL")

    def test_remove_reaction_hidden_message_returns_404(self):
        self._add_reaction(self.member, "👍")
        ChatMessageHiddenForUser.objects.create(
            message=self.message,
            user=self.member,
        )

        url = _reaction_detail_url(self.trip.id, self.message.id, "👍")
        response = self.client.delete(url, **_auth(self.member))

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")
        self.assertTrue(MessageReaction.objects.filter(
            message=self.message,
            user=self.member,
            emoji="👍",
        ).exists())

    def test_reactions_in_message_history_payload(self):
        """Reactions must appear in chat history responses."""
        self._add_reaction(self.captain, "👍")
        self._add_reaction(self.member, "👍")

        response = self.client.get(
            f"/api/trips/{self.trip.id}/chat/messages",
            **_auth(self.member),
        )
        self.assertEqual(response.status_code, 200)
        results = response.data["results"]
        self.assertEqual(len(results), 1)
        reactions = results[0]["reactions"]
        self.assertEqual(len(reactions), 1)
        self.assertEqual(reactions[0]["emoji"], "👍")


class AIMessageReactionTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("ai-react-cap@example.com", "airxcap", "ARC001")
        self.member = create_completed_user("ai-react-mem@example.com", "airxmem", "ARM001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)

    @patch("chat.services._push_reaction_update")
    def test_ai_message_accepts_reactions(self, mock_push):
        ai_message = ChatMessage.objects.create(
            trip=self.trip,
            sender=None,
            sender_kind="AI",
            sender_display_name_snapshot="GoPlanAI",
            sender_identify_tag_snapshot=None,
            content="AI reply",
            ai_status="SUCCESS",
        )

        payload = add_reaction(
            user=self.member,
            trip_id=self.trip.id,
            message_id=ai_message.id,
            emoji="👍",
        )

        self.assertEqual(payload["reactions"][0]["emoji"], "👍")
        self.assertEqual(payload["change_sequence"], 1)
        self.assertTrue(
            MessageReaction.objects.filter(
                message=ai_message,
                user=self.member,
                emoji="👍",
            ).exists()
        )


class ReactionSequenceContractTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user(
            "sequence-react-cap@example.com",
            "seqreactcap",
            "SRC001",
        )
        self.member = create_completed_user(
            "sequence-react-mem@example.com",
            "seqreactmem",
            "SRM001",
        )
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)
        self.message = _make_message(self.trip, self.captain)

    @patch("chat.services._push_reaction_update")
    def test_reversed_reaction_events_expose_current_sequence(self, mock_push):
        newer_timestamp = timezone.now()
        older_timestamp = newer_timestamp - timedelta(days=1)
        callbacks = []

        with patch(
            "chat.services.transaction.on_commit",
            side_effect=callbacks.append,
        ):
            with patch("chat.services.timezone.now", return_value=newer_timestamp):
                first = add_reaction(
                    user=self.member,
                    trip_id=self.trip.id,
                    message_id=self.message.id,
                    emoji="❤️",
                )
            with patch("chat.services.timezone.now", return_value=older_timestamp):
                second = add_reaction(
                    user=self.member,
                    trip_id=self.trip.id,
                    message_id=self.message.id,
                    emoji="😂",
                )

        self.assertEqual(len(callbacks), 2)
        for callback in reversed(callbacks):
            callback()

        reversed_delivery = [
            call.kwargs["payload"] for call in mock_push.call_args_list
        ]
        self.assertEqual(
            [payload["change_sequence"] for payload in reversed_delivery],
            [second["change_sequence"], first["change_sequence"]],
        )
        self.assertGreater(
            reversed_delivery[0]["change_sequence"],
            reversed_delivery[1]["change_sequence"],
        )
        self.assertLess(
            reversed_delivery[0]["updated_at"],
            reversed_delivery[1]["updated_at"],
        )
        self.message.refresh_from_db()
        self.assertEqual(
            self.message.change_sequence,
            reversed_delivery[0]["change_sequence"],
        )

    @patch("chat.services.async_to_sync")
    def test_reaction_websocket_payload_carries_sequence_and_updated_at(
        self,
        mock_async_to_sync,
    ):
        self.message.change_sequence = 42
        self.message.updated_at = timezone.now()
        payload = {
            "reactions": [],
            "change_sequence": self.message.change_sequence,
            "updated_at": self.message.updated_at.isoformat(),
        }

        _push_reaction_update(message=self.message, payload=payload)

        group_send = mock_async_to_sync.return_value
        event = group_send.call_args.args[1]["data"]
        self.assertEqual(event["change_sequence"], 42)
        self.assertEqual(event["updated_at"], self.message.updated_at.isoformat())
        self.assertEqual(event["reactions"], [])
