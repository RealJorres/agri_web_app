"""Test-only URLconf: a scoped viewset over Barangay, used until real record endpoints exist."""

from django.urls import include, path
from rest_framework import routers, serializers, viewsets

from apps.locations.models import Barangay
from common.permissions import HasCapability
from common.scoping import ScopedQuerySetMixin


class _BarangaySerializer(serializers.ModelSerializer[Barangay]):
    class Meta:
        model = Barangay
        fields = ["id", "name"]


class ScopedBarangayViewSet(ScopedQuerySetMixin, viewsets.ReadOnlyModelViewSet[Barangay]):
    queryset = Barangay.objects.all()
    serializer_class = _BarangaySerializer
    permission_classes = [HasCapability]
    scope_municipality_path = "municipality"


router = routers.SimpleRouter()
router.register("scoped-barangays", ScopedBarangayViewSet, basename="scoped-barangay")

urlpatterns = [path("", include("config.urls")), path("test/", include(router.urls))]
