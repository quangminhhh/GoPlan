from __future__ import annotations

import io
import logging
import re
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import PurePath
from typing import Iterable

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from PIL import Image, ImageOps

from media.image_validation import (
    ALLOWED_WEB_IMAGE_FORMATS,
    ImageProbeResult,
    ImageValidationError,
    detect_image_format_from_header,
    validate_pillow_image,
)
from memories.models import TripPhoto
from trips.models import MemberStatus, Trip, TripMember, TripRole, TripStatus
from trips.services import TripNotFoundError, TripTerminalError

logger = logging.getLogger(__name__)


class TripPhotoServiceError(Exception):
    error_code = "TRIP_PHOTO_ERROR"

    def __init__(self, error_code: str | None = None, detail: str | None = None) -> None:
        self.error_code = error_code or self.error_code
        self.detail = detail or "Trip photo request failed."
        super().__init__(self.detail)


class TripPhotoValidationError(TripPhotoServiceError):
    error_code = "PHOTO_INVALID_IMAGE"


class TripPhotoStorageError(TripPhotoServiceError):
    error_code = "PHOTO_STORAGE_ERROR"


class TripPhotoNotFoundError(TripPhotoServiceError):
    error_code = "PHOTO_NOT_FOUND"


class TripPhotoDeleteForbiddenError(TripPhotoServiceError):
    error_code = "PHOTO_DELETE_FORBIDDEN"


@dataclass(frozen=True)
class PreparedTripPhoto:
    original_filename: str
    original_width: int
    original_height: int
    thumbnail_content: ContentFile
    thumbnail_width: int
    thumbnail_height: int
    medium_content: ContentFile
    medium_width: int
    medium_height: int


@dataclass(frozen=True)
class ValidatedTripPhotoUpload:
    image_file: object
    probe: ImageProbeResult


def _setting(name: str, default: int) -> int:
    return int(getattr(settings, name, default))


def _max_files_per_upload() -> int:
    return _setting("TRIP_PHOTO_MAX_FILES_PER_UPLOAD", 20)


def _max_bytes() -> int:
    return _setting("TRIP_PHOTO_MAX_BYTES", 10 * 1024 * 1024)


def _max_upload_bytes() -> int:
    return _setting("TRIP_PHOTO_MAX_UPLOAD_BYTES", 50 * 1024 * 1024)


def _max_source_pixels() -> int:
    return _setting("TRIP_PHOTO_MAX_SOURCE_PIXELS", 45_000_000)


def _max_upload_source_pixels() -> int:
    return _setting("TRIP_PHOTO_MAX_UPLOAD_SOURCE_PIXELS", 90_000_000)


def _max_decoded_bytes() -> int:
    return _setting("TRIP_PHOTO_MAX_DECODED_BYTES", 160 * 1024 * 1024)


def _thumbnail_max_edge() -> int:
    return _setting("TRIP_PHOTO_THUMBNAIL_MAX_EDGE", 480)


def _medium_max_edge() -> int:
    return _setting("TRIP_PHOTO_MEDIUM_MAX_EDGE", 2560)


def _webp_quality() -> int:
    return _setting("TRIP_PHOTO_WEBP_QUALITY", 84)


def _max_download_files() -> int:
    return _setting("TRIP_PHOTO_MAX_DOWNLOAD_FILES", 100)


def _get_active_membership(trip_id, actor, *, for_update: bool = False):
    if for_update:
        try:
            trip = Trip.objects.select_for_update().get(pk=trip_id)
        except Trip.DoesNotExist as exc:
            raise TripNotFoundError("Trip not found.") from exc
        try:
            membership = TripMember.objects.select_for_update().get(
                trip=trip,
                user=actor,
                status=MemberStatus.ACTIVE,
            )
        except TripMember.DoesNotExist as exc:
            raise TripNotFoundError("Trip not found.") from exc
        membership.trip = trip
        return membership

    queryset = TripMember.objects.select_related("trip").filter(
        trip_id=trip_id,
        user=actor,
        status=MemberStatus.ACTIVE,
    )
    try:
        return queryset.get()
    except TripMember.DoesNotExist as exc:
        raise TripNotFoundError("Trip not found.") from exc


def _assert_trip_accepts_photo_mutation(status: str) -> None:
    if status == TripStatus.CANCELLED:
        raise TripTerminalError("Cancelled trips cannot change photos.")


def list_trip_photos(*, trip_id, actor):
    _get_active_membership(trip_id, actor)
    return (
        TripPhoto.objects
        .filter(trip_id=trip_id)
        .select_related("uploaded_by")
        .order_by("-created_at", "-id")
    )


def _detect_source_format(image_file) -> str:
    image_file.seek(0)
    header = image_file.read(512)
    image_file.seek(0)
    try:
        return detect_image_format_from_header(header)
    except ImageValidationError as exc:
        raise TripPhotoValidationError(exc.error_code, exc.detail) from exc


def _validate_upload_count(files: list) -> None:
    if not files:
        raise TripPhotoValidationError("NO_FILES", "Select at least one photo to upload.")
    if len(files) > _max_files_per_upload():
        raise TripPhotoValidationError(
            "TOO_MANY_FILES",
            f"Upload at most {_max_files_per_upload()} photos at a time.",
        )


def _file_size_bytes(image_file) -> int:
    try:
        return max(0, int(getattr(image_file, "size", 0) or 0))
    except (TypeError, ValueError):
        return 0


def _validate_upload_total_bytes(files: list) -> None:
    total_bytes = sum(_file_size_bytes(image_file) for image_file in files)
    if total_bytes > _max_upload_bytes():
        raise TripPhotoValidationError(
            "PHOTO_UPLOAD_TOO_LARGE",
            f"Upload at most {_max_upload_bytes() // (1024 * 1024)} MiB of photos at a time.",
        )


def _source_pixel_count(probe: ImageProbeResult) -> int:
    return probe.width * probe.height


def _estimated_bytes_per_pixel(probe: ImageProbeResult) -> int:
    if probe.has_transparency or probe.mode in {"RGBA", "LA"}:
        return 4
    if probe.mode in {"RGB", "YCbCr"}:
        return 3
    if probe.mode in {"L", "P", "1"}:
        return 1
    if probe.mode == "CMYK":
        return 4
    return 4


def _validate_upload_total_source_pixels(probes: Iterable[ImageProbeResult]) -> None:
    total_pixels = sum(_source_pixel_count(probe) for probe in probes)
    if total_pixels > _max_upload_source_pixels():
        raise TripPhotoValidationError(
            "PHOTO_DIMENSIONS_TOO_LARGE",
            "Upload contains too many total source pixels.",
        )


def _validate_decoded_byte_budget(probe: ImageProbeResult) -> None:
    decoded_bytes = _source_pixel_count(probe) * _estimated_bytes_per_pixel(probe)
    if decoded_bytes > _max_decoded_bytes():
        raise TripPhotoValidationError(
            "PHOTO_DIMENSIONS_TOO_LARGE",
            "Photo dimensions are too large to process safely.",
        )


def _safe_original_filename(image_file) -> str:
    raw_name = getattr(image_file, "name", "") or ""
    return PurePath(raw_name).name[:160]


def _validate_image_file(image_file) -> ImageProbeResult:
    size = getattr(image_file, "size", 0)
    if size > _max_bytes():
        raise TripPhotoValidationError(
            "PHOTO_TOO_LARGE",
            f"Photo exceeds {_max_bytes() // (1024 * 1024)} MiB limit.",
        )

    expected_format = _detect_source_format(image_file)
    try:
        probe = validate_pillow_image(
            image_file,
            expected_format=expected_format,
            allowed_formats=ALLOWED_WEB_IMAGE_FORMATS,
            max_source_pixels=_max_source_pixels(),
        )
        _validate_decoded_byte_budget(probe)
    except TripPhotoValidationError:
        raise
    except ImageValidationError as exc:
        raise TripPhotoValidationError(exc.error_code, exc.detail) from exc
    finally:
        image_file.seek(0)
    return probe


def _validate_image_uploads(files: list) -> list[ValidatedTripPhotoUpload]:
    validated_uploads = [
        ValidatedTripPhotoUpload(
            image_file=image_file,
            probe=_validate_image_file(image_file),
        )
        for image_file in files
    ]
    _validate_upload_total_source_pixels(item.probe for item in validated_uploads)
    return validated_uploads


def _to_clean_rgb(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA") or "transparency" in image.info:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")


def _resize_to_max_edge(image: Image.Image, max_edge: int) -> Image.Image:
    output = image.copy()
    if max(output.size) > max_edge:
        output.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    return output


def _encode_webp(image: Image.Image) -> ContentFile:
    output = io.BytesIO()
    image.save(output, format="WEBP", quality=_webp_quality(), method=6)
    return ContentFile(output.getvalue())


def _render_trip_photo_variants(
    image_file,
    *,
    probe: ImageProbeResult | None = None,
) -> PreparedTripPhoto:
    if probe is None:
        _validate_image_file(image_file)
    try:
        image_file.seek(0)
        with Image.open(image_file) as source:
            normalized = ImageOps.exif_transpose(source)
            normalized.load()
            clean = _to_clean_rgb(normalized)
            thumbnail = _resize_to_max_edge(clean, _thumbnail_max_edge())
            medium = _resize_to_max_edge(clean, _medium_max_edge())
            return PreparedTripPhoto(
                original_filename=_safe_original_filename(image_file),
                original_width=clean.width,
                original_height=clean.height,
                thumbnail_content=_encode_webp(thumbnail),
                thumbnail_width=thumbnail.width,
                thumbnail_height=thumbnail.height,
                medium_content=_encode_webp(medium),
                medium_width=medium.width,
                medium_height=medium.height,
            )
    except TripPhotoValidationError:
        raise
    except ImageValidationError as exc:
        raise TripPhotoValidationError(exc.error_code, exc.detail) from exc
    except (
        OSError,
        ValueError,
        SyntaxError,
        Image.DecompressionBombError,
    ) as exc:
        raise TripPhotoValidationError(
            "PHOTO_INVALID_IMAGE",
            "Photo could not be parsed safely.",
        ) from exc
    finally:
        image_file.seek(0)


def _variant_storage_name(trip_id, suffix: str) -> str:
    return f"trip-photos/{trip_id}/{uuid.uuid4().hex}_{suffix}.webp"


def _save_trip_photo_file(storage_name: str, content: ContentFile) -> str:
    content.seek(0)
    return default_storage.save(storage_name, content)


def _delete_storage_file_best_effort(name: str) -> None:
    try:
        default_storage.delete(name)
    except Exception:
        logger.warning("Failed to clean up trip photo storage file %s", name, exc_info=True)


def _delete_many_best_effort(names: Iterable[str]) -> None:
    for name in names:
        _delete_storage_file_best_effort(name)


def _build_photo_records(*, trip, actor, prepared_items: list[PreparedTripPhoto]) -> list[TripPhoto]:
    saved_names: list[str] = []
    created_photos: list[TripPhoto] = []
    try:
        for item in prepared_items:
            thumbnail_name = _save_trip_photo_file(
                _variant_storage_name(trip.id, "thumb"),
                item.thumbnail_content,
            )
            saved_names.append(thumbnail_name)
            medium_name = _save_trip_photo_file(
                _variant_storage_name(trip.id, "medium"),
                item.medium_content,
            )
            saved_names.append(medium_name)
            created_photos.append(
                TripPhoto(
                    trip=trip,
                    uploaded_by=actor,
                    uploaded_by_display_name_snapshot=actor.display_name,
                    uploaded_by_identify_tag_snapshot=actor.identify_tag,
                    original_filename=item.original_filename,
                    original_width=item.original_width,
                    original_height=item.original_height,
                    thumbnail=thumbnail_name,
                    medium=medium_name,
                    thumbnail_width=item.thumbnail_width,
                    thumbnail_height=item.thumbnail_height,
                    medium_width=item.medium_width,
                    medium_height=item.medium_height,
                )
            )

        with transaction.atomic():
            return list(TripPhoto.objects.bulk_create(created_photos))
    except TripPhotoServiceError:
        _delete_many_best_effort(saved_names)
        raise
    except Exception as exc:
        _delete_many_best_effort(saved_names)
        raise TripPhotoStorageError(
            "PHOTO_STORAGE_ERROR",
            "Could not store trip photo safely. Please try again.",
        ) from exc


def create_trip_photos(*, trip_id, actor, files: list) -> list[TripPhoto]:
    _validate_upload_count(files)
    _validate_upload_total_bytes(files)
    membership = _get_active_membership(trip_id, actor)
    trip = membership.trip
    _assert_trip_accepts_photo_mutation(trip.status)

    validated_uploads = _validate_image_uploads(files)
    prepared_items = [
        _render_trip_photo_variants(item.image_file, probe=item.probe)
        for item in validated_uploads
    ]
    with transaction.atomic():
        locked_membership = _get_active_membership(trip_id, actor, for_update=True)
        _assert_trip_accepts_photo_mutation(locked_membership.trip.status)
        return _build_photo_records(
            trip=locked_membership.trip,
            actor=actor,
            prepared_items=prepared_items,
        )


def _get_photo_for_member(*, trip_id, photo_id, actor, for_update: bool = False):
    membership = _get_active_membership(trip_id, actor, for_update=for_update)
    queryset = TripPhoto.objects.filter(
        pk=photo_id,
        trip_id=trip_id,
    )
    if for_update:
        queryset = queryset.select_for_update()
    else:
        queryset = queryset.select_related("uploaded_by")
    try:
        return membership, queryset.get()
    except TripPhoto.DoesNotExist as exc:
        raise TripPhotoNotFoundError("PHOTO_NOT_FOUND", "Photo not found.") from exc


def get_trip_photo(*, trip_id, photo_id, actor):
    """Return one photo together with the membership used for its permissions."""
    return _get_photo_for_member(
        trip_id=trip_id,
        photo_id=photo_id,
        actor=actor,
    )


def delete_trip_photo(*, trip_id, photo_id, actor) -> None:
    with transaction.atomic():
        membership, photo = _get_photo_for_member(
            trip_id=trip_id,
            photo_id=photo_id,
            actor=actor,
            for_update=True,
        )
        _assert_trip_accepts_photo_mutation(membership.trip.status)

        can_delete = (
            photo.uploaded_by_id == actor.id
            or membership.role == TripRole.CAPTAIN
        )
        if not can_delete:
            raise TripPhotoDeleteForbiddenError(
                "PHOTO_DELETE_FORBIDDEN",
                "You do not have permission to delete this photo.",
            )

        thumbnail_name = photo.thumbnail.name
        medium_name = photo.medium.name
        photo.delete()

    _delete_storage_file_best_effort(thumbnail_name)
    _delete_storage_file_best_effort(medium_name)


def get_trip_photo_asset(*, trip_id, photo_id, actor, variant: str):
    _membership, photo = _get_photo_for_member(
        trip_id=trip_id,
        photo_id=photo_id,
        actor=actor,
    )
    if variant == "thumbnail":
        return photo.thumbnail
    if variant == "medium":
        return photo.medium
    raise TripPhotoNotFoundError("PHOTO_NOT_FOUND", "Photo not found.")


# -------- Photo download --------


def safe_photo_filename(original_filename: str, photo_id) -> str:
    """Build an ASCII-safe ``.webp`` download filename from the original name.

    Stored photos are always WebP, so the extension is forced to ``.webp``
    regardless of the original upload extension.
    """
    ascii_name = (
        unicodedata.normalize("NFKD", original_filename or "")
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", PurePath(ascii_name).stem).strip("._-")
    if not stem:
        stem = f"photo-{photo_id.hex if hasattr(photo_id, 'hex') else str(photo_id)}"
    return f"{stem}.webp"


def safe_trip_photos_zip_filename(trip_name: str) -> str:
    """Build an ASCII-safe ``.zip`` filename for a bulk photo download."""
    ascii_name = (
        unicodedata.normalize("NFKD", trip_name or "")
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", ascii_name).strip("._-")
    if not stem:
        stem = "trip"
    return f"{stem}-photos.zip"


def get_trip_photo_download(*, trip_id, photo_id, actor):
    """Return ``(field, filename)`` for a single photo download (medium WebP)."""
    _membership, photo = _get_photo_for_member(
        trip_id=trip_id,
        photo_id=photo_id,
        actor=actor,
    )
    return photo.medium, safe_photo_filename(photo.original_filename, photo.id)


def _unique_zip_name(name: str, seen: set[str]) -> str:
    if name not in seen:
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    suffix = 2
    while True:
        candidate = f"{stem} ({suffix}).{ext}" if ext else f"{stem} ({suffix})"
        if candidate not in seen:
            return candidate
        suffix += 1


def _build_download_entries(photos) -> list[tuple[str, object]]:
    entries: list[tuple[str, object]] = []
    seen: set[str] = set()
    for photo in photos:
        name = _unique_zip_name(
            safe_photo_filename(photo.original_filename, photo.id), seen
        )
        seen.add(name)
        entries.append((name, photo.medium))
    return entries


def get_trip_photos_for_download(*, trip_id, photo_ids, actor):
    """Validate access and resolve the requested photos for a bulk download.

    Returns ``(membership, entries)`` where ``entries`` is an ordered list of
    ``(zip_entry_name, medium_field)`` pairs with de-duplicated entry names.
    Raises ``TripPhotoNotFoundError`` if any id does not belong to the trip.
    """
    membership = _get_active_membership(trip_id, actor)

    # De-duplicate while preserving the requested order.
    ordered_ids: list = []
    seen_ids: set = set()
    for photo_id in photo_ids:
        if photo_id not in seen_ids:
            seen_ids.add(photo_id)
            ordered_ids.append(photo_id)

    if not ordered_ids:
        raise TripPhotoValidationError(
            "PHOTO_DOWNLOAD_EMPTY",
            "Select at least one photo to download.",
        )
    if len(ordered_ids) > _max_download_files():
        raise TripPhotoValidationError(
            "PHOTO_DOWNLOAD_TOO_MANY",
            "Too many photos selected for download.",
        )

    photos_by_id = {
        photo.id: photo
        for photo in TripPhoto.objects.filter(trip_id=trip_id, pk__in=ordered_ids)
    }
    missing = [photo_id for photo_id in ordered_ids if photo_id not in photos_by_id]
    if missing:
        raise TripPhotoNotFoundError(
            "PHOTO_NOT_FOUND",
            "One or more selected photos were not found.",
        )

    ordered_photos = [photos_by_id[photo_id] for photo_id in ordered_ids]
    return membership, _build_download_entries(ordered_photos)
