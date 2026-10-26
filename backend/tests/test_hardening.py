import os
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.accounts.models import User
from apps.surveys.models import InventoryRecord

pytestmark = pytest.mark.django_db


def test_api_responses_carry_security_headers(client):
    response = client.get("/api/health")

    assert response["Content-Security-Policy"].startswith("default-src 'none'")
    assert response["Cache-Control"] == "no-store"
    assert "camera=()" in response["Permissions-Policy"]
    assert response["X-Content-Type-Options"] == "nosniff"


def test_seed_demo_refuses_without_debug(settings):
    settings.DEBUG = False

    with pytest.raises(CommandError, match="DEBUG"):
        call_command("seed_demo")


def test_seed_demo_builds_every_workflow_state(settings, monkeypatch):
    settings.DEBUG = True
    monkeypatch.setitem(os.environ, "DEMO_PASSWORD", "synthetic-demo-pass-123")
    out = StringIO()

    call_command("seed_demo", "--farmers-per-town", "6", stdout=out)
    call_command("seed_demo", stdout=out)  # idempotent

    assert "already present" in out.getvalue()
    assert User.objects.filter(email__endswith="@demo.test").count() == 7
    statuses = set(InventoryRecord.objects.values_list("status", flat=True))
    assert statuses == {"draft", "submitted", "validated", "approved"}
    assert InventoryRecord.objects.count() == 36
