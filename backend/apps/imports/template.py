"""The clean ongoing import template (brief §10.B): one row per crop stand.

Generated from the catalog and locations (dropdowns), and imported through the regular services
(create_farmer, create_record, submit...) so every scope check, rule and audit entry applies."""

import csv
import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from django.core.files.base import ContentFile
from django.utils import timezone
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from apps.accounts.models import User
from apps.accounts.selectors import get_scope
from apps.catalog.models import Commodity, GrowthStage
from apps.catalog.selectors import source_index, stages_for, variety_index
from apps.farms import services as farm_services
from apps.farms.models import CropStand
from apps.locations.models import Barangay, Municipality
from apps.registry import services as registry_services
from apps.registry.models import Association, Farmer
from apps.registry.selectors import farmers_for
from apps.surveys import services as survey_services
from apps.surveys.models import InventoryRecord, SurveyRound
from common.text import normalize_name, normalize_person_name

from .models import ImportJob, ImportRowLink
from .normalizers import (
    Mapped,
    clean_text,
    map_tokens,
    parse_associations,
    parse_contact,
    parse_count,
    parse_years,
    split_values,
)

SHEET = "Records"
LISTS = "Lists"
PRIVACY_NOTICE = (
    "PRIVACY NOTICE (RA 10173): Personal data collected here is used by the Provincial "
    "Agriculture Office of Marinduque only to manage agricultural programs. Record 'Y' in the "
    "Consent column only after the farmer has been informed and agreed."
)


@dataclass(frozen=True)
class Column:
    key: str
    header: str
    required: bool = False
    width: int = 16


BASE_COLUMNS = [
    Column("municipality", "Municipality", True),
    Column("barangay", "Home barangay", True, 28),
    Column("first_name", "First name", True),
    Column("middle_name", "Middle name"),
    Column("last_name", "Last name", True),
    Column("suffix", "Suffix", width=8),
    Column("sex", "Sex", width=10),
    Column("birth_year", "Birth year", width=10),
    Column("rsbsa_no", "RSBSA no."),
    Column("contact_no", "Contact no."),
    Column("consent", "Consent (Y/N)", True, 12),
    Column("associations", "Association(s)", width=28),
    Column("farm_barangay", "Farm barangay (if different)", width=28),
    Column("sitio", "Sitio"),
    Column("varieties", "Variety(ies)", width=18),
    Column("years", "Year(s) planted", width=16),
    Column("source", "Source of planting materials", width=24),
]
END_COLUMNS = [Column("remarks", "Remarks", width=32)]


def columns_for(commodity: Commodity) -> list[Column]:
    stage_cols = [Column(f"stage:{s.code}", s.label, width=12) for s in stages_for(commodity)]
    return [*BASE_COLUMNS, *stage_cols, *END_COLUMNS]


def _barangay_label(b: Barangay) -> str:
    return f"{b.name} ({b.municipality.name})"


def generate(commodity: Commodity) -> bytes:
    """Build the template workbook with dropdowns sourced from the catalog."""
    cols = columns_for(commodity)
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET
    bold = Font(bold=True)
    required_fill = PatternFill("solid", fgColor="FFF4CC")
    for i, col in enumerate(cols, start=1):
        cell = ws.cell(row=1, column=i, value=col.header + (" *" if col.required else ""))
        cell.font = bold
        if col.required:
            cell.fill = required_fill
        ws.column_dimensions[get_column_letter(i)].width = col.width
    ws.freeze_panes = "A2"

    lists = wb.create_sheet(LISTS)
    lists.sheet_state = "hidden"
    values = {
        "municipality": [m.name for m in Municipality.objects.order_by("name")],
        "barangay": [
            _barangay_label(b)
            for b in Barangay.objects.select_related("municipality").order_by(
                "municipality__name", "name"
            )
        ],
        "varieties": [v.code for v in variety_index_items(commodity)],
        "source": [s.name for s in source_index_items()],
        "sex": ["Male", "Female"],
        "consent": ["Y", "N"],
    }
    values["farm_barangay"] = values["barangay"]
    keys = [c.key for c in cols]
    for list_col, (key, items) in enumerate(values.items(), start=1):
        letter = get_column_letter(list_col)
        lists.cell(row=1, column=list_col, value=key)
        for r, item in enumerate(items, start=2):
            lists.cell(row=r, column=list_col, value=item)
        if not items or key not in keys:
            continue
        target = get_column_letter(keys.index(key) + 1)
        dv = DataValidation(
            type="list",
            formula1=f"={LISTS}!${letter}$2:${letter}${len(items) + 1}",
            allow_blank=True,
            # Varieties may hold several codes ("BR25, UF18"): warn instead of blocking.
            errorStyle="warning" if key == "varieties" else "stop",
            showErrorMessage=True,
        )
        dv.add(f"{target}2:{target}5000")
        ws.add_data_validation(dv)

    help_ws = wb.create_sheet("Instructions", 0)
    lines = [
        f"{commodity.name} inventory template - one row per farmer farm (crop stand).",
        "Columns marked * are required. Use the dropdowns; several varieties or years may be "
        "separated with commas.",
        "Stage columns hold tree counts (whole numbers, 0 or more). Leave blank if unknown.",
        "",
        PRIVACY_NOTICE,
        "",
        f"Generated {timezone.now():%Y-%m-%d}. Do not rename the column headers.",
    ]
    for r, line in enumerate(lines, start=1):
        help_ws.cell(row=r, column=1, value=line)
    help_ws.column_dimensions["A"].width = 120
    wb.active = wb.index(ws)

    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def variety_index_items(commodity: Commodity) -> list[Any]:
    return list(commodity.varieties.order_by("code"))


def source_index_items() -> list[Any]:
    from apps.catalog.models import MaterialSource

    return list(MaterialSource.objects.order_by("name"))


# --- Reading and validating ---------------------------------------------------------------------


@dataclass
class TemplateRow:
    row: int
    raw: dict[str, Any]
    errors: list[str] = field(default_factory=list)
    clean: dict[str, Any] = field(default_factory=dict)


def _read(path: Path, commodity: Commodity) -> list[TemplateRow]:
    cols = columns_for(commodity)
    by_header = {normalize_name(c.header): c.key for c in cols}
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as fh:
            table = [tuple(r) for r in csv.reader(fh)]
    else:
        wb = load_workbook(path, read_only=True, data_only=True)
        try:
            sheet = wb[SHEET] if SHEET in wb.sheetnames else wb.active
            table = list(sheet.iter_rows(values_only=True)) if sheet else []
        finally:
            wb.close()
    if not table:
        return []
    header_keys = [by_header.get(normalize_name(clean_text(h).rstrip(" *"))) for h in table[0]]
    missing = [c.header for c in cols if c.required and c.key not in header_keys]
    if missing:
        from common.exceptions import DomainError

        raise DomainError(
            "template_headers",
            "This file does not match the template. Missing columns: " + ", ".join(missing),
        )
    rows = []
    for number, values in enumerate(table[1:], start=2):
        raw = {k: v for k, v in zip(header_keys, values, strict=False) if k}
        if any(clean_text(v) for v in raw.values()):
            rows.append(TemplateRow(number, raw))
    return rows


def _find_barangay(text: Any, municipality: Municipality | None) -> Barangay | None:
    name = clean_text(text)
    if municipality is None or not name:
        return None
    suffix = f"({municipality.name})"
    if name.lower().endswith(suffix.lower()):
        name = name[: -len(suffix)].strip()
    return Barangay.objects.filter(
        municipality=municipality, normalized_name=normalize_name(name)
    ).first()


def validate(rows: list[TemplateRow], job: ImportJob, actor: User | None) -> None:
    commodity = job.commodity
    assert commodity is not None  # noqa: S101
    municipalities = {m.normalized_name: m for m in Municipality.objects.all()}
    stages = {s.code: s for s in GrowthStage.objects.filter(commodity=commodity)}
    varieties, sources = variety_index(commodity), source_index()
    visible = farmers_for(get_scope(actor)) if actor else Farmer.objects.all()
    seen: dict[str, int] = {}

    for r in rows:
        v, e, c = r.raw, r.errors, r.clean
        municipality = municipalities.get(normalize_name(clean_text(v.get("municipality"))))
        if municipality is None:
            e.append("Municipality not recognised.")
        home = _find_barangay(v.get("barangay"), municipality)
        if municipality and home is None:
            e.append("Home barangay not found in that municipality.")
        farm_b = (
            _find_barangay(v.get("farm_barangay"), municipality)
            if clean_text(v.get("farm_barangay"))
            else home
        )
        if clean_text(v.get("farm_barangay")) and farm_b is None:
            e.append("Farm barangay not found in that municipality.")
        first, last = clean_text(v.get("first_name")), clean_text(v.get("last_name"))
        if not (first or last):
            e.append("First or last name is required.")
        sex = normalize_name(clean_text(v.get("sex")))
        sex_value = {"male": "male", "m": "male", "female": "female", "f": "female", "": ""}.get(
            sex
        )
        if sex_value is None:
            e.append("Sex must be Male or Female.")
        birth = parse_count(v.get("birth_year"))
        if birth.issue or (
            birth.value is not None and not 1900 <= birth.value <= timezone.now().year
        ):
            e.append("Birth year must be a 4-digit year.")
        consent = normalize_name(clean_text(v.get("consent"))) in {"y", "yes"}
        if not consent:
            e.append("Consent must be 'Y' (show the privacy notice first).")
        rsbsa = clean_text(v.get("rsbsa_no")).upper() or None

        mapped_v: Mapped[Any] = map_tokens(split_values(v.get("varieties")), varieties.resolve)
        if mapped_v.unknown:
            e.append(f"Unknown variety: {', '.join(mapped_v.unknown)}.")
        mapped_s: Mapped[Any] = map_tokens(split_values(v.get("source")), sources.resolve)
        if mapped_s.unknown:
            e.append(f"Unknown source: {', '.join(mapped_s.unknown)}.")
        if len(mapped_s.found) > 1:
            e.append("Choose one source per row.")
        years = parse_years(v.get("years"))
        if years.issue:
            e.append(f"Year(s) planted: {years.issue}.")

        counts = {}
        for code, stage in stages.items():
            parsed = parse_count(v.get(f"stage:{code}"))
            if parsed.issue:
                e.append(f"{stage.label}: {parsed.issue}.")
            counts[code] = parsed.value
        remarks = clean_text(v.get("remarks"))
        if not any(counts.values()) and not remarks:
            e.append("Enter at least one stage count, or explain in Remarks.")

        identity = rsbsa or f"{getattr(home, 'pk', '')}|{normalize_person_name(f'{first} {last}')}"
        if identity in seen:
            e.append(f"Same farmer as row {seen[identity]} (one row per farm).")
        seen.setdefault(identity, r.row)
        existing = visible.filter(rsbsa_no__iexact=rsbsa).first() if rsbsa else None

        c.update(
            municipality=municipality,
            home=home,
            farm_barangay=farm_b,
            farmer={
                "first_name": first,
                "middle_name": clean_text(v.get("middle_name")),
                "last_name": last,
                "suffix": clean_text(v.get("suffix")),
                "sex": sex_value or "",
                "birth_year": birth.value,
                "rsbsa_no": rsbsa,
                "contact_no": parse_contact(v.get("contact_no")),
                "home_barangay": home,
            },
            existing_farmer=existing,
            associations=parse_associations(v.get("associations")),
            sitio=clean_text(v.get("sitio")),
            varieties=mapped_v.found,
            source=mapped_s.found[0] if len(mapped_s.found) == 1 else None,
            years=years.years,
            counts=counts,
            remarks=remarks,
        )
        if (
            existing
            and job.survey_round
            and farm_b
            and InventoryRecord.objects.filter(
                survey_round=job.survey_round,
                crop_stand__farm__farmer=existing,
                crop_stand__farm__barangay=farm_b,
                crop_stand__commodity=commodity,
            ).exists()
        ):
            e.append("This farm already has a record in the selected round.")


def _error_report(rows: list[TemplateRow], commodity: Commodity) -> ContentFile[bytes] | None:
    bad = [r for r in rows if r.errors]
    if not bad:
        return None
    cols = columns_for(commodity)
    wb = Workbook()
    ws = wb.active
    ws.title = "Errors"
    ws.append(["Row", *[c.header for c in cols], "Errors"])
    for r in bad:
        ws.append([r.row, *[clean_text(r.raw.get(c.key)) for c in cols], " | ".join(r.errors)])
    buffer = io.BytesIO()
    wb.save(buffer)
    return ContentFile(buffer.getvalue())


def preview(job: ImportJob) -> tuple[dict[str, Any], ContentFile[bytes] | None]:
    commodity = job.commodity
    assert commodity is not None  # noqa: S101
    rows = _read(Path(job.file.path), commodity)
    validate(rows, job, job.uploaded_by)
    errors = [{"sheet": SHEET, "row": r.row, "messages": r.errors} for r in rows if r.errors]
    return (
        {
            "municipalities": sorted(
                {r.clean["municipality"].name for r in rows if r.clean.get("municipality")}
            ),
            "counts": {
                "rows": len(rows),
                "valid_rows": sum(1 for r in rows if not r.errors),
                "rows_with_errors": len(errors),
                "existing_farmers": sum(1 for r in rows if r.clean.get("existing_farmer")),
            },
            "errors": errors,
            "review": [],
            "decisions": {},
            "reconciliation": None,
            "sheet_issues": [],
        },
        _error_report(rows, commodity),
    )


def commit(job: ImportJob, actor: User) -> dict[str, Any]:
    """Load every valid row (rows with errors are skipped; see the error report)."""
    commodity = job.commodity
    survey_round: SurveyRound | None = job.survey_round
    assert commodity is not None  # noqa: S101
    assert survey_round is not None  # noqa: S101
    rows = _read(Path(job.file.path), commodity)
    validate(rows, job, actor)
    stages = {s.code: s for s in GrowthStage.objects.filter(commodity=commodity)}
    linked = set(
        ImportRowLink.objects.filter(file_sha256=job.file_sha256).values_list("row", flat=True)
    )
    tally = {
        "records_submitted": 0,
        "farmers_created": 0,
        "rows_skipped_errors": 0,
        "rows_already_imported": 0,
    }
    for r in rows:
        if r.errors:
            tally["rows_skipped_errors"] += 1
            continue
        if r.row in linked:
            tally["rows_already_imported"] += 1
            continue
        c = r.clean
        farmer = c["existing_farmer"]
        if farmer is None:
            farmer = registry_services.create_farmer(
                actor=actor, data=c["farmer"], consent_given=True
            )
            tally["farmers_created"] += 1
        for name in c["associations"]:
            association = Association.objects.filter(
                municipality=c["municipality"], normalized_name=normalize_name(name)
            ).first() or registry_services.create_association(
                actor=actor, data={"name": name, "municipality": c["municipality"]}
            )
            if not association.memberships.filter(farmer=farmer).exists():
                registry_services.add_member(actor=actor, association=association, farmer=farmer)
        stand = (
            CropStand.objects.filter(
                farm__farmer=farmer, farm__barangay=c["farm_barangay"], commodity=commodity
            )
            .select_related("farm__barangay", "commodity")
            .first()
        )
        if stand is None:
            farm = farm_services.create_farm(
                actor=actor,
                farmer=farmer,
                data={"barangay": c["farm_barangay"], "sitio": c["sitio"]},
            )
            stand = farm_services.create_crop_stand(
                actor=actor, farm=farm, commodity=commodity, data={}
            )
        for year in c["years"] or ([None] if c["varieties"] or c["source"] else []):
            farm_services.create_planting(
                actor=actor,
                stand=stand,
                data={"year_planted": year, "source": c["source"]},
                varieties=c["varieties"],
            )
        record = survey_services.create_record(
            actor=actor,
            survey_round=survey_round,
            crop_stand=stand,
            counts=[
                survey_services.CountInput(stages[code], value)
                for code, value in c["counts"].items()
                if value is not None
            ],
            remarks=c["remarks"],
        )
        survey_services.submit(actor=actor, record=record)
        ImportRowLink.objects.create(
            file_sha256=job.file_sha256,
            sheet=SHEET,
            row=r.row,
            job=job,
            farmer=farmer,
            farm=stand.farm,
            crop_stand=stand,
            record=record,
        )
        tally["records_submitted"] += 1
    return tally
