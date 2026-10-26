"""Reads for rounds, records and the official numbers. Totals are always computed from approved
(or locked) records at query time; nothing is stored (brief rule 2.1)."""

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast
from uuid import UUID

from django.db.models import Count, Q, QuerySet, Sum

from apps.accounts.roles import Cap
from apps.accounts.selectors import Scope
from apps.catalog.models import Commodity, GrowthStage
from apps.catalog.selectors import plants_per_ha
from apps.farms.models import CropStand, Farm
from apps.registry.models import Farmer
from common.scoping import scope_q, scope_queryset

from .models import OFFICIAL_STATUSES, InventoryRecord, RecordStatus, StageCount, SurveyRound

RECORD_BARANGAY = "crop_stand__farm__barangay"
RECORD_PROGRAM = "crop_stand__commodity__program"


def records_for(scope: Scope, capability: Cap = Cap.VIEW_RECORDS) -> QuerySet[InventoryRecord]:
    return scope_queryset(
        InventoryRecord.objects.select_related(
            "survey_round__commodity",
            "crop_stand__commodity",
            "crop_stand__farm__barangay__municipality",
            "crop_stand__farm__farmer",
        ),
        scope,
        capability,
        barangay_path=RECORD_BARANGAY,
        program_path=RECORD_PROGRAM,
    )


def rounds_for(scope: Scope) -> QuerySet[SurveyRound]:
    """Rounds are not personal data: visible to everyone whose grants cover the program."""
    program_ids = {g.program_id for g in scope.grants_with(Cap.VIEW_AGGREGATES)}
    queryset = SurveyRound.objects.select_related("commodity__program")
    if not program_ids:
        return queryset.none()
    if None in program_ids:
        return queryset
    return queryset.filter(commodity__program_id__in=program_ids)


def _aggregate_scope(scope: Scope) -> Q | None:
    return scope_q(
        scope, Cap.VIEW_AGGREGATES, barangay_path=RECORD_BARANGAY, program_path=RECORD_PROGRAM
    )


@dataclass(frozen=True)
class StageTotal:
    municipality_id: UUID
    municipality: str
    stage_code: str
    stage_label: str
    sort_order: int
    count: int
    area_ha: Decimal | None


def stage_totals(survey_round: SurveyRound, scope: Scope) -> list[StageTotal]:
    """Official totals per municipality x stage for one round (approved/locked records only)."""
    q = _aggregate_scope(scope)
    if q is None:
        return []
    commodity = survey_round.commodity
    density = plants_per_ha(commodity)
    rows = (
        StageCount.objects.filter(
            _prefix(q),
            inventory_record__survey_round=survey_round,
            inventory_record__status__in=OFFICIAL_STATUSES,
            inventory_record__deleted_at__isnull=True,
        )
        .values(
            "inventory_record__crop_stand__farm__barangay__municipality_id",
            "inventory_record__crop_stand__farm__barangay__municipality__name",
            "growth_stage__code",
            "growth_stage__label",
            "growth_stage__sort_order",
        )
        .annotate(count=Sum("count"), area=Sum("area_ha"))
        .order_by(
            "inventory_record__crop_stand__farm__barangay__municipality__name",
            "growth_stage__sort_order",
        )
    )
    out = []
    for r in rows:
        count = r["count"] or 0
        if commodity.measure_type == "area":
            area = r["area"]
        else:
            area = (Decimal(count) / Decimal(str(density))) if density else None
        out.append(
            StageTotal(
                municipality_id=r["inventory_record__crop_stand__farm__barangay__municipality_id"],
                municipality=r["inventory_record__crop_stand__farm__barangay__municipality__name"],
                stage_code=r["growth_stage__code"],
                stage_label=r["growth_stage__label"],
                sort_order=r["growth_stage__sort_order"],
                count=count,
                area_ha=area,
            )
        )
    return out


def _prefix(q: Q, prefix: str = "inventory_record__") -> Q:
    """Re-root a Q built for InventoryRecord so it applies to StageCount."""
    out = Q()
    out.connector, out.negated = q.connector, q.negated
    for child in q.children:
        if isinstance(child, Q):
            out.children.append(_prefix(child, prefix))
        else:
            key, value = cast(tuple[str, Any], child)
            out.children.append((f"{prefix}{key}", value))
    return out


def round_progress(survey_round: SurveyRound, scope: Scope) -> list[dict[str, Any]]:
    """Per municipality: expected crop stands vs records by status (aggregate, no names)."""
    q = scope_q(
        scope,
        Cap.VIEW_AGGREGATES,
        barangay_path="farm__barangay",
        program_path="commodity__program",
    )
    if q is None:
        return []
    expected = (
        CropStand.objects.filter(q, commodity=survey_round.commodity)
        .values("farm__barangay__municipality_id", "farm__barangay__municipality__name")
        .annotate(n=Count("id"))
    )
    by_status = (
        InventoryRecord.objects.filter(_prefix(q, "crop_stand__"), survey_round=survey_round)
        .values("crop_stand__farm__barangay__municipality_id", "status")
        .annotate(n=Count("id"))
    )
    rows: dict[UUID, dict[str, Any]] = {}
    for e in expected:
        rows[e["farm__barangay__municipality_id"]] = {
            "municipality_id": e["farm__barangay__municipality_id"],
            "municipality": e["farm__barangay__municipality__name"],
            "expected": e["n"],
            **dict.fromkeys(RecordStatus.values, 0),
        }
    for s in by_status:
        row = rows.get(s["crop_stand__farm__barangay__municipality_id"])
        if row is not None:
            row[s["status"]] = s["n"]
    return sorted(rows.values(), key=lambda r: r["municipality"])


def latest_official_round(commodity: Commodity) -> SurveyRound | None:
    return (
        SurveyRound.objects.filter(commodity=commodity, records__status__in=OFFICIAL_STATUSES)
        .distinct()
        .order_by("-as_of_date")
        .first()
    )


def home_stats(scope: Scope) -> dict[str, Any]:
    """Headline numbers for the home page, limited to the user's scope."""
    farmer_q = scope_q(scope, Cap.VIEW_AGGREGATES, barangay_path="home_barangay")
    farm_q = scope_q(scope, Cap.VIEW_AGGREGATES, barangay_path="barangay")
    commodities = []
    for commodity in Commodity.objects.order_by("name"):
        survey_round = latest_official_round(commodity)
        if survey_round is None:
            continue
        totals = stage_totals(survey_round, scope)
        stages = []
        for stage in GrowthStage.objects.filter(commodity=commodity).order_by("sort_order"):
            matching = [t for t in totals if t.stage_code == stage.code]
            count = sum(t.count for t in matching)
            area = sum((t.area_ha or Decimal(0) for t in matching), Decimal(0))
            stages.append(
                {
                    "code": stage.code,
                    "label": stage.label,
                    "count": count,
                    "area_ha": round(area, 2),
                }
            )
        commodities.append(
            {
                "commodity": {
                    "id": str(commodity.pk),
                    "code": commodity.code,
                    "name": commodity.name,
                },
                "round": {"id": str(survey_round.pk), "name": survey_round.name},
                "stages": stages,
                "total": sum(s["count"] for s in stages),
                "total_area_ha": round(sum((s["area_ha"] for s in stages), Decimal(0)), 2),
            }
        )
    return {
        "farmers": Farmer.objects.filter(farmer_q).count() if farmer_q is not None else 0,
        "farms": Farm.objects.filter(farm_q).count() if farm_q is not None else 0,
        "commodities": commodities,
    }
