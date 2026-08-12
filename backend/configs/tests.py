import logging
import os
import subprocess
import sys
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

from configs.settings import env_int, env_origins, env_positive_int


class SettingsEnvironmentTests(SimpleTestCase):
    def test_env_origins_parses_trimmed_explicit_origins(self):
        with patch.dict(
            os.environ,
            {
                "TEST_ALLOWED_ORIGINS": (
                    " https://app.example.com, http://127.0.0.1:8000 "
                )
            },
            clear=True,
        ):
            self.assertEqual(
                env_origins("TEST_ALLOWED_ORIGINS"),
                ("https://app.example.com", "http://127.0.0.1:8000"),
            )

    def test_env_origins_rejects_missing_or_blank_allowlist(self):
        for value in (None, "", " , "):
            with self.subTest(value=value):
                environment = (
                    {} if value is None else {"TEST_ALLOWED_ORIGINS": value}
                )
                with patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesMessage(
                        ImproperlyConfigured,
                        "TEST_ALLOWED_ORIGINS must contain at least one origin.",
                    ):
                        env_origins("TEST_ALLOWED_ORIGINS")

    def test_env_origins_rejects_permissive_values(self):
        for value in (
            "*",
            "null",
            "https://*.example.com",
        ):
            with self.subTest(value=value):
                with patch.dict(
                    os.environ,
                    {"TEST_ALLOWED_ORIGINS": value},
                    clear=True,
                ):
                    with self.assertRaisesMessage(
                        ImproperlyConfigured,
                        "TEST_ALLOWED_ORIGINS entry 1 must be an explicit "
                        "HTTP(S) origin.",
                    ):
                        env_origins("TEST_ALLOWED_ORIGINS")

    def test_env_origins_rejects_non_origin_urls(self):
        invalid_origins = (
            "ftp://api.example.com",
            "https://user@example.com",
            "https://api.example.com/path",
            "https://api.example.com?query=1",
            "https://api.example.com#fragment",
            "https://api.example.com:not-a-port",
            "http://[::1",
            "http://[]",
            "https://bad host.example",
            "https://example.com\\evil",
            "https://.example.com",
        )
        for value in invalid_origins:
            with self.subTest(value=value):
                with patch.dict(
                    os.environ,
                    {"TEST_ALLOWED_ORIGINS": value},
                    clear=True,
                ):
                    with self.assertRaisesMessage(
                        ImproperlyConfigured,
                        "TEST_ALLOWED_ORIGINS entry 1 must be a valid HTTP(S) origin",
                    ) as raised:
                        env_origins("TEST_ALLOWED_ORIGINS")
                self.assertNotIn(value, str(raised.exception))

    def test_env_origins_redacts_invalid_values_and_discards_validation_context(self):
        marker = "REVIEW_FAKE_SECRET_72"
        cases = (
            f"not-a-url-{marker}",
            f"https://review-user:{marker}@example.com",
        )

        for value in cases:
            with self.subTest(value=value):
                with patch.dict(
                    os.environ,
                    {
                        "TEST_ALLOWED_ORIGINS": (
                            f"https://app.example.com,{value}"
                        )
                    },
                    clear=True,
                ):
                    with self.assertRaisesMessage(
                        ImproperlyConfigured,
                        "TEST_ALLOWED_ORIGINS entry 2",
                    ) as raised:
                        env_origins("TEST_ALLOWED_ORIGINS")

                self.assertNotIn(marker, str(raised.exception))
                self.assertIsNone(raised.exception.__cause__)
                self.assertIsNone(raised.exception.__context__)

    def test_asgi_startup_rejects_unsafe_origin_allowlists(self):
        cases = (
            ("*", "entry 1 must be an explicit HTTP(S) origin"),
            ("", "must contain at least one origin"),
        )
        for value, expected_error in cases:
            with self.subTest(value=value):
                environment = os.environ.copy()
                environment["CORS_ALLOWED_ORIGINS"] = value
                result = subprocess.run(
                    [sys.executable, "-c", "import configs.asgi"],
                    capture_output=True,
                    check=False,
                    env=environment,
                    text=True,
                )

                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected_error, result.stderr)

    def test_asgi_startup_does_not_log_invalid_origin_values(self):
        marker = "REVIEW_FAKE_SECRET_72"
        cases = (
            f"not-a-url-{marker}",
            f"https://review-user:{marker}@example.com",
        )

        for value in cases:
            with self.subTest(value=value):
                environment = os.environ.copy()
                environment["CORS_ALLOWED_ORIGINS"] = value
                result = subprocess.run(
                    [sys.executable, "-c", "import configs.asgi"],
                    capture_output=True,
                    check=False,
                    env=environment,
                    text=True,
                )

                self.assertNotEqual(result.returncode, 0)
                self.assertIn(
                    "CORS_ALLOWED_ORIGINS entry 1 must be a valid HTTP(S) origin",
                    result.stderr,
                )
                self.assertNotIn(marker, result.stderr)

    def test_env_int_uses_default_when_variable_is_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(env_int("DB_CONN_MAX_AGE", 0), 0)

    def test_env_int_parses_integer_value(self):
        with patch.dict(os.environ, {"DB_CONN_MAX_AGE": "60"}):
            self.assertEqual(env_int("DB_CONN_MAX_AGE", 0), 60)

    def test_env_int_rejects_non_integer_value(self):
        with patch.dict(os.environ, {"DB_CONN_MAX_AGE": "not-an-int"}):
            with self.assertRaises(ImproperlyConfigured):
                env_int("DB_CONN_MAX_AGE", 0)

    def test_env_positive_int_uses_default_when_variable_is_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                env_positive_int("HERE_LOCATION_SEARCH_TIMEOUT_SECONDS", 5),
                5,
            )

    def test_env_positive_int_uses_default_when_variable_is_blank(self):
        with patch.dict(
            os.environ,
            {"HERE_LOCATION_SEARCH_TIMEOUT_SECONDS": "  "},
            clear=True,
        ):
            self.assertEqual(
                env_positive_int("HERE_LOCATION_SEARCH_TIMEOUT_SECONDS", 5),
                5,
            )

    def test_env_positive_int_parses_positive_integer_value(self):
        with patch.dict(
            os.environ,
            {"HERE_LOCATION_SEARCH_TIMEOUT_SECONDS": " 12 "},
            clear=True,
        ):
            self.assertEqual(
                env_positive_int("HERE_LOCATION_SEARCH_TIMEOUT_SECONDS", 5),
                12,
            )

    def test_env_positive_int_rejects_non_integer_value(self):
        with patch.dict(
            os.environ,
            {"HERE_LOCATION_SEARCH_TIMEOUT_SECONDS": "not-an-int"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "HERE_LOCATION_SEARCH_TIMEOUT_SECONDS must be a positive integer.",
            ):
                env_positive_int("HERE_LOCATION_SEARCH_TIMEOUT_SECONDS", 5)

    def test_env_positive_int_rejects_zero(self):
        with patch.dict(
            os.environ,
            {"HERE_LOCATION_SEARCH_TIMEOUT_SECONDS": "0"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "HERE_LOCATION_SEARCH_TIMEOUT_SECONDS must be a positive integer.",
            ):
                env_positive_int("HERE_LOCATION_SEARCH_TIMEOUT_SECONDS", 5)

    def test_env_positive_int_rejects_negative_integer(self):
        with patch.dict(
            os.environ,
            {"HERE_LOCATION_SEARCH_TIMEOUT_SECONDS": "-1"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "HERE_LOCATION_SEARCH_TIMEOUT_SECONDS must be a positive integer.",
            ):
                env_positive_int("HERE_LOCATION_SEARCH_TIMEOUT_SECONDS", 5)

    def test_env_positive_int_rejects_non_positive_default(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "HERE_LOCATION_SEARCH_TIMEOUT_SECONDS must be a positive integer.",
            ):
                env_positive_int("HERE_LOCATION_SEARCH_TIMEOUT_SECONDS", 0)

    def test_http_client_request_url_logging_is_disabled_below_warning(self):
        for logger_name in ("httpx", "httpcore"):
            with self.subTest(logger_name=logger_name):
                logger = logging.getLogger(logger_name)
                self.assertFalse(logger.isEnabledFor(logging.INFO))
                self.assertTrue(logger.isEnabledFor(logging.WARNING))
