from django.conf import settings
from django.contrib import admin
from django.urls import URLPattern, URLResolver, include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from common.views import HealthView

api_v1: list[URLPattern | URLResolver] = [
    path("", include("apps.accounts.urls")),
    path("", include("apps.locations.urls")),
    path("", include("apps.catalog.urls")),
    path("", include("apps.registry.urls")),
    path("", include("apps.farms.urls")),
]

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health", HealthView.as_view(), name="health"),
    path("api/v1/", include((api_v1, "api"), namespace="v1")),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
]

if settings.DEBUG:
    urlpatterns += [
        path("api/schema/swagger/", SpectacularSwaggerView.as_view(url_name="schema"), name="docs"),
    ]
