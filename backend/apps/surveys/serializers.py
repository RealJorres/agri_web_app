from typing import Any

from rest_framework import serializers

from apps.catalog.models import Commodity, GrowthStage
from apps.farms.models import CropStand
from common.scoping import scope_for
from common.viewsets import PersonalFieldsMixin

from . import services
from .models import InventoryRecord, StageCount, SurveyRound, WorkflowComment


class SurveyRoundSerializer(serializers.ModelSerializer[SurveyRound]):
    commodity = serializers.PrimaryKeyRelatedField(queryset=Commodity.objects.all())
    commodity_name = serializers.CharField(source="commodity.name", read_only=True)

    class Meta:
        model = SurveyRound
        fields = [
            "id",
            "commodity",
            "commodity_name",
            "name",
            "as_of_date",
            "deadline",
            "status",
            "is_historical",
            "closed_at",
        ]
        read_only_fields = ["status", "is_historical", "closed_at"]
        extra_kwargs: dict[str, dict[str, Any]] = {"name": {"validators": []}}


class StageCountSerializer(serializers.ModelSerializer[StageCount]):
    growth_stage = serializers.SerializerMethodField()

    class Meta:
        model = StageCount
        fields = ["growth_stage", "count", "area_ha"]

    def get_growth_stage(self, obj: StageCount) -> dict[str, Any]:
        s = obj.growth_stage
        return {"id": str(s.pk), "code": s.code, "label": s.label, "sort_order": s.sort_order}


class StageCountInputSerializer(serializers.Serializer[Any]):
    growth_stage = serializers.PrimaryKeyRelatedField(queryset=GrowthStage.objects.all())
    count = serializers.IntegerField(min_value=0, required=False, allow_null=True)
    area_ha = serializers.DecimalField(
        max_digits=10, decimal_places=4, min_value=0, required=False, allow_null=True
    )


class CommentSerializer(serializers.ModelSerializer[WorkflowComment]):
    author = serializers.SerializerMethodField()

    class Meta:
        model = WorkflowComment
        fields = ["id", "action", "body", "author", "created_at"]

    def get_author(self, obj: WorkflowComment) -> str:
        return obj.author.get_full_name() or obj.author.email


class InventoryRecordSerializer(PersonalFieldsMixin, serializers.ModelSerializer[InventoryRecord]):
    personal_fields = ("farmer",)

    survey_round = serializers.SerializerMethodField()
    crop_stand = serializers.SerializerMethodField()
    farm = serializers.SerializerMethodField()
    farmer = serializers.SerializerMethodField()
    counts = serializers.SerializerMethodField()
    total = serializers.SerializerMethodField()
    allowed_actions = serializers.SerializerMethodField()

    class Meta:
        model = InventoryRecord
        fields = [
            "id",
            "survey_round",
            "crop_stand",
            "farm",
            "farmer",
            "status",
            "version",
            "counts",
            "total",
            "remarks",
            "flags",
            "submitted_at",
            "validated_at",
            "approved_at",
            "updated_at",
            "allowed_actions",
        ]

    def get_survey_round(self, obj: InventoryRecord) -> dict[str, str]:
        return {"id": str(obj.survey_round_id), "name": obj.survey_round.name}

    def get_crop_stand(self, obj: InventoryRecord) -> dict[str, str]:
        c = obj.crop_stand.commodity
        return {"id": str(obj.crop_stand_id), "commodity": c.code, "commodity_name": c.name}

    def get_farm(self, obj: InventoryRecord) -> dict[str, Any]:
        farm = obj.crop_stand.farm
        return {
            "id": str(farm.pk),
            "barangay": farm.barangay.name,
            "municipality": farm.barangay.municipality.name,
        }

    def get_farmer(self, obj: InventoryRecord) -> dict[str, str]:
        farmer = obj.crop_stand.farm.farmer
        return {"id": str(farmer.pk), "display_name": farmer.display_name}

    def get_counts(self, obj: InventoryRecord) -> list[dict[str, Any]]:
        counts = sorted(obj.stage_counts.all(), key=lambda c: c.growth_stage.sort_order)
        return StageCountSerializer(counts, many=True).data  # type: ignore[return-value]

    def get_total(self, obj: InventoryRecord) -> int:
        return sum(c.count or 0 for c in obj.stage_counts.all())

    def get_allowed_actions(self, obj: InventoryRecord) -> list[str]:
        request = self.context.get("request")
        return services.allowed_actions(scope_for(request), obj) if request else []


class InventoryRecordWriteSerializer(serializers.Serializer[Any]):
    survey_round = serializers.PrimaryKeyRelatedField(queryset=SurveyRound.objects.all())
    crop_stand = serializers.PrimaryKeyRelatedField(queryset=CropStand.objects.all())
    counts = StageCountInputSerializer(many=True, required=False)
    remarks = serializers.CharField(required=False, allow_blank=True, max_length=2000)


class InventoryRecordUpdateSerializer(serializers.Serializer[Any]):
    counts = StageCountInputSerializer(many=True, required=False)
    remarks = serializers.CharField(required=False, allow_blank=True, max_length=2000)


class TransitionSerializer(serializers.Serializer[Any]):
    comment = serializers.CharField(required=False, allow_blank=True, max_length=2000)


def to_count_inputs(rows: list[dict[str, Any]]) -> list[services.CountInput]:
    return [
        services.CountInput(
            growth_stage=r["growth_stage"], count=r.get("count"), area_ha=r.get("area_ha")
        )
        for r in rows
    ]


class StageTotalSerializer(serializers.Serializer[Any]):
    municipality_id = serializers.UUIDField()
    municipality = serializers.CharField()
    stage_code = serializers.CharField()
    stage_label = serializers.CharField()
    sort_order = serializers.IntegerField()
    count = serializers.IntegerField()
    area_ha = serializers.DecimalField(max_digits=12, decimal_places=2, allow_null=True)


class RoundProgressSerializer(serializers.Serializer[Any]):
    municipality_id = serializers.UUIDField()
    municipality = serializers.CharField()
    expected = serializers.IntegerField()
    draft = serializers.IntegerField()
    submitted = serializers.IntegerField()
    validated = serializers.IntegerField()
    approved = serializers.IntegerField()
    locked = serializers.IntegerField()
