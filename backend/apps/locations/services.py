"""Location writes: municipality seeding and the official PSGC loader (ADR-0005)."""

import csv
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from django.db import transaction
from openpyxl import load_workbook

from common.exceptions import DomainError
from common.text import collapse_spaces, normalize_name

from .models import Barangay, Municipality

MARINDUQUE_MUNICIPALITIES = ["Boac", "Buenavista", "Gasan", "Mogpog", "Santa Cruz", "Torrijos"]

# PSA's PSGC publication: one row per geographic unit with a 10-digit code and a level.
CODE_HEADERS = ("10-digit psgc", "psgc", "code")
NAME_HEADERS = ("name",)
LEVEL_HEADERS = ("geographic level", "level")
LEVEL_PROVINCE = {"prov"}
LEVEL_MUNICIPALITY = {"mun", "city"}
LEVEL_BARANGAY = {"bgy"}
_PARENTHETICAL = re.compile(r"\s*\(.*?\)\s*")


@transaction.atomic
def seed_municipalities() -> int:
    """Create the province's municipalities by name (no PSGC codes). Returns how many were new."""
    created = 0
    for name in MARINDUQUE_MUNICIPALITIES:
        _, was_created = Municipality.objects.get_or_create(
            normalized_name=normalize_name(name), defaults={"name": name}
        )
        created += was_created
    return created


@dataclass(frozen=True)
class PsgcRow:
    code: str
    name: str
    level: str


@dataclass
class PsgcReport:
    municipalities_coded: list[str] = field(default_factory=list)
    municipalities_missing: list[str] = field(default_factory=list)
    barangays_verified: int = 0
    barangays_created: int = 0
    # Import-created barangays with no PSGC match: keep is_verified=False, review manually.
    barangays_unmatched: list[str] = field(default_factory=list)


def _psgc_name(raw: str) -> str:
    """'Boac (Capital)' -> 'Boac'."""
    return collapse_spaces(_PARENTHETICAL.sub(" ", raw))


def read_psgc_rows(path: Path) -> Iterator[PsgcRow]:
    """Yield rows from PSA's PSGC .xlsx (or a .csv export with the same headers)."""
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as fh:
            rows: Iterator[tuple[object, ...]] = (tuple(r) for r in csv.reader(fh))
            yield from _parse_psgc(rows)
        return
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = next(
            (ws for ws in workbook.worksheets if "psgc" in ws.title.lower()), workbook.active
        )
        if sheet is None:
            raise DomainError("psgc_format", "The PSGC workbook has no sheets.")
        yield from _parse_psgc(sheet.iter_rows(values_only=True))
    finally:
        workbook.close()


def _parse_psgc(rows: Iterator[tuple[object, ...]]) -> Iterator[PsgcRow]:
    columns: dict[str, int] | None = None
    for row in rows:
        cells = ["" if c is None else str(c).strip() for c in row]
        if columns is None:
            lowered = [c.lower() for c in cells]
            found = {
                key: next((lowered.index(h) for h in headers if h in lowered), -1)
                for key, headers in (
                    ("code", CODE_HEADERS),
                    ("name", NAME_HEADERS),
                    ("level", LEVEL_HEADERS),
                )
            }
            if min(found.values()) >= 0:
                columns = found
            continue
        code = cells[columns["code"]].split(".")[0].zfill(10) if cells[columns["code"]] else ""
        if code.strip("0"):
            yield PsgcRow(code, cells[columns["name"]], cells[columns["level"]].lower())
    if columns is None:
        raise DomainError(
            "psgc_format",
            "PSGC header row not found (expected '10-digit PSGC', 'Name', 'Geographic Level').",
        )


@transaction.atomic
def load_psgc(path: Path, *, province: str, dry_run: bool = False) -> PsgcReport:
    """Fill municipality/barangay PSGC codes for one province from the official file."""
    rows = list(read_psgc_rows(path))
    target = normalize_name(province)
    prov = next(
        (r for r in rows if r.level in LEVEL_PROVINCE and normalize_name(r.name) == target), None
    )
    if prov is None:
        raise DomainError("psgc_province", f"Province '{province}' not found in the PSGC file.")
    # 10-digit PSGC: RR PPP MM BBB -> province prefix is the first 5 digits.
    in_province = [r for r in rows if r.code.startswith(prov.code[:5]) and r is not prov]

    report = PsgcReport()
    municipalities = {m.normalized_name: m for m in Municipality.objects.all()}
    by_prefix: dict[str, Municipality] = {}
    for row in (r for r in in_province if r.level in LEVEL_MUNICIPALITY):
        municipality = municipalities.get(normalize_name(_psgc_name(row.name)))
        if municipality is None:
            report.municipalities_missing.append(_psgc_name(row.name))
            continue
        municipality.psgc_code = row.code
        municipality.save(update_fields=["psgc_code", "updated_at"])
        by_prefix[row.code[:7]] = municipality
        report.municipalities_coded.append(municipality.name)

    matched_ids: set[object] = set()
    for row in (r for r in in_province if r.level in LEVEL_BARANGAY):
        municipality = by_prefix.get(row.code[:7])
        if municipality is None:
            continue
        name = _psgc_name(row.name)
        barangay = Barangay.objects.filter(
            municipality=municipality, normalized_name=normalize_name(name)
        ).first()
        if barangay is None:
            barangay = Barangay(municipality=municipality, name=name)
            report.barangays_created += 1
        else:
            report.barangays_verified += 1
        barangay.psgc_code = row.code
        barangay.is_verified = True
        barangay.save()
        matched_ids.add(barangay.pk)

    report.barangays_unmatched = [
        str(b)
        for b in Barangay.objects.filter(is_verified=False).select_related("municipality")
        if b.pk not in matched_ids
    ]
    if dry_run:
        transaction.set_rollback(True)
    return report
