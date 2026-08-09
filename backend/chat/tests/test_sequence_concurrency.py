from __future__ import annotations

import threading
from unittest.mock import patch
from uuid import uuid4

from django.db import close_old_connections, connections
from django.test import TransactionTestCase

from chat.models import ChatMessage
from chat.services import send_chat_message
from test_helpers import create_completed_user
from trips.models import MemberStatus, Trip, TripMember, TripRole


class ChatChangeSequenceConcurrencyTests(TransactionTestCase):

    def test_concurrent_sends_allocate_distinct_monotonic_trip_sequences(self):
        captain = create_completed_user(
            "sequence-concurrency-cap@example.com",
            "seqconcap",
            "SCC001",
        )
        member = create_completed_user(
            "sequence-concurrency-mem@example.com",
            "seqconmem",
            "SCM001",
        )
        trip = Trip.objects.create(
            created_by=captain,
            name="Sequence concurrency",
            destination="Da Nang",
            start_date="2026-06-01",
            end_date="2026-06-05",
        )
        TripMember.objects.create(
            trip=trip,
            user=captain,
            role=TripRole.CAPTAIN,
            status=MemberStatus.ACTIVE,
        )
        TripMember.objects.create(
            trip=trip,
            user=member,
            role=TripRole.MEMBER,
            status=MemberStatus.ACTIVE,
        )
        start = threading.Barrier(3)
        outcomes = []
        outcome_lock = threading.Lock()

        def send(user, content):
            close_old_connections()
            try:
                start.wait(timeout=5)
                message, created = send_chat_message(
                    user=user,
                    trip_id=trip.id,
                    content=content,
                    client_message_id=uuid4(),
                )
                outcome = (message.change_sequence, created, None)
            except Exception as exc:  # pragma: no cover - asserted below
                outcome = (None, None, exc)
            finally:
                close_old_connections()
                connections.close_all()
            with outcome_lock:
                outcomes.append(outcome)

        with patch("chat.services.push_chat_message"):
            threads = [
                threading.Thread(target=send, args=(captain, "Captain message")),
                threading.Thread(target=send, args=(member, "Member message")),
            ]
            for thread in threads:
                thread.start()
            start.wait(timeout=5)
            for thread in threads:
                thread.join(timeout=5)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual([error for _, _, error in outcomes], [None, None])
        self.assertEqual(sorted(sequence for sequence, _, _ in outcomes), [1, 2])
        self.assertTrue(all(created for _, created, _ in outcomes))
        self.assertEqual(
            sorted(
                ChatMessage.objects.filter(trip=trip).values_list(
                    "change_sequence",
                    flat=True,
                )
            ),
            [1, 2],
        )
        trip.refresh_from_db()
        self.assertEqual(trip.chat_change_sequence, 2)
