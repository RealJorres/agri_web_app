"""Report content: plain dicts built from LIVE official records (not the analytics views), so a
report is always the authoritative figure. Renderers (xlsx/pdf) only lay these dicts out."""

import hashlib
import json
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.db.models import Count, Sum

from apps.accounts.selectors import Scope
from apps.catalog.models import GrowthStage
from apps.catalog.selectors import plants_per_ha
from apps.surveys.models import OFFICIAL_STATUSES, InventoryRecord, RoundStatus, SurveyRound
from apps.surveys.selectors import stage_totals

from .models import ReportKind, ReportSettings, Signatory

AREA_PLACES = Decimal("0.001")  # the 2023 SUMMARY sheet shows area to 3 decimals


def _common(survey_round: SurveyRound, kind: str) -> dict[str, Any]:
    settings = ReportSettings.current()
    return {
        "kind": kind,
        "letterhead": [line for line in settings.letterhead.splitlines() if line.strip()],
        "program_line": settings.program_line,
        "round": {
            "id": str(survey_round.pk),
            "name": survey_round.name,
            "as_of": survey_round.as_of_date.isoformat(),
        },
        "commodity": survey_round.commodity.name,
        "final": survey_round.status == RoundStatus.CLOSED,
        "signatories": [
            {"caption": s.caption, "name": s.name, "title": s.title}
            for s in Signatory.objects.filter(report_kind=kind).order_by("order")
        ],
    }


def _area(trees: int, density: float | None) -> Decimal | None:
    if not density:
        return None
    return (Decimal(trees) / Decimal(str(density))).quantize(AREA_PLACES, ROUND_HALF_UP)


def summary(survey_round: SurveyRound, scope: Scope) -> dict[str, Any]:
    """The provincial summary in the layout of the 2023 SUMMARY sheet."""
    commodity = survey_round.commodity
    density = plants_per_ha(commodity)
    stages = list(GrowthStage.objects.filter(commodity=commodity).order_by("sort_order"))
    by_town: dict[str, dict[str, int]] = defaultdict(dict)
    for t in stage_totals(survey_round, scope):
        by_town[t.municipality][t.stage_code] = t.count

    # "No. of farmers" as in the 2023 sheet: distinct farmers with at least one tree counted.
    # Filter per RECORD first (a subquery), then count distinct farmers per municipality;
    # filtering after the GROUP BY would test the municipality's total instead.
    with_trees = (
        InventoryRecord.objects.filter(
            survey_round=survey_round, status__in=OFFICIAL_STATUSES, deleted_at__isnull=True
        )
        .annotate(trees=Sum("stage_counts__count"))
        .filter(trees__gt=0)
        .values("id")
    )
    farmers = dict(
        InventoryRecord.objects.filter(id__in=with_trees)
        .values("crop_stand__farm__barangay__municipality__name")
        .annotate(n=Count("crop_stand__farm__farmer", distinct=True))
        .values_list("crop_stand__farm__barangay__municipality__name", "n")
    )
    rows = []
    for town in sorted(by_town):
        trees = [by_town[town].get(s.code, 0) for s in stages]
        areas = [_area(t, density) for t in trees]
        rows.append(
            {
                "municipality": town,
                "farmers": farmers.get(town, 0),
                "trees": trees,
                "trees_total": sum(trees),
                "area": areas,
                "area_total": _area(sum(trees), density),
            }
        )
    total_trees = [sum(r["trees"][i] for r in rows) for i in range(len(stages))]
    spacing = f"{commodity.spacing_m.normalize():f}" if commodity.spacing_m else ""
    content = _common(survey_round, ReportKind.SUMMARY)
    content.update(
        stages=[s.label for s in stages],
        rows=rows,
        total={
            "farmers": sum(r["farmers"] for r in rows),
            "trees": total_trees,
            "trees_total": sum(total_trees),
            "area": [_area(t, density) for t in total_trees],
            "area_total": _area(sum(total_trees), density),
        },
        density_note=(
            f"{int(density):,} {commodity.name.lower()} trees/hectare"
            + (f" with {spacing}x{spacing} planting distance" if commodity.spacing_m else "")
            if density
            else ""
        ),
    )
    return content


def municipal_list(survey_round: SurveyRound, scope: Scope, municipality_id: Any) -> dict[str, Any]:
    """Farmer-level list for one municipality (personal data: callers must check the capability)."""
    from apps.surveys.selectors import records_for

    stages = list(
        GrowthStage.objects.filter(commodity=survey_round.commodity).order_by("sort_order")
    )
    records = (
        records_for(scope)
        .filter(
            survey_round=survey_round,
            status__in=OFFICIAL_STATUSES,
            crop_stand__farm__barangay__municipality_id=municipality_id,
        )
        .prefetch_related(
            "stage_counts__growth_stage",
            "crop_stand__plantings__varieties",
            "crop_stand__plantings__source",
            "crop_stand__farm__farmer__memberships__association",
        )
        .order_by("crop_stand__farm__farmer__last_name", "crop_stand__farm__farmer__first_name")
    )
    town = ""
    rows: list[dict[str, Any]] = []
    for number, record in enumerate(records, start=1):
        farm = record.crop_stand.farm
        farmer = farm.farmer
        town = farm.barangay.municipality.name
        plantings = list(record.crop_stand.plantings.all())
        counts = {c.growth_stage.code: c.count for c in record.stage_counts.all()}
        rows.append(
            {
                "no": number,
                "name": farmer.display_name,
                "barangay": farmer.home_barangay.name,
                "farm_location": farm.barangay.name,
                "association": ", ".join(m.association.name for m in farmer.memberships.all()),
                "contact": farmer.contact_no,
                "variety": ", ".join(
                    sorted({v.code for p in plantings for v in p.varieties.all()})
                ),
                "planted": ", ".join(
                    str(y) for y in sorted({p.year_planted for p in plantings if p.year_planted})
                ),
                "source": ", ".join(sorted({p.source.name for p in plantings if p.source})),
                "counts": [counts.get(s.code) for s in stages],
                "remarks": record.remarks,
            }
        )
    content = _common(survey_round, ReportKind.MUNICIPAL_LIST)
    content.update(
        municipality=town,
        stages=[s.label for s in stages],
        rows=rows,
        totals=[sum(r["counts"][i] or 0 for r in rows) for i in range(len(stages))],
    )
    return content


def content_hash(content: dict[str, Any]) -> str:
    """SHA-256 of the canonical content (ADR-0015). Draft/final state is not part of the hash."""
    canonical = {k: v for k, v in content.items() if k != "final"}
    payload = json.dumps(canonical, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()
