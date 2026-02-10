from django.urls import include, path

from api.views import HealthCheckAPIView


# -------- API Routes --------
urlpatterns = [
    path("health", HealthCheckAPIView.as_view(), name="health"),
    path("auth/", include("accounts.urls")),
]
