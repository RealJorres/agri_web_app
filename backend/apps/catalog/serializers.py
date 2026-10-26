from rest_framework import serializers

from .models import Commodity, GrowthStage, MaterialSource, Program, Unit, Variety


class ProgramSerializer(serializers.ModelSerializer[Program]):
    class Meta:
        model = Program
        fields = ["id", "code", "name"]


class GrowthStageSerializer(serializers.ModelSerializer[GrowthStage]):
    class Meta:
        model = GrowthStage
        fields = ["id", "code", "label", "sort_order", "is_bearing"]


class CommoditySerializer(serializers.ModelSerializer[Commodity]):
    program = ProgramSerializer(read_only=True)
    stages = GrowthStageSerializer(many=True, read_only=True)

    class Meta:
        model = Commodity
        fields = [
            "id",
            "code",
            "name",
            "program",
            "measure_type",
            "spacing_m",
            "plants_per_ha",
            "attributes_schema",
            "outlier_multiplier",
            "stages",
        ]


class VarietySerializer(serializers.ModelSerializer[Variety]):
    class Meta:
        model = Variety
        fields = ["id", "commodity", "code", "name"]


class MaterialSourceSerializer(serializers.ModelSerializer[MaterialSource]):
    class Meta:
        model = MaterialSource
        fields = ["id", "code", "name"]


class UnitSerializer(serializers.ModelSerializer[Unit]):
    class Meta:
        model = Unit
        fields = ["id", "code", "name", "kind", "to_base"]
