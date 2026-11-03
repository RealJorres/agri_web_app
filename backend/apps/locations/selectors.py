"""Map reads. Boundaries are public geography (reference data): not personal and not scoped; the
figures drawn on them come from the scoped analytics endpoints."""

import json
from typing import Any
from uuid import UUID

from django.contrib.gis.db.models import GeometryField
from django.contrib.gis.db.models.functions import AsGeoJSON
from django.db.models import F, Func, Value

from .models import Barangay, Municipality

# About 20 m: invisible at the zooms the choropleth is read at, and keeps responses small.
SIMPLIFY_TOLERANCE_DEG = 0.0002
COORDINATE_DECIMALS = 5


def boundary_counts() -> dict[str, int]:
    return {
        "municipality_boundaries": Municipality.objects.filter(boundary__isnull=False).count(),
        "barangay_boundaries": Barangay.objects.filter(boundary__isnull=False).count(),
    }


def boundary_features(*, level: str, municipality: UUID | None = None) -> dict[str, Any]:
    """A GeoJSON FeatureCollection. The id is in properties because MapLibre needs numeric
    top-level feature ids; it joins on properties.id instead."""
    rows: Any
    if level == "barangay":
        rows = Barangay.objects.filter(boundary__isnull=False)
        if municipality:
            rows = rows.filter(municipality_id=municipality)
    else:
        rows = Municipality.objects.filter(boundary__isnull=False)
        if municipality:
            rows = rows.filter(pk=municipality)
    simplified = Func(
        F("boundary"),
        Value(SIMPLIFY_TOLERANCE_DEG),
        function="ST_SimplifyPreserveTopology",
        output_field=GeometryField(srid=4326),
    )
    annotated = rows.annotate(shape=AsGeoJSON(simplified, precision=COORDINATE_DECIMALS))
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"id": str(pk), "name": name},
                "geometry": json.loads(shape),
            }
            for pk, name, shape in annotated.values_list("pk", "name", "shape")
        ],
    }
