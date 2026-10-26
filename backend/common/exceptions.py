"""API error contract: every error response is {"code", "message", "fields"}."""

from typing import Any

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler


class DomainError(Exception):
    """A business-rule violation raised by a service function."""

    status_code: int = status.HTTP_400_BAD_REQUEST

    def __init__(
        self,
        code: str,
        message: str,
        fields: dict[str, list[str]] | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fields = fields or {}
        if status_code is not None:
            self.status_code = status_code


def _flatten_fields(detail: Any, prefix: str = "") -> dict[str, list[str]]:
    """Turn DRF's nested validation detail into {"a.b.0": ["msg", ...]}."""
    if isinstance(detail, dict):
        out: dict[str, list[str]] = {}
        for key, value in detail.items():
            out.update(_flatten_fields(value, f"{prefix}.{key}" if prefix else str(key)))
        return out
    if isinstance(detail, list):
        if all(not isinstance(item, dict | list) for item in detail):
            return {prefix or "non_field_errors": [str(item) for item in detail]}
        out = {}
        for index, item in enumerate(detail):
            out.update(_flatten_fields(item, f"{prefix}.{index}" if prefix else str(index)))
        return out
    return {prefix or "non_field_errors": [str(detail)]}


def exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    if isinstance(exc, DomainError):
        return Response(
            {"code": exc.code, "message": exc.message, "fields": exc.fields},
            status=exc.status_code,
        )
    if isinstance(exc, Http404):
        exc = exceptions.NotFound()
    elif isinstance(exc, DjangoPermissionDenied):
        exc = exceptions.PermissionDenied()

    response = drf_exception_handler(exc, context)
    if response is None or not isinstance(exc, exceptions.APIException):
        return response  # Unhandled: Django returns a generic 500 without details.

    if isinstance(exc, exceptions.ValidationError):
        body = {
            "code": "validation_error",
            "message": "Some fields are invalid.",
            "fields": _flatten_fields(exc.detail),
        }
    else:
        detail = exc.detail
        message = str(detail.get("detail", detail)) if isinstance(detail, dict) else str(detail)
        codes = exc.get_codes()
        code = codes.get("detail", exc.default_code) if isinstance(codes, dict) else codes
        body = {"code": str(code), "message": message, "fields": {}}
    response.data = body
    return response
