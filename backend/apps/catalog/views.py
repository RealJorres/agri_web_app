from django.db.models import Prefetch
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response

from common.views import ReferenceViewSet

from . import selectors
from .models import Commodity, GrowthStage, Unit
from .serializers import (
    CommoditySerializer,
    GrowthStageSerializer,
    MaterialSourceSerializer,
    ProgramSerializer,
    UnitSerializer,
    VarietySerializer,
)


class ProgramViewSet(ReferenceViewSet):
    queryset = selectors.programs()
    serializer_class = ProgramSerializer


class CommodityViewSet(ReferenceViewSet):
    queryset = selectors.commodities().prefetch_related(
        Prefetch("stages", queryset=GrowthStage.objects.order_by("sort_order"))
    )
    serializer_class = CommoditySerializer
    filterset_fields = ["program"]

    @action(detail=True, methods=["get"], serializer_class=GrowthStageSerializer)
    def stages(self, request: Request, pk: str | None = None) -> Response:
        commodity: Commodity = self.get_object()
        return Response(GrowthStageSerializer(selectors.stages_for(commodity), many=True).data)


class VarietyViewSet(ReferenceViewSet):
    queryset = selectors.varieties().order_by("code")
    serializer_class = VarietySerializer
    filterset_fields = ["commodity"]


class MaterialSourceViewSet(ReferenceViewSet):
    queryset = selectors.material_sources()
    serializer_class = MaterialSourceSerializer


class UnitViewSet(ReferenceViewSet):
    queryset = Unit.objects.order_by("kind", "code")
    serializer_class = UnitSerializer
