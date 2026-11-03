from typing import Any

from django.conf import settings
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.roles import Cap
from common.permissions import HasCapability
from common.views import ReferenceViewSet

from . import selectors
from .filters import BarangayFilter
from .models import Barangay, Municipality
from .serializers import (
    BarangaySerializer,
    BoundaryCollectionSerializer,
    MapConfigSerializer,
    MunicipalitySerializer,
)


class MunicipalityViewSet(ReferenceViewSet):
    queryset = Municipality.objects.order_by("name")
    serializer_class = MunicipalitySerializer


class BarangayViewSet(ReferenceViewSet):
    queryset = Barangay.objects.select_related("municipality").order_by(
        "municipality__name", "name"
    )
    serializer_class = BarangaySerializer
    filterset_class = BarangayFilter


class MapConfigView(APIView):
    """Tile source and starting view (ADR-0016), plus what boundary data has been loaded."""

    permission_classes = [HasCapability]
    read_capability = Cap.VIEW_AGGREGATES

    @extend_schema(responses=MapConfigSerializer)
    def get(self, request: Request) -> Response:
        data = {
            "tile_url": settings.MAP_TILE_URL,
            "tile_attribution": settings.MAP_TILE_ATTRIBUTION,
            "center": settings.MAP_DEFAULT_CENTER,
            "zoom": settings.MAP_DEFAULT_ZOOM,
            **selectors.boundary_counts(),
        }
        return Response(MapConfigSerializer(data).data)


class _BoundaryQuery(serializers.Serializer[Any]):
    level = serializers.ChoiceField(choices=["municipality", "barangay"], default="municipality")
    municipality = serializers.UUIDField(required=False)


class BoundariesView(APIView):
    permission_classes = [HasCapability]
    read_capability = Cap.VIEW_AGGREGATES

    @extend_schema(
        parameters=[
            OpenApiParameter("level", str, enum=["municipality", "barangay"]),
            OpenApiParameter("municipality", OpenApiTypes.UUID),
        ],
        responses=BoundaryCollectionSerializer,
    )
    def get(self, request: Request) -> Response:
        query = _BoundaryQuery(data=request.query_params)
        query.is_valid(raise_exception=True)
        return Response(
            selectors.boundary_features(
                level=query.validated_data["level"],
                municipality=query.validated_data.get("municipality"),
            )
        )
