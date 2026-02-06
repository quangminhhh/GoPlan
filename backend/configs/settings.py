from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent

# -------- Core Flags --------
DEBUG = os.environ.get('DJANGO_DEBUG') == '1'
SECRET_KEY = os.environ['DJANGO_SECRET_KEY']
# Keep hostnames in sync with DJANGO_ALLOWED_HOSTS in backend/.env (comma-separated, no spaces).
ALLOWED_HOSTS = os.environ['DJANGO_ALLOWED_HOSTS'].split(',')

# -------- Installed Apps --------
INSTALLED_APPS = [
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

    # Local apps
    'api'
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
# ASGI_APPLICATION = 'configs.asgi.application'

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
# Values must follow backend/db.env and podman-compose.yml service names.
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.environ['DB_NAME'],
        'USER': os.environ['DB_USER'],
        'PASSWORD': os.environ['DB_PASSWORD'],
        'HOST': os.environ['DB_HOST'],
        'PORT': os.environ['DB_PORT'],
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

# -------- Cross-Origin Settings --------
CORS_ALLOWED_ORIGINS = os.environ['CORS_ALLOWED_ORIGINS'].split(',')
CSRF_TRUSTED_ORIGINS = os.environ['CSRF_TRUSTED_ORIGINS'].split(',')

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    CSRF_COOKIE_SAMESITE = 'Lax'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# -------- Optional Config Blocks --------
# Uncomment the snippets below when the project needs them and ensure requirements.txt matches.

# REST Framework Defaults
# REST_FRAMEWORK = {
#     'DEFAULT_AUTHENTICATION_CLASSES': (
#         'rest_framework_simplejwt.authentication.JWTAuthentication',
#     )
# }

# JWT Settings
# SIMPLE_JWT = {
#     'ACCESS_TOKEN_LIFETIME': timedelta(minutes=60),
#     'REFRESH_TOKEN_LIFETIME': timedelta(days=1),
#     'AUTH_HEADER_TYPES': ('Bearer',),
#     'BLACKLIST_AFTER_ROTATION': True,
# }

# Custom User Model
# AUTH_USER_MODEL = 'accounts.User'

# MongoDB Integration
# MONGO_URL = os.environ.get('MONGO_URL')
# MONGO_DB = os.environ.get('MONGO_DB')

# Channels Configuration
# CHANNEL_LAYERS = {
#     'default': {
#         'BACKEND': 'channels_redis.core.RedisChannelLayer',
#         'CONFIG': {
#             'hosts': [('redis-messaging', 6379)],
#         },
#     }
# }
