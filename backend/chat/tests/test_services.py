from __future__ import annotations

from datetime import timedelta
from uuid import uuid4
from unittest.mock import patch

from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from chat.models import ChatMessage
from chat.services import (
    ChatChangeSequenceExhaustedError,
    ChatInvalidContentError,
    add_reaction,
    list_chat_messages,
    send_chat_message,
)
from test_helpers import create_completed_user
from trips.models import (
    CHAT_CHANGE_SEQUENCE_MAX,
    MemberStatus,
    Trip,
    TripMember,
    TripRole,
    TripStatus,
)
from trips.services import TripNotFoundError, TripTerminalError

TEST_CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer",
    },
}


def _make_trip(captain, *, status=TripStatus.PLANNING):
    trip = Trip.objects.create(
        created_by=captain,
        name="Chat Trip",
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


def _make_message(trip, sender, content, created_at):
    message = ChatMessage.objects.create(
        trip=trip,
        sender=sender,
        sender_display_name_snapshot=sender.display_name,
        sender_identify_tag_snapshot=sender.identify_tag,
        content=content,
        client_message_id=uuid4(),
    )
    ChatMessage.objects.filter(pk=message.pk).update(created_at=created_at)
    message.refresh_from_db()
    return message


class SendChatMessageServiceTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("cap@example.com", "captain", "CAP001")
        self.member = create_completed_user("mem@example.com", "member", "MEM001")
        self.other = create_completed_user("other@example.com", "other", "OTH001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)

    def test_send_chat_message_creates_message_with_snapshots(self):
        client_message_id = uuid4()

        message, created = send_chat_message(
            user=self.member,
            trip_id=self.trip.id,
            content="  Hello trip  ",
            client_message_id=client_message_id,
        )

        self.assertTrue(created)
        self.assertEqual(message.content, "Hello trip")
        self.assertEqual(message.client_message_id, client_message_id)
        self.assertEqual(message.sender_display_name_snapshot, self.member.display_name)
        self.assertEqual(message.sender_identify_tag_snapshot, self.member.identify_tag)
        self.assertEqual(message.change_sequence, 1)
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 1)
        self.assertEqual(ChatMessage.objects.count(), 1)

    def test_idempotent_retry_returns_existing_message(self):
        client_message_id = uuid4()
        first, first_created = send_chat_message(
            user=self.member,
            trip_id=self.trip.id,
            content="Hello once",
            client_message_id=client_message_id,
        )

        second, second_created = send_chat_message(
            user=self.member,
            trip_id=self.trip.id,
            content="Hello twice",
            client_message_id=client_message_id,
        )

        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(first.id, second.id)
        self.assertEqual(second.content, "Hello once")
        self.assertEqual(first.change_sequence, 1)
        self.assertEqual(second.change_sequence, 1)
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 1)
        self.assertEqual(ChatMessage.objects.count(), 1)

    def test_each_new_message_allocates_next_trip_sequence(self):
        first, _ = send_chat_message(
            user=self.member,
            trip_id=self.trip.id,
            content="First sequence",
            client_message_id=uuid4(),
        )
        second, _ = send_chat_message(
            user=self.captain,
            trip_id=self.trip.id,
            content="Second sequence",
            client_message_id=uuid4(),
        )

        self.assertEqual((first.change_sequence, second.change_sequence), (1, 2))
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.chat_change_sequence, 2)

    def test_non_member_gets_trip_not_found(self):
        with self.assertRaises(TripNotFoundError):
            send_chat_message(
                user=self.other,
                trip_id=self.trip.id,
                content="No access",
                client_message_id=uuid4(),
            )

    def test_terminal_trip_rejects_new_message(self):
        self.trip.status = TripStatus.COMPLETED
        self.trip.save(update_fields=["status"])

        with self.assertRaises(TripTerminalError):
            send_chat_message(
                user=self.member,
                trip_id=self.trip.id,
                content="Too late",
                client_message_id=uuid4(),
            )

    def test_idempotent_retry_after_terminal_returns_existing_message(self):
        client_message_id = uuid4()
        first, first_created = send_chat_message(
            user=self.member,
            trip_id=self.trip.id,
            content="Sent before terminal",
            client_message_id=client_message_id,
        )
        self.trip.status = TripStatus.COMPLETED
        self.trip.save(update_fields=["status"])

        second, second_created = send_chat_message(
            user=self.member,
            trip_id=self.trip.id,
            content="Retry after terminal",
            client_message_id=client_message_id,
        )

        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(first.id, second.id)
        self.assertEqual(second.content, "Sent before terminal")
        self.assertEqual(ChatMessage.objects.count(), 1)

    def test_blank_content_rejected(self):
        with self.assertRaises(ChatInvalidContentError):
            send_chat_message(
                user=self.member,
                trip_id=self.trip.id,
                content="   ",
                client_message_id=uuid4(),
            )

    def test_sequence_exhaustion_rejects_create_without_partial_write(self):
        self.trip.chat_change_sequence = CHAT_CHANGE_SEQUENCE_MAX
        self.trip.save(update_fields=["chat_change_sequence"])

        with self.assertRaises(ChatChangeSequenceExhaustedError):
            send_chat_message(
                user=self.member,
                trip_id=self.trip.id,
                content="Cannot allocate",
                client_message_id=uuid4(),
            )

        self.trip.refresh_from_db()
        self.assertEqual(
            self.trip.chat_change_sequence,
            CHAT_CHANGE_SEQUENCE_MAX,
        )
        self.assertFalse(ChatMessage.objects.exists())


class ListChatMessagesServiceTests(APITestCase):

    def setUp(self):
        self.captain = create_completed_user("cap-list@example.com", "caplist", "CLT001")
        self.member = create_completed_user("mem-list@example.com", "memlist", "MLT001")
        self.other = create_completed_user("other-list@example.com", "othlist", "OLT001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)
        base = timezone.now()
        self.messages = [
            _make_message(self.trip, self.member, "one", base + timedelta(seconds=1)),
            _make_message(self.trip, self.member, "two", base + timedelta(seconds=2)),
            _make_message(self.trip, self.member, "three", base + timedelta(seconds=3)),
            _make_message(self.trip, self.member, "four", base + timedelta(seconds=4)),
        ]

    def test_history_returns_descending_page_and_cursor(self):
        page = list_chat_messages(user=self.member, trip_id=self.trip.id, limit=2)

        self.assertEqual([m["content"] for m in page["results"]], ["four", "three"])
        self.assertIsNotNone(page["next_cursor"])

        next_page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            cursor=page["next_cursor"],
            limit=2,
        )
        self.assertEqual([m["content"] for m in next_page["results"]], ["two", "one"])
        self.assertIsNone(next_page["next_cursor"])

    def test_gap_fill_returns_ascending_with_has_more(self):
        page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            since=self.messages[0].id,
            limit=2,
        )

        self.assertEqual([m["content"] for m in page["results"]], ["two", "three"])
        self.assertTrue(page["has_more"])

        next_page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            since=page["results"][-1]["id"],
            limit=2,
        )
        self.assertEqual([m["content"] for m in next_page["results"]], ["four"])
        self.assertFalse(next_page["has_more"])

    @patch("chat.services._push_reaction_update")
    def test_updated_since_returns_existing_message_mutations(self, mock_push):
        before_update = timezone.now()

        add_reaction(
            user=self.captain,
            trip_id=self.trip.id,
            message_id=self.messages[0].id,
            emoji="👍",
        )

        page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            updated_since=before_update,
            limit=10,
        )

        self.assertEqual([m["content"] for m in page["results"]], ["one"])
        self.assertEqual(page["results"][0]["reactions"][0]["emoji"], "👍")
        self.assertFalse(page["has_more"])

    def test_updated_since_id_paginates_same_timestamp_mutations(self):
        same_updated_at = timezone.now()
        ChatMessage.objects.filter(
            pk__in=[message.pk for message in self.messages]
        ).update(updated_at=same_updated_at)
        before_updates = same_updated_at - timedelta(seconds=1)

        first_page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            updated_since=before_updates,
            limit=1,
        )
        second_page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            updated_since=first_page["results"][-1]["updated_at"],
            updated_since_id=first_page["results"][-1]["id"],
            limit=10,
        )

        returned_ids = {
            first_page["results"][0]["id"],
            *[message["id"] for message in second_page["results"]],
        }
        self.assertEqual(returned_ids, {str(message.id) for message in self.messages})
        self.assertTrue(first_page["has_more"])
        self.assertFalse(second_page["has_more"])

    @patch("chat.services._push_reaction_update")
    def test_changed_since_catches_equal_and_backward_updated_at(self, mock_push):
        same_time = timezone.now()
        with patch("chat.services.timezone.now", return_value=same_time):
            first = add_reaction(
                user=self.captain,
                trip_id=self.trip.id,
                message_id=self.messages[0].id,
                emoji="👍",
            )
            second = add_reaction(
                user=self.captain,
                trip_id=self.trip.id,
                message_id=self.messages[0].id,
                emoji="😂",
            )

        equal_time_page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            changed_since=first["change_sequence"],
            limit=10,
        )
        self.assertEqual(
            [message["id"] for message in equal_time_page["results"]],
            [str(self.messages[0].id)],
        )
        self.assertEqual(
            equal_time_page["results"][0]["change_sequence"],
            second["change_sequence"],
        )

        backward_time = same_time - timedelta(days=1)
        with patch("chat.services.timezone.now", return_value=backward_time):
            third = add_reaction(
                user=self.captain,
                trip_id=self.trip.id,
                message_id=self.messages[0].id,
                emoji="😮",
            )

        backward_time_page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            changed_since=second["change_sequence"],
            limit=10,
        )
        self.assertEqual(
            [message["id"] for message in backward_time_page["results"]],
            [str(self.messages[0].id)],
        )
        self.assertEqual(
            backward_time_page["results"][0]["change_sequence"],
            third["change_sequence"],
        )

    def test_changed_since_id_paginates_duplicate_legacy_sequence_losslessly(self):
        duplicate_sequence = 7
        ordered_messages = sorted(self.messages[:2], key=lambda message: message.id)
        ChatMessage.objects.filter(
            pk__in=[message.pk for message in ordered_messages]
        ).update(change_sequence=duplicate_sequence)
        ChatMessage.objects.filter(pk=self.messages[2].pk).update(
            change_sequence=duplicate_sequence + 1
        )

        first_page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            changed_since=duplicate_sequence - 1,
            limit=1,
        )
        second_page = list_chat_messages(
            user=self.member,
            trip_id=self.trip.id,
            changed_since=first_page["results"][-1]["change_sequence"],
            changed_since_id=first_page["results"][-1]["id"],
            limit=10,
        )

        returned_ids = [
            first_page["results"][0]["id"],
            *[message["id"] for message in second_page["results"]],
        ]
        self.assertEqual(
            returned_ids,
            [
                str(ordered_messages[0].id),
                str(ordered_messages[1].id),
                str(self.messages[2].id),
            ],
        )
        self.assertTrue(first_page["has_more"])
        self.assertFalse(second_page["has_more"])

    def test_non_member_cannot_list(self):
        with self.assertRaises(TripNotFoundError):
            list_chat_messages(user=self.other, trip_id=self.trip.id)

    def _assert_reinvited_member_can_read_full_history(self, status):
        first_membership = TripMember.objects.get(trip=self.trip, user=self.member)
        first_membership.status = status
        first_membership.left_at = timezone.now()
        first_membership.save(update_fields=["status", "left_at"])
        TripMember.objects.create(
            trip=self.trip,
            user=self.member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )

        page = list_chat_messages(user=self.member, trip_id=self.trip.id, limit=10)

        self.assertEqual(
            [m["content"] for m in page["results"]],
            ["four", "three", "two", "one"],
        )

    def test_reinvited_removed_member_can_read_full_chat_history(self):
        self._assert_reinvited_member_can_read_full_history(MemberStatus.REMOVED)

    def test_reinvited_left_member_can_read_full_chat_history(self):
        self._assert_reinvited_member_can_read_full_history(MemberStatus.LEFT)


@override_settings(CHANNEL_LAYERS=TEST_CHANNEL_LAYERS)
class ChatMessagePushTests(TransactionTestCase):

    def test_new_message_pushes_after_commit(self):
        captain = create_completed_user("push-cap@example.com", "pushcap", "PCA001")
        member = create_completed_user("push-mem@example.com", "pushmem", "PME001")
        trip = _make_trip(captain)
        _add_member(trip, member)

        with patch("chat.services.async_to_sync") as mock_async_to_sync:
            mock_send = mock_async_to_sync.return_value
            message, created = send_chat_message(
                user=member,
                trip_id=trip.id,
                content="Push me",
                client_message_id=uuid4(),
            )

        self.assertTrue(created)
        mock_async_to_sync.assert_called_once()
        mock_send.assert_called_once()
        self.assertEqual(mock_send.call_args[0][0], f"trip_chat_{trip.id}")
        self.assertEqual(mock_send.call_args[0][1]["type"], "chat_message_push")
        self.assertEqual(
            mock_send.call_args[0][1]["data"]["message"]["id"],
            str(message.id),
        )
        self.assertEqual(
            mock_send.call_args[0][1]["data"]["message"]["change_sequence"],
            message.change_sequence,
        )

    def test_idempotent_retry_does_not_push_again(self):
        captain = create_completed_user("retry-cap@example.com", "retrycap", "RCA001")
        member = create_completed_user("retry-mem@example.com", "retrymem", "RME001")
        trip = _make_trip(captain)
        _add_member(trip, member)
        client_message_id = uuid4()

        send_chat_message(
            user=member,
            trip_id=trip.id,
            content="First",
            client_message_id=client_message_id,
        )

        with patch("chat.services.async_to_sync") as mock_async_to_sync:
            _message, created = send_chat_message(
                user=member,
                trip_id=trip.id,
                content="Retry",
                client_message_id=client_message_id,
            )

        self.assertFalse(created)
        mock_async_to_sync.assert_not_called()

    def test_idempotent_retry_after_terminal_does_not_push_again(self):
        captain = create_completed_user("retry-term-cap@example.com", "rtcap", "RTC001")
        member = create_completed_user("retry-term-mem@example.com", "rtmem", "RTM001")
        trip = _make_trip(captain)
        _add_member(trip, member)
        client_message_id = uuid4()

        send_chat_message(
            user=member,
            trip_id=trip.id,
            content="Created before terminal",
            client_message_id=client_message_id,
        )
        trip.status = TripStatus.COMPLETED
        trip.save(update_fields=["status"])

        with patch("chat.services.async_to_sync") as mock_async_to_sync:
            _message, created = send_chat_message(
                user=member,
                trip_id=trip.id,
                content="Retry after terminal",
                client_message_id=client_message_id,
            )

        self.assertFalse(created)
        mock_async_to_sync.assert_not_called()


# -------- Sender avatar_url Tests --------

import io
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image as PILImage
from accounts.services import update_avatar
from chat.services import build_chat_message_payload


class ChatSenderAvatarUrlTests(APITestCase):
    """Sender avatar resolves at read time (not snapshotted)."""

    def setUp(self):
        self.captain = create_completed_user("ch_cap@example.com", "chcap", "CHC001")
        self.sender = create_completed_user("ch_snd@example.com", "chsnd", "CHS001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.sender)
        self.message = _make_message(
            self.trip,
            self.sender,
            "hello",
            timezone.now(),
        )

    def test_sender_payload_has_avatar_url_null_when_no_avatar(self):
        message = ChatMessage.objects.select_related("sender").get(pk=self.message.pk)
        payload = build_chat_message_payload(message)
        self.assertIn("avatar_url", payload["sender"])
        self.assertIsNone(payload["sender"]["avatar_url"])

    def test_sender_payload_avatar_url_reflects_current_user_record(self):
        buf = io.BytesIO()
        PILImage.new("RGB", (256, 256), "purple").save(buf, format="JPEG")
        update_avatar(
            self.sender,
            SimpleUploadedFile("a.jpg", buf.getvalue(), content_type="image/jpeg"),
        )
        message = ChatMessage.objects.select_related("sender").get(pk=self.message.pk)
        payload = build_chat_message_payload(message)
        self.assertTrue(payload["sender"]["avatar_url"].startswith("/media/avatars/"))

    def test_sender_payload_avatar_url_is_null_when_sender_deleted(self):
        self.sender.delete()
        message = ChatMessage.objects.select_related("sender").get(pk=self.message.pk)
        payload = build_chat_message_payload(message)
        self.assertIsNone(payload["sender"]["avatar_url"])
        self.assertTrue(payload["sender"]["display_name"])
