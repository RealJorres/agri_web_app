from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from common.serializers import CodeRefSerializer, RefSerializer

from .models import User, UserAssignment
from .selectors import get_scope


class LoginSerializer(serializers.Serializer[None]):
    email = serializers.EmailField()
    password = serializers.CharField(trim_whitespace=False, write_only=True)


class AssignmentSerializer(serializers.ModelSerializer[UserAssignment]):
    role_label = serializers.CharField(source="get_role_display", read_only=True)
    municipality = RefSerializer(read_only=True, allow_null=True)
    program = CodeRefSerializer(read_only=True, allow_null=True)
    barangays = RefSerializer(many=True, read_only=True)

    class Meta:
        model = UserAssignment
        fields = ["id", "role", "role_label", "municipality", "program", "barangays"]
        read_only_fields = fields


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

    @extend_schema_field(AssignmentSerializer(many=True))
    def get_assignments(self, obj: User) -> list[dict[str, object]]:
        qs = obj.assignments.select_related("municipality", "program").prefetch_related("barangays")
        return AssignmentSerializer(qs, many=True).data  # type: ignore[return-value]


class AccessTokenSerializer(serializers.Serializer[None]):
    access = serializers.CharField()


class LoginResponseSerializer(AccessTokenSerializer):
    user = MeSerializer()
