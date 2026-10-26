import json

import pytest
from django.db import DatabaseError, connection, transaction
from django.test import RequestFactory

from apps.audit.context import AuditContextMiddleware, client_ip, current_meta
from apps.audit.models import AppendOnlyError, AuditLog
from apps.audit.services import REDACTED, changes, mask, record, snapshot
from apps.registry.tests.factories import FarmerFactory

pytestmark = pytest.mark.django_db


def test_record_is_append_only_in_orm():
    entry = record(actor=None, action="test.action", object_type="x", object_id="1")

    with pytest.raises(AppendOnlyError):
        entry.save()
    with pytest.raises(AppendOnlyError):
        entry.delete()
    with pytest.raises(AppendOnlyError):
        AuditLog.objects.filter(pk=entry.pk).update(action="tampered")
    with pytest.raises(AppendOnlyError):
        AuditLog.objects.filter(pk=entry.pk).delete()


def test_database_trigger_blocks_update_and_delete():
    entry = record(actor=None, action="test.action", object_type="x", object_id="1")

    for sql in (
        "UPDATE audit_auditlog SET action = 'tampered' WHERE id = %s",
        "DELETE FROM audit_auditlog WHERE id = %s",
    ):
        with (
            pytest.raises(DatabaseError, match="append-only"),
            transaction.atomic(),
            connection.cursor() as cursor,
        ):
            cursor.execute(sql, [entry.pk])


def test_snapshot_and_mask_hide_personal_values():
    farmer = FarmerFactory(first_name="Synthetic", contact_no="09170000000")

    values = mask(
        snapshot(farmer, ["first_name", "contact_no", "status", "rsbsa_no"]),
        ["first_name", "contact_no", "rsbsa_no"],
    )

    assert values == {
        "first_name": REDACTED,
        "contact_no": REDACTED,
        "status": "active",
        "rsbsa_no": None,  # empty stays empty
    }


def test_changes_detects_personal_change_without_revealing_it():
    before = {"contact_no": "0917-000-0001", "status": "active"}
    after = {"contact_no": "0917-000-0002", "status": "active"}

    old, new = changes(before, after, personal=["contact_no"])

    assert old == {"contact_no": REDACTED}
    assert new == {"contact_no": REDACTED}
    assert "0917" not in json.dumps([old, new])


def test_changes_ignores_unchanged_fields():
    assert changes({"a": 1, "b": 2}, {"a": 1, "b": 3}) == ({"b": 2}, {"b": 3})


def test_middleware_captures_ip_and_user_agent():
    request = RequestFactory().get("/", REMOTE_ADDR="10.0.0.5", HTTP_USER_AGENT="pytest-agent")
    seen = {}

    def view(_request):
        seen["meta"] = current_meta()
        record(actor=None, action="test.mw", object_type="x", object_id="1")
        from django.http import HttpResponse

        return HttpResponse()

    AuditContextMiddleware(view)(request)

    assert seen["meta"].ip == "10.0.0.5"
    entry = AuditLog.objects.get(action="test.mw")
    assert (entry.ip, entry.user_agent) == ("10.0.0.5", "pytest-agent")
    assert current_meta().ip is None  # reset after the request


def test_client_ip_honours_trusted_proxy_count(settings):
    request = RequestFactory().get(
        "/", REMOTE_ADDR="172.18.0.2", HTTP_X_FORWARDED_FOR="203.0.113.9, 172.18.0.1"
    )
    assert client_ip(request) == "172.18.0.2"

    settings.AUDIT_TRUSTED_PROXY_COUNT = 1
    assert client_ip(request) == "172.18.0.1"
    settings.AUDIT_TRUSTED_PROXY_COUNT = 2
    assert client_ip(request) == "203.0.113.9"
