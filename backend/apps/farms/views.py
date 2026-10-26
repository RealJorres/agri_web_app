from typing import Any

import django_filters
from django.db.models import Prefetch, QuerySet
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response

from apps.audit.views import AuditTrailMixin
from apps.production import services as production
from apps.production.serializers import HarvestSerializer
from apps.registry.selectors import farmers_for
from common.exceptions import DomainError
from common.scoping import scope_for
from common.viewsets import ServiceModelViewSet

from . import services
from .models import CropStand, Farm, Planting
from .serializers import (
    CropStandSerializer,
    CropStandUpdateSerializer,
    CropStandWriteSerializer,
    FarmSerializer,
    FarmWriteSerializer,
    PlantingSerializer,
    PlantingWriteSerializer,
)


def _stands() -> Prefetch[Any]:
    return Prefetch(
        "crop_stands",
        queryset=CropStand.objects.select_related("commodity").prefetch_related(
            Prefetch(
                "plantings",
                queryset=Planting.objects.select_related("source").prefetch_related("varieties"),
            )
        ),
    )


class FarmFilter(django_filters.FilterSet):
    farmer = django_filters.UUIDFilter(field_name="farmer_id")
    barangay = django_filters.UUIDFilter(field_name="barangay_id")
    municipality = django_filters.UUIDFilter(field_name="barangay__municipality_id")

    class Meta:
        model = Farm
        fields = ["tenure"]


class FarmViewSet(AuditTrailMixin, ServiceModelViewSet):
    queryset = Farm.objects.select_related("barangay__municipality", "farmer")
    serializer_class = FarmSerializer
    write_serializer_class = FarmWriteSerializer
    filterset_class = FarmFilter
    scope_barangay_path = "barangay"

    def get_queryset(self) -> QuerySet[Farm]:
        return super().get_queryset().prefetch_related(_stands()).order_by("barangay__name")

    def service_create(self, data: dict[str, Any]) -> Farm:
        requested = data.pop("farmer", None)
        farmer = (
            farmers_for(scope_for(self.request)).filter(pk=requested.pk).first()
            if requested
            else None
        )
        if farmer is None:
            raise DomainError("not_found", "Farmer not found.", {"farmer": ["Not found."]}, 404)
        farm = services.create_farm(actor=self.actor, farmer=farmer, data=data)
        return self.get_queryset().get(pk=farm.pk)

    def service_update(self, instance: Farm, data: dict[str, Any]) -> Farm:
        if "farmer" in data and data.pop("farmer") != instance.farmer:
            raise DomainError(
                "farmer_immutable",
                "A farm cannot change owner here; merge the farmers instead.",
                {"farmer": ["Cannot be changed."]},
            )
        services.update_farm(actor=self.actor, farm=instance, data=data)
        return self.get_queryset().get(pk=instance.pk)

    def service_destroy(self, instance: Farm) -> None:
        services.delete_farm(actor=self.actor, farm=instance)

    @extend_schema(request=CropStandWriteSerializer, responses=CropStandSerializer(many=True))
    @action(detail=True, methods=["get", "post"], url_path="crop-stands")
    def crop_stands(self, request: Request, pk: str | None = None) -> Response:
        farm = self.get_object()
        context = self.get_serializer_context()
        if request.method == "GET":
            return Response(
                CropStandSerializer(farm.crop_stands.all(), many=True, context=context).data
            )
        serializer = CropStandWriteSerializer(data=request.data, context=context)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        stand = services.create_crop_stand(
            actor=self.actor, farm=farm, commodity=data.pop("commodity"), data=data
        )
        return Response(
            CropStandSerializer(stand, context=context).data, status=status.HTTP_201_CREATED
        )


class CropStandViewSet(AuditTrailMixin, ServiceModelViewSet):
    queryset = CropStand.objects.select_related("commodity__program", "farm__barangay")
    serializer_class = CropStandSerializer
    write_serializer_class = CropStandUpdateSerializer
    http_method_names = ["get", "patch", "put", "post", "delete", "head", "options"]
    scope_barangay_path = "farm__barangay"
    scope_program_path = "commodity__program"

    def get_queryset(self) -> QuerySet[CropStand]:
        return (
            super()
            .get_queryset()
            .prefetch_related(
                Prefetch(
                    "plantings",
                    queryset=Planting.objects.select_related("source").prefetch_related(
                        "varieties"
                    ),
                )
            )
        )

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        raise DomainError(
            "use_farm_endpoint", "Create crop stands via /farms/{id}/crop-stands.", status_code=405
        )

    def service_update(self, instance: CropStand, data: dict[str, Any]) -> CropStand:
        return services.update_crop_stand(actor=self.actor, stand=instance, data=data)

    def service_destroy(self, instance: CropStand) -> None:
        services.delete_crop_stand(actor=self.actor, stand=instance)

    @extend_schema(request=PlantingWriteSerializer, responses=PlantingSerializer(many=True))
    @action(detail=True, methods=["get", "post"])
    def plantings(self, request: Request, pk: str | None = None) -> Response:
        stand = self.get_object()
        if request.method == "GET":
            return Response(PlantingSerializer(stand.plantings.all(), many=True).data)
        serializer = PlantingWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        planting = services.create_planting(
            actor=self.actor, stand=stand, data=data, varieties=data.pop("varieties", [])
        )
        return Response(PlantingSerializer(planting).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=HarvestSerializer, responses=HarvestSerializer(many=True))
    @action(detail=True, methods=["get", "post"])
    def harvests(self, request: Request, pk: str | None = None) -> Response:
        stand = self.get_object()
        if request.method == "GET":
            return Response(HarvestSerializer(stand.harvests.all(), many=True).data)
        serializer = HarvestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        harvest = production.create_harvest(
            actor=self.actor, stand=stand, data=serializer.validated_data
        )
        return Response(HarvestSerializer(harvest).data, status=status.HTTP_201_CREATED)


class PlantingViewSet(ServiceModelViewSet):
    queryset = Planting.objects.select_related(
        "source", "crop_stand__farm__barangay", "crop_stand__commodity"
    ).prefetch_related("varieties")
    serializer_class = PlantingSerializer
    write_serializer_class = PlantingWriteSerializer
    scope_barangay_path = "crop_stand__farm__barangay"
    scope_program_path = "crop_stand__commodity__program"

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        raise DomainError(
            "use_crop_stand_endpoint",
            "List plantings via /crop-stands/{id}/plantings.",
            status_code=405,
        )

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return self.list(request)

    def service_update(self, instance: Planting, data: dict[str, Any]) -> Planting:
        varieties = data.pop("varieties", None)
        return services.update_planting(
            actor=self.actor, planting=instance, data=data, varieties=varieties
        )

    def service_destroy(self, instance: Planting) -> None:
        services.delete_planting(actor=self.actor, planting=instance)
