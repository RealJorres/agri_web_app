import pytest

from apps.catalog.selectors import stage_index
from apps.farms.tests.factories import cacao
from apps.imports.legacy_cacao_2023 import read_workbook, sum_ranges
from apps.locations.services import MARINDUQUE_MUNICIPALITIES

from .legacy_fixture import build_legacy_workbook

pytestmark = pytest.mark.django_db


@pytest.fixture
def workbook(tmp_path):
    path = tmp_path / "synthetic-cacao-2023.xlsx"
    truth = build_legacy_workbook(path)
    return read_workbook(path, MARINDUQUE_MUNICIPALITIES, stage_index(cacao()).resolve), truth


def test_reads_every_municipal_sheet_and_summary(workbook):
    wb, _ = workbook

    assert [s.municipality for s in wb.sheets] == [
        "Boac",
        "Buenavista",
        "Mogpog",
        "Gasan",
        "Santa Cruz",
        "Torrijos",
    ]
    assert wb.unknown_sheets == []
    boac = wb.sheets[0]
    assert boac.header_row == 11
    assert boac.stage_columns == {"SEEDLING": 10, "VEGETATIVE": 11, "FLOWERING": 12, "FRUITING": 13}
    assert boac.title.startswith("INITIAL CACAO POPULATION DATA")
    assert boac.as_of == "as of July, 2023"
    assert boac.issues == []


def test_rows_split_at_total_row(workbook):
    wb, truth = workbook
    santa_cruz = next(s for s in wb.sheets if s.municipality == "Santa Cruz")

    assert len([r for s in wb.sheets for r in s.above_total]) == truth.named_rows
    assert santa_cruz.total_row == 19
    assert [r.name for r in santa_cruz.below_total] == [
        "Late Sampleentry",
        "Prepared by: Sample Officer",
    ]


def test_total_formulas_evaluated_and_coverage_known(workbook):
    wb, truth = workbook
    santa_cruz = next(s for s in wb.sheets if s.municipality == "Santa Cruz")
    mogpog = next(s for s in wb.sheets if s.municipality == "Mogpog")

    seedling = santa_cruz.totals["SEEDLING"]
    assert seedling.formula == "=SUM(J13:J15)"
    assert seedling.covered_rows == [13, 14, 15]
    assert seedling.workbook_value == truth.workbook_totals["Santa Cruz"][0]
    assert santa_cruz.totals["FRUITING"].covered_rows == list(range(13, 19))
    assert mogpog.totals["FLOWERING"].formula == "=SUM(L13)"
    assert mogpog.totals["FLOWERING"].covered_rows == [13]


def test_summary_sheet_maps_growing_to_seedling(workbook):
    wb, truth = workbook

    row = wb.summary["santa cruz"]
    assert row.farmers == 6
    assert row.population["SEEDLING"] == truth.workbook_totals["Santa Cruz"][0]
    assert row.area["SEEDLING"] == round(truth.workbook_totals["Santa Cruz"][0] / 625, 2)
    assert wb.summary_issues == []


@pytest.mark.parametrize(
    ("formula", "ranges"),
    [
        ("=SUM(J13:J48)", [(10, 13, 10, 48)]),
        ("=SUM(L28)", [(12, 28, 12, 28)]),
        ("=sum($J$13:$J$20, J22)", [(10, 13, 10, 20), (10, 22, 10, 22)]),
        ("=J13+J14", None),
        ("", None),
    ],
)
def test_sum_ranges(formula, ranges):
    assert sum_ranges(formula) == ranges


def test_sheet_without_header_is_reported(tmp_path):
    from openpyxl import Workbook

    wb = Workbook()
    wb.active.title = "GASAN"
    wb.active["A1"] = "nothing here"
    path = tmp_path / "bad.xlsx"
    wb.save(path)

    result = read_workbook(path, MARINDUQUE_MUNICIPALITIES, stage_index(cacao()).resolve)

    assert result.sheets[0].issues == ["Header row with 'NAME OF FARMER' not found; sheet skipped."]
    assert result.summary_issues == []
