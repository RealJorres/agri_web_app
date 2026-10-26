from common.views import ReferenceViewSet

from .filters import BarangayFilter
from .models import Barangay, Municipality
from .serializers import BarangaySerializer, MunicipalitySerializer


class MunicipalityViewSet(ReferenceViewSet):
    queryset = Municipality.objects.order_by("name")
    serializer_class = MunicipalitySerializer


class BarangayViewSet(ReferenceViewSet):
    queryset = Barangay.objects.select_related("municipality").order_by(
        "municipality__name", "name"
    )
    serializer_class = BarangaySerializer
    filterset_class = BarangayFilter
