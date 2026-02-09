from django.urls import include, path


# -------- API Routes --------
urlpatterns = [
    path("auth/", include("accounts.urls")),
]
