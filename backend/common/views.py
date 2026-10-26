import logging

import redis
from django.conf import settings
from django.db import connection
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

logger = logging.getLogger(__name__)


def _check_database() -> bool:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        return True
    except Exception:
        logger.exception("Health check: database unavailable")
        return False


def _check_redis() -> bool:
    try:
        client = redis.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=2)
        return bool(client.ping())
    except Exception:
        logger.exception("Health check: redis unavailable")
        return False


class HealthView(APIView):
    """Liveness/readiness probe. Reports only up/down, never error details."""

    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(
        responses=inline_serializer(
            "Health",
            {"status": serializers.CharField(), "checks": serializers.DictField()},
        )
    )
    def get(self, request: Request) -> Response:
        checks = {
            "database": "ok" if _check_database() else "down",
            "redis": "ok" if _check_redis() else "down",
        }
        healthy = all(value == "ok" for value in checks.values())
        return Response(
            {"status": "ok" if healthy else "degraded", "checks": checks},
            status=200 if healthy else 503,
        )
