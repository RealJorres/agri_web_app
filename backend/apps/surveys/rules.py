"""Validation rules for inventory records (brief §8).

Each rule returns Issues. Errors block submission; warnings are stored in record.flags.
"""

import dataclasses
import statistics
from dataclasses import asdict, dataclass
from decimal import Decimal
from typing import Any, Literal

from django.conf import settings
from django.db.models import Sum

from apps.catalog.models import MeasureType
from apps.registry.models import Farmer
from apps.registry.selectors import find_duplicate_farmers

from .models import InventoryRecord, RecordStatus, StageCount

MIN_OUTLIER_SAMPLE = 5


@dataclass(frozen=True)
class Issue:
    level: Literal["error", "warning"]
    code: str
    message: str
    field: str = ""
    data: dict[str, Any] = dataclasses.field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def stand_total(counts: list[StageCount], measure_type: str) -> Decimal:
    """Sum of a record's measured quantity: trees for tree crops, hectares for area crops."""
    if measure_type == MeasureType.AREA:
        return sum((c.area_ha or Decimal(0) for c in counts), Decimal(0))
    return Decimal(sum(c.count or 0 for c in counts))


def check_counts(counts: list[StageCount], measure_type: str) -> list[Issue]:
    issues = []
    for c in counts:
        value = c.area_ha if measure_type == MeasureType.AREA else c.count
        if value is not None and value < 0:
            issues.append(
                Issue(
                    "error",
                    "negative_count",
                    "Counts cannot be negative.",
                    f"stage.{c.growth_stage_id}",
                )
            )
    return issues


def check_not_empty(counts: list[StageCount], measure_type: str, remarks: str) -> list[Issue]:
    if stand_total(counts, measure_type) > 0 or remarks.strip():
        return []
    return [
        Issue(
            "error",
            "empty_record",
            "Enter at least one stage count, or explain in the remarks why there is none.",
            "counts",
        )
    ]


def check_farm_barangay(record: InventoryRecord) -> list[Issue]:
    if record.crop_stand.farm.barangay_id:
        return []
    return [Issue("error", "barangay_required", "The farm has no barangay.", "farm")]


def check_outlier(record: InventoryRecord, counts: list[StageCount]) -> list[Issue]:
    """Warn when this stand exceeds outlier_multiplier x the municipal median of the round."""
    commodity = record.crop_stand.commodity
    measure = commodity.measure_type
    value_field = "area_ha" if measure == MeasureType.AREA else "count"
    municipality_id = record.crop_stand.farm.barangay.municipality_id
    peers = (
        InventoryRecord.objects.filter(
            survey_round_id=record.survey_round_id,
            crop_stand__farm__barangay__municipality_id=municipality_id,
        )
        .exclude(pk=record.pk)
        .exclude(status=RecordStatus.DRAFT)
        .annotate(total=Sum(f"stage_counts__{value_field}"))
        .values_list("total", flat=True)
    )
    totals = [Decimal(t or 0) for t in peers]
    if len(totals) < MIN_OUTLIER_SAMPLE:
        return []
    median = Decimal(statistics.median(totals))
    limit = commodity.outlier_multiplier * median
    total = stand_total(counts, measure)
    if median <= 0 or total <= limit:
        return []
    return [
        Issue(
            "warning",
            "outlier",
            f"Total {total:,} is more than {commodity.outlier_multiplier}x the municipal median "
            f"({median:,}). Please double-check.",
            "counts",
            {"total": str(total), "median": str(median), "sample": len(totals)},
        )
    ]


def check_duplicate_farmer(farmer: Farmer) -> list[Issue]:
    """Warn on a likely duplicate in the same municipality (or same RSBSA). Ids only, no names."""
    candidates = find_duplicate_farmers(
        Farmer.objects.all(),
        name=farmer.display_name,
        municipality_id=farmer.home_barangay.municipality_id,
        rsbsa_no=farmer.rsbsa_no,
        exclude_id=farmer.pk,
        threshold=settings.DUPLICATE_WARN_SIMILARITY,
    )
    if not candidates:
        return []
    return [
        Issue(
            "warning",
            "possible_duplicate_farmer",
            "This farmer may already be registered. Review and merge if they are the same person.",
            "farmer",
            {
                "candidates": [
                    {"id": str(c.farmer.pk), "similarity": c.similarity, "reason": c.reason}
                    for c in candidates
                ]
            },
        )
    ]


def evaluate(record: InventoryRecord) -> list[Issue]:
    counts = list(record.stage_counts.all())
    measure = record.crop_stand.commodity.measure_type
    return [
        *check_counts(counts, measure),
        *check_not_empty(counts, measure, record.remarks),
        *check_farm_barangay(record),
        *check_outlier(record, counts),
        *check_duplicate_farmer(record.crop_stand.farm.farmer),
    ]
