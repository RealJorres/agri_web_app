from rest_framework import serializers

from .models import User, UserAssignment
from .selectors import get_scope


class LoginSerializer(serializers.Serializer[None]):
    email = serializers.EmailField()
    password = serializers.CharField(trim_whitespace=False, write_only=True)


class AssignmentSerializer(serializers.ModelSerializer[UserAssignment]):
    role_label = serializers.CharField(source="get_role_display", read_only=True)
    municipality = serializers.SerializerMethodField()
    program = serializers.SerializerMethodField()
    barangays = serializers.SerializerMethodField()

    class Meta:
        model = UserAssignment
        fields = ["id", "role", "role_label", "municipality", "program", "barangays"]

    def get_municipality(self, obj: UserAssignment) -> dict[str, str] | None:
        m = obj.municipality
        return {"id": str(m.pk), "name": m.name} if m else None

    def get_program(self, obj: UserAssignment) -> dict[str, str] | None:
        p = obj.program
        return {"id": str(p.pk), "code": p.code, "name": p.name} if p else None

    def get_barangays(self, obj: UserAssignment) -> list[dict[str, str]]:
        return [{"id": str(b.pk), "name": b.name} for b in obj.barangays.all()]


class MeSerializer(serializers.ModelSerializer[User]):
    full_name = serializers.CharField(source="get_full_name", read_only=True)
    roles = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()
    assignments = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "first_name",
            "last_name",
            "full_name",
            "is_superuser",
            "roles",
            "capabilities",
            "assignments",
        ]

    def get_roles(self, obj: User) -> list[str]:
        return sorted(get_scope(obj).roles)

    def get_capabilities(self, obj: User) -> list[str]:
        return sorted(str(c) for c in get_scope(obj).capabilities)

    def get_assignments(self, obj: User) -> list[dict[str, object]]:
        qs = obj.assignments.select_related("municipality", "program").prefetch_related("barangays")
        return AssignmentSerializer(qs, many=True).data  # type: ignore[return-value]


class AccessTokenSerializer(serializers.Serializer[None]):
    access = serializers.CharField()


class LoginResponseSerializer(AccessTokenSerializer):
    user = MeSerializer()
