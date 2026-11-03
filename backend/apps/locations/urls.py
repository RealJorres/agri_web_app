from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter(trailing_slash=False)
router.register("municipalities", views.MunicipalityViewSet, basename="municipality")
router.register("barangays", views.BarangayViewSet, basename="barangay")

urlpatterns = [
    *router.urls,
    path("map/config", views.MapConfigView.as_view(), name="map-config"),
    path("map/boundaries", views.BoundariesView.as_view(), name="map-boundaries"),
]
