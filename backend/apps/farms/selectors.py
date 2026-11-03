"""Farm reads for the map. A farm's location is personal data (Farm.PERSONAL_FIELDS)."""

from typing import Any
from uuid import UUID

from apps.accounts.roles import Cap
from apps.accounts.selectors import Scope
from common.scoping import scope_queryset

from .models import Farm


def farm_points(scope: Scope, *, municipality: UUID | None = None) -> dict[str, Any]:
    """Located farms in scope, and how many farms in scope have no location yet."""
    farms = scope_queryset(
        Farm.objects.all(), scope, Cap.VIEW_PERSONAL_DATA, barangay_path="barangay"
    )
    if municipality:
        farms = farms.filter(barangay__municipality_id=municipality)
    located = farms.filter(location__isnull=False).select_related("barangay__municipality")
    results = [
        {
            "id": farm.pk,
            "farmer": farm.farmer_id,
            "lon": farm.location.x,
            "lat": farm.location.y,
            "barangay": farm.barangay.name,
            "municipality": farm.barangay.municipality.name,
        }
        for farm in located
    ]
    return {"results": results, "total_farms": farms.count(), "located": len(results)}
