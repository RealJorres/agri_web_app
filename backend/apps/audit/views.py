from typing import Any

from drf_spectacular.utils import extend_schema
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response

from .selectors import audit_trail
from .serializers import AuditLogSerializer


class AuditTrailMixin:
    """Adds GET {id}/audit to a scoped viewset (the object lookup enforces scope -> 404)."""

    get_object: Any
    paginate_queryset: Any
    get_paginated_response: Any

    @extend_schema(responses=AuditLogSerializer(many=True))
    @action(detail=True, methods=["get"], url_path="audit")
    def audit(self, request: Request, pk: str | None = None) -> Response:
        entries = audit_trail(self.get_object())
        page = self.paginate_queryset(entries)
        return self.get_paginated_response(AuditLogSerializer(page, many=True).data)
