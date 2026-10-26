"""Builds a SYNTHETIC workbook with the same layout and defects as the PAO's 2023 cacao file
(brief §3), so the legacy adapter is tested in CI without real personal data.

Every name is fake ("Sample..."); contact numbers use the 0900-000-xxxx test range.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from openpyxl import Workbook

STAGES = ["SEEDLING", "VEGETATIVE", "FLOWERING", "FRUITING"]
STAGE_COLS = ["J", "K", "L", "M"]
HEADERS = [
    "NO.",
    "NAME OF FARMER",
    "BARANGAY",
    "FARM LOCATION",
    "NAME OF ASSOCIATION",
    "CONTACT NO.",
    "VARIETY",
    "DATE PLANTED",
    "SOURCE OF PLANTING MATERIALS",
    "STATUS/NO. OF CACAO PLANTED",
    None,
    None,
    None,
    "REMARKS",
]
FIRST_DATA_ROW = 13


@dataclass
class Row:
    name: str
    barangay: str
    counts: tuple[Any, Any, Any, Any] = (None, None, None, None)
    farm_location: str = ""
    association: str = ""
    contact: Any = None
    variety: str = ""
    date_planted: Any = None
    source: str = ""
    remarks: str = ""


@dataclass
class Sheet:
    title: str
    town: str
    rows: list[Row]
    below: list[Row] = field(default_factory=list)
    # stage index -> formula override for the TOTAL row (defects), e.g. {0: "=SUM(J13:J15)"}
    total_overrides: dict[int, str] = field(default_factory=dict)
    extra_empty_column: bool = False


def _n(v: Any) -> int:
    return int(v) if isinstance(v, int | float) else 0


SHEETS: list[Sheet] = [
    Sheet(
        "BOAC",
        "Boac",
        [
            Row(
                "Juan A. Samplecruz",
                "Synthetic Alpha",
                (10, 200, 50, 100),
                variety="UF18 & BR25",
                date_planted="2016, 2018,2021 & 2022",
                source="DA-RFO",
                contact=9000000001.0,
                association="Sample Boac FA",
                remarks="8 kilos harvest",
            ),
            Row(
                "Maria Sampleyes",
                "Synthetic Alpha",
                (0, 300, 0, 0),
                variety="BR 25",
                date_planted=2019,
                source="DA- RFO",
                association="None Member",
            ),
            Row(
                "Pedro Samplelos",
                "Synthetic Beta, Boac",
                (None, 100, 25, 75),
                variety="CriolIo",
                date_planted=2017.0,
                source="Own Produce",
                remarks="3 kls.",
            ),
            Row("Rosa Sampleduo", "Synthetic Beta", (5, 0, 0, 10), farm_location="Synthetic Gamma"),
            Row("Rosa Sampleduo", "Synthetic Beta", (0, 0, 0, 20), farm_location="Synthetic Beta"),
            Row("Ana Samplenone", "Synthetic Gamma"),  # named, no trees counted
        ],
    ),
    Sheet(
        "BUENAVISTA",
        "Buenavista",
        [
            Row(
                "Jose Samplebv",
                "Synthetic Delta",
                (100, 50, 0, 30),
                variety="KI & K18",
                date_planted="2017& 2019",
                source="PS",
                association="Sample BV Coop, Other Sample FA",
            ),
            Row(
                "Lito Samplebv",
                "Synthetic Delta",
                (0, 25, 5, 0),
                variety="W10 &  Criollo",
                source="DA/PCA/Own Produced",
                remarks="1 sack",
            ),
        ],
    ),
    Sheet(
        "MOGPOG",
        "Mogpog",
        [
            Row(
                "Nena Samplemog",
                "Synthetic Lamesa, Mogpog",
                (3, 4, 5, 6),
                date_planted="unknown",
                remarks="6 kilos dried",
            ),
            Row(
                "Tony Samplemog",
                "Synthetic Lamesa",
                (7, 8, 9, 10),
                source="PCA",
                remarks="1 kilo every other month",
            ),
            Row("Lina Samplemog", "Synthetic Ino", (1, 1, 1, 1)),
        ],
        total_overrides={2: "=SUM(L13)"},
        extra_empty_column=True,
    ),
    Sheet(
        "GASAN",
        "Gasan",
        [
            Row(
                "Carlos Samplegas",
                "Synthetic Tabionan",
                (20, 40, 60, 80),
                farm_location="Pulong Parang/Masalukot",
                association="Mat. Sample Gasan FA",
                variety="BR25&UF18",
            ),
            Row(
                "Elena Samplegas",
                "Synthetic Tabionan",
                (0, 0, 0, 15),
                association="Mat Sample Gasan FA",
                remarks="325 trees died in May 2023, 80 now",
            ),
        ],
    ),
    Sheet(
        "SANTA CRUZ",
        "Santa Cruz",
        [
            Row("Ramon Samplesc", "Synthetic Maharlika", (10, 10500, 30, 40), variety="BR25 "),
            Row("Liza Samplesc", "Synthetic Maharlika", (2, 2, 2, 2)),
            Row("Rico Samplesc", "Synthetic Matalaba", (3, 3, 3, 3)),
            # The SUM ranges below stop at row 15 for J, K, L: these three rows are skipped.
            Row("Dina Samplesc", "Synthetic Matalaba", (100, 150, 170, 5)),
            Row("Eric Samplesc", "Synthetic Matalaba", (60, 100, 100, 5)),
            Row("Gina Samplesc", "Synthetic Matalaba", (60, 100, 100, 5)),
        ],
        total_overrides={0: "=SUM(J13:J15)", 1: "=SUM(K13:K15)", 2: "=SUM(L13:L15)"},
        below=[
            Row("Late Sampleentry", "Synthetic Matalaba", (0, 12, 0, 0)),  # has barangay -> draft
            Row("Prepared by: Sample Officer", ""),  # name only -> review list
        ],
    ),
    Sheet(
        "TORRIJOS",
        "Torrijos",
        [
            Row("Tess Sampletor", "Synthetic Poctoy", ("1,200", 30, 0, 0), date_planted=42736),
            Row("Juan A. Samplecruz", "Synthetic Poctoy", (0, 0, 0, 1)),  # same name, other town
        ],
    ),
]


@dataclass
class Expected:
    """Ground truth derived from SHEETS (what a correct import must report)."""

    named_rows: int
    rows_with_trees: int
    true_totals: dict[str, list[int]]  # town -> [seedling, vegetative, flowering, fruiting]
    workbook_totals: dict[str, list[int]]  # what the defective TOTAL rows show
    below_total_with_barangay: int
    name_only_rows: int


def expected() -> Expected:
    true_totals = {
        s.town: [
            sum(
                _n(r.counts[i])
                if not isinstance(r.counts[i], str)
                else int(r.counts[i].replace(",", ""))
                for r in s.rows
            )
            for i in range(4)
        ]
        for s in SHEETS
    }
    workbook = {}
    for s in SHEETS:
        values = []
        for i in range(4):
            override = s.total_overrides.get(i)
            if override is None:
                values.append(true_totals[s.town][i])
                continue
            inner = override[5:-1]
            start, _, end = inner.partition(":")
            r1, r2 = int(start[1:]), int((end or start)[1:])
            rows = s.rows[r1 - FIRST_DATA_ROW : r2 - FIRST_DATA_ROW + 1]
            values.append(sum(_n(r.counts[i]) for r in rows))
        workbook[s.town] = values
    named = sum(len(s.rows) for s in SHEETS)
    with_trees = sum(
        1
        for s in SHEETS
        for r in s.rows
        if any((_n(c) if not isinstance(c, str) else 1) > 0 for c in r.counts)
    )
    return Expected(
        named_rows=named,
        rows_with_trees=with_trees,
        true_totals=true_totals,
        workbook_totals=workbook,
        below_total_with_barangay=sum(1 for s in SHEETS for r in s.below if r.barangay),
        name_only_rows=sum(1 for s in SHEETS for r in s.below if not r.barangay),
    )


def _write_row(ws: Any, r: int, number: int | None, row: Row) -> None:
    ws[f"A{r}"] = number
    ws[f"B{r}"] = row.name
    ws[f"C{r}"] = row.barangay or None
    ws[f"D{r}"] = row.farm_location or None
    ws[f"E{r}"] = row.association or None
    ws[f"F{r}"] = row.contact
    ws[f"G{r}"] = row.variety or None
    ws[f"H{r}"] = row.date_planted
    ws[f"I{r}"] = row.source or None
    for col, value in zip(STAGE_COLS, row.counts, strict=True):
        ws[f"{col}{r}"] = value
    ws[f"N{r}"] = row.remarks or None


def build_legacy_workbook(path: Path) -> Expected:
    wb = Workbook()
    wb.remove(wb.active)
    for spec in SHEETS:
        ws = wb.create_sheet(spec.title)
        ws["A1"] = "Republic of the Philippines"
        ws["A2"] = "Province of Marinduque"
        ws["A3"] = "PROVINCIAL AGRICULTURE OFFICE"
        for r in range(1, 11):
            ws.merge_cells(f"A{r}:N{r}")
        ws["A9"] = f"INITIAL CACAO POPULATION DATA IN THE MUNICIPALITY OF {spec.town.upper()}"
        ws["A10"] = "as of July, 2023"
        for col, header in enumerate(HEADERS, start=1):
            if header:
                ws.cell(row=11, column=col, value=header)
        ws.merge_cells("J11:M11")
        for col, stage in zip(STAGE_COLS, STAGES, strict=True):
            ws[f"{col}12"] = stage
        if spec.extra_empty_column:
            ws["O11"] = None
        r = FIRST_DATA_ROW
        for number, row in enumerate(spec.rows, start=1):
            _write_row(ws, r, number, row)
            r += 1
        last = r - 1
        ws[f"B{r}"] = "TOTAL"
        for i, col in enumerate(STAGE_COLS):
            ws[f"{col}{r}"] = spec.total_overrides.get(
                i, f"=SUM({col}{FIRST_DATA_ROW}:{col}{last})"
            )
        r += 2
        for row in spec.below:
            _write_row(ws, r, None, row)
            r += 1

    summary = wb.create_sheet("SUMMARY")
    summary["A3"] = "SUMMARY OF CACAO POPULATION (synthetic)"
    summary["C5"] = "AREA BY STAGE (ha)"
    summary["G5"] = "PLANT POPULATION BY STAGE"
    summary["A6"] = "MUNICIPALITY"
    summary["B6"] = "NO. OF FARMERS"
    labels = ["GROWING", "VEGETATIVE", "FLOWERING", "FRUITING"]
    for offset, label in enumerate(labels):
        summary.cell(row=6, column=3 + offset, value=label)
        summary.cell(row=6, column=7 + offset, value=label)
    truth = expected()
    for i, spec in enumerate(SHEETS):
        row = 7 + i
        summary.cell(row=row, column=1, value=spec.town.upper())
        summary.cell(row=row, column=2, value=len(spec.rows))
        for s in range(4):
            trees = truth.workbook_totals[spec.town][s]
            summary.cell(row=row, column=3 + s, value=round(trees / 625, 2))
            summary.cell(row=row, column=7 + s, value=trees)
    summary["A20"] = "625 cacao trees/hectare with 4x4 planting distance"
    summary["A22"] = "Prepared by:"
    wb.save(path)
    return truth
