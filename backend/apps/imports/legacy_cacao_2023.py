"""Reader for the PAO's 2023 cacao inventory workbook (brief §3, §10.A).

Layout per municipal sheet: titles in rows 1-10, headers ("NAME OF FARMER" ...) in the header row,
stage labels in the row below it, data until a TOTAL row with SUM formulas, then stray rows.
Everything is located by content, not by fixed row/column numbers, and stages are resolved through
the catalog (aliases), so the reader is not hard-wired to cacao's stage names.

Only reads. Returns plain dataclasses; the pipeline decides what to import.
"""

import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from openpyxl import load_workbook
from openpyxl.utils import column_index_from_string, get_column_letter

from common.text import normalize_name

from .normalizers import clean_text

HEADER_SCAN_ROWS = 30
TRAILING_EMPTY_ROWS = 25  # stop reading a sheet after this many empty rows past the total

# Header text (normalized, "contains") -> field name. Order matters: first match wins.
HEADER_FIELDS: list[tuple[str, str]] = [
    ("name of farmer", "name"),
    ("farm location", "farm_location"),
    ("barangay", "barangay"),
    ("association", "association"),
    ("contact", "contact"),
    ("variety", "variety"),
    ("date planted", "date_planted"),
    ("source", "source"),
    ("remark", "remarks"),
]

StageResolver = Callable[[str], Any]  # raw label -> GrowthStage-like (with .code) or None


@dataclass
class LegacyRow:
    sheet: str
    row: int
    values: dict[str, Any]  # field -> raw cell value
    counts: dict[str, Any]  # stage code -> raw cell value
    below_total: bool = False

    @property
    def name(self) -> str:
        return clean_text(self.values.get("name"))

    def is_empty(self) -> bool:
        return not any(clean_text(v) for v in (*self.values.values(), *self.counts.values()))


@dataclass
class StageTotal:
    stage: str
    column: str
    formula: str  # e.g. "=SUM(J13:J48)" ('' when the cell holds a plain number)
    cached: Any  # value Excel saved with the file (None if never calculated)
    evaluated: int | None  # our evaluation of the formula over the sheet
    covered_rows: list[int]  # data rows the formula includes

    @property
    def workbook_value(self) -> int | None:
        """What the workbook shows: Excel's cached value, else our evaluation."""
        if isinstance(self.cached, int | float):
            return int(self.cached)
        return self.evaluated


@dataclass
class LegacySheet:
    name: str
    municipality: str
    title: str = ""
    as_of: str = ""
    header_row: int = 0
    columns: dict[str, int] = field(default_factory=dict)  # field -> 1-based column
    stage_columns: dict[str, int] = field(default_factory=dict)  # stage code -> column
    rows: list[LegacyRow] = field(default_factory=list)
    total_row: int | None = None
    totals: dict[str, StageTotal] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)

    @property
    def above_total(self) -> list[LegacyRow]:
        return [r for r in self.rows if not r.below_total]

    @property
    def below_total(self) -> list[LegacyRow]:
        return [r for r in self.rows if r.below_total]


@dataclass
class SummaryRow:
    municipality: str
    farmers: int | None
    area: dict[str, float]  # stage code -> hectares
    population: dict[str, int]  # stage code -> trees


@dataclass
class LegacyWorkbook:
    sheets: list[LegacySheet]
    summary: dict[str, SummaryRow]  # normalized municipality -> row
    summary_issues: list[str] = field(default_factory=list)
    unknown_sheets: list[str] = field(default_factory=list)


# --- Formula evaluation -------------------------------------------------------------------------

_SUM = re.compile(r"^=\s*SUM\((?P<args>[^()]*)\)\s*$", re.IGNORECASE)
_REF = re.compile(r"^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$", re.IGNORECASE)


def sum_ranges(formula: str) -> list[tuple[int, int, int, int]] | None:
    """'=SUM(J13:J48)' -> [(col, row, col, row)]; None if it is not a plain SUM of ranges."""
    match = _SUM.match(formula or "")
    if not match:
        return None
    ranges = []
    for arg in match.group("args").split(","):
        ref = _REF.match(arg.strip())
        if not ref:
            return None
        c1, r1 = column_index_from_string(ref.group(1).upper()), int(ref.group(2))
        c2 = column_index_from_string(ref.group(3).upper()) if ref.group(3) else c1
        r2 = int(ref.group(4)) if ref.group(4) else r1
        ranges.append((min(c1, c2), min(r1, r2), max(c1, c2), max(r1, r2)))
    return ranges


def _numeric(value: Any) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, int | float):
        return float(value)
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return 0.0  # Excel's SUM ignores text


# --- Reading ------------------------------------------------------------------------------------


def _rows(path: Path, data_only: bool) -> dict[str, list[tuple[Any, ...]]]:
    workbook = load_workbook(path, read_only=True, data_only=data_only)
    try:
        return {ws.title: list(ws.iter_rows(values_only=True)) for ws in workbook.worksheets}
    finally:
        workbook.close()


def _cell(rows: list[tuple[Any, ...]], row: int, col: int) -> Any:
    """1-based access that tolerates ragged rows."""
    if row < 1 or row > len(rows):
        return None
    values = rows[row - 1]
    return values[col - 1] if 0 < col <= len(values) else None


def _find_header(rows: list[tuple[Any, ...]]) -> int | None:
    for r in range(1, min(len(rows), HEADER_SCAN_ROWS) + 1):
        if any("name of farmer" in normalize_name(clean_text(v)) for v in rows[r - 1]):
            return r
    return None


def _map_columns(header: tuple[Any, ...]) -> dict[str, int]:
    columns: dict[str, int] = {}
    for col, value in enumerate(header, start=1):
        text = normalize_name(clean_text(value))
        if not text:
            continue
        if text in {"no", "no.", "number"} and "no" not in columns:
            columns["no"] = col
            continue
        for needle, name in HEADER_FIELDS:
            if needle in text and name not in columns:
                columns[name] = col
                break
    return columns


def _map_stages(
    rows: list[tuple[Any, ...]], header_row: int, resolve: StageResolver
) -> dict[str, int]:
    stages: dict[str, int] = {}
    for r in (header_row + 1, header_row):
        for col, value in enumerate(rows[r - 1] if r <= len(rows) else (), start=1):
            stage = resolve(clean_text(value)) if clean_text(value) else None
            if stage is not None and stage.code not in stages:
                stages[stage.code] = col
    return stages


def _is_total_row(
    values: tuple[Any, ...], formulas: tuple[Any, ...], stage_cols: dict[str, int], label_cols: int
) -> bool:
    for v in values[:label_cols]:
        if normalize_name(clean_text(v)).startswith("total"):
            return True
    for col in stage_cols.values():
        f = formulas[col - 1] if col <= len(formulas) else None
        if isinstance(f, str) and f.lstrip().upper().startswith("=SUM"):
            return True
    return False


def read_sheet(
    title: str,
    municipality: str,
    values: list[tuple[Any, ...]],
    formulas: list[tuple[Any, ...]],
    resolve: StageResolver,
) -> LegacySheet:
    sheet = LegacySheet(name=title, municipality=municipality)
    header = _find_header(formulas)
    if header is None:
        sheet.issues.append("Header row with 'NAME OF FARMER' not found; sheet skipped.")
        return sheet
    sheet.header_row = header
    for r in range(1, header):
        text = " ".join(clean_text(v) for v in values[r - 1] if clean_text(v))
        if "population data" in text.lower() or "municipality of" in text.lower():
            sheet.title = text
        elif text.lower().startswith("as of"):
            sheet.as_of = text
    sheet.columns = _map_columns(formulas[header - 1])
    sheet.stage_columns = _map_stages(formulas, header, resolve)
    missing = [f for f in ("name", "barangay") if f not in sheet.columns]
    if missing or not sheet.stage_columns:
        sheet.issues.append(
            f"Missing columns: {', '.join(missing) or 'stage counts'}; sheet skipped."
        )
        return sheet

    label_cols = min(sheet.stage_columns.values()) - 1
    first_data = (
        header + 2
        if any(_cell(formulas, header + 1, c) for c in sheet.stage_columns.values())
        else header + 1
    )
    empty_run = 0
    for r in range(first_data, len(values) + 1):
        row_values = values[r - 1]
        row_formulas = formulas[r - 1] if r <= len(formulas) else ()
        if sheet.total_row is None and _is_total_row(
            row_values, row_formulas, sheet.stage_columns, label_cols
        ):
            sheet.total_row = r
            continue
        row = LegacyRow(
            sheet=title,
            row=r,
            values={f: _cell(values, r, c) for f, c in sheet.columns.items()},
            counts={s: _cell(values, r, c) for s, c in sheet.stage_columns.items()},
            below_total=sheet.total_row is not None,
        )
        if row.is_empty():
            empty_run += 1
            if sheet.total_row is not None and empty_run >= TRAILING_EMPTY_ROWS:
                break
            continue
        empty_run = 0
        sheet.rows.append(row)

    if sheet.total_row is None:
        sheet.issues.append("No TOTAL row found; all rows treated as data.")
    else:
        sheet.totals = _read_totals(sheet, values, formulas)
    return sheet


def _read_totals(
    sheet: LegacySheet, values: list[tuple[Any, ...]], formulas: list[tuple[Any, ...]]
) -> dict[str, StageTotal]:
    assert sheet.total_row is not None  # noqa: S101 - caller checks
    totals = {}
    for stage, col in sheet.stage_columns.items():
        formula_cell = _cell(formulas, sheet.total_row, col)
        cached = _cell(values, sheet.total_row, col)
        formula = (
            formula_cell if isinstance(formula_cell, str) and formula_cell.startswith("=") else ""
        )
        evaluated: int | None = None
        covered: list[int] = []
        if formula:
            ranges = sum_ranges(formula)
            if ranges is None:
                sheet.issues.append(
                    f"{get_column_letter(col)}{sheet.total_row}: unsupported formula {formula}"
                )
            else:
                total = 0.0
                for c1, r1, c2, r2 in ranges:
                    for r in range(r1, r2 + 1):
                        for c in range(c1, c2 + 1):
                            total += _numeric(_cell(values, r, c))
                            if c == col:
                                covered.append(r)
                evaluated = round(total)
        elif isinstance(formula_cell, int | float):
            evaluated = int(formula_cell)  # a typed-in number instead of a formula
        totals[stage] = StageTotal(
            stage=stage,
            column=get_column_letter(col),
            formula=formula,
            cached=cached,
            evaluated=evaluated,
            covered_rows=sorted(set(covered)),
        )
    return totals


def read_summary(
    rows: list[tuple[Any, ...]], municipalities: list[str], resolve: StageResolver
) -> tuple[dict[str, SummaryRow], list[str]]:
    """SUMMARY sheet: per municipality, number of farmers, area by stage and population by stage.

    Stage label columns appear twice (area block, population block). A block is "area" when the
    text above it mentions area/ha, else "population"; with no hints, the first block is area."""
    issues: list[str] = []
    wanted = {normalize_name(m): m for m in municipalities}
    label_row = None
    for r, values in enumerate(rows[:HEADER_SCAN_ROWS], start=1):
        if sum(1 for v in values if clean_text(v) and resolve(clean_text(v))) >= 2:
            label_row = r
            break
    if label_row is None:
        return {}, ["SUMMARY: stage label row not found; summary not reconciled."]

    blocks: list[dict[str, int]] = []
    for col, value in enumerate(rows[label_row - 1], start=1):
        stage = resolve(clean_text(value)) if clean_text(value) else None
        if stage is None:
            continue
        if not blocks or stage.code in blocks[-1]:
            blocks.append({})
        blocks[-1][stage.code] = col

    def hint(block: dict[str, int]) -> str:
        first = min(block.values())
        text = " ".join(
            normalize_name(clean_text(_cell(rows, r, c)))
            for r in range(max(1, label_row - 3), label_row)
            for c in range(max(1, first - 1), first + 4)
        )
        if "area" in text or " ha" in f" {text}" or "hectare" in text:
            return "area"
        if "population" in text or "trees" in text or "no of" in text:
            return "population"
        return ""

    kinds = [hint(b) for b in blocks]
    if len(blocks) >= 2 and not any(kinds):
        kinds[0], kinds[1] = "area", "population"
    if "population" not in kinds:
        kinds = ["area" if k == "area" else "population" for k in kinds]
    farmers_col = next(
        (
            c
            for r in (label_row, label_row - 1)
            if r >= 1
            for c, v in enumerate(rows[r - 1], start=1)
            if "farmer" in normalize_name(clean_text(v))
        ),
        None,
    )

    out: dict[str, SummaryRow] = {}
    for r in range(label_row + 1, len(rows) + 1):
        values = rows[r - 1]
        label = next((clean_text(v) for v in values if isinstance(v, str) and clean_text(v)), "")
        key = normalize_name(label)
        if key not in wanted:
            continue
        area: dict[str, float] = {}
        population: dict[str, int] = {}
        for block, kind in zip(blocks, kinds, strict=False):
            for stage, col in block.items():
                value = _cell(rows, r, col)
                if isinstance(value, int | float):
                    if kind == "area":
                        area[stage] = float(value)
                    else:
                        population[stage] = round(value)
        farmers = _cell(rows, r, farmers_col) if farmers_col else None
        out[key] = SummaryRow(
            municipality=wanted[key],
            farmers=int(farmers) if isinstance(farmers, int | float) else None,
            area=area,
            population=population,
        )
    missing = [m for k, m in wanted.items() if k not in out]
    if missing:
        issues.append(f"SUMMARY: no row for {', '.join(missing)}.")
    return out, issues


def read_workbook(path: Path, municipalities: list[str], resolve: StageResolver) -> LegacyWorkbook:
    values = _rows(path, data_only=True)
    formulas = _rows(path, data_only=False)
    by_name = {normalize_name(m): m for m in municipalities}
    sheets: list[LegacySheet] = []
    unknown: list[str] = []
    summary: dict[str, SummaryRow] = {}
    summary_issues: list[str] = []
    for title in formulas:
        key = normalize_name(title)
        if key in by_name:
            sheets.append(read_sheet(title, by_name[key], values[title], formulas[title], resolve))
        elif key == "summary":
            summary, summary_issues = read_summary(values[title], municipalities, resolve)
        else:
            unknown.append(title)
    return LegacyWorkbook(sheets, summary, summary_issues, unknown)


def iter_rows(workbook: LegacyWorkbook) -> Iterator[LegacyRow]:
    for sheet in workbook.sheets:
        yield from sheet.rows
