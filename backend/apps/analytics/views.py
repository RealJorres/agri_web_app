from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.roles import Cap
from apps.catalog.models import Commodity
from apps.surveys.models import SurveyRound
from apps.surveys.selectors import rounds_for
from common.permissions import HasCapability
from common.scoping import scope_for

from . import selectors, services
from .serializers import (
    BreakdownRowSerializer,
    DistributionSerializer,
    OverviewSerializer,
    RefreshStatusSerializer,
    TrendPointSerializer,
)


class _AnalyticsView(APIView):
    """Aggregates only: every role with view_aggregates, rows limited to the caller's scope."""

    permission_classes = [HasCapability]
    read_capability = Cap.VIEW_AGGREGATES

    def round(self, request: Request, pk: str) -> SurveyRound:
        return get_object_or_404(rounds_for(scope_for(request)).select_related("commodity"), pk=pk)


class _MunicipalityQuery(serializers.Serializer[Any]):
    municipality = serializers.UUIDField(required=False)


MUNICIPALITY_PARAM = OpenApiParameter("municipality", OpenApiTypes.UUID)


def _municipality(request: Request) -> Any:
    query = _MunicipalityQuery(data=request.query_params)
    query.is_valid(raise_exception=True)
    return query.validated_data.get("municipality")


class OverviewView(_AnalyticsView):
    @extend_schema(parameters=[MUNICIPALITY_PARAM], responses=OverviewSerializer)
    def get(self, request: Request, pk: str) -> Response:
        data = selectors.overview(
            self.round(request, pk), scope_for(request), municipality=_municipality(request)
        )
        return Response(OverviewSerializer(data).data)


class _BreakdownQuery(serializers.Serializer[Any]):
    level = serializers.ChoiceField(choices=["municipality", "barangay"], default="municipality")
    municipality = serializers.UUIDField(required=False)


class BreakdownView(_AnalyticsView):
    @extend_schema(
        parameters=[
            OpenApiParameter("level", str, enum=["municipality", "barangay"]),
            OpenApiParameter("municipality", OpenApiTypes.UUID),
        ],
        responses=BreakdownRowSerializer(many=True),
    )
    def get(self, request: Request, pk: str) -> Response:
        query = _BreakdownQuery(data=request.query_params)
        query.is_valid(raise_exception=True)
        rows = selectors.breakdown(
            self.round(request, pk),
            scope_for(request),
            level=query.validated_data["level"],
            municipality=query.validated_data.get("municipality"),
        )
        return Response(BreakdownRowSerializer(rows, many=True).data)


class DistributionView(_AnalyticsView):
    @extend_schema(parameters=[MUNICIPALITY_PARAM], responses=DistributionSerializer)
    def get(self, request: Request, pk: str) -> Response:
        data = selectors.distribution(
            self.round(request, pk), scope_for(request), municipality=_municipality(request)
        )
        return Response(DistributionSerializer(data).data)


class _TrendQuery(serializers.Serializer[Any]):
    commodity = serializers.PrimaryKeyRelatedField(queryset=Commodity.objects.all())
    municipality = serializers.UUIDField(required=False)


class TrendsView(_AnalyticsView):
    @extend_schema(
        parameters=[
            OpenApiParameter("commodity", OpenApiTypes.UUID, required=True),
            OpenApiParameter("municipality", OpenApiTypes.UUID),
        ],
        responses=TrendPointSerializer(many=True),
    )
    def get(self, request: Request) -> Response:
        query = _TrendQuery(data=request.query_params)
        query.is_valid(raise_exception=True)
        points = selectors.trends(
            query.validated_data["commodity"],
            scope_for(request),
            municipality=query.validated_data.get("municipality"),
        )
        return Response(TrendPointSerializer(points, many=True).data)


class RefreshStatusView(_AnalyticsView):
    @extend_schema(responses=RefreshStatusSerializer)
    def get(self, request: Request) -> Response:
        state = services.last_refresh()
        return Response(
            {
                "refreshed_at": state.refreshed_at if state else None,
                "duration_ms": state.duration_ms if state else 0,
            }
        )
