from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.catalog.models import Commodity, MaterialSource, Variety
from apps.locations.models import Barangay
from common.serializers import CodeRefSerializer, RefSerializer
from common.viewsets import PersonalFieldsMixin

from .models import CropStand, Farm, Planting

LONLAT_SCHEMA = {
    "type": "object",
    "properties": {"lon": {"type": "number"}, "lat": {"type": "number"}},
    "required": ["lon", "lat"],
    "nullable": True,
}


class PlantingSerializer(serializers.ModelSerializer[Planting]):
    # "source" shadows Field.source in the DRF stubs; the runtime is fine.
    source = serializers.SlugRelatedField(  # type: ignore[var-annotated,assignment]
        read_only=True, slug_field="code"
    )
    varieties = serializers.SlugRelatedField(  # type: ignore[var-annotated]
        many=True, read_only=True, slug_field="code"
    )

    class Meta:
        model = Planting
        fields = ["id", "crop_stand", "year_planted", "source", "qty_planted", "notes", "varieties"]
        read_only_fields = fields


class PlantingWriteSerializer(serializers.ModelSerializer[Planting]):
    source = serializers.PrimaryKeyRelatedField(  # type: ignore[assignment]
        queryset=MaterialSource.objects.all(), allow_null=True, required=False
    )
    varieties = serializers.PrimaryKeyRelatedField(
        queryset=Variety.objects.all(), many=True, required=False
    )

    class Meta:
        model = Planting
        fields = ["year_planted", "source", "qty_planted", "notes", "varieties"]


class CropStandSerializer(serializers.ModelSerializer[CropStand]):
    commodity = CodeRefSerializer(read_only=True)
    plantings = PlantingSerializer(many=True, read_only=True)

    class Meta:
        model = CropStand
        fields = ["id", "farm", "commodity", "spacing_m", "attributes", "plantings"]
        read_only_fields = fields


class CropStandWriteSerializer(serializers.ModelSerializer[CropStand]):
    commodity = serializers.PrimaryKeyRelatedField(queryset=Commodity.objects.all())

    class Meta:
        model = CropStand
        fields = ["commodity", "spacing_m", "attributes"]


class CropStandUpdateSerializer(serializers.ModelSerializer[CropStand]):
    class Meta:
        model = CropStand
        fields = ["spacing_m", "attributes"]


class FarmSerializer(PersonalFieldsMixin, serializers.ModelSerializer[Farm]):
    personal_fields = (*Farm.PERSONAL_FIELDS, "farmer_name")

    farmer_name = serializers.CharField(source="farmer.display_name", read_only=True)
    barangay = RefSerializer(read_only=True)
    municipality = RefSerializer(source="barangay.municipality", read_only=True)
    tenure = serializers.CharField(read_only=True)  # "" when not recorded
    location = serializers.SerializerMethodField()
    crop_stands = CropStandSerializer(many=True, read_only=True)

    class Meta:
        model = Farm
        fields = [
            "id",
            "farmer",
            "farmer_name",
            "barangay",
            "municipality",
            "sitio",
            "location",
            "declared_area_ha",
            "tenure",
            "location_raw",
            "crop_stands",
        ]
        read_only_fields = fields

    @extend_schema_field(LONLAT_SCHEMA)
    def get_location(self, obj: Farm) -> dict[str, float] | None:
        if obj.location is None:
            return None
        return {"lon": obj.location.x, "lat": obj.location.y}


@extend_schema_field(LONLAT_SCHEMA)
class LonLatField(serializers.Field[Any, Any, Any, Any]):
    """{"lon": 121.9, "lat": 13.4} <-> Point (WGS84), limited to the Philippines' bounding box."""

    def to_internal_value(self, data: Any) -> Any:
        from django.contrib.gis.geos import Point

        try:
            lon, lat = float(data["lon"]), float(data["lat"])
        except (TypeError, KeyError, ValueError):
            raise serializers.ValidationError('Expected {"lon": number, "lat": number}.') from None
        if not (116 <= lon <= 127 and 4 <= lat <= 22):
            raise serializers.ValidationError("Location must be within the Philippines.")
        return Point(lon, lat, srid=4326)

    def to_representation(self, value: Any) -> Any:
        return {"lon": value.x, "lat": value.y}


class FarmPointSerializer(serializers.Serializer[Any]):
    """No names: the point links to the farmer's page, where access is checked again."""

    id = serializers.UUIDField()
    farmer = serializers.UUIDField()
    lon = serializers.FloatField()
    lat = serializers.FloatField()
    barangay = serializers.CharField()
    municipality = serializers.CharField()


class FarmPointsSerializer(serializers.Serializer[Any]):
    results = FarmPointSerializer(many=True)
    total_farms = serializers.IntegerField()
    located = serializers.IntegerField()


class FarmWriteSerializer(serializers.ModelSerializer[Farm]):
    barangay = serializers.PrimaryKeyRelatedField(queryset=Barangay.objects.all())
    location = LonLatField(required=False, allow_null=True)

    class Meta:
        model = Farm
        fields = [
            "farmer",
            "barangay",
            "sitio",
            "location",
            "declared_area_ha",
            "tenure",
            "location_raw",
        ]
        extra_kwargs = {"farmer": {"required": False}}
