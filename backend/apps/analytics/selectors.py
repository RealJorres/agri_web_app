"""Dashboard figures from the analytics views, limited to the caller's scope (view_aggregates)."""

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID

from django.db.models import Count, QuerySet, Sum

from apps.accounts.roles import Cap
from apps.accounts.selectors import Scope
from apps.catalog.models import Commodity, GrowthStage, MeasureType
from apps.catalog.selectors import plants_per_ha
from apps.farms.models import Planting, PlantingVariety
from apps.surveys.models import SurveyRound
from common.scoping import scope_queryset

from .models import RecordFact, StageTotal

PROGRAM_PATH = "survey_round__commodity__program"
FARM_SIZE_BUCKETS = [(1, 49), (50, 99), (100, 249), (250, 499), (500, 999), (1000, None)]


def stage_rows(scope: Scope, **filters: Any) -> QuerySet[StageTotal]:
    return scope_queryset(
        StageTotal.objects.filter(**filters),
        scope,
        Cap.VIEW_AGGREGATES,
        barangay_path="barangay",
        program_path=PROGRAM_PATH,
    )


def fact_rows(scope: Scope, **filters: Any) -> QuerySet[RecordFact]:
    return scope_queryset(
        RecordFact.objects.filter(**filters),
        scope,
        Cap.VIEW_AGGREGATES,
        barangay_path="barangay",
        program_path=PROGRAM_PATH,
    )


def _area(commodity: Commodity, trees: int, area: Decimal | None) -> Decimal | None:
    if commodity.measure_type == MeasureType.AREA:
        return area
    density = plants_per_ha(commodity)
    if not density:
        return None
    return (Decimal(trees) / Decimal(str(density))).quantize(Decimal("0.01"), ROUND_HALF_UP)


@dataclass
class Totals:
    trees: int = 0
    area_ha: Decimal | None = None
    farmers: int = 0
    records: int = 0
    bearing_trees: int = 0
    stages: dict[str, int] = field(default_factory=dict)

    @property
    def bearing_share(self) -> float | None:
        return round(self.bearing_trees / self.trees, 4) if self.trees else None

    @property
    def trees_per_farm(self) -> float | None:
        return round(self.trees / self.records, 1) if self.records else None


def _totals(survey_round: SurveyRound, scope: Scope, **filters: Any) -> Totals:
    commodity = survey_round.commodity
    by_stage = {
        r["growth_stage__code"]: r["trees"]
        for r in stage_rows(scope, survey_round=survey_round, **filters)
        .values("growth_stage__code")
        .annotate(trees=Sum("trees"))
    }
    facts = fact_rows(scope, survey_round=survey_round, **filters).aggregate(
        trees=Sum("trees"),
        bearing=Sum("bearing_trees"),
        records=Count("id"),
        farmers=Count("farmer", distinct=True),
    )
    trees = int(facts["trees"] or 0)
    return Totals(
        trees=trees,
        area_ha=_area(commodity, trees, None),
        farmers=facts["farmers"],
        records=facts["records"],
        bearing_trees=int(facts["bearing"] or 0),
        stages={code: int(v or 0) for code, v in by_stage.items()},
    )


def previous_round(survey_round: SurveyRound, scope: Scope, **filters: Any) -> SurveyRound | None:
    """The latest earlier round of the same commodity with official data in scope."""
    earlier = SurveyRound.objects.filter(
        commodity=survey_round.commodity, as_of_date__lt=survey_round.as_of_date
    ).order_by("-as_of_date")
    for candidate in earlier:
        if fact_rows(scope, survey_round=candidate, **filters).exists():
            return candidate
    return None


def overview(
    survey_round: SurveyRound, scope: Scope, *, municipality: UUID | None = None
) -> dict[str, Any]:
    filters: dict[str, Any] = {"municipality_id": municipality} if municipality else {}
    stages = list(
        GrowthStage.objects.filter(commodity=survey_round.commodity).order_by("sort_order")
    )
    current = _totals(survey_round, scope, **filters)
    prev_round = previous_round(survey_round, scope, **filters)
    prev = _totals(prev_round, scope, **filters) if prev_round else None

    def delta(now: float | int | None, before: float | int | None) -> float | int | None:
        if prev is None or now is None or before is None:
            return None
        return round(now - before, 4) if isinstance(now, float) else now - before

    return {
        "round": survey_round,
        "previous_round": prev_round,
        "trees": current.trees,
        "area_ha": current.area_ha,
        "farmers": current.farmers,
        "records": current.records,
        "bearing_trees": current.bearing_trees,
        "bearing_share": current.bearing_share,
        "trees_per_farm": current.trees_per_farm,
        "stages": [
            {
                "code": s.code,
                "label": s.label,
                "is_bearing": s.is_bearing,
                "trees": current.stages.get(s.code, 0),
                "area_ha": _area(survey_round.commodity, current.stages.get(s.code, 0), None),
                "change": delta(current.stages.get(s.code, 0), prev.stages.get(s.code, 0))
                if prev
                else None,
            }
            for s in stages
        ],
        "change": {
            "trees": delta(current.trees, prev.trees if prev else None),
            "farmers": delta(current.farmers, prev.farmers if prev else None),
            "bearing_share": delta(current.bearing_share, prev.bearing_share if prev else None),
        },
    }


def breakdown(
    survey_round: SurveyRound, scope: Scope, *, level: str, municipality: UUID | None = None
) -> list[dict[str, Any]]:
    """Per municipality (or per barangay, optionally within one municipality)."""
    key = "barangay" if level == "barangay" else "municipality"
    filters: dict[str, Any] = {"municipality_id": municipality} if municipality else {}
    commodity = survey_round.commodity
    rows: dict[UUID, dict[str, Any]] = {}

    stage_q = stage_rows(scope, survey_round=survey_round, **filters)
    for r in stage_q.values(f"{key}_id", f"{key}__name", "growth_stage__code").annotate(
        t=Sum("trees")
    ):
        row = rows.setdefault(
            r[f"{key}_id"],
            {"id": r[f"{key}_id"], "name": r[f"{key}__name"], "stages": defaultdict(int)},
        )
        row["stages"][r["growth_stage__code"]] += int(r["t"] or 0)

    facts = fact_rows(scope, survey_round=survey_round, **filters)
    for f in facts.values(f"{key}_id").annotate(
        trees=Sum("trees"),
        bearing=Sum("bearing_trees"),
        records=Count("id"),
        farmers=Count("farmer", distinct=True),
    ):
        found = rows.get(f[f"{key}_id"])
        if found is None:  # a record with no stage counts at all
            continue
        trees = int(f["trees"] or 0)
        found.update(
            trees=trees,
            area_ha=_area(commodity, trees, None),
            farmers=f["farmers"],
            records=f["records"],
            bearing_share=round(int(f["bearing"] or 0) / trees, 4) if trees else None,
        )
    out = []
    for row in rows.values():
        row.setdefault("trees", sum(row["stages"].values()))
        row.setdefault("area_ha", _area(commodity, row["trees"], None))
        row.setdefault("farmers", 0)
        row.setdefault("records", 0)
        row.setdefault("bearing_share", None)
        row["stages"] = dict(row["stages"])
        out.append(row)
    return sorted(out, key=lambda r: (-r["trees"], r["name"]))


def trends(
    commodity: Commodity, scope: Scope, *, municipality: UUID | None = None
) -> list[dict[str, Any]]:
    """Totals per round (oldest first) for rounds with official data in scope."""
    filters: dict[str, Any] = {"municipality_id": municipality} if municipality else {}
    out = []
    for survey_round in SurveyRound.objects.filter(commodity=commodity).order_by("as_of_date"):
        totals = _totals(survey_round, scope, **filters)
        if totals.records == 0:
            continue
        out.append(
            {
                "round": survey_round,
                "trees": totals.trees,
                "farmers": totals.farmers,
                "bearing_share": totals.bearing_share,
                "stages": totals.stages,
            }
        )
    return out


def distribution(
    survey_round: SurveyRound, scope: Scope, *, municipality: UUID | None = None
) -> dict[str, Any]:
    """Farm sizes (trees per record), planting years and varieties of official stands in scope."""
    filters: dict[str, Any] = {"municipality_id": municipality} if municipality else {}
    facts = fact_rows(scope, survey_round=survey_round, **filters)
    sizes = []
    for low, high in FARM_SIZE_BUCKETS:
        bucket = facts.filter(trees__gte=low)
        if high is not None:
            bucket = bucket.filter(trees__lte=high)
        label = f"{low:,}-{high:,}" if high is not None else f"{low:,}+"
        sizes.append({"label": label, "farms": bucket.count()})
    zero = facts.filter(trees=0).count()
    if zero:
        sizes.insert(0, {"label": "0", "farms": zero})

    stands = facts.values("crop_stand_id")
    years = (
        Planting.objects.filter(crop_stand_id__in=stands)
        .values("year_planted")
        .annotate(stands=Count("crop_stand", distinct=True))
        .order_by("year_planted")
    )
    varieties = (
        PlantingVariety.objects.filter(
            planting__crop_stand_id__in=stands, planting__deleted_at__isnull=True
        )
        .values("variety__code", "variety__name")
        .annotate(stands=Count("planting__crop_stand", distinct=True))
        .order_by("-stands", "variety__code")
    )
    total_stands = facts.count()
    with_variety = (
        PlantingVariety.objects.filter(planting__crop_stand_id__in=stands)
        .values("planting__crop_stand")
        .distinct()
        .count()
    )
    return {
        "farm_sizes": sizes,
        "planting_years": [
            {"year": y["year_planted"], "stands": y["stands"]} for y in years if y["year_planted"]
        ],
        "planting_year_unknown": total_stands
        - Planting.objects.filter(crop_stand_id__in=stands, year_planted__isnull=False)
        .values("crop_stand")
        .distinct()
        .count(),
        "varieties": [
            {"code": v["variety__code"], "name": v["variety__name"], "stands": v["stands"]}
            for v in varieties
        ],
        "variety_unknown": total_stands - with_variety,
        "stands": total_stands,
    }
