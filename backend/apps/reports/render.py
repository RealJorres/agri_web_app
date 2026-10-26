"""Lay report content out as .xlsx (openpyxl) or .pdf (WeasyPrint). No data access here."""

import base64
import io
from typing import Any

from django.template.loader import render_to_string
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from .models import ReportSettings

THIN = Side(style="thin", color="999999")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
BOLD = Font(bold=True)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)


def _letterhead(ws: Worksheet, content: dict[str, Any], width: int, title: str) -> int:
    row = 1
    for line in content["letterhead"]:
        ws.cell(row=row, column=1, value=line).font = Font(bold=row <= 3)
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=width)
        ws.cell(row=row, column=1).alignment = Alignment(horizontal="center")
        row += 1
    row += 1
    for text in (content["program_line"], title, f"as of {content['round']['as_of']}"):
        if not text:
            continue
        ws.cell(row=row, column=1, value=text).font = BOLD
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=width)
        ws.cell(row=row, column=1).alignment = Alignment(horizontal="center")
        row += 1
    if not content["final"]:
        ws.cell(
            row=row, column=1, value="DRAFT - the round is still open; figures may change."
        ).font = Font(bold=True, color="B8322F")
        row += 1
    return row + 1


def _signatures(ws: Worksheet, content: dict[str, Any], row: int, width: int) -> None:
    blocks = content["signatories"] or [
        {"caption": c, "name": "", "title": ""} for c in ("Prepared by:", "Submitted by:", "Noted:")
    ]
    row += 2
    span = max(1, width // max(1, len(blocks)))
    for i, block in enumerate(blocks):
        col = 1 + i * span
        ws.cell(row=row, column=col, value=block["caption"])
        ws.cell(
            row=row + 2, column=col, value=block["name"] or "______________________"
        ).font = BOLD
        ws.cell(row=row + 3, column=col, value=block["title"])


def _bytes(wb: Workbook) -> bytes:
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def summary_xlsx(content: dict[str, Any]) -> bytes:
    stages: list[str] = content["stages"]
    n = len(stages)
    width = 2 + (n + 1) * 2  # municipality, farmers, area x n + total, trees x n + total
    wb = Workbook()
    ws = wb.active
    ws.title = "SUMMARY"
    title = (
        f"SUMMARY OF {content['commodity'].upper()} POPULATION DATA IN THE PROVINCE OF MARINDUQUE"
    )
    row = _letterhead(ws, content, width, title)

    # Two header rows like the 2023 sheet.
    headers = [
        (1, 1, "MUNICIPALITY / PROVINCE"),
        (2, 2, "NO. OF FARMERS"),
        (3, 2 + n, "AREA PLANTED (HA.)"),
        (3 + n, 3 + n, "TOTAL AREA (HA.)"),
        (4 + n, 3 + 2 * n, "PLANT POPULATION"),
        (4 + 2 * n, 4 + 2 * n, "TOTAL PLANT POPULATION"),
    ]
    for start, end, text in headers:
        ws.cell(row=row, column=start, value=text)
        if end > start:
            ws.merge_cells(start_row=row, start_column=start, end_row=row, end_column=end)
        else:
            ws.merge_cells(start_row=row, start_column=start, end_row=row + 1, end_column=start)
    for i, label in enumerate(stages):
        ws.cell(row=row + 1, column=3 + i, value=label.upper())
        ws.cell(row=row + 1, column=4 + n + i, value=label.upper())
    for r in (row, row + 1):
        for c in range(1, width + 1):
            cell = ws.cell(row=r, column=c)
            cell.font, cell.alignment, cell.border = BOLD, CENTER, BOX
    row += 2

    def write(values: list[Any], bold: bool = False) -> None:
        nonlocal row
        for c, value in enumerate(values, start=1):
            cell = ws.cell(row=row, column=c, value=value)
            cell.border = BOX
            cell.font = Font(bold=bold)
            if isinstance(value, float):
                cell.number_format = "0.000"
            elif isinstance(value, int):
                cell.number_format = "#,##0"
        row += 1

    def num(v: Any) -> Any:
        return float(v) if v is not None else None

    for r in content["rows"]:
        write(
            [
                f"{r['municipality'].upper()}, MARINDUQUE",
                r["farmers"],
                *map(num, r["area"]),
                num(r["area_total"]),
                *r["trees"],
                r["trees_total"],
            ]
        )
    t = content["total"]
    write(
        [
            "TOTAL",
            t["farmers"],
            *map(num, t["area"]),
            num(t["area_total"]),
            *t["trees"],
            t["trees_total"],
        ],
        bold=True,
    )
    if content["density_note"]:
        ws.cell(row=row + 1, column=1, value=f"NOTE: {content['density_note']}")
        row += 1
    _signatures(ws, content, row, width)

    ws.column_dimensions["A"].width = 28
    for c in range(2, width + 1):
        ws.column_dimensions[get_column_letter(c)].width = 13
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    return _bytes(wb)


def municipal_list_xlsx(content: dict[str, Any]) -> bytes:
    stages: list[str] = content["stages"]
    columns = [
        "NO.",
        "NAME OF FARMER",
        "BARANGAY",
        "FARM LOCATION",
        "NAME OF ASSOCIATION",
        "CONTACT NO.",
        "VARIETY",
        "DATE PLANTED",
        "SOURCE OF PLANTING MATERIALS",
        *[s.upper() for s in stages],
        "REMARKS",
    ]
    wb = Workbook()
    ws = wb.active
    ws.title = content["municipality"].upper()[:31] or "LIST"
    title = (
        f"{content['commodity'].upper()} POPULATION DATA IN THE MUNICIPALITY OF "
        f"{content['municipality'].upper()}"
    )
    row = _letterhead(ws, content, len(columns), title)
    for c, text in enumerate(columns, start=1):
        cell = ws.cell(row=row, column=c, value=text)
        cell.font, cell.alignment, cell.border = BOLD, CENTER, BOX
    row += 1
    for r in content["rows"]:
        values = [
            r["no"],
            r["name"],
            r["barangay"],
            r["farm_location"],
            r["association"],
            r["contact"],
            r["variety"],
            r["planted"],
            r["source"],
            *r["counts"],
            r["remarks"],
        ]
        for c, value in enumerate(values, start=1):
            ws.cell(row=row, column=c, value=value).border = BOX
        row += 1
    ws.cell(row=row, column=2, value="TOTAL").font = BOLD
    for i, total in enumerate(content["totals"]):
        cell = ws.cell(row=row, column=10 + i, value=total)
        cell.font, cell.number_format = BOLD, "#,##0"
    _signatures(ws, content, row + 1, len(columns))
    for c, w in enumerate([6, 28, 18, 18, 24, 15, 14, 14, 18], start=1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.page_setup.orientation = "landscape"
    return _bytes(wb)


def _logo_data_uri() -> str:
    settings = ReportSettings.current()
    if not settings.logo:
        return ""
    with settings.logo.open("rb") as fh:
        data = base64.b64encode(fh.read()).decode()
    return f"data:image/png;base64,{data}"


def pdf(template: str, content: dict[str, Any]) -> bytes:
    from weasyprint import HTML  # heavy import: only when a PDF is requested

    html = render_to_string(template, {"c": content, "logo": _logo_data_uri()})
    return HTML(string=html).write_pdf()
