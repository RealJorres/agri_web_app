import uuid
from typing import Any, NoReturn

from django.conf import settings
from django.db import models


class AppendOnlyError(RuntimeError):
    pass


class AuditLogQuerySet(models.QuerySet["AuditLog"]):
    def update(self, **kwargs: Any) -> NoReturn:
        raise AppendOnlyError("Audit log entries cannot be updated.")

    def delete(self) -> NoReturn:
        raise AppendOnlyError("Audit log entries cannot be deleted.")


class AuditLog(models.Model):
    """Append-only (ORM guard here + database trigger in migration 0002).

    Personal values are masked before they reach ``before``/``after`` (ADR-0006).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # PROTECT: users with audit history are deactivated, never deleted (rows cannot be updated).
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="+",
    )
    action = models.CharField(max_length=50, db_index=True)
    object_type = models.CharField(max_length=100)
    object_id = models.CharField(max_length=64, blank=True)
    before = models.JSONField(null=True, blank=True)
    after = models.JSONField(null=True, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    objects = AuditLogQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["object_type", "object_id"], name="audit_object_idx")]

    def __str__(self) -> str:
        return f"{self.created_at:%Y-%m-%d %H:%M} {self.action} {self.object_type}:{self.object_id}"

    def save(self, *args: Any, **kwargs: Any) -> None:
        if not self._state.adding:
            raise AppendOnlyError("Audit log entries cannot be updated.")
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> NoReturn:
        raise AppendOnlyError("Audit log entries cannot be deleted.")
