from rest_framework import serializers

from .models import AuditLog


class AuditLogSerializer(serializers.ModelSerializer[AuditLog]):
    actor = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = [
            "id",
            "created_at",
            "actor",
            "action",
            "object_type",
            "object_id",
            "before",
            "after",
        ]

    def get_actor(self, obj: AuditLog) -> str | None:
        if obj.actor is None:
            return None
        return obj.actor.get_full_name() or obj.actor.email
