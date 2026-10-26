from django.db.models import Model, QuerySet

from .models import AuditLog


def audit_trail(obj: Model) -> QuerySet[AuditLog]:
    """Entries about one object, newest first. Callers must already have scoped access to obj."""
    return AuditLog.objects.filter(
        object_type=obj._meta.label_lower, object_id=str(obj.pk)
    ).select_related("actor")
