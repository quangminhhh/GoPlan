from __future__ import annotations

from datetime import timedelta
from importlib import import_module
from types import SimpleNamespace

from django.apps import apps as django_apps
from django.db import connection
from django.test import TransactionTestCase
from django.utils import timezone

from chat.models import ChatMessage, ChatMessageAIStatus, ChatMessageSenderKind
from test_helpers import create_completed_user
from trips.models import Trip


backfill_chat_change_sequences = import_module(
    "chat.migrations.0007_chatmessage_change_sequence_and_more"
).backfill_chat_change_sequences


class ChatChangeSequenceMigrationTests(TransactionTestCase):

    def test_backfill_sequences_all_shared_rows_per_trip_and_sets_allocator(self):
        captain = create_completed_user(
            "migration-sequence@example.com",
            "migrationseq",
            "MIG001",
        )
        first_trip = Trip.objects.create(
            created_by=captain,
            name="First migration trip",
            destination="Da Nang",
            start_date="2026-06-01",
            end_date="2026-06-05",
            chat_change_sequence=99,
        )
        second_trip = Trip.objects.create(
            created_by=captain,
            name="Second migration trip",
            destination="Hue",
            start_date="2026-07-01",
            end_date="2026-07-05",
            chat_change_sequence=99,
        )
        user_message = ChatMessage.objects.create(
            trip=first_trip,
            sender=captain,
            sender_display_name_snapshot=captain.display_name,
            sender_identify_tag_snapshot=captain.identify_tag,
            content="User message",
        )
        ai_message = ChatMessage.objects.create(
            trip=first_trip,
            sender=None,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            content="AI message",
            ai_status=ChatMessageAIStatus.SUCCESS,
        )
        tombstone = ChatMessage.objects.create(
            trip=first_trip,
            sender=captain,
            sender_display_name_snapshot=captain.display_name,
            sender_identify_tag_snapshot=captain.identify_tag,
            content="",
            deleted_for_everyone_at=timezone.now(),
            deleted_for_everyone_by=captain,
        )
        other_trip_message = ChatMessage.objects.create(
            trip=second_trip,
            sender=None,
            sender_kind=ChatMessageSenderKind.AI,
            sender_display_name_snapshot="GoPlanAI",
            content="Other trip AI message",
            ai_status=ChatMessageAIStatus.SUCCESS,
        )

        base_time = timezone.now() - timedelta(days=1)
        message_times = {
            user_message.pk: base_time + timedelta(seconds=1),
            ai_message.pk: base_time + timedelta(seconds=1),
            tombstone.pk: base_time + timedelta(seconds=2),
            other_trip_message.pk: base_time + timedelta(seconds=1),
        }
        for message in (
            user_message,
            ai_message,
            tombstone,
            other_trip_message,
        ):
            ChatMessage.objects.filter(pk=message.pk).update(
                updated_at=message_times[message.pk],
                change_sequence=0,
            )

        schema_editor = SimpleNamespace(connection=connection)
        backfill_chat_change_sequences(django_apps, schema_editor)

        first_trip.refresh_from_db()
        second_trip.refresh_from_db()
        user_message.refresh_from_db()
        ai_message.refresh_from_db()
        tombstone.refresh_from_db()
        other_trip_message.refresh_from_db()
        tied_messages = sorted(
            (user_message, ai_message),
            key=lambda message: message.pk,
        )
        self.assertEqual(
            [message.change_sequence for message in tied_messages],
            [1, 2],
        )
        self.assertEqual(tombstone.change_sequence, 3)
        self.assertEqual(first_trip.chat_change_sequence, 3)
        self.assertEqual(other_trip_message.change_sequence, 1)
        self.assertEqual(second_trip.chat_change_sequence, 1)
        self.assertFalse(
            ChatMessage.objects.filter(change_sequence=0).exists()
        )
