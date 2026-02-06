from django.contrib import admin
from django.urls import path, include

# -------- Root URL Patterns --------
urlpatterns = [
    path('admin/', admin.site.urls),
    # Keep /api/ as the unified entry point for all application endpoints
    path('api/', include('api.urls')),
]
