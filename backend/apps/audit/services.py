"""Write audit entries. Call from services, inside the same transaction as the change."""

from collections.abc import Iterable
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from django.db.models import Model

from .context import current_meta
from .models import AuditLog

REDACTED = "[personal]"


def _json_value(value: Any) -> Any:
    if isinstance(value, Model):
        return str(value.pk)
    if isinstance(value, UUID | Decimal):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, list | tuple | set):
        return [_json_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _json_value(v) for k, v in value.items()}
    if hasattr(value, "wkt"):  # GEOS geometry
        return value.wkt
    return value


def snapshot(obj: Model, fields: Iterable[str]) -> dict[str, Any]:
    """Raw field values (JSON-ready). Store only after mask()/changes() for personal fields."""
    out: dict[str, Any] = {}
    for name in fields:
        field = obj._meta.get_field(name)
        out[name] = _json_value(getattr(obj, getattr(field, "attname", name)))
    return out


def mask(values: dict[str, Any], personal: Iterable[str]) -> dict[str, Any]:
    """Replace personal values with a marker; empty stays empty (ADR-0006)."""
    hidden = set(personal)
    return {
        k: (REDACTED if v not in (None, "") else None) if k in hidden else v
        for k, v in values.items()
    }


def changes(
    before: dict[str, Any], after: dict[str, Any], personal: Iterable[str] = ()
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Changed keys only, compared on raw values, then masked: a personal field shows that it
    changed but never what it was or became."""
    keys = [k for k in after if before.get(k) != after.get(k)]
    return (
        mask({k: before.get(k) for k in keys}, personal),
        mask({k: after.get(k) for k in keys}, personal),
    )


def record(
    *,
    actor: Any,
    action: str,
    obj: Model | None = None,
    object_type: str | None = None,
    object_id: str | UUID | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> AuditLog:
    if obj is not None:
        object_type = object_type or obj._meta.label_lower
        object_id = object_id or obj.pk
    meta = current_meta()
    return AuditLog.objects.create(
        actor=actor if getattr(actor, "pk", None) else None,
        action=action,
        object_type=object_type or "",
        object_id=str(object_id or ""),
        before=_json_value(before) if before is not None else None,
        after=_json_value(after) if after is not None else None,
        ip=meta.ip,
        user_agent=meta.user_agent,
    )
