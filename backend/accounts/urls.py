from django.urls import path

from accounts.views import LoginAPIView, LogoutAPIView, RefreshAPIView, RegisterAPIView

app_name = "accounts"

urlpatterns = [
    path("register", RegisterAPIView.as_view(), name="register"),
    path("login", LoginAPIView.as_view(), name="login"),
    path("refresh", RefreshAPIView.as_view(), name="refresh"),
    path("logout", LogoutAPIView.as_view(), name="logout"),
]
