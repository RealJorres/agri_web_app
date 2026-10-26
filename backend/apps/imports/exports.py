"""Excel exports of farmer and inventory lists with the caller's current filters.

Both contain personal data: they require the export_personal_data capability and every export
is audited with the filters used and the row count (never the rows themselves)."""

import io
from typing import Any

from django.db.models import Prefetch, QuerySet
from openpyxl import Workbook
from openpyxl.styles import Font

from apps.accounts.models import User
from apps.audit import services as audit
from apps.registry.models import Farmer
from apps.surveys.models import InventoryRecord, StageCount

MAX_EXPORT_ROWS = 20_000


def _workbook(title: str, headers: list[str], rows: list[list[Any]]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(row)
    ws.freeze_panes = "A2"
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def export_farmers(*, actor: User, queryset: QuerySet[Farmer], filters: dict[str, Any]) -> bytes:
    farmers = list(
        queryset.select_related("home_barangay__municipality")
        .prefetch_related("memberships__association")
        .order_by("home_barangay__municipality__name", "last_name", "first_name")[:MAX_EXPORT_ROWS]
    )
    rows = [
        [
            f.last_name,
            f.first_name,
            f.middle_name,
            f.suffix,
            f.sex,
            f.birth_year,
            f.rsbsa_no,
            f.contact_no,
            f.home_barangay.name,
            f.home_barangay.municipality.name,
            "; ".join(m.association.name for m in f.memberships.all()),
            f.status,
            "Y" if f.consent_at else "",
        ]
        for f in farmers
    ]
    data = _workbook(
        "Farmers",
        [
            "Last name",
            "First name",
            "Middle name",
            "Suffix",
            "Sex",
            "Birth year",
            "RSBSA no.",
            "Contact no.",
            "Barangay",
            "Municipality",
            "Associations",
            "Status",
            "Consent",
        ],
        rows,
    )
    audit.record(
        actor=actor,
        action="export.farmers",
        object_type="registry.farmer",
        after={"rows": len(rows), "filters": filters},
    )
    return data


def export_inventory(
    *, actor: User, queryset: QuerySet[InventoryRecord], filters: dict[str, Any]
) -> bytes:
    records = list(
        queryset.select_related(
            "survey_round",
            "crop_stand__commodity",
            "crop_stand__farm__barangay__municipality",
            "crop_stand__farm__farmer",
        )
        .prefetch_related(
            Prefetch("stage_counts", queryset=StageCount.objects.select_related("growth_stage"))
        )
        .order_by(
            "crop_stand__farm__barangay__municipality__name", "crop_stand__farm__farmer__last_name"
        )[:MAX_EXPORT_ROWS]
    )
    stage_codes: list[str] = []
    labels: dict[str, str] = {}
    for record in records:
        for count in sorted(record.stage_counts.all(), key=lambda c: c.growth_stage.sort_order):
            if count.growth_stage.code not in labels:
                stage_codes.append(count.growth_stage.code)
                labels[count.growth_stage.code] = count.growth_stage.label
    rows = []
    for record in records:
        counts = {c.growth_stage.code: c.count for c in record.stage_counts.all()}
        farm = record.crop_stand.farm
        rows.append(
            [
                record.survey_round.name,
                record.crop_stand.commodity.name,
                farm.barangay.municipality.name,
                farm.barangay.name,
                farm.farmer.display_name,
                *[counts.get(code) for code in stage_codes],
                sum(v or 0 for v in counts.values()),
                record.status,
                record.remarks,
            ]
        )
    data = _workbook(
        "Inventory",
        [
            "Round",
            "Commodity",
            "Municipality",
            "Barangay",
            "Farmer",
            *[labels[c] for c in stage_codes],
            "Total",
            "Status",
            "Remarks",
        ],
        rows,
    )
    audit.record(
        actor=actor,
        action="export.inventory",
        object_type="surveys.inventoryrecord",
        after={"rows": len(rows), "filters": filters},
    )
    return data
