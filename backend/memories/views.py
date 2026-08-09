from __future__ import annotations

import uuid

from django.conf import settings
from django.http import FileResponse, StreamingHttpResponse
from rest_framework import permissions, status
from rest_framework.pagination import CursorPagination
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsProfileCompleted
from memories.memory_video_services import (
    MemoryVideoDeleteBlockedError,
    MemoryVideoNotFoundError,
    MemoryVideoNotReadyError,
    MemoryVideoPermissionError,
    MemoryVideoServiceError,
    MemoryVideoValidationError,
    create_trip_memory_video,
    delete_trip_memory_video,
    disable_memory_share_link,
    enable_memory_share_link,
    get_private_memory_download_file,
    get_private_memory_poster_file,
    get_private_memory_video_file,
    get_public_memory_poster_file,
    get_public_memory_video,
    get_public_memory_video_file,
    get_trip_memory_video,
    list_trip_memory_video_statuses,
    list_trip_memory_videos,
    memory_photo_limits,
    update_trip_memory_video,
)
from memories.memory_video_streaming import range_streaming_response, safe_mp4_filename
from memories.photo_zip import iter_trip_photos_zip
from memories.serializers import (
    PublicTripMemoryVideoSerializer,
    TripMemoryVideoCreateSerializer,
    TripMemoryVideoSerializer,
    TripMemoryVideoUpdateSerializer,
    TripPhotoBulkDownloadSerializer,
    TripPhotoSerializer,
    TripPhotoUploadSerializer,
    memory_video_validation_error_code,
)
from memories.services import (
    TripPhotoDeleteForbiddenError,
    TripPhotoNotFoundError,
    TripPhotoServiceError,
    TripPhotoStorageError,
    TripPhotoValidationError,
    create_trip_photos,
    delete_trip_photo,
    get_trip_photo,
    get_trip_photo_asset,
    get_trip_photo_download,
    get_trip_photos_for_download,
    list_trip_photos,
    safe_trip_photos_zip_filename,
    _get_active_membership,
)
from trips.services import TripNotFoundError, TripTerminalError

TRIP_PHOTO_PERMISSIONS = [permissions.IsAuthenticated, IsProfileCompleted]
TRIP_MEMORY_PERMISSIONS = [permissions.IsAuthenticated, IsProfileCompleted]
PUBLIC_MEMORY_NOT_FOUND_DETAIL = "Memory video not found."
PUBLIC_MEMORY_NOT_FOUND_CODE = "MEMORY_NOT_FOUND"
PUBLIC_MEMORY_METADATA_CACHE_CONTROL = "no-store"
PUBLIC_MEMORY_ASSET_CACHE_CONTROL = "no-store"
MAX_MEMORY_STATUS_IDS = 10


class TripPhotoPagination(CursorPagination):
    page_size = 20
    page_size_query_param = "page_size"
    max_page_size = 60
    ordering = ("-created_at", "-id")
    cursor_query_param = "cursor"


class TripMemoryVideoPagination(CursorPagination):
    page_size = 20
    page_size_query_param = "page_size"
    max_page_size = 60
    ordering = ("-created_at", "-id")
    cursor_query_param = "cursor"


def _error_response(detail: str, error_code: str, status_code: int) -> Response:
    return Response(
        {"detail": detail, "error_code": error_code},
        status=status_code,
    )


def _map_service_error(exc: Exception) -> Response | None:
    if isinstance(exc, TripNotFoundError):
        return _error_response(str(exc), exc.error_code, status.HTTP_404_NOT_FOUND)
    if isinstance(exc, TripTerminalError):
        return _error_response(str(exc), exc.error_code, status.HTTP_409_CONFLICT)
    if isinstance(exc, TripPhotoDeleteForbiddenError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_403_FORBIDDEN)
    if isinstance(exc, TripPhotoNotFoundError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_404_NOT_FOUND)
    if isinstance(exc, TripPhotoValidationError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_400_BAD_REQUEST)
    if isinstance(exc, TripPhotoStorageError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_500_INTERNAL_SERVER_ERROR)
    if isinstance(exc, TripPhotoServiceError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_400_BAD_REQUEST)
    if isinstance(exc, MemoryVideoPermissionError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_403_FORBIDDEN)
    if isinstance(exc, MemoryVideoNotFoundError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_404_NOT_FOUND)
    if isinstance(exc, MemoryVideoDeleteBlockedError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_409_CONFLICT)
    if isinstance(exc, MemoryVideoNotReadyError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_409_CONFLICT)
    if isinstance(exc, MemoryVideoValidationError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_400_BAD_REQUEST)
    if isinstance(exc, MemoryVideoServiceError):
        return _error_response(exc.detail, exc.error_code, status.HTTP_400_BAD_REQUEST)
    return None


def _memory_serializer_context(request, membership) -> dict:
    return {
        "request": request,
        "actor": request.user,
        "membership": membership,
        "public_base_url": settings.PUBLIC_APP_BASE_URL,
    }


def _memory_serializer_validation_error(errors) -> Response:
    return _error_response(
        "Invalid memory video request.",
        memory_video_validation_error_code(errors),
        status.HTTP_400_BAD_REQUEST,
    )


def _parse_memory_status_ids(query_params) -> list[str]:
    raw_ids = query_params.getlist("ids")
    if len(raw_ids) > MAX_MEMORY_STATUS_IDS:
        raise MemoryVideoValidationError(
            "MEMORY_INVALID_REQUEST",
            f"Request at most {MAX_MEMORY_STATUS_IDS} memory ids.",
        )

    parsed_ids = []
    for raw_id in raw_ids:
        try:
            parsed_ids.append(str(uuid.UUID(str(raw_id))))
        except (TypeError, ValueError) as exc:
            raise MemoryVideoValidationError(
                "MEMORY_INVALID_REQUEST",
                "Memory status ids must be valid UUIDs.",
            ) from exc
    return parsed_ids


def _public_memory_not_found_response() -> Response:
    return _error_response(
        PUBLIC_MEMORY_NOT_FOUND_DETAIL,
        PUBLIC_MEMORY_NOT_FOUND_CODE,
        status.HTTP_404_NOT_FOUND,
    )


def _memory_asset_not_found_response() -> Response:
    return _error_response(
        "Memory video not found.",
        "MEMORY_NOT_FOUND",
        status.HTTP_404_NOT_FOUND,
    )


class TripPhotoListCreateAPIView(APIView):
    permission_classes = TRIP_PHOTO_PERMISSIONS
    parser_classes = [MultiPartParser, FormParser]
    throttle_scope = "trip_photos_list"

    def get_throttles(self):
        self.throttle_scope = (
            "trip_photos_upload" if self.request.method == "POST" else "trip_photos_list"
        )
        return super().get_throttles()

    def get(self, request, trip_id):
        try:
            membership = _get_active_membership(trip_id, request.user)
            queryset = list_trip_photos(trip_id=trip_id, actor=request.user)
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        paginator = TripPhotoPagination()
        page = paginator.paginate_queryset(queryset, request)
        serializer = TripPhotoSerializer(
            page,
            many=True,
            context={"actor": request.user, "membership": membership},
        )
        return paginator.get_paginated_response(serializer.data)

    def post(self, request, trip_id):
        serializer = TripPhotoUploadSerializer(
            data={"files": request.FILES.getlist("files")},
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        try:
            membership = _get_active_membership(trip_id, request.user)
            photos = create_trip_photos(
                trip_id=trip_id,
                actor=request.user,
                files=serializer.validated_data["files"],
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        return Response(
            {
                "photos": TripPhotoSerializer(
                    photos,
                    many=True,
                    context={"actor": request.user, "membership": membership},
                ).data
            },
            status=status.HTTP_201_CREATED,
        )


class TripPhotoDetailAPIView(APIView):
    permission_classes = TRIP_PHOTO_PERMISSIONS
    throttle_scope = "trip_photos_detail"

    def get(self, request, trip_id, photo_id):
        try:
            membership, photo = get_trip_photo(
                trip_id=trip_id,
                photo_id=photo_id,
                actor=request.user,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        return Response(
            TripPhotoSerializer(
                photo,
                context={"actor": request.user, "membership": membership},
            ).data,
            status=status.HTTP_200_OK,
        )

    def delete(self, request, trip_id, photo_id):
        try:
            delete_trip_photo(trip_id=trip_id, photo_id=photo_id, actor=request.user)
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response
        return Response(status=status.HTTP_204_NO_CONTENT)


class TripPhotoAssetAPIView(APIView):
    permission_classes = TRIP_PHOTO_PERMISSIONS
    throttle_scope = "trip_photo_assets"

    def get_throttles(self):
        self.throttle_scope = (
            "trip_photos_download"
            if self.kwargs.get("variant") == "download"
            else "trip_photo_assets"
        )
        return super().get_throttles()

    def get(self, request, trip_id, photo_id, variant: str):
        if variant == "download":
            return self._download(request, trip_id, photo_id)

        try:
            field = get_trip_photo_asset(
                trip_id=trip_id,
                photo_id=photo_id,
                actor=request.user,
                variant=variant,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        response = FileResponse(field.storage.open(field.name, "rb"), content_type="image/webp")
        response.headers["Cache-Control"] = "private, no-store"
        return response

    def _download(self, request, trip_id, photo_id):
        try:
            field, filename = get_trip_photo_download(
                trip_id=trip_id,
                photo_id=photo_id,
                actor=request.user,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        response = range_streaming_response(
            field=field,
            range_header=request.headers.get("Range"),
            content_type="image/webp",
            content_disposition=f'attachment; filename="{filename}"',
        )
        response.headers["Cache-Control"] = "private, no-store"
        return response


class TripPhotoBulkDownloadAPIView(APIView):
    permission_classes = TRIP_PHOTO_PERMISSIONS
    throttle_scope = "trip_photos_bulk_download"

    def post(self, request, trip_id):
        serializer = TripPhotoBulkDownloadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            membership, entries = get_trip_photos_for_download(
                trip_id=trip_id,
                photo_ids=serializer.validated_data["photo_ids"],
                actor=request.user,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        filename = safe_trip_photos_zip_filename(membership.trip.name)
        response = StreamingHttpResponse(
            iter_trip_photos_zip(entries),
            content_type="application/zip",
        )
        response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
        response.headers["Cache-Control"] = "private, no-store"
        return response


class TripMemoryVideoListCreateAPIView(APIView):
    permission_classes = TRIP_MEMORY_PERMISSIONS
    throttle_scope = "trip_memories_list"

    def get_throttles(self):
        self.throttle_scope = (
            "trip_memories_create" if self.request.method == "POST" else "trip_memories_list"
        )
        return super().get_throttles()

    def get(self, request, trip_id):
        try:
            membership = _get_active_membership(trip_id, request.user)
            queryset = list_trip_memory_videos(trip_id=trip_id, actor=request.user)
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        paginator = TripMemoryVideoPagination()
        page = paginator.paginate_queryset(queryset, request)
        serializer = TripMemoryVideoSerializer(
            page,
            many=True,
            context=_memory_serializer_context(request, membership),
        )
        return paginator.get_paginated_response(serializer.data)

    def post(self, request, trip_id):
        try:
            membership = _get_active_membership(trip_id, request.user)
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        serializer = TripMemoryVideoCreateSerializer(
            data=request.data,
            context={"request": request},
        )
        if not serializer.is_valid():
            return _memory_serializer_validation_error(serializer.errors)

        try:
            memory = create_trip_memory_video(
                trip_id=trip_id,
                actor=request.user,
                title=serializer.validated_data["title"],
                source_mode=serializer.validated_data["source_mode"],
                photo_ids=serializer.validated_data["photo_ids"],
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        return Response(
            {
                "memory": TripMemoryVideoSerializer(
                    memory,
                    context=_memory_serializer_context(request, membership),
                ).data
            },
            status=status.HTTP_201_CREATED,
        )


class TripMemoryVideoStatusAPIView(APIView):
    permission_classes = TRIP_MEMORY_PERMISSIONS
    throttle_scope = "trip_memories_status"

    def get(self, request, trip_id):
        try:
            memory_ids = _parse_memory_status_ids(request.query_params)
            membership = _get_active_membership(trip_id, request.user)
            memories = list_trip_memory_video_statuses(
                trip_id=trip_id,
                actor=request.user,
                memory_ids=memory_ids,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        return Response(
            {
                "results": TripMemoryVideoSerializer(
                    memories,
                    many=True,
                    context=_memory_serializer_context(request, membership),
                ).data
            }
        )


class TripMemoryVideoCreateOptionsAPIView(APIView):
    permission_classes = TRIP_MEMORY_PERMISSIONS
    throttle_scope = "trip_memories_detail"

    def get(self, request, trip_id):
        try:
            _get_active_membership(trip_id, request.user)
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        return Response({"photo_limits": memory_photo_limits()})


class TripMemoryVideoDetailAPIView(APIView):
    permission_classes = TRIP_MEMORY_PERMISSIONS
    throttle_scope = "trip_memories_detail"

    def get(self, request, trip_id, memory_id):
        try:
            membership = _get_active_membership(trip_id, request.user)
            memory = get_trip_memory_video(
                trip_id=trip_id,
                memory_id=memory_id,
                actor=request.user,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        return Response(
            {
                "memory": TripMemoryVideoSerializer(
                    memory,
                    context=_memory_serializer_context(request, membership),
                ).data
            }
        )

    def patch(self, request, trip_id, memory_id):
        try:
            membership = _get_active_membership(trip_id, request.user)
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        serializer = TripMemoryVideoUpdateSerializer(
            data=request.data,
            context={"request": request},
        )
        if not serializer.is_valid():
            return _memory_serializer_validation_error(serializer.errors)

        try:
            memory = update_trip_memory_video(
                trip_id=trip_id,
                memory_id=memory_id,
                actor=request.user,
                title=serializer.validated_data["title"],
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        return Response(
            {
                "memory": TripMemoryVideoSerializer(
                    memory,
                    context=_memory_serializer_context(request, membership),
                ).data
            }
        )

    def delete(self, request, trip_id, memory_id):
        try:
            delete_trip_memory_video(
                trip_id=trip_id,
                memory_id=memory_id,
                actor=request.user,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response
        return Response(status=status.HTTP_204_NO_CONTENT)


class TripMemoryVideoAssetAPIView(APIView):
    permission_classes = TRIP_MEMORY_PERMISSIONS
    throttle_scope = "trip_memory_assets"

    def get(self, request, trip_id, memory_id, variant: str):
        try:
            if variant == "video":
                asset = get_private_memory_video_file(
                    trip_id=trip_id,
                    memory_id=memory_id,
                    actor=request.user,
                )
                response = range_streaming_response(
                    field=asset.field,
                    range_header=request.headers.get("Range"),
                    content_type="video/mp4",
                    content_disposition="inline",
                )
                response.headers["Cache-Control"] = "private, no-store"
            elif variant == "download":
                asset = get_private_memory_download_file(
                    trip_id=trip_id,
                    memory_id=memory_id,
                    actor=request.user,
                )
                filename = safe_mp4_filename(asset.memory.title)
                response = range_streaming_response(
                    field=asset.field,
                    range_header=request.headers.get("Range"),
                    content_type="video/mp4",
                    content_disposition=f'attachment; filename="{filename}"',
                )
                response.headers["Cache-Control"] = "private, no-store"
            elif variant == "poster":
                asset = get_private_memory_poster_file(
                    trip_id=trip_id,
                    memory_id=memory_id,
                    actor=request.user,
                )
                field = asset.field
                response = FileResponse(
                    field.storage.open(field.name, "rb"),
                    content_type="image/webp",
                )
                response.headers["Content-Length"] = str(field.size)
                response.headers["Cache-Control"] = "private, no-store"
            else:
                raise MemoryVideoNotFoundError(
                    "MEMORY_NOT_FOUND",
                    "Memory video asset not found.",
                )
        except OSError:
            return _memory_asset_not_found_response()
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        return response


class TripMemoryVideoShareLinkAPIView(APIView):
    permission_classes = TRIP_MEMORY_PERMISSIONS
    throttle_scope = "trip_memory_share_link"

    def post(self, request, trip_id, memory_id):
        try:
            membership = _get_active_membership(trip_id, request.user)
            memory, _url = enable_memory_share_link(
                trip_id=trip_id,
                memory_id=memory_id,
                actor=request.user,
                public_base_url=settings.PUBLIC_APP_BASE_URL,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        payload = TripMemoryVideoSerializer(
            memory,
            context=_memory_serializer_context(request, membership),
        ).data
        return Response({"share": payload["share"]})

    def delete(self, request, trip_id, memory_id):
        try:
            membership = _get_active_membership(trip_id, request.user)
            memory = disable_memory_share_link(
                trip_id=trip_id,
                memory_id=memory_id,
                actor=request.user,
            )
        except Exception as exc:
            response = _map_service_error(exc)
            if response is None:
                raise
            return response

        payload = TripMemoryVideoSerializer(
            memory,
            context=_memory_serializer_context(request, membership),
        ).data
        return Response({"share": payload["share"]})


class PublicTripMemoryVideoDetailAPIView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_scope = "public_memory_detail"

    def get(self, request, share_slug: str):
        try:
            memory = get_public_memory_video(share_slug=share_slug)
        except MemoryVideoNotFoundError:
            return _public_memory_not_found_response()

        serializer = PublicTripMemoryVideoSerializer(
            memory,
            context={"request": request},
        )
        response = Response(serializer.data)
        response.headers["Cache-Control"] = PUBLIC_MEMORY_METADATA_CACHE_CONTROL
        return response


class PublicTripMemoryVideoAssetAPIView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_scope = "public_memory_assets"

    def get(self, request, share_slug: str, variant: str):
        try:
            if variant == "video":
                asset = get_public_memory_video_file(share_slug=share_slug)
                response = range_streaming_response(
                    field=asset.field,
                    range_header=request.headers.get("Range"),
                    content_type="video/mp4",
                    content_disposition="inline",
                )
                response.headers["Cache-Control"] = PUBLIC_MEMORY_ASSET_CACHE_CONTROL
                return response

            if variant == "poster":
                asset = get_public_memory_poster_file(share_slug=share_slug)
                field = asset.field
                response = FileResponse(
                    field.storage.open(field.name, "rb"),
                    content_type="image/webp",
                )
                response.headers["Content-Length"] = str(field.size)
                response.headers["Cache-Control"] = PUBLIC_MEMORY_ASSET_CACHE_CONTROL
                return response
        except (MemoryVideoNotFoundError, OSError, FileNotFoundError):
            return _public_memory_not_found_response()

        return _public_memory_not_found_response()
