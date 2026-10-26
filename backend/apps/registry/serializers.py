from typing import Any

from rest_framework import serializers

from apps.locations.models import Barangay
from common.serializers import RefSerializer
from common.viewsets import PersonalFieldsMixin

from .models import Association, AssociationMember, Farmer


class FarmerSerializer(PersonalFieldsMixin, serializers.ModelSerializer[Farmer]):
    personal_fields = (*Farmer.PERSONAL_FIELDS, "display_name")

    display_name = serializers.CharField(read_only=True)
    sex = serializers.CharField(read_only=True)  # "" when not recorded
    home_barangay = RefSerializer(read_only=True)
    municipality = RefSerializer(source="home_barangay.municipality", read_only=True)
    has_consent = serializers.SerializerMethodField()

    class Meta:
        model = Farmer
        fields = [
            "id",
            "display_name",
            "first_name",
            "middle_name",
            "last_name",
            "suffix",
            "full_name_raw",
            "sex",
            "birth_year",
            "rsbsa_no",
            "contact_no",
            "home_barangay",
            "municipality",
            "status",
            "has_consent",
            "consent_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_has_consent(self, obj: Farmer) -> bool:
        return obj.consent_at is not None


class MembershipSerializer(serializers.ModelSerializer[AssociationMember]):
    association = RefSerializer(read_only=True)

    class Meta:
        model = AssociationMember
        fields = ["id", "association", "role", "since"]
        read_only_fields = fields


class FarmerDetailSerializer(FarmerSerializer):
    memberships = MembershipSerializer(many=True, read_only=True)

    class Meta(FarmerSerializer.Meta):
        fields = [*FarmerSerializer.Meta.fields, "memberships"]


class FarmerWriteSerializer(serializers.ModelSerializer[Farmer]):
    home_barangay = serializers.PrimaryKeyRelatedField(queryset=Barangay.objects.all())
    consent_given = serializers.BooleanField(write_only=True, default=False)

    class Meta:
        model = Farmer
        fields = [
            "first_name",
            "middle_name",
            "last_name",
            "suffix",
            "sex",
            "birth_year",
            "rsbsa_no",
            "contact_no",
            "home_barangay",
            "status",
            "consent_given",
        ]
        # Uniqueness is enforced by the service (clear 409 instead of a generic 400).
        extra_kwargs: dict[str, dict[str, Any]] = {"rsbsa_no": {"validators": []}}


class DuplicateCandidateSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField(source="farmer.pk")
    display_name = serializers.CharField(source="farmer.display_name")
    home_barangay = serializers.CharField(source="farmer.home_barangay.name")
    municipality = serializers.CharField(source="farmer.home_barangay.municipality.name")
    similarity = serializers.FloatField()
    reason = serializers.CharField()


class MergeSerializer(serializers.Serializer[Any]):
    duplicate = serializers.UUIDField(help_text="Farmer to merge into this one; it is retired.")


class MergeResultSerializer(serializers.Serializer[Any]):
    target = FarmerSerializer()
    farms_moved = serializers.IntegerField()
    memberships_moved = serializers.IntegerField()
    fields_filled = serializers.ListField(child=serializers.CharField())
    conflicts = serializers.ListField(child=serializers.CharField())


class AssociationSerializer(serializers.ModelSerializer[Association]):
    municipality_name = serializers.CharField(source="municipality.name", read_only=True)
    member_count = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = Association
        fields = [
            "id",
            "name",
            "short_name",
            "type",
            "municipality",
            "municipality_name",
            "registration_body",
            "registration_no",
            "member_count",
        ]
        extra_kwargs: dict[str, dict[str, Any]] = {"name": {"validators": []}}


class MemberSerializer(PersonalFieldsMixin, serializers.ModelSerializer[AssociationMember]):
    personal_fields = ("farmer_name",)

    farmer_name = serializers.CharField(source="farmer.display_name", read_only=True)
    home_barangay = serializers.CharField(source="farmer.home_barangay.name", read_only=True)

    class Meta:
        model = AssociationMember
        fields = ["id", "farmer", "farmer_name", "home_barangay", "role", "since"]
        extra_kwargs: dict[str, dict[str, Any]] = {"farmer": {"queryset": Farmer.objects.all()}}
