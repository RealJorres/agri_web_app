from typing import Any

from django.db import transaction
from django.db.models import QuerySet
from django.http import FileResponse, HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.accounts.roles import Cap
from apps.audit import services as audit
from apps.registry.filters import FarmerFilter
from apps.registry.selectors import farmers_for
from apps.surveys.selectors import records_for
from apps.surveys.views import InventoryRecordFilter
from common.exceptions import DomainError
from common.permissions import HasCapability
from common.scoping import scope_for

from . import exports, services, tasks, template
from .models import ImportJob, ImportKind
from .serializers import (
    CommitSerializer,
    ImportJobListSerializer,
    ImportJobSerializer,
    TemplateQuerySerializer,
    UploadSerializer,
)

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _xlsx(data: bytes, filename: str) -> HttpResponse:
    response = HttpResponse(data, content_type=XLSX)
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Cache-Control"] = "no-store"
    return response


class ImportJobViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet[ImportJob],
):
    permission_classes = [HasCapability]
    read_capability = Cap.RUN_IMPORTS
    write_capability = Cap.RUN_IMPORTS
    parser_classes = [MultiPartParser]
    throttle_scope = "import"

    def get_throttles(self) -> list[Any]:
        return [ScopedRateThrottle()] if self.action == "create" else super().get_throttles()

    def get_queryset(self) -> QuerySet[ImportJob]:
        """Admins see every job; others see their own (summaries hold personal data)."""
        queryset = ImportJob.objects.select_related("uploaded_by")
        if getattr(self, "swagger_fake_view", False):
            return queryset.none()  # schema generation runs without a real user
        if scope_for(self.request).can(Cap.ADMIN):
            return queryset
        return queryset.filter(uploaded_by=self.request.user)

    def get_serializer_class(self) -> Any:
        if self.action == "list":
            return ImportJobListSerializer
        if self.action == "create":
            return UploadSerializer
        return ImportJobSerializer

    @property
    def actor(self) -> User:
        user: Any = self.request.user
        return user

    @extend_schema(request=UploadSerializer, responses={201: ImportJobSerializer})
    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = UploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        job = services.create_job(
            actor=self.actor,
            upload=data["file"],
            kind=data["kind"],
            survey_round=data.get("survey_round"),
        )
        transaction.on_commit(lambda: tasks.preview_import.delay(str(job.pk)))
        return Response(ImportJobSerializer(job).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=CommitSerializer, responses={202: ImportJobSerializer})
    @action(detail=True, methods=["post"], parser_classes=[JSONParser])
    def commit(self, request: Request, pk: str | None = None) -> Response:
        job = self.get_object()
        serializer = CommitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        if job.status != "ready":
            raise DomainError(
                "not_ready", f"This import is {job.get_status_display().lower()}.", status_code=409
            )
        services._check_commit_rights(job, self.actor)
        overrides = serializer.validated_data.get("association_overrides")
        transaction.on_commit(
            lambda: tasks.commit_import.delay(str(job.pk), str(self.actor.pk), overrides)
        )
        return Response(ImportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)

    @extend_schema(responses={(200, XLSX): OpenApiTypes.BINARY})
    @action(detail=True, methods=["get"], url_path="error-report")
    def error_report(self, request: Request, pk: str | None = None) -> FileResponse:
        job = self.get_object()
        if not job.error_report:
            raise DomainError("not_found", "This import has no error report.", status_code=404)
        audit.record(actor=self.actor, action="import.download_error_report", obj=job)
        response = FileResponse(
            job.error_report.open("rb"), as_attachment=True, filename=f"import-errors-{job.pk}.xlsx"
        )
        response["Cache-Control"] = "no-store"
        return response

    @extend_schema(
        parameters=[OpenApiParameter("commodity", OpenApiTypes.UUID, required=True)],
        responses={(200, XLSX): OpenApiTypes.BINARY},
    )
    @action(detail=False, methods=["get"], url_path="template")
    def template(self, request: Request) -> HttpResponse:
        query = TemplateQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        commodity = query.validated_data["commodity"]
        return _xlsx(template.generate(commodity), f"{commodity.code.lower()}-template.xlsx")


class _ExportView(APIView):
    permission_classes = [HasCapability]
    read_capability = Cap.EXPORT_PERSONAL_DATA

    @staticmethod
    def filters(request: Request) -> dict[str, Any]:
        return {k: request.query_params.getlist(k) for k in request.query_params}


class FarmerExportView(_ExportView):
    @extend_schema(responses={(200, XLSX): OpenApiTypes.BINARY})
    def get(self, request: Request) -> HttpResponse:
        scope = scope_for(request)
        queryset = FarmerFilter(request.query_params, queryset=farmers_for(scope)).qs
        user: Any = request.user
        data = exports.export_farmers(actor=user, queryset=queryset, filters=self.filters(request))
        return _xlsx(data, "farmers.xlsx")


class InventoryExportView(_ExportView):
    @extend_schema(responses={(200, XLSX): OpenApiTypes.BINARY})
    def get(self, request: Request) -> HttpResponse:
        scope = scope_for(request)
        queryset = InventoryRecordFilter(request.query_params, queryset=records_for(scope)).qs
        user: Any = request.user
        data = exports.export_inventory(
            actor=user, queryset=queryset, filters=self.filters(request)
        )
        return _xlsx(data, "inventory.xlsx")


__all__ = ["FarmerExportView", "ImportJobViewSet", "ImportKind", "InventoryExportView"]
