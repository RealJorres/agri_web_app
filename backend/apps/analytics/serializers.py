from typing import Any

from rest_framework import serializers

from common.serializers import RefSerializer


class _Stage(serializers.Serializer[Any]):
    code = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]  # shadows Field.label in stubs
    is_bearing = serializers.BooleanField()
    trees = serializers.IntegerField()
    area_ha = serializers.DecimalField(max_digits=14, decimal_places=2, allow_null=True)
    change = serializers.IntegerField(allow_null=True)


class _Change(serializers.Serializer[Any]):
    trees = serializers.IntegerField(allow_null=True)
    farmers = serializers.IntegerField(allow_null=True)
    bearing_share = serializers.FloatField(allow_null=True)


class OverviewSerializer(serializers.Serializer[Any]):
    round = RefSerializer()
    previous_round = RefSerializer(allow_null=True)
    trees = serializers.IntegerField()
    area_ha = serializers.DecimalField(max_digits=14, decimal_places=2, allow_null=True)
    farmers = serializers.IntegerField()
    records = serializers.IntegerField()
    bearing_trees = serializers.IntegerField()
    bearing_share = serializers.FloatField(allow_null=True)
    trees_per_farm = serializers.FloatField(allow_null=True)
    stages = _Stage(many=True)
    change = _Change()


class BreakdownRowSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField()
    name = serializers.CharField()
    trees = serializers.IntegerField()
    area_ha = serializers.DecimalField(max_digits=14, decimal_places=2, allow_null=True)
    farmers = serializers.IntegerField()
    records = serializers.IntegerField()
    bearing_share = serializers.FloatField(allow_null=True)
    stages = serializers.DictField(child=serializers.IntegerField())


class TrendPointSerializer(serializers.Serializer[Any]):
    round = RefSerializer()
    as_of_date = serializers.DateField(source="round.as_of_date")
    trees = serializers.IntegerField()
    farmers = serializers.IntegerField()
    bearing_share = serializers.FloatField(allow_null=True)
    stages = serializers.DictField(child=serializers.IntegerField())


class _Bucket(serializers.Serializer[Any]):
    label = serializers.CharField()  # type: ignore[assignment]  # shadows Field.label in stubs
    farms = serializers.IntegerField()


class _Year(serializers.Serializer[Any]):
    year = serializers.IntegerField()
    stands = serializers.IntegerField()


class _Variety(serializers.Serializer[Any]):
    code = serializers.CharField()
    name = serializers.CharField()
    stands = serializers.IntegerField()


class DistributionSerializer(serializers.Serializer[Any]):
    farm_sizes = _Bucket(many=True)
    planting_years = _Year(many=True)
    planting_year_unknown = serializers.IntegerField()
    varieties = _Variety(many=True)
    variety_unknown = serializers.IntegerField()
    stands = serializers.IntegerField()


class RefreshStatusSerializer(serializers.Serializer[Any]):
    refreshed_at = serializers.DateTimeField(allow_null=True)
    duration_ms = serializers.IntegerField()


class _HarvestKg(serializers.Serializer[Any]):
    wet_beans = serializers.DecimalField(max_digits=14, decimal_places=3)
    dried_beans = serializers.DecimalField(max_digits=14, decimal_places=3)
    pods = serializers.DecimalField(max_digits=14, decimal_places=3)
    unknown = serializers.DecimalField(max_digits=14, decimal_places=3)


class _HarvestRow(serializers.Serializer[Any]):
    municipality_id = serializers.UUIDField()
    municipality = serializers.CharField()
    harvests = serializers.IntegerField()
    farmers = serializers.IntegerField()
    kg = _HarvestKg()
    sacks = serializers.DecimalField(max_digits=14, decimal_places=3)
    other_entries = serializers.IntegerField()
    estimated_dates = serializers.IntegerField()


class HarvestSummarySerializer(serializers.Serializer[Any]):
    year = serializers.IntegerField(allow_null=True)
    years = serializers.ListField(child=serializers.IntegerField())
    undated_excluded = serializers.IntegerField()
    rows = _HarvestRow(many=True)
