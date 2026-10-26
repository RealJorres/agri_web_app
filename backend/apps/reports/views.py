from typing import Any

from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers, status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.roles import Cap
from apps.audit import services as audit
from apps.locations.models import Municipality
from apps.surveys.models import SurveyRound
from apps.surveys.selectors import rounds_for
from common.permissions import HasCapability
from common.scoping import can_reach, scope_for

from . import content, render, services

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
FORMATS = {"xlsx": XLSX, "pdf": "application/pdf"}


def _file(data: bytes, filename: str, fmt: str) -> HttpResponse:
    response = HttpResponse(data, content_type=FORMATS[fmt])
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Cache-Control"] = "no-store"
    return response


def _slug(text: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in text.lower()).strip("-")


class _ReportView(APIView):
    permission_classes = [HasCapability]
    read_capability = Cap.VIEW_AGGREGATES

    def round(self, request: Request, pk: str) -> SurveyRound:
        return get_object_or_404(rounds_for(scope_for(request)).select_related("commodity"), pk=pk)


class _SignoffSerializer(serializers.Serializer[Any]):
    state = serializers.ChoiceField(choices=["unsigned", "signed", "superseded"])
    signed_by = serializers.CharField(allow_null=True)
    signed_at = serializers.DateTimeField(allow_null=True)
    content_sha256 = serializers.CharField(allow_null=True)
    current_sha256 = serializers.CharField()


def _status_data(st: services.SignoffStatus) -> dict[str, Any]:
    s = st.signoff
    return {
        "state": st.state,
        "signed_by": (s.signed_by.get_full_name() or s.signed_by.email) if s else None,
        "signed_at": s.signed_at if s else None,
        "content_sha256": s.content_sha256 if s else None,
        "current_sha256": st.current_sha256,
    }


class SummaryFileView(_ReportView):
    """The provincial summary (aggregates only), scoped to the caller's assignment."""

    @extend_schema(
        responses={(200, XLSX): OpenApiTypes.BINARY, (200, "application/pdf"): OpenApiTypes.BINARY}
    )
    def get(self, request: Request, pk: str, fmt: str) -> HttpResponse:
        survey_round = self.round(request, pk)
        data = content.summary(survey_round, scope_for(request))
        name = f"summary-{_slug(survey_round.name)}.{fmt}"
        if fmt == "xlsx":
            return _file(render.summary_xlsx(data), name, fmt)
        return _file(render.pdf("reports/summary.html", data), name, fmt)


class MunicipalListFileView(_ReportView):
    """Farmer-level list: personal data, so it needs export_personal_data and is audited."""

    read_capability = Cap.EXPORT_PERSONAL_DATA

    @extend_schema(
        parameters=[OpenApiParameter("municipality", OpenApiTypes.UUID, required=True)],
        responses={(200, XLSX): OpenApiTypes.BINARY, (200, "application/pdf"): OpenApiTypes.BINARY},
    )
    def get(self, request: Request, pk: str, fmt: str) -> HttpResponse:
        survey_round = self.round(request, pk)
        town = get_object_or_404(Municipality, pk=request.query_params.get("municipality") or None)
        scope = scope_for(request)
        if not can_reach(scope, Cap.EXPORT_PERSONAL_DATA, municipality_id=town.pk):
            return HttpResponse(status=404)
        data = content.municipal_list(survey_round, scope, town.pk)
        audit.record(
            actor=request.user,
            action="export.municipal_list",
            object_type="surveys.surveyround",
            object_id=survey_round.pk,
            after={"municipality": town.name, "format": fmt, "rows": len(data["rows"])},
        )
        name = f"{_slug(town.name)}-{_slug(survey_round.name)}.{fmt}"
        if fmt == "xlsx":
            return _file(render.municipal_list_xlsx(data), name, fmt)
        return _file(render.pdf("reports/municipal_list.html", data), name, fmt)


class SignoffView(_ReportView):
    write_capability = Cap.SIGN_REPORTS  # GET status: view_aggregates; POST sign: sign_reports

    @extend_schema(responses=_SignoffSerializer)
    def get(self, request: Request, pk: str) -> Response:
        return Response(
            _SignoffSerializer(_status_data(services.signoff_status(self.round(request, pk)))).data
        )

    @extend_schema(request=None, responses={201: _SignoffSerializer})
    def post(self, request: Request, pk: str) -> Response:
        survey_round = self.round(request, pk)
        user: Any = request.user
        services.sign_off_summary(actor=user, survey_round=survey_round)
        data = _SignoffSerializer(_status_data(services.signoff_status(survey_round))).data
        return Response(data, status=status.HTTP_201_CREATED)
