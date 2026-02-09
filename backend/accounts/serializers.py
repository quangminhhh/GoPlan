from __future__ import annotations

from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework import serializers
from rest_framework_simplejwt.exceptions import InvalidToken
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken, TokenError

User = get_user_model()


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, min_length=8, trim_whitespace=False)

    def validate_email(self, value: str) -> str:
        normalized_email = User.objects.normalize_email_value(value)
        if User.objects.filter(email=normalized_email).exists():
            raise serializers.ValidationError("A user with this email already exists.")
        return normalized_email

    def validate_password(self, value: str) -> str:
        candidate_user = User(email=self.initial_data.get("email", ""))
        try:
            validate_password(value, user=candidate_user)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages)) from exc
        return value

    def create(self, validated_data):
        try:
            with transaction.atomic():
                return User.objects.create_user(
                    email=validated_data["email"],
                    password=validated_data["password"],
                )
        except IntegrityError as exc:
            raise serializers.ValidationError({"email": ["A user with this email already exists."]}) from exc


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate(self, attrs):
        email = User.objects.normalize_email_value(attrs["email"])
        password = attrs["password"]
        request = self.context.get("request")

        user = authenticate(request=request, email=email, password=password)
        if user is None or not user.is_active:
            raise AuthenticationFailed("Invalid email or password.")

        attrs["user"] = user
        return attrs


class RefreshTokenSerializer(serializers.Serializer):
    refresh = serializers.CharField(write_only=True)

    def validate(self, attrs):
        token_serializer = TokenRefreshSerializer(data={"refresh": attrs["refresh"]})
        try:
            token_serializer.is_valid(raise_exception=True)
        except TokenError as exc:
            raise InvalidToken(exc.args[0]) from exc
        return token_serializer.validated_data


class LogoutSerializer(serializers.Serializer):
    refresh = serializers.CharField(write_only=True)

    def validate(self, attrs):
        request = self.context["request"]
        refresh_value = attrs["refresh"]

        try:
            token = RefreshToken(refresh_value)
        except TokenError:
            attrs["token"] = None
            return attrs

        token_user_id = token.payload.get("user_id")
        if token_user_id is None:
            attrs["token"] = None
            return attrs

        if str(token_user_id) != str(request.user.id):
            raise PermissionDenied("You cannot revoke a token that does not belong to the authenticated user.")

        attrs["token"] = token
        return attrs

    def save(self, **kwargs):
        token = self.validated_data.get("token")
        if token is None:
            return None

        try:
            token.blacklist()
        except TokenError:
            # Idempotent behavior: token may already be invalid/blacklisted.
            return None

        return None
