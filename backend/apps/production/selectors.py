"""Harvest summaries (ADR-0018). Computed from harvest rows on every request; nothing is stored.

Kilograms are kept per product form (wet and dried beans are not comparable weights), and sacks or
other units are never converted to kg: the PAO has not given a sack weight.
"""

from decimal import Decimal
from typing import Any
from uuid import UUID

from django.db.models import Count, Q, Sum
from django.db.models.functions import ExtractYear

from apps.accounts.roles import Cap
from apps.accounts.selectors import Scope
from common.scoping import scope_queryset

from .models import Harvest, HarvestUnit, ProductForm

KG_FORMS = [f.value for f in ProductForm]
MUNICIPALITY = "crop_stand__farm__barangay__municipality"


def harvests_for(scope: Scope, capability: Cap = Cap.VIEW_AGGREGATES) -> Any:
    return scope_queryset(
        Harvest.objects.all(),
        scope,
        capability,
        barangay_path="crop_stand__farm__barangay",
        program_path="crop_stand__commodity__program",
    )


def harvest_summary(
    scope: Scope, *, commodity: UUID | None = None, year: int | None = None
) -> dict[str, Any]:
    """Per municipality: harvests, farmers, kg by product form, sacks, other-unit entries."""
    base = harvests_for(scope)
    if commodity is not None:
        base = base.filter(crop_stand__commodity_id=commodity)
    years = list(
        base.filter(harvest_date__isnull=False)
        .annotate(y=ExtractYear("harvest_date"))
        .order_by("y")  # clear the model ordering, or DISTINCT also keys on harvest_date
        .values_list("y", flat=True)
        .distinct()
    )
    undated = 0
    if year is not None:
        undated = base.filter(harvest_date__isnull=True).count()
        base = base.filter(harvest_date__year=year)

    kg = {
        f"kg_{form}": Sum("quantity", filter=Q(unit=HarvestUnit.KG, product_form=form))
        for form in KG_FORMS
    }
    rows = (
        base.values(f"{MUNICIPALITY}_id", f"{MUNICIPALITY}__name")
        .annotate(
            harvests=Count("id"),
            farmers=Count("crop_stand__farm__farmer", distinct=True),
            sacks=Sum("quantity", filter=Q(unit=HarvestUnit.SACK)),
            other_entries=Count("id", filter=Q(unit=HarvestUnit.OTHER)),
            estimated_dates=Count("id", filter=Q(date_estimated=True)),
            **kg,
        )
        .order_by(f"{MUNICIPALITY}__name")
    )
    zero = Decimal("0")
    out = [
        {
            "municipality_id": r[f"{MUNICIPALITY}_id"],
            "municipality": r[f"{MUNICIPALITY}__name"],
            "harvests": r["harvests"],
            "farmers": r["farmers"],
            "kg": {form: r[f"kg_{form}"] or zero for form in KG_FORMS},
            "sacks": r["sacks"] or zero,
            "other_entries": r["other_entries"],
            "estimated_dates": r["estimated_dates"],
        }
        for r in rows
    ]
    return {"year": year, "years": years, "undated_excluded": undated, "rows": out}
