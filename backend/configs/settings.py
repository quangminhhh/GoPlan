import os
import sys

from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.validators import URLValidator
from PIL import Image as _PILImage

# Process-wide hard guard for extreme decompression bombs. Every Image.open path
# that accepts user-controlled files must enforce a local pixel/dimension cap
# before storing files; do not rely on this global ceiling as feature validation.
_PILImage.MAX_IMAGE_PIXELS = 50_000_000


BASE_DIR = Path(__file__).resolve().parent.parent
_HTTP_ORIGIN_VALIDATOR = URLValidator(schemes=("http", "https"))


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_list(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "")
    return tuple(item.strip() for item in raw.split(",") if item.strip())


def env_origins(name: str) -> tuple[str, ...]:
    origins = env_list(name)
    if not origins:
        raise ImproperlyConfigured(f"{name} must contain at least one origin.")

    for origin in origins:
        lowered_origin = origin.lower()
        if lowered_origin == "null" or "*" in origin:
            raise ImproperlyConfigured(
                f"{name} must contain only explicit HTTP(S) origins."
            )

        try:
            _HTTP_ORIGIN_VALIDATOR(origin)
            parsed = urlsplit(origin)
            hostname = parsed.hostname
            _ = parsed.port
        except (ValidationError, ValueError) as exc:
            raise ImproperlyConfigured(
                f"{name} contains an invalid origin: {origin}."
            ) from exc

        if (
            parsed.scheme not in {"http", "https"}
            or hostname is None
            or hostname.startswith(".")
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or parsed.netloc.endswith(":")
        ):
            raise ImproperlyConfigured(
                f"{name} contains an invalid origin: {origin}."
            )

    return origins


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default

    try:
        return int(raw)
    except ValueError as exc:
        raise ImproperlyConfigured(f"{name} must be an integer.") from exc


def env_positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        value = default
    else:
        try:
            value = int(raw)
        except ValueError as exc:
            raise ImproperlyConfigured(
                f"{name} must be a positive integer."
            ) from exc

    if value <= 0:
        raise ImproperlyConfigured(f"{name} must be a positive integer.")

    return value


# -------- Core Flags --------
DEBUG = os.environ.get('DJANGO_DEBUG') == '1'
SECRET_KEY = os.environ['DJANGO_SECRET_KEY']
ALLOWED_HOSTS = os.environ['DJANGO_ALLOWED_HOSTS'].split(',')
_RAW_FRONTEND_BASE_URL = os.environ.get('FRONTEND_BASE_URL')
_RAW_PUBLIC_APP_BASE_URL = os.environ.get("PUBLIC_APP_BASE_URL")
if not DEBUG and not (_RAW_FRONTEND_BASE_URL or _RAW_PUBLIC_APP_BASE_URL):
    raise RuntimeError("Set PUBLIC_APP_BASE_URL or FRONTEND_BASE_URL in production.")
FRONTEND_BASE_URL = _RAW_FRONTEND_BASE_URL or 'http://localhost:3000'
PUBLIC_APP_BASE_URL = (_RAW_PUBLIC_APP_BASE_URL or FRONTEND_BASE_URL).rstrip('/')
DEV_THROTTLE_BYPASS_ENABLED = DEBUG and env_bool("DEV_THROTTLE_BYPASS_ENABLED", False)
DEV_THROTTLE_BYPASS_EMAILS = (
    env_list("DEV_THROTTLE_BYPASS_EMAILS") if DEV_THROTTLE_BYPASS_ENABLED else ()
)
GOPLAN_INTERNAL_PROXY_SECRET = os.environ.get("GOPLAN_INTERNAL_PROXY_SECRET", "")

# -------- Installed Apps --------
INSTALLED_APPS = [
    'daphne',

    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',

    # Third-party apps
    'corsheaders',
    'rest_framework',
    'rest_framework_simplejwt',
    'rest_framework_simplejwt.token_blacklist',
    'channels',

    # Local apps
    'api',
    'accounts',
    'realtime',
    'notifications',
    'friends',
    'trips',
    'expenses',
    'ai.apps.AIConfig',
    'chat',
    'media',
    'memories',
    'location_search',

]

# -------- Middleware Chain --------
MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'configs.urls'

# WSGI entrypoint (traditional HTTP)
WSGI_APPLICATION = 'configs.wsgi.application'

# ASGI entrypoint (HTTP + WebSocket via Channels/Daphne)
ASGI_APPLICATION = 'configs.asgi.application'

# -------- Templates --------
TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {'context_processors': [
            'django.template.context_processors.request',
            'django.contrib.auth.context_processors.auth',
            'django.contrib.messages.context_processors.messages',
        ]},
    },
]

# -------- Database (PostgreSQL) --------
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.environ['DB_NAME'],
        'USER': os.environ['DB_USER'],
        'PASSWORD': os.environ['DB_PASSWORD'],
        'HOST': os.environ['DB_HOST'],
        'PORT': os.environ['DB_PORT'],
        'CONN_MAX_AGE': env_int('DB_CONN_MAX_AGE', 0),
    }
}

# -------- Authentication Policies --------
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# -------- Locale --------
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'Asia/Ho_Chi_Minh'
USE_I18N = True
USE_TZ = True

# -------- Static Files --------
STATIC_URL = 'static/'

# -------- Media Files --------
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media_files'

STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
    },
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
    },
}
UPLOAD_MAX_BYTES = 5 * 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = UPLOAD_MAX_BYTES
FILE_UPLOAD_MAX_MEMORY_SIZE = UPLOAD_MAX_BYTES
# Trip covers accept camera-sized sources and are downscaled server-side,
# mirroring the trip-photo pipeline limits below.
TRIP_COVER_MAX_BYTES = 10 * 1024 * 1024
TRIP_COVER_MAX_SOURCE_PIXELS = 45_000_000
TRIP_COVER_MAX_EDGE = 2560
TRIP_COVER_WEBP_QUALITY = 84
TRIP_PHOTO_MAX_FILES_PER_UPLOAD = 20
TRIP_PHOTO_MAX_BYTES = 10 * 1024 * 1024
TRIP_PHOTO_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
TRIP_PHOTO_MAX_SOURCE_PIXELS = 45_000_000
TRIP_PHOTO_MAX_UPLOAD_SOURCE_PIXELS = 90_000_000
TRIP_PHOTO_MAX_DECODED_BYTES = 160 * 1024 * 1024
TRIP_PHOTO_THUMBNAIL_MAX_EDGE = 480
TRIP_PHOTO_MEDIUM_MAX_EDGE = 2560
TRIP_PHOTO_WEBP_QUALITY = 84
TRIP_MEMORY_MIN_PHOTOS = 5
TRIP_MEMORY_MAX_PHOTOS = 50
TRIP_MEMORY_AUTO_PICK_PHOTOS = 20
TRIP_MEMORY_RENDER_QUEUE = "memory_render"
TRIP_MEMORY_VIDEO_WIDTH = 1920
TRIP_MEMORY_VIDEO_HEIGHT = 1080
TRIP_MEMORY_VIDEO_FPS = 30
TRIP_MEMORY_SECONDS_PER_PHOTO = 4
# Cinematic render tuning (Ken Burns motion + crossfade + blurred fill).
TRIP_MEMORY_TRANSITION_SECONDS = 0.8
TRIP_MEMORY_VIDEO_FADE_SECONDS = 0.8
TRIP_MEMORY_KEN_BURNS_ZOOM = 0.12
TRIP_MEMORY_KEN_BURNS_SUPERSAMPLE = 2.5
TRIP_MEMORY_BACKGROUND_BLUR_SIGMA = 20
TRIP_MEMORY_VIDEO_PRESET = "faster"
TRIP_MEMORY_RENDER_STALE_SECONDS = 15 * 60
TRIP_MEMORY_RENDER_ACTIVE_RETRY_MAX_RETRIES = 3
TRIP_MEMORY_FFMPEG_TIMEOUT_SECONDS = 540
TRIP_MEMORY_RENDER_SOFT_TIME_LIMIT_SECONDS = 600
TRIP_MEMORY_RENDER_TIME_LIMIT_SECONDS = 720
TRIP_MEMORY_RENDER_SECONDS_PER_PHOTO_BUDGET = 24
TRIP_MEMORY_RENDER_TIME_LIMIT_GRACE_SECONDS = 120
TRIP_MEMORY_RENDER_MAX_RECOVERIES = 2
TRIP_MEMORY_MAX_ACTIVE_PER_USER_PER_TRIP = 1
TRIP_MEMORY_MAX_ACTIVE_PER_TRIP = 3

# -------- Cross-Origin Settings --------
CORS_ALLOWED_ORIGINS = env_origins('CORS_ALLOWED_ORIGINS')
CSRF_TRUSTED_ORIGINS = os.environ['CSRF_TRUSTED_ORIGINS'].split(',')

SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SAMESITE = 'Lax'

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True

# -------- Cache (throttle counters, shared state) --------
# DRF throttling stores its counters in the default cache. It must live in
# Redis so counts are consistent across worker processes and survive restarts;
# LocMemCache would silently reset on every autoreload/deploy.
REDIS_CACHE_URL = os.environ.get('REDIS_CACHE_URL', 'redis://localhost:6379/3')

TESTING = 'test' in sys.argv

if TESTING:
    # Tests must stay hermetic: no Redis dependency, and throttle counters
    # must never leak between test runs.
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        }
    }
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': REDIS_CACHE_URL,
        }
    }

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# REST Framework Defaults
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'accounts.authentication.JWTAuthentication',
    ),
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    'DEFAULT_THROTTLE_CLASSES': (
        'accounts.throttling.DevBypassAnonRateThrottle',
        'accounts.throttling.DevBypassUserRateThrottle',
        'accounts.throttling.DevBypassScopedRateThrottle',
    ),
    'DEFAULT_THROTTLE_RATES': {
        'anon': '30/minute',
        'user': '60/minute',
        'auth_login': '20/hour',
        'auth_register': '10/hour',
        'auth_refresh': '10/minute',
        'auth_me': '30/minute',
        'auth_logout': '30/hour',
        'auth_profile_setup': '20/hour',
        'auth_profile_name': '60/hour',
        'auth_verify_email': '10/hour',
        'auth_resend_verification': '5/hour',
        'auth_password_reset_request': '5/hour',
        'auth_password_reset_confirm': '10/hour',
        'auth_avatar': '10/hour',
        'auth_password_change': '5/hour',
        'realtime_ws_ticket': '20/minute',
        'notifications_list': '120/hour',
        'notifications_unread_count': '300/hour',
        'notifications_mark_read': '120/hour',
        'notifications_mark_all_read': '60/hour',
        'friends_send_request': '30/hour',
        'friends_requests_list': '120/hour',
        'friends_respond': '60/hour',
        'friends_list': '120/hour',
        'friends_remove': '30/hour',
        'friends_search': '60/hour',
        'media_upload': '30/hour',
        'public_media': '600/hour',
        'trip_photos_list': '120/hour',
        'trip_photos_upload': '30/hour',
        'trip_photos_detail': '120/hour',
        'trip_photo_assets': '600/hour',
        'trip_photos_download': '300/hour',
        'trip_photos_bulk_download': '30/hour',
        'trip_memories_list': '120/hour',
        'trip_memories_create': '30/hour',
        'trip_memories_detail': '120/hour',
        'trip_memories_status': '600/hour',
        'trip_memory_assets': '600/hour',
        'trip_memory_share_link': '60/hour',
        'public_memory_detail': '600/hour',
        'public_memory_assets': '600/hour',
        'trips_list_create': '60/hour',
        'trips_detail_update': '120/hour',
        'trips_invitations_list': '240/hour',
        'trips_send_invitations': '10/hour',
        'trips_invitable_friends': '60/hour',
        'trips_accept_invitation': '30/hour',
        'trips_decline_invitation': '30/hour',
        'trips_start': '20/hour',
        'trips_complete': '20/hour',
        'trips_cancel': '20/hour',
        'trips_remove_member': '30/hour',
        'trips_leave': '30/hour',
        'trips_timeline_detail': '240/hour',
        'trips_timeline_sections': '120/hour',
        'trips_timeline_section_detail': '120/hour',
        'trips_timeline_activities': '240/hour',
        'trips_timeline_activity_detail': '240/hour',
        'trips_timeline_activity_status': '240/hour',
        'trips_timeline_custom_types': '60/hour',
        'trips_timeline_custom_type_detail': '60/hour',
        'expenses_list_create': '120/hour',
        'expenses_detail': '120/hour',
        'expenses_contributions': '240/hour',
        'chat_send': '60/minute',
        'chat_ai_prompt': '20/hour',
        'ai_action_draft': '60/hour',
        'ai_action_confirm': '30/hour',
        'chat_reaction': '120/minute',
        'chat_delete': '60/minute',
        'settlement_finalize': '30/hour',
        'settlement_reopen': '20/hour',
        'settlement_transfer_action': '240/hour',
        'location_suggest': '30/minute',
        'location_lookup': '30/minute',
        'ws_ticket_refresh': '20/minute',
    },
}

if TESTING:
    # The anon bucket is keyed by REMOTE_ADDR, which is always 127.0.0.1 in
    # tests, so the whole suite shares one bucket and would trip it. Scoped
    # per-endpoint rates keep production values; dedicated throttle tests
    # patch rates and clear the cache themselves.
    REST_FRAMEWORK['DEFAULT_THROTTLE_RATES'] = {
        **REST_FRAMEWORK['DEFAULT_THROTTLE_RATES'],
        'anon': '1000/minute',
    }

if not DEBUG:
    REST_FRAMEWORK['DEFAULT_RENDERER_CLASSES'] = (
        'rest_framework.renderers.JSONRenderer',
    )

# JWT Settings
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=15),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'UPDATE_LAST_LOGIN': True,
    'AUTH_HEADER_TYPES': ('Bearer',),
    'AUTH_TOKEN_CLASSES': ('accounts.tokens.AccessToken',),
    'USER_ID_FIELD': 'id',
    'USER_ID_CLAIM': 'user_id',
}

# Custom User Model
AUTH_USER_MODEL = 'accounts.User'

# -------- Email Backend --------
EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend'
EMAIL_HOST = os.environ.get('EMAIL_HOST', 'localhost')
EMAIL_PORT = int(os.environ.get('EMAIL_PORT', '1025'))
EMAIL_USE_TLS = os.environ.get('EMAIL_USE_TLS', '0') == '1'
EMAIL_USE_SSL = os.environ.get('EMAIL_USE_SSL', '0') == '1'
EMAIL_HOST_USER = os.environ.get('EMAIL_HOST_USER', '')
EMAIL_HOST_PASSWORD = os.environ.get('EMAIL_HOST_PASSWORD', '')
DEFAULT_FROM_EMAIL = os.environ.get('DEFAULT_FROM_EMAIL', 'noreply@goplan.app')

# -------- Password Reset --------
PASSWORD_RESET_TIMEOUT = 3600  # 1 hour

# -------- Email Verification --------
EMAIL_VERIFICATION_MAX_AGE_SECONDS = 60 * 60 * 24  # 24 hours
# MongoDB Integration
# MONGO_URL = os.environ.get('MONGO_URL')
# MONGO_DB = os.environ.get('MONGO_DB')

# -------- Celery Configuration --------
CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/1")
CELERY_RESULT_BACKEND = os.environ.get("CELERY_RESULT_BACKEND", "redis://localhost:6379/2")
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_TIME_LIMIT = int(os.environ.get("CELERY_TASK_TIME_LIMIT", "120"))
CELERY_TASK_SOFT_TIME_LIMIT = int(os.environ.get("CELERY_TASK_SOFT_TIME_LIMIT", "90"))
CELERY_TASK_ROUTES = {
    "memories.tasks.render_trip_memory_video_task": {"queue": TRIP_MEMORY_RENDER_QUEUE},
}

# -------- HERE Location Search --------
ENABLE_HERE_LOCATION_SEARCH = env_bool("ENABLE_HERE_LOCATION_SEARCH", False)
HERE_API_KEY = os.environ.get("HERE_API_KEY", "")
HERE_LOCATION_SEARCH_TIMEOUT_SECONDS = env_positive_int(
    "HERE_LOCATION_SEARCH_TIMEOUT_SECONDS",
    5,
)
HERE_LOCATION_SEARCH_SUGGEST_CACHE_TTL_SECONDS = env_positive_int(
    "HERE_LOCATION_SEARCH_SUGGEST_CACHE_TTL_SECONDS",
    60,
)
HERE_LOCATION_SEARCH_LOOKUP_CACHE_TTL_SECONDS = env_positive_int(
    "HERE_LOCATION_SEARCH_LOOKUP_CACHE_TTL_SECONDS",
    300,
)

# -------- DeepSeek AI Configuration --------
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")
DEEPSEEK_TIMEOUT_SECONDS = int(os.environ.get("DEEPSEEK_TIMEOUT_SECONDS", "60"))
DEEPSEEK_MAX_OUTPUT_TOKENS = int(os.environ.get("DEEPSEEK_MAX_OUTPUT_TOKENS", "4000"))
GOPLAN_AI_LOCK_TTL_SECONDS = int(os.environ.get("GOPLAN_AI_LOCK_TTL_SECONDS", "120"))
GOPLAN_AI_MAX_ATTEMPTS = int(os.environ.get("GOPLAN_AI_MAX_ATTEMPTS", "3"))
GOPLAN_AI_ACTION_DRAFT_TTL_SECONDS = int(
    os.environ.get("GOPLAN_AI_ACTION_DRAFT_TTL_SECONDS", str(60 * 60 * 24))
)
GOPLAN_AI_CONTEXT_RECENT_CHAT_LIMIT = int(
    os.environ.get("GOPLAN_AI_CONTEXT_RECENT_CHAT_LIMIT", "20")
)
GOPLAN_AI_CONTEXT_TIMELINE_ACTIVITY_LIMIT = int(
    os.environ.get("GOPLAN_AI_CONTEXT_TIMELINE_ACTIVITY_LIMIT", "120")
)
GOPLAN_AI_CONTEXT_EXPENSE_LIMIT = int(
    os.environ.get("GOPLAN_AI_CONTEXT_EXPENSE_LIMIT", "80")
)

# -------- Channels Configuration --------
REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'hosts': [REDIS_URL],
        },
    },
}

# -------- WebSocket Configuration --------
WS_HEARTBEAT_INTERVAL = 30  # seconds
WS_TICKET_LIFETIME_SECONDS = 60
WS_MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION = 20
WS_SUBPROTOCOL = 'goplan.realtime.v1'

WS_CLOSE_CODES = {
    'AUTH_FAILED': 4001,      # Token invalid/revoked — client should not retry
    'TOKEN_EXPIRED': 4002,    # Token expired — client should refresh then retry
    'SERVER_ERROR': 4500,
}

# -------- Logging Configuration --------
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {
            "()": "pythonjsonlogger.jsonlogger.JsonFormatter",
            "fmt": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
    },
    "handlers": {
        "ai_agent_console": {
            "class": "logging.StreamHandler",
            "formatter": "json",
            "level": "INFO",
        },
    },
    "loggers": {
        "ai.agent": {
            "handlers": ["ai_agent_console"],
            "level": "INFO",
            "propagate": False,
        },
        # HTTPX logs complete request URLs at INFO, while HERE authentication
        # uses an apiKey query parameter. Keep client/transport request logs
        # below WARNING disabled so deployment logging cannot expose the key.
        "httpx": {
            "handlers": [],
            "level": "WARNING",
            "propagate": True,
        },
        "httpcore": {
            "handlers": [],
            "level": "WARNING",
            "propagate": True,
        },
    },
}
