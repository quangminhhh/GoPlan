from __future__ import annotations

import io
import uuid
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from PIL import Image as PILImage
from rest_framework.test import APITestCase

from accounts.tokens import AccessToken
from memories.models import TripPhoto
from test_helpers import create_completed_user
from trips.models import MemberStatus, Trip, TripMember, TripRole, TripStatus


def _auth(user):
    return {"HTTP_AUTHORIZATION": f"Bearer {AccessToken.for_user(user)}"}


def _make_trip(captain, *, status=TripStatus.PLANNING) -> Trip:
    trip = Trip.objects.create(
        created_by=captain,
        name="Photo API Trip",
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


def _add_member(trip: Trip, user, *, role=TripRole.MEMBER) -> TripMember:
    return TripMember.objects.create(
        trip=trip,
        user=user,
        role=role,
        status=MemberStatus.ACTIVE,
    )


def _photos_url(trip_id) -> str:
    return f"/api/trips/{trip_id}/photos"


def _photo_detail_url(trip_id, photo_id) -> str:
    return f"/api/trips/{trip_id}/photos/{photo_id}"


def _photo_asset_url(trip_id, photo_id, variant: str) -> str:
    return f"/api/trips/{trip_id}/photos/{photo_id}/{variant}"


def _photos_bulk_download_url(trip_id) -> str:
    return f"/api/trips/{trip_id}/photos/download"


def _make_upload(
    *,
    fmt: str = "JPEG",
    filename: str | None = None,
    color: str = "navy",
    size: tuple[int, int] = (1200, 900),
) -> SimpleUploadedFile:
    buf = io.BytesIO()
    PILImage.new("RGB", size, color).save(buf, format=fmt)
    content_type = {
        "JPEG": "image/jpeg",
        "PNG": "image/png",
        "WEBP": "image/webp",
    }[fmt]
    return SimpleUploadedFile(
        filename or f"photo.{fmt.lower()}",
        buf.getvalue(),
        content_type=content_type,
    )


class TripPhotosAPITests(APITestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory()
        self.override = override_settings(
            MEDIA_ROOT=self.tempdir.name,
            TRIP_PHOTO_MAX_BYTES=10 * 1024 * 1024,
            TRIP_PHOTO_MAX_SOURCE_PIXELS=45_000_000,
            TRIP_PHOTO_THUMBNAIL_MAX_EDGE=480,
            TRIP_PHOTO_MEDIUM_MAX_EDGE=2560,
            TRIP_PHOTO_WEBP_QUALITY=84,
            TRIP_PHOTO_MAX_FILES_PER_UPLOAD=20,
        )
        self.override.enable()
        self.captain = create_completed_user("api-photo-cap@example.com", "apiphotocap", "APC001")
        self.member = create_completed_user("api-photo-mem@example.com", "apiphotomem", "APM001")
        self.other = create_completed_user("api-photo-other@example.com", "apiphotooth", "APO001")
        self.trip = _make_trip(self.captain)
        _add_member(self.trip, self.member)

    def tearDown(self) -> None:
        self.override.disable()
        self.tempdir.cleanup()

    def test_member_lists_empty_photos(self):
        response = self.client.get(_photos_url(self.trip.id), **_auth(self.member))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["results"], [])
        self.assertIsNone(response.data["next"])
        self.assertIsNone(response.data["previous"])

    def test_non_member_gets_404_when_listing_photos(self):
        response = self.client.get(_photos_url(self.trip.id), **_auth(self.other))

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")

    def test_member_uploads_multiple_photos_and_list_uses_pagination_envelope(self):
        response = self.client.post(
            _photos_url(self.trip.id),
            {
                "files": [
                    _make_upload(filename="first.jpg", color="red"),
                    _make_upload(fmt="PNG", filename="second.png", color="green"),
                ]
            },
            format="multipart",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(response.data["photos"]), 2)
        self.assertEqual(TripPhoto.objects.count(), 2)
        first_payload = response.data["photos"][0]
        self.assertEqual(first_payload["uploaded_by"]["id"], str(self.member.id))
        self.assertTrue(first_payload["can_delete"])

        list_response = self.client.get(_photos_url(self.trip.id), **_auth(self.member))
        self.assertEqual(list_response.status_code, 200)
        self.assertIn("results", list_response.data)
        self.assertEqual(len(list_response.data["results"]), 2)

    def test_member_can_request_larger_photo_page_size(self):
        TripPhoto.objects.bulk_create(
            [
                TripPhoto(
                    trip=self.trip,
                    uploaded_by=self.member,
                    original_filename=f"photo-{index}.jpg",
                    original_width=1200,
                    original_height=900,
                    thumbnail=f"trip-photos/photo-{index}-thumb.webp",
                    medium=f"trip-photos/photo-{index}-medium.webp",
                    thumbnail_width=480,
                    thumbnail_height=360,
                    medium_width=1200,
                    medium_height=900,
                )
                for index in range(3)
            ]
        )

        response = self.client.get(
            f"{_photos_url(self.trip.id)}?page_size=2",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data["results"]), 2)
        self.assertIsNotNone(response.data["next"])

    def test_non_member_cannot_upload_photos(self):
        response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.other),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")
        self.assertEqual(TripPhoto.objects.count(), 0)

    def test_upload_rejects_more_than_max_files_with_error_code(self):
        response = self.client.post(
            _photos_url(self.trip.id),
            {
                "files": [
                    _make_upload(filename=f"photo-{index}.jpg")
                    for index in range(21)
                ]
            },
            format="multipart",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "TOO_MANY_FILES")
        self.assertEqual(TripPhoto.objects.count(), 0)

    def test_uploader_can_delete_own_photo(self):
        upload_response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )
        photo_id = upload_response.data["photos"][0]["id"]

        response = self.client.delete(
            _photo_detail_url(self.trip.id, photo_id),
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 204)
        self.assertFalse(TripPhoto.objects.filter(pk=photo_id).exists())

    def test_member_can_retrieve_one_photo_as_authoritative_delete_probe(self):
        upload_response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )
        uploaded = upload_response.data["photos"][0]

        response = self.client.get(
            _photo_detail_url(self.trip.id, uploaded["id"]),
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, uploaded)

    def test_detail_probe_returns_photo_not_found_after_delete(self):
        upload_response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )
        photo_id = upload_response.data["photos"][0]["id"]
        self.client.delete(
            _photo_detail_url(self.trip.id, photo_id),
            **_auth(self.member),
        )

        response = self.client.get(
            _photo_detail_url(self.trip.id, photo_id),
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "PHOTO_NOT_FOUND")

    def test_captain_can_delete_member_photo(self):
        upload_response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )
        photo_id = upload_response.data["photos"][0]["id"]

        response = self.client.delete(
            _photo_detail_url(self.trip.id, photo_id),
            **_auth(self.captain),
        )

        self.assertEqual(response.status_code, 204)
        self.assertFalse(TripPhoto.objects.filter(pk=photo_id).exists())

    def test_member_cannot_delete_other_member_photo(self):
        second_member = create_completed_user("second-photo@example.com", "secondphoto", "APS002")
        _add_member(self.trip, second_member)
        upload_response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )
        photo_id = upload_response.data["photos"][0]["id"]

        response = self.client.delete(
            _photo_detail_url(self.trip.id, photo_id),
            **_auth(second_member),
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.data["error_code"], "PHOTO_DELETE_FORBIDDEN")
        self.assertTrue(TripPhoto.objects.filter(pk=photo_id).exists())

    def test_member_fetches_thumbnail_and_medium(self):
        upload_response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )
        photo_id = upload_response.data["photos"][0]["id"]

        thumbnail = self.client.get(
            _photo_asset_url(self.trip.id, photo_id, "thumbnail"),
            **_auth(self.member),
        )
        medium = self.client.get(
            _photo_asset_url(self.trip.id, photo_id, "medium"),
            **_auth(self.member),
        )

        self.assertEqual(thumbnail.status_code, 200)
        self.assertEqual(thumbnail["Content-Type"], "image/webp")
        self.assertEqual(thumbnail["Cache-Control"], "private, no-store")
        self.assertGreater(len(b"".join(thumbnail.streaming_content)), 0)
        self.assertEqual(medium.status_code, 200)
        self.assertEqual(medium["Content-Type"], "image/webp")
        self.assertEqual(medium["Cache-Control"], "private, no-store")

    def test_non_member_cannot_fetch_photo_asset(self):
        upload_response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )
        photo_id = upload_response.data["photos"][0]["id"]

        response = self.client.get(
            _photo_asset_url(self.trip.id, photo_id, "thumbnail"),
            **_auth(self.other),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")

    def test_member_of_another_trip_cannot_fetch_photo_with_wrong_trip_id(self):
        upload_response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )
        photo_id = upload_response.data["photos"][0]["id"]
        other_trip = _make_trip(self.other)

        response = self.client.get(
            _photo_asset_url(other_trip.id, photo_id, "thumbnail"),
            **_auth(self.other),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "PHOTO_NOT_FOUND")

    def test_completed_trip_allows_photo_upload(self):
        self.trip.status = TripStatus.COMPLETED
        self.trip.save(update_fields=["status"])

        response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(TripPhoto.objects.count(), 1)

    def test_cancelled_trip_rejects_photo_upload(self):
        self.trip.status = TripStatus.CANCELLED
        self.trip.save(update_fields=["status"])

        response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload()]},
            format="multipart",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["error_code"], "TRIP_TERMINAL")
        self.assertEqual(TripPhoto.objects.count(), 0)

    def test_mixed_valid_invalid_batch_creates_no_db_records_and_leaves_no_files(self):
        response = self.client.post(
            _photos_url(self.trip.id),
            {
                "files": [
                    _make_upload(filename="valid.jpg"),
                    SimpleUploadedFile(
                        "bad.svg",
                        b"<svg></svg>",
                        content_type="image/svg+xml",
                    ),
                ]
            },
            format="multipart",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "UNSUPPORTED_IMAGE_TYPE")
        self.assertEqual(TripPhoto.objects.count(), 0)
        self.assertEqual(
            [path for path in Path(self.tempdir.name).rglob("*") if path.is_file()],
            [],
        )

    # -------- Single photo download --------

    def _upload_photo(self, *, filename="photo.jpg", color="navy"):
        response = self.client.post(
            _photos_url(self.trip.id),
            {"files": [_make_upload(filename=filename, color=color)]},
            format="multipart",
            **_auth(self.member),
        )
        self.assertEqual(response.status_code, 201)
        return response.data["photos"][0]["id"]

    def test_member_downloads_single_photo_as_webp_attachment(self):
        photo_id = self._upload_photo(filename="Hạ Long Bay.jpg")

        response = self.client.get(
            _photo_asset_url(self.trip.id, photo_id, "download"),
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/webp")
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertIn("attachment;", response["Content-Disposition"])
        self.assertTrue(response["Content-Disposition"].endswith('.webp"'))
        self.assertGreater(len(b"".join(response.streaming_content)), 0)

    def test_non_member_cannot_download_single_photo(self):
        photo_id = self._upload_photo()

        response = self.client.get(
            _photo_asset_url(self.trip.id, photo_id, "download"),
            **_auth(self.other),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")

    def test_download_unknown_photo_returns_404(self):
        response = self.client.get(
            _photo_asset_url(self.trip.id, uuid.uuid4(), "download"),
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "PHOTO_NOT_FOUND")

    # -------- Bulk ZIP download --------

    def test_member_bulk_downloads_selected_photos_as_zip(self):
        first = self._upload_photo(filename="alpha.jpg", color="red")
        second = self._upload_photo(filename="beta.png", color="green")

        response = self.client.post(
            _photos_bulk_download_url(self.trip.id),
            {"photo_ids": [first, second]},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/zip")
        self.assertIn("attachment;", response["Content-Disposition"])
        self.assertTrue(response["Content-Disposition"].endswith('.zip"'))

        payload = b"".join(response.streaming_content)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            names = archive.namelist()
            self.assertEqual(len(names), 2)
            for name in names:
                self.assertTrue(name.endswith(".webp"))
                self.assertGreater(len(archive.read(name)), 0)

    def test_bulk_download_de_duplicates_colliding_entry_names(self):
        first = self._upload_photo(filename="same.jpg", color="red")
        second = self._upload_photo(filename="same.png", color="green")

        response = self.client.post(
            _photos_bulk_download_url(self.trip.id),
            {"photo_ids": [first, second]},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 200)
        payload = b"".join(response.streaming_content)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            names = archive.namelist()
        self.assertEqual(len(names), len(set(names)))

    def test_bulk_download_rejects_empty_selection(self):
        response = self.client.post(
            _photos_bulk_download_url(self.trip.id),
            {"photo_ids": []},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)

    def test_bulk_download_rejects_photo_from_another_trip(self):
        photo_id = self._upload_photo()
        other_trip = _make_trip(self.other)

        response = self.client.post(
            _photos_bulk_download_url(other_trip.id),
            {"photo_ids": [photo_id]},
            format="json",
            **_auth(self.other),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "PHOTO_NOT_FOUND")

    def test_non_member_cannot_bulk_download(self):
        photo_id = self._upload_photo()

        response = self.client.post(
            _photos_bulk_download_url(self.trip.id),
            {"photo_ids": [photo_id]},
            format="json",
            **_auth(self.other),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error_code"], "TRIP_NOT_FOUND")

    @override_settings(TRIP_PHOTO_MAX_DOWNLOAD_FILES=1)
    def test_bulk_download_rejects_too_many_photos(self):
        first = self._upload_photo(filename="one.jpg", color="red")
        second = self._upload_photo(filename="two.png", color="green")

        response = self.client.post(
            _photos_bulk_download_url(self.trip.id),
            {"photo_ids": [first, second]},
            format="json",
            **_auth(self.member),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["error_code"], "PHOTO_DOWNLOAD_TOO_MANY")
