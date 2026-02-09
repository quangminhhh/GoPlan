from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework_simplejwt.tokens import RefreshToken

User = get_user_model()


def build_auth_response(user: User) -> dict:
    refresh = RefreshToken.for_user(user)
    return {
        "user": {
            "id": str(user.id),
            "email": user.email,
        },
        "tokens": {
            "access": str(refresh.access_token),
            "refresh": str(refresh),
            "token_type": "Bearer",
        },
    }
