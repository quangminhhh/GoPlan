from __future__ import annotations

import uuid

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

User = get_user_model()


class AuthAPITestCase(APITestCase):
    register_url = "/api/auth/register"
    login_url = "/api/auth/login"
    refresh_url = "/api/auth/refresh"
    logout_url = "/api/auth/logout"

    @staticmethod
    def issue_tokens_for_user(user):
        refresh = RefreshToken.for_user(user)
        return {
            "access": str(refresh.access_token),
            "refresh": str(refresh),
        }

    def test_register_success_returns_tokens_and_uuid(self):
        payload = {"email": "owner@example.com", "password": "StrongPass#2026"}
        response = self.client.post(self.register_url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(User.objects.count(), 1)
        self.assertEqual(response.data["user"]["email"], payload["email"])
        self.assertIn("access", response.data["tokens"])
        self.assertIn("refresh", response.data["tokens"])
        uuid.UUID(response.data["user"]["id"])

    def test_register_rejects_duplicate_email(self):
        User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        payload = {"email": "OWNER@EXAMPLE.COM", "password": "StrongPass#2026"}

        response = self.client.post(self.register_url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("email", response.data)

    def test_register_normalizes_email_to_lowercase(self):
        payload = {"email": "Owner@Example.Com", "password": "StrongPass#2026"}
        response = self.client.post(self.register_url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["user"]["email"], "owner@example.com")

    def test_register_rejects_weak_password(self):
        payload = {"email": "owner@example.com", "password": "12345678"}
        response = self.client.post(self.register_url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("password", response.data)

    def test_login_success(self):
        User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        payload = {"email": "owner@example.com", "password": "StrongPass#2026"}

        response = self.client.post(self.login_url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["user"]["email"], payload["email"])
        self.assertIn("access", response.data["tokens"])

    def test_login_rejects_wrong_password(self):
        User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        payload = {"email": "owner@example.com", "password": "WrongPass#2026"}

        response = self.client.post(self.login_url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_login_accepts_case_insensitive_email(self):
        User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        payload = {"email": "OWNER@EXAMPLE.COM", "password": "StrongPass#2026"}

        response = self.client.post(self.login_url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["user"]["email"], "owner@example.com")

    def test_refresh_success_returns_new_access_and_refresh(self):
        user = User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        tokens = self.issue_tokens_for_user(user)

        response = self.client.post(self.refresh_url, {"refresh": tokens["refresh"]}, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("access", response.data)
        self.assertIn("refresh", response.data)
        self.assertNotEqual(response.data["refresh"], tokens["refresh"])

    def test_refresh_invalid_token_returns_401(self):
        response = self.client.post(self.refresh_url, {"refresh": "invalid-token"}, format="json")

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(response.data["code"], "token_not_valid")

    def test_refresh_missing_field_returns_400(self):
        response = self.client.post(self.refresh_url, {}, format="json")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("refresh", response.data)

    def test_logout_requires_access_token(self):
        user = User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        tokens = self.issue_tokens_for_user(user)

        response = self.client.post(self.logout_url, {"refresh": tokens["refresh"]}, format="json")

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_logout_success_blacklists_refresh(self):
        user = User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        tokens = self.issue_tokens_for_user(user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

        response = self.client.post(self.logout_url, {"refresh": tokens["refresh"]}, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["detail"], "Logout successful.")

        refresh_response = self.client.post(self.refresh_url, {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(refresh_response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_logout_is_idempotent_for_blacklisted_or_invalid_refresh(self):
        user = User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        tokens = self.issue_tokens_for_user(user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

        first_response = self.client.post(self.logout_url, {"refresh": tokens["refresh"]}, format="json")
        second_response = self.client.post(self.logout_url, {"refresh": tokens["refresh"]}, format="json")
        invalid_response = self.client.post(self.logout_url, {"refresh": "invalid-token"}, format="json")

        self.assertEqual(first_response.status_code, status.HTTP_200_OK)
        self.assertEqual(second_response.status_code, status.HTTP_200_OK)
        self.assertEqual(invalid_response.status_code, status.HTTP_200_OK)

    def test_logout_rejects_refresh_of_another_user_with_403(self):
        owner_user = User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        other_user = User.objects.create_user(email="other@example.com", password="StrongPass#2026")
        owner_tokens = self.issue_tokens_for_user(owner_user)
        other_tokens = self.issue_tokens_for_user(other_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {owner_tokens['access']}")

        response = self.client.post(self.logout_url, {"refresh": other_tokens["refresh"]}, format="json")

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_logout_missing_refresh_returns_400(self):
        user = User.objects.create_user(email="owner@example.com", password="StrongPass#2026")
        tokens = self.issue_tokens_for_user(user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

        response = self.client.post(self.logout_url, {}, format="json")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("refresh", response.data)
