from typing import Any

from rest_framework import serializers

from .models import Barangay, Municipality


class MunicipalitySerializer(serializers.ModelSerializer[Municipality]):
    class Meta:
        model = Municipality
        fields = ["id", "name", "psgc_code"]


class BarangaySerializer(serializers.ModelSerializer[Barangay]):
    class Meta:
        model = Barangay
        fields = ["id", "name", "psgc_code", "municipality", "is_verified"]


class MapConfigSerializer(serializers.Serializer[Any]):
    tile_url = serializers.CharField()
    tile_attribution = serializers.CharField()
    center = serializers.ListField(child=serializers.FloatField(), min_length=2, max_length=2)
    zoom = serializers.FloatField()
    municipality_boundaries = serializers.IntegerField()
    barangay_boundaries = serializers.IntegerField()


class BoundaryPropertiesSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField()
    name = serializers.CharField()


class BoundaryFeatureSerializer(serializers.Serializer[Any]):
    type = serializers.CharField()
    properties = BoundaryPropertiesSerializer()
    geometry = serializers.JSONField()


class BoundaryCollectionSerializer(serializers.Serializer[Any]):
    """Schema only: the selector already returns GeoJSON."""

    type = serializers.CharField()
    features = BoundaryFeatureSerializer(many=True)
