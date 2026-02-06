---
version: 2
date: 2025-11-06
base: null
supersedes:
  - "CONTEXT-1@1"
codebase_sha: "5fde0e1e5243385582fdc17d45349323b1ea6001"
scope: "Current Django 5 backend skeleton packaged for Podman with PostgreSQL"
---

## overview.md

- `backend/configs/settings.py` expects all secrets and host metadata from `.env`; Podman compose injects them at runtime.
- Postgres 16 (service `postgresql-skeleton`) and the Django container (`backend`) are orchestrated by `podman-compose.yml`; service names must stay in sync with env files.
- Django REST Framework and Simple JWT are installed/placeholdered but not yet configured; enabling JWT requires uncommenting snippets in settings and `requirements.txt`.
- Global timezone defaults to `Asia/Ho_Chi_Minh`; adjust before deployment if infrastructure assumes UTC.
- Stub `api` app contains no models, serializers, or URL routes yet—intended as extension point for the first feature slice.

## django_project.json

```json
{
  "settings": {
    "DEBUG": {"env": "DJANGO_DEBUG", "truthy": ["1"], "default": false},
    "SECRET_KEY": {"env": "DJANGO_SECRET_KEY", "required": true},
    "ALLOWED_HOSTS": {"env": "DJANGO_ALLOWED_HOSTS", "parser": "comma"},
    "LANGUAGE_CODE": "en-us",
    "TIME_ZONE": "Asia/Ho_Chi_Minh",
    "USE_I18N": true,
    "USE_TZ": true,
    "DATABASES": {
      "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": {"env": "DB_NAME"},
        "USER": {"env": "DB_USER"},
        "PASSWORD": {"env": "DB_PASSWORD"},
        "HOST": {"env": "DB_HOST"},
        "PORT": {"env": "DB_PORT"}
      }
    },
    "INSTALLED_APPS": [
      "django.contrib.admin",
      "django.contrib.auth",
      "django.contrib.contenttypes",
      "django.contrib.sessions",
      "django.contrib.messages",
      "django.contrib.staticfiles",
      "corsheaders",
      "rest_framework",
      "rest_framework_simplejwt",
      "rest_framework_simplejwt.token_blacklist",
      "api"
    ],
    "MIDDLEWARE": [
      "corsheaders.middleware.CorsMiddleware",
      "django.middleware.security.SecurityMiddleware",
      "django.contrib.sessions.middleware.SessionMiddleware",
      "django.middleware.common.CommonMiddleware",
      "django.middleware.csrf.CsrfViewMiddleware",
      "django.contrib.auth.middleware.AuthenticationMiddleware",
      "django.contrib.messages.middleware.MessageMiddleware",
      "django.middleware.clickjacking.XFrameOptionsMiddleware"
    ],
    "TEMPLATES": [
      {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": true,
        "OPTIONS": {
          "context_processors": [
            "django.template.context_processors.request",
            "django.contrib.auth.context_processors.auth",
            "django.contrib.messages.context_processors.messages"
          ]
        }
      }
    ],
    "STATIC_URL": "static/",
    "CORS_ALLOWED_ORIGINS": {"env": "CORS_ALLOWED_ORIGINS", "parser": "comma"},
    "CSRF_TRUSTED_ORIGINS": {"env": "CSRF_TRUSTED_ORIGINS", "parser": "comma"},
    "SECURE_DEFAULTS": {
      "enabled_when": "DJANGO_DEBUG=0",
      "settings": [
        "SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO','https')",
        "SECURE_SSL_REDIRECT=True",
        "SESSION_COOKIE_SECURE=True",
        "CSRF_COOKIE_SECURE=True",
        "SESSION_COOKIE_SAMESITE='Lax'",
        "CSRF_COOKIE_SAMESITE='Lax'"
      ]
    },
    "DEFAULT_AUTO_FIELD": "django.db.models.BigAutoField",
    "REST_FRAMEWORK": null,
    "AUTH_USER_MODEL": null
  },
  "entrypoints": {
    "ROOT_URLCONF": "configs.urls",
    "WSGI_APPLICATION": "configs.wsgi.application",
    "ASGI_APPLICATION": null
  },
  "optional_snippets": {
    "REST_FRAMEWORK": "Enable JWT authentication in configs/settings.py when djangorestframework-simplejwt is installed.",
    "SIMPLE_JWT": "See commented template in configs/settings.py for default token lifetimes."
  }
}
```

## env_files.json

```json
[
  {
    "path": "backend/.env",
    "sections": {
      "core": ["DJANGO_DEBUG", "DJANGO_ALLOWED_HOSTS", "CORS_ALLOWED_ORIGINS", "CSRF_TRUSTED_ORIGINS", "DJANGO_SECRET_KEY"],
      "database": ["DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST", "DB_PORT"],
      "optional": ["MONGO_URL", "MONGO_DB", "REDIS_URL"]
    },
    "notes": "DB_* values must mirror backend/db.env and the podman service key."
  },
  {
    "path": "backend/db.env",
    "sections": {
      "postgres": ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"]
    },
    "notes": "Stay aligned with backend/.env to avoid credential drift; used by postgresql-skeleton service."
  }
]
```

## podman_compose.json

```json
{
  "services": {
    "postgresql-skeleton": {
      "image": "postgres:16-alpine",
      "env_file": ["backend/db.env"],
      "ports": ["5432:5432"],
      "volume": "pgdata",
      "healthcheck": "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB",
      "todos": [
        "Rename service/container to the real project slug",
        "Keep DB_HOST in backend/.env synchronized"
      ]
    },
    "backend": {
      "dockerfile": "backend/Containerfile",
      "command": "python manage.py migrate && python manage.py runserver 0.0.0.0:8000",
      "ports": ["8000:8000"],
      "volumes": ["./backend:/app:Z"],
      "env_file": ["backend/.env"],
      "depends_on": ["postgresql-skeleton"],
      "todos": [
        "Rename image/container tags",
        "Switch to Daphne when ASGI support is introduced"
      ]
    }
  },
  "volumes": ["pgdata"],
  "commented_services": ["mongo", "redis-skeleton"]
}
```

## dependencies.json

```json
[
  {"name": "django", "version": "5.2.6", "role": "core framework"},
  {"name": "django-cors-headers", "version": "4.7.0", "role": "CORS middleware"},
  {"name": "djangorestframework", "version": "3.16.1", "role": "API toolkit"},
  {"name": "psycopg[binary]", "version": "3.2.9", "role": "PostgreSQL driver"},
  {"name": "djangorestframework-simplejwt", "version": "5.5.1", "role": "JWT auth (commented out)"}
]
```

## apps.json

```json
[
  {
    "label": "api",
    "purpose": "placeholder Django app for project-specific REST endpoints",
    "urls_module": "backend/api/urls.py",
    "status": "empty urlpatterns"
  }
]
```

## models.json

```json
[]
```

## migrations.json

```json
[
  {
    "app": "api",
    "last_applied": null,
    "pending": [],
    "data_migrations": []
  }
]
```

## serializers.json

```json
[]
```

## permissions.json

```json
[]
```

## viewsets.json

```json
[]
```

## routers.json

```json
[]
```

## urls.json

```json
[
  {
    "pattern": "/admin/",
    "target": "django.contrib.admin.site.urls",
    "notes": "Default Django admin; requires staff/superuser credentials"
  },
  {
    "pattern": "/api/",
    "target": "include(api.urls)",
    "notes": "No routes registered yet; returns 404"
  }
]
```

## signals.json

```json
[]
```

## management_commands.json

```json
[]
```

## tests_oracles.json

```json
[
  {
    "id": "t_admin_redirect_to_login",
    "api": "GET /admin/",
    "expected": {"status": 302, "redirect_contains": "/admin/login/"},
    "notes": "Confirms admin access requires authentication."
  },
  {
    "id": "t_api_placeholder_404",
    "api": "GET /api/",
    "expected": {"status": 404},
    "notes": "Ensures empty api.urls keeps returning 404 until endpoints exist."
  },
  {
    "id": "t_root_404",
    "api": "GET /",
    "expected": {"status": 404},
    "notes": "Root URL remains undefined in skeleton."
  }
]
```

## invariants.json

```json
[
  {
    "id": "inv_secret_key_required",
    "statement": "Every environment must supply DJANGO_SECRET_KEY; container startup will crash otherwise."
  },
  {
    "id": "inv_postgres_required",
    "statement": "Primary database runs on PostgreSQL via podman-compose; SQLite is not configured."
  },
  {
    "id": "inv_env_sync",
    "statement": "DB credentials in backend/.env and backend/db.env must stay identical."
  },
  {
    "id": "inv_cors_required_prod",
    "statement": "CORS_ALLOWED_ORIGINS and CSRF_TRUSTED_ORIGINS must be populated before exposing the API."
  }
]
```

## edge_cases.json

```json
[
  {
    "id": "edge_missing_csrf_origins",
    "risk": "Django will raise runtime errors if CSRF_TRUSTED_ORIGINS is empty when DEBUG=0."
  }
]
```

## compatibility.json

```json
[
  {
    "area": "podman",
    "detail": "Compose file uses version 3.9 syntax; compatible with Podman 4.x and Docker Engine."
  }
]
```

## open_questions.json

```json
[
  {
    "id": "q_service_renaming",
    "question": "What final slug should replace the placeholder service/container/image names in podman-compose.yml?"
  },
  {
    "id": "q_jwt_enablement",
    "question": "When will REST_FRAMEWORK and SIMPLE_JWT snippets be activated to require authenticated APIs?"
  },
  {
    "id": "q_custom_user_model",
    "question": "Is a custom AUTH_USER_MODEL planned before the first migration lands?"
  },
  {
    "id": "q_timezone_policy",
    "question": "Should the project remain on Asia/Ho_Chi_Minh or switch to UTC for server deployments?"
  }
]
```
