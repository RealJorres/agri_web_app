from typing import Any

import django_filters
from django.db.models import Prefetch, QuerySet
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.roles import Cap
from apps.audit.views import AuditTrailMixin
from apps.farms.models import CropStand
from common.exceptions import DomainError
from common.permissions import HasCapability
from common.scoping import scope_for
from common.viewsets import ServiceModelViewSet

from . import selectors, services
from .models import InventoryRecord, RecordStatus, StageCount, SurveyRound
from .serializers import (
    CommentSerializer,
    InventoryRecordSerializer,
    InventoryRecordUpdateSerializer,
    InventoryRecordWriteSerializer,
    RoundProgressSerializer,
    StageTotalSerializer,
    SurveyRoundSerializer,
    TransitionSerializer,
    to_count_inputs,
)


class SurveyRoundViewSet(mixins.CreateModelMixin, viewsets.ReadOnlyModelViewSet[SurveyRound]):
    serializer_class = SurveyRoundSerializer
    permission_classes = [HasCapability]
    read_capability = Cap.VIEW_AGGREGATES
    write_capability = Cap.MANAGE_ROUNDS
    filterset_fields = ["commodity", "status"]

    def get_queryset(self) -> QuerySet[SurveyRound]:
        return selectors.rounds_for(scope_for(self.request))

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        user: Any = request.user
        survey_round = services.open_round(
            actor=user,
            commodity=data["commodity"],
            name=data["name"],
            as_of_date=data["as_of_date"],
            deadline=data.get("deadline"),
        )
        return Response(self.get_serializer(survey_round).data, status=201)

    @extend_schema(
        request=None,
        responses=inline_serializer("CloseResult", {"locked": serializers.IntegerField()}),
    )
    @action(detail=True, methods=["post"])
    def close(self, request: Request, pk: str | None = None) -> Response:
        user: Any = request.user
        locked = services.close_round(actor=user, survey_round=self.get_object())
        return Response({"locked": locked})

    @extend_schema(responses=RoundProgressSerializer(many=True))
    @action(detail=True, methods=["get"])
    def progress(self, request: Request, pk: str | None = None) -> Response:
        rows = selectors.round_progress(self.get_object(), scope_for(request))
        return Response(RoundProgressSerializer(rows, many=True).data)

    @extend_schema(responses=StageTotalSerializer(many=True))
    @action(detail=True, methods=["get"])
    def totals(self, request: Request, pk: str | None = None) -> Response:
        """Official totals per municipality and stage (approved/locked records only)."""
        rows = selectors.stage_totals(self.get_object(), scope_for(request))
        return Response(StageTotalSerializer(rows, many=True).data)


class InventoryRecordFilter(django_filters.FilterSet):
    survey_round = django_filters.UUIDFilter(field_name="survey_round_id")
    crop_stand = django_filters.UUIDFilter(field_name="crop_stand_id")
    farmer = django_filters.UUIDFilter(field_name="crop_stand__farm__farmer_id")
    municipality = django_filters.UUIDFilter(
        field_name="crop_stand__farm__barangay__municipality_id"
    )
    barangay = django_filters.UUIDFilter(field_name="crop_stand__farm__barangay_id")
    status = django_filters.MultipleChoiceFilter(choices=RecordStatus.choices)

    class Meta:
        model = InventoryRecord
        fields = ["status"]


class InventoryRecordViewSet(AuditTrailMixin, ServiceModelViewSet):
    queryset = InventoryRecord.objects.select_related(
        "survey_round__commodity",
        "crop_stand__commodity",
        "crop_stand__farm__barangay__municipality",
        "crop_stand__farm__farmer",
    ).prefetch_related(
        Prefetch("stage_counts", queryset=StageCount.objects.select_related("growth_stage"))
    )
    serializer_class = InventoryRecordSerializer
    filterset_class = InventoryRecordFilter
    ordering_fields = ["updated_at", "submitted_at", "status"]
    scope_barangay_path = selectors.RECORD_BARANGAY
    scope_program_path = selectors.RECORD_PROGRAM
    action_capabilities = {
        "submit": Cap.SUBMIT,
        "validate": Cap.VALIDATE,
        "approve": Cap.APPROVE,
        "reopen": Cap.REOPEN,
        "return_": Cap.VIEW_RECORDS,  # validator or coordinator: the service decides
    }

    def get_serializer_class(self) -> Any:
        if self.action == "create":
            return InventoryRecordWriteSerializer
        if self.action in ("update", "partial_update"):
            return InventoryRecordUpdateSerializer
        return super().get_serializer_class()

    def get_queryset(self) -> QuerySet[InventoryRecord]:
        return super().get_queryset().order_by("-updated_at")

    def _fresh(self, record: InventoryRecord) -> InventoryRecord:
        return self.get_queryset().get(pk=record.pk)

    def service_create(self, data: dict[str, Any]) -> InventoryRecord:
        stand = (
            CropStand.objects.filter(pk=data["crop_stand"].pk)
            .select_related("farm__barangay", "commodity")
            .get()
        )
        record = services.create_record(
            actor=self.actor,
            survey_round=data["survey_round"],
            crop_stand=stand,
            counts=to_count_inputs(data.get("counts", [])),
            remarks=data.get("remarks", ""),
        )
        return self._fresh(record)

    def service_update(self, instance: InventoryRecord, data: dict[str, Any]) -> InventoryRecord:
        counts = to_count_inputs(data["counts"]) if "counts" in data else None
        services.update_record(
            actor=self.actor, record=instance, counts=counts, remarks=data.get("remarks")
        )
        return self._fresh(instance)

    def service_destroy(self, instance: InventoryRecord) -> None:
        services.delete_record(actor=self.actor, record=instance)

    def _run(self, request: Request, fn: Any) -> Response:
        record = self.get_object()
        serializer = TransitionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        fn(actor=self.actor, record=record, comment=serializer.validated_data.get("comment", ""))
        return self.render(self._fresh(record))

    @extend_schema(request=TransitionSerializer, responses=InventoryRecordSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request: Request, pk: str | None = None) -> Response:
        return self._run(request, services.submit)

    @extend_schema(request=TransitionSerializer, responses=InventoryRecordSerializer)
    @action(detail=True, methods=["post"])
    def validate(self, request: Request, pk: str | None = None) -> Response:
        return self._run(request, services.validate)

    @extend_schema(request=TransitionSerializer, responses=InventoryRecordSerializer)
    @action(detail=True, methods=["post"])
    def approve(self, request: Request, pk: str | None = None) -> Response:
        return self._run(request, services.approve)

    @extend_schema(request=TransitionSerializer, responses=InventoryRecordSerializer)
    @action(detail=True, methods=["post"], url_path="return")
    def return_(self, request: Request, pk: str | None = None) -> Response:
        return self._run(request, services.return_record)

    @extend_schema(request=TransitionSerializer, responses=InventoryRecordSerializer)
    @action(detail=True, methods=["post"])
    def reopen(self, request: Request, pk: str | None = None) -> Response:
        return self._run(request, services.reopen)

    @extend_schema(responses=CommentSerializer(many=True))
    @action(detail=True, methods=["get"])
    def comments(self, request: Request, pk: str | None = None) -> Response:
        record = self.get_object()
        return Response(CommentSerializer(record.comments.select_related("author"), many=True).data)


class HomeStatsView(APIView):
    permission_classes = [HasCapability]
    read_capability = Cap.VIEW_AGGREGATES

    @extend_schema(
        responses=inline_serializer(
            "HomeStats",
            {
                "farmers": serializers.IntegerField(),
                "farms": serializers.IntegerField(),
                "commodities": serializers.ListField(child=serializers.DictField()),
            },
        )
    )
    def get(self, request: Request) -> Response:
        if not scope_for(request).can(Cap.VIEW_AGGREGATES):
            raise DomainError("forbidden", "Not allowed.", status_code=403)
        return Response(selectors.home_stats(scope_for(request)))
