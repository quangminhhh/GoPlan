from __future__ import annotations

from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView


class HealthCheckAPIView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, *args, **kwargs):
        payload = {
            "status": "ok",
            "service": "backend",
            "timestamp": timezone.now().isoformat(),
        }
        return Response(payload, status=status.HTTP_200_OK)
