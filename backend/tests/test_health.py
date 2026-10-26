from unittest import mock

import pytest
from django.urls import reverse

pytestmark = pytest.mark.django_db


def test_health_ok(client):
    response = client.get(reverse("health"))

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"database": "ok", "redis": "ok"}}


def test_health_reports_down_dependency_without_details(client):
    with mock.patch("common.views.redis.Redis.from_url", side_effect=ConnectionError("secret")):
        response = client.get(reverse("health"))

    assert response.status_code == 503
    body = response.json()
    assert body["checks"]["redis"] == "down"
    assert "secret" not in response.content.decode()


def test_schema_is_valid_openapi(client):
    response = client.get(reverse("schema"), {"format": "json"})

    assert response.status_code == 200
    assert response.json()["openapi"].startswith("3.")
