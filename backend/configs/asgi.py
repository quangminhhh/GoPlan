import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'configs.settings')

# MUST be called before importing anything that touches Django models
# (middleware, routing, consumers) — ensures django.setup() runs first.
django_asgi_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import OriginValidator  # noqa: E402
from django.conf import settings  # noqa: E402

from realtime.middleware import WebSocketAuthMiddleware  # noqa: E402
from realtime.routing import websocket_urlpatterns  # noqa: E402


def build_asgi_application() -> ProtocolTypeRouter:
    return ProtocolTypeRouter({
        "http": django_asgi_app,
        "websocket": OriginValidator(
            WebSocketAuthMiddleware(
                URLRouter(websocket_urlpatterns)
            ),
            allowed_origins=settings.CORS_ALLOWED_ORIGINS,
        ),
    })


application = build_asgi_application()
