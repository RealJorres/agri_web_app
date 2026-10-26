"""Turn a read legacy workbook into an import plan + reconciliation. Reads the database (catalog,
barangays, associations) but never writes: the same plan drives the preview and the commit."""

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from rapidfuzz import fuzz

from apps.catalog.models import Commodity, MaterialSource, Variety
from apps.catalog.selectors import plants_per_ha, source_index, variety_index
from apps.locations.models import Barangay, Municipality
from apps.registry.models import Association
from common.text import normalize_name, normalize_person_name

from .legacy_cacao_2023 import LegacyRow, LegacySheet, LegacyWorkbook
from .normalizers import (
    HarvestInfo,
    Mapped,
    NameParts,
    clean_barangay,
    clean_text,
    map_tokens,
    parse_associations,
    parse_contact,
    parse_count,
    parse_person_name,
    parse_remarks,
    parse_years,
    split_sites,
    split_values,
)

ASSOC_AUTO, ASSOC_REVIEW = 90, 75
# Placeholder for rows with no BARANGAY and no FARM LOCATION (unverified, never a PSGC code).
UNRECORDED_BARANGAY = "(Barangay not recorded)"


@dataclass
class AssociationChoice:
    raw: str
    canonical: str  # name the membership will use
    existing_id: str | None  # matched DB association, if any
    score: int
    decision: str  # "existing" | "same_as_file" | "new" | "review"


@dataclass
class PlannedRow:
    sheet: str
    row: int
    municipality: str
    incomplete: bool  # below the TOTAL row -> draft + farmer needs_review
    full_name_raw: str
    name: NameParts
    home_barangay: str
    farm_barangay: str
    location_raw: str
    contact: str
    associations: list[AssociationChoice]
    varieties: list[Variety]
    sources: list[MaterialSource]
    years: list[int]
    counts: dict[str, int | None]
    harvests: list[HarvestInfo]
    remarks: str
    raw_variety: str
    raw_source: str
    raw_date: str
    missing: list[str] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)

    @property
    def identity(self) -> tuple[str, str, str]:
        return (
            self.municipality,
            normalize_name(self.home_barangay),
            normalize_person_name(self.full_name_raw),
        )

    @property
    def total(self) -> int:
        return sum(v or 0 for v in self.counts.values())


@dataclass
class LegacyPlan:
    rows: list[PlannedRow]
    review: list[dict[str, Any]]
    decisions: dict[str, list[dict[str, Any]]]
    counts: dict[str, int]
    reconciliation: dict[str, Any]
    sheet_issues: list[str]


def _review(row: LegacyRow, kind: str, message: str, value: Any = "") -> dict[str, Any]:
    return {
        "sheet": row.sheet,
        "row": row.row,
        "kind": kind,
        "message": message,
        "value": clean_text(value),
    }


class _AssociationMatcher:
    """Fuzzy-match association names within a municipality (DB first, then this file)."""

    def __init__(self, municipality: Municipality | None, overrides: dict[str, str]) -> None:
        self.known: list[tuple[str, str | None]] = []  # (canonical name, db id)
        if municipality is not None:
            self.known = [
                (a.name, str(a.pk)) for a in Association.objects.filter(municipality=municipality)
            ]
        self.overrides = overrides  # normalized raw -> association id or "new"

    def match(self, raw: str) -> AssociationChoice:
        key = normalize_name(raw)
        override = self.overrides.get(key)
        if override and override != "new":
            name = next((n for n, i in self.known if i == override), raw)
            return AssociationChoice(raw, name, override, 100, "existing")
        best: tuple[int, str, str | None] = (0, raw, None)
        for name, db_id in self.known:
            score = int(fuzz.token_sort_ratio(key, normalize_name(name)))
            if score > best[0]:
                best = (score, name, db_id)
        score, name, db_id = best
        if override == "new" or score < ASSOC_REVIEW:
            self.known.append((raw, None))
            return AssociationChoice(raw, raw, None, score, "new")
        if score >= ASSOC_AUTO:
            return AssociationChoice(
                raw, name, db_id, score, "existing" if db_id else "same_as_file"
            )
        self.known.append((raw, None))
        return AssociationChoice(raw, raw, None, score, "review")


def build_plan(
    workbook: LegacyWorkbook,
    commodity: Commodity,
    association_overrides: dict[str, str] | None = None,
) -> LegacyPlan:
    varieties = variety_index(commodity)
    sources = source_index()
    overrides = {normalize_name(k): v for k, v in (association_overrides or {}).items()}
    municipalities = {m.name: m for m in Municipality.objects.all()}
    barangays: dict[tuple[str, str], Barangay] = {
        (b.municipality.name, b.normalized_name): b
        for b in Barangay.objects.select_related("municipality")
    }

    rows: list[PlannedRow] = []
    review: list[dict[str, Any]] = []
    tally: dict[str, Counter[tuple[str, str]]] = defaultdict(Counter)
    association_decisions: list[dict[str, Any]] = []
    sheet_issues = [f"{s.name}: {i}" for s in workbook.sheets for i in s.issues]
    sheet_issues += workbook.summary_issues + [
        f"Unknown sheet ignored: {t}" for t in workbook.unknown_sheets
    ]
    counts: Counter[str] = Counter()

    for sheet in workbook.sheets:
        town = sheet.municipality
        matcher = _AssociationMatcher(municipalities.get(town), overrides)
        for raw in sheet.rows:
            name = raw.name
            home_raw = clean_text(raw.values.get("barangay"))
            has_counts = any(parse_count(v).value for v in raw.counts.values())
            if raw.below_total:
                if not home_raw:
                    counts["name_only_rows"] += 1
                    review.append(
                        _review(
                            raw,
                            "name_only_row",
                            "Row below the TOTAL with only a name "
                            "(signatory or note?). Not imported.",
                            name,
                        )
                    )
                    continue
                counts["below_total_rows"] += 1
            elif not name:
                if has_counts:
                    counts["unnamed_rows_with_counts"] += 1
                    review.append(
                        _review(
                            raw,
                            "counts_without_name",
                            "Tree counts without a farmer name. Not imported.",
                            "",
                        )
                    )
                continue
            else:
                counts["named_rows"] += 1
                if has_counts:
                    counts["rows_with_trees"] += 1

            planned = _plan_row(
                raw, town, varieties.resolve, sources.resolve, matcher, review, tally
            )
            if not planned.home_barangay:
                # The row still counts in the official totals (brief §3): keep it, flag it, and
                # file it under FARM LOCATION or an explicit placeholder (ADR-0013 §10).
                planned.missing.append("barangay")
                planned.home_barangay = planned.farm_barangay or UNRECORDED_BARANGAY
                planned.farm_barangay = planned.farm_barangay or UNRECORDED_BARANGAY
                review.append(
                    _review(
                        raw,
                        "missing_barangay",
                        f"BARANGAY is empty: filed under '{planned.home_barangay}'. "
                        "Correct the farmer's barangay.",
                    )
                )
            for choice in planned.associations:
                if choice.decision == "review":
                    review.append(
                        _review(
                            raw,
                            "association_review",
                            f"'{choice.raw}' is similar ({choice.score}%) to an existing "
                            "association; imported as a new one unless you map it.",
                            choice.raw,
                        )
                    )
            for key in ("home_barangay", "farm_barangay"):
                bname = getattr(planned, key)
                if bname and (town, normalize_name(bname)) not in barangays:
                    tally["new_barangays"][(town, bname)] += 1
            rows.append(planned)
        for choice_name, choice in {
            c.raw: c for r in rows if r.municipality == town for c in r.associations
        }.items():
            association_decisions.append(
                {
                    "municipality": town,
                    "raw": choice_name,
                    "use": choice.canonical,
                    "decision": choice.decision,
                    "score": choice.score,
                }
            )

    _flag_repeated_names(rows, review)
    counts["farmers"] = len({r.identity for r in rows})
    counts["records"] = len(rows)
    counts["incomplete_records"] = sum(1 for r in rows if r.incomplete)
    counts["harvests"] = sum(len(r.harvests) for r in rows)
    counts["review_items"] = len(review)
    counts["new_barangays"] = len(tally["new_barangays"])

    # Normalization decisions, grouped by raw value: "BR 25" -> "BR25" (3 rows), etc.
    decisions: dict[str, list[dict[str, Any]]] = {}
    for kind, counter in tally.items():
        if kind == "new_barangays":
            decisions[kind] = [
                {"municipality": town, "barangay": name, "rows": n}
                for (town, name), n in sorted(counter.items())
            ]
        else:
            decisions[kind] = [
                {"raw": raw_value, "result": result, "rows": n}
                for (raw_value, result), n in sorted(counter.items())
            ]
    decisions["associations"] = association_decisions
    return LegacyPlan(
        rows=rows,
        review=review,
        decisions=decisions,
        counts=dict(counts),
        reconciliation=reconcile(workbook, commodity),
        sheet_issues=sheet_issues,
    )


def _plan_row(
    raw: LegacyRow,
    town: str,
    resolve_variety: Any,
    resolve_source: Any,
    matcher: _AssociationMatcher,
    review: list[dict[str, Any]],
    tally: dict[str, Counter[tuple[str, str]]],
) -> PlannedRow:
    v = raw.values
    home_raw = clean_text(v.get("barangay"))
    home = clean_barangay(home_raw, town)
    if home != home_raw:
        tally["barangay"][(home_raw, home)] += 1

    location_raw = clean_text(v.get("farm_location"))
    sites = split_sites(location_raw, town)
    farm = sites[0] if sites else home
    if location_raw and normalize_name(farm) != normalize_name(home):
        tally["farm_location"][(location_raw, farm)] += 1

    variety_raw = clean_text(v.get("variety"))
    mapped_v: Mapped[Variety] = map_tokens(split_values(variety_raw), resolve_variety)
    if variety_raw:
        tally["variety"][(variety_raw, ", ".join(x.code for x in mapped_v.found) or "-")] += 1
    for token in mapped_v.unknown:
        review.append(
            _review(raw, "unknown_variety", f"Unknown variety '{token}' (not imported).", token)
        )

    source_raw = clean_text(v.get("source"))
    mapped_s: Mapped[MaterialSource] = map_tokens(split_values(source_raw), resolve_source)
    if source_raw:
        tally["source"][(source_raw, ", ".join(x.code for x in mapped_s.found) or "-")] += 1
    for token in mapped_s.unknown:
        review.append(
            _review(raw, "unknown_source", f"Unknown planting material source '{token}'.", token)
        )

    years = parse_years(v.get("date_planted"))
    if years.issue:
        review.append(
            _review(raw, "unparsed_year", f"DATE PLANTED: {years.issue}.", v.get("date_planted"))
        )
    elif isinstance(v.get("date_planted"), str) and len(years.years) > 1:
        tally["date_planted"][
            (clean_text(v.get("date_planted")), ", ".join(map(str, years.years)))
        ] += 1

    counts: dict[str, int | None] = {}
    issues: list[str] = []
    for stage, cell in raw.counts.items():
        parsed = parse_count(cell)
        counts[stage] = parsed.value
        if parsed.issue:
            issues.append(f"{stage}: {parsed.issue}")
            review.append(_review(raw, "invalid_count", f"{stage}: {parsed.issue}.", cell))

    remarks = parse_remarks(v.get("remarks"))
    associations = [matcher.match(a) for a in parse_associations(v.get("association"))]
    missing = [
        label
        for label, value in (
            ("variety", variety_raw),
            ("date_planted", clean_text(v.get("date_planted"))),
            ("source", source_raw),
            ("contact", clean_text(v.get("contact"))),
        )
        if not value
    ]
    if not any(counts.values()):
        missing.append("counts")
    return PlannedRow(
        sheet=raw.sheet,
        row=raw.row,
        municipality=town,
        incomplete=raw.below_total,
        full_name_raw=raw.name,
        name=parse_person_name(raw.name),
        home_barangay=home,
        farm_barangay=farm,
        location_raw=location_raw,
        contact=parse_contact(v.get("contact")),
        associations=associations,
        varieties=mapped_v.found,
        sources=mapped_s.found,
        years=years.years,
        counts=counts,
        harvests=remarks.harvests,
        remarks=remarks.remaining,
        raw_variety=variety_raw,
        raw_source=source_raw,
        raw_date=clean_text(v.get("date_planted")),
        missing=missing,
        issues=issues,
    )


def _flag_repeated_names(rows: list[PlannedRow], review: list[dict[str, Any]]) -> None:
    by_name: dict[str, list[PlannedRow]] = defaultdict(list)
    for r in rows:
        by_name[normalize_person_name(r.full_name_raw)].append(r)
    for group in by_name.values():
        if len(group) < 2:
            continue
        identities = {r.identity for r in group}
        kind, message = (
            (
                "same_name_twice",
                "Same name and barangay twice: imported as ONE farmer with "
                "several farms. Split them if they are different people.",
            )
            if len(identities) == 1
            else (
                "possible_duplicate",
                "Same name in different places: imported as separate "
                "farmers. Merge them if they are the same person.",
            )
        )
        for r in group:
            others = [f"{o.sheet}!{o.row}" for o in group if o is not r]
            review.append(
                {
                    "sheet": r.sheet,
                    "row": r.row,
                    "kind": kind,
                    "message": f"{message} Other rows: {', '.join(others)}.",
                    "value": "",
                }
            )


def reconcile(workbook: LegacyWorkbook, commodity: Commodity) -> dict[str, Any]:
    """Rows vs the workbook's own TOTAL rows vs the SUMMARY sheet, per municipality and stage."""
    stages = [s.code for s in commodity.stages.order_by("sort_order")]
    density = plants_per_ha(commodity)
    out_rows = []
    differences: list[str] = []
    province = {k: Counter[str]() for k in ("computed", "workbook", "summary")}
    for sheet in workbook.sheets:
        summary = workbook.summary.get(normalize_name(sheet.municipality))
        entry: dict[str, Any] = {"municipality": sheet.municipality, "stages": {}}
        for stage in stages:
            computed = sum(parse_count(r.counts.get(stage)).value or 0 for r in sheet.above_total)
            total = sheet.totals.get(stage)
            workbook_value = total.workbook_value if total else None
            summary_value = summary.population.get(stage) if summary else None
            skipped = _skipped_rows(sheet, stage)
            cell = {
                "computed": computed,
                "workbook": workbook_value,
                "summary": summary_value,
                "diff_workbook": None if workbook_value is None else computed - workbook_value,
                "diff_summary": None if summary_value is None else computed - summary_value,
                "formula": total.formula if total else "",
                "skipped_rows": skipped,
            }
            entry["stages"][stage] = cell
            province["computed"][stage] += computed
            province["workbook"][stage] += workbook_value or 0
            province["summary"][stage] += summary_value or 0
            if cell["diff_workbook"]:
                detail = f"; {cell['formula']} skips rows {_ranges(skipped)}" if skipped else ""
                differences.append(
                    f"{sheet.municipality} {stage}: TOTAL row {workbook_value:,} vs farmer rows "
                    f"{computed:,} ({cell['diff_workbook']:+,}){detail}"
                )
            uncovered = _uncovered_rows(sheet, stage)
            cell["uncovered_rows"] = uncovered
            if uncovered and not cell["diff_workbook"]:
                differences.append(
                    f"{sheet.municipality} {stage}: {cell['formula']} does not cover rows "
                    f"{_ranges(uncovered)} (no effect on the current values, but new entries there "
                    "would not be totalled)"
                )
            if cell["diff_summary"] and cell["diff_summary"] != cell["diff_workbook"]:
                differences.append(
                    f"{sheet.municipality} {stage}: SUMMARY {summary_value:,} vs farmer rows "
                    f"{computed:,} ({cell['diff_summary']:+,})"
                )
        entry["computed_total"] = sum(c["computed"] for c in entry["stages"].values())
        entry["workbook_total"] = sum(c["workbook"] or 0 for c in entry["stages"].values())
        entry["diff_total"] = entry["computed_total"] - entry["workbook_total"]
        out_rows.append(entry)

    computed_total = sum(province["computed"].values())
    return {
        "stages": stages,
        "municipalities": out_rows,
        "province": {
            "computed": dict(province["computed"]),
            "workbook": dict(province["workbook"]),
            "summary": dict(province["summary"]),
            "computed_total": computed_total,
            "workbook_total": sum(province["workbook"].values()),
            "summary_total": sum(province["summary"].values()),
            "area_ha": str(round(Decimal(computed_total) / Decimal(str(density)), 2))
            if density
            else None,
        },
        "differences": differences,
    }


def _skipped_rows(sheet: LegacySheet, stage: str) -> list[int]:
    total = sheet.totals.get(stage)
    if total is None or not total.formula:
        return []
    with_values = [r.row for r in sheet.above_total if parse_count(r.counts.get(stage)).value]
    return [r for r in with_values if r not in set(total.covered_rows)]


def _uncovered_rows(sheet: LegacySheet, stage: str) -> list[int]:
    """Data rows (above TOTAL) that the stage's SUM formula leaves out, with or without values."""
    total = sheet.totals.get(stage)
    if total is None or not total.formula or not sheet.above_total:
        return []
    covered = set(total.covered_rows)
    first, last = sheet.above_total[0].row, sheet.above_total[-1].row
    return [r for r in range(first, last + 1) if r not in covered]


def _ranges(rows: list[int]) -> str:
    """[49, 50, 51, 60] -> '49-51, 60'."""
    parts: list[str] = []
    for r in rows:
        if parts and int(parts[-1].split("-")[-1]) == r - 1:
            parts[-1] = f"{parts[-1].split('-')[0]}-{r}"
        else:
            parts.append(str(r))
    return ", ".join(parts)
