from __future__ import annotations

from django.contrib.auth.base_user import BaseUserManager
from django.contrib.auth.password_validation import validate_password


class UserManager(BaseUserManager):
    use_in_migrations = True

    @staticmethod
    def normalize_email_value(email: str) -> str:
        normalized = BaseUserManager.normalize_email(email)
        return normalized.strip().lower()

    def _create_user(self, email: str, password: str, **extra_fields):
        if not email:
            raise ValueError("The Email must be set.")
        if not password:
            raise ValueError("The Password must be set.")

        normalized_email = self.normalize_email_value(email)
        user = self.model(email=normalized_email, **extra_fields)
        validate_password(password, user=user)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        extra_fields.setdefault("is_active", True)
        return self._create_user(email=email, password=password, **extra_fields)

    def create_superuser(self, email: str, password: str, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("is_active", True)

        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")

        return self._create_user(email=email, password=password, **extra_fields)
