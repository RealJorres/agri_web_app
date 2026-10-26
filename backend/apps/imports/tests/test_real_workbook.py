"""Acceptance tests against the REAL PAO workbook (brief §3 expected results).

Skipped automatically when data/raw/ has no workbook (CI, fresh clones). They assert counts and
totals only and never print personal data.
"""

from decimal import Decimal
from pathlib import Path

import pytest

from apps.imports import services
from apps.imports.models import ImportKind, ImportStatus

from .conftest import upload_of

# The PAO's file name varies ("cacao production data as of july, 2023.xlsx"); match loosely.
REAL_FILE = next(
    iter(sorted(Path("/data/raw").glob("*cacao*2023*.xlsx"))), Path("/data/raw/missing.xlsx")
)
STAGES = ["SEEDLING", "VEGETATIVE", "FLOWERING", "FRUITING"]
TRUE_TOTALS = {
    "Boac": [30, 3_205, 1_365, 2_475],
    "Buenavista": [7_085, 4_175, 615, 3_244],
    "Mogpog": [1_053, 1_332, 600, 988],
    "Gasan": [2_750, 5_650, 1_915, 3_520],
    "Santa Cruz": [1_483, 14_655, 6_205, 9_334],
    "Torrijos": [1_230, 3_800, 3_333, 1_670],
}
PROVINCE = [13_631, 32_817, 14_033, 21_231]

pytestmark = [
    pytest.mark.real_data,
    pytest.mark.django_db,
    pytest.mark.skipif(not REAL_FILE.is_file(), reason=f"{REAL_FILE.name} not in data/raw/"),
]


@pytest.fixture
def previewed(seeded, admin):
    job = services.create_job(
        actor=admin, upload=upload_of(REAL_FILE), kind=ImportKind.LEGACY_CACAO_2023
    )
    job = services.run_preview(job)
    assert job.status == ImportStatus.READY, job.error_message
    return job


def test_row_counts(previewed):
    counts = previewed.summary["counts"]

    assert counts["named_rows"] == 212
    assert counts["rows_with_trees"] == 208


def test_true_totals_per_municipality_and_province(previewed):
    rec = previewed.summary["reconciliation"]
    by_town = {m["municipality"]: m for m in rec["municipalities"]}

    for town, expected in TRUE_TOTALS.items():
        assert [by_town[town]["stages"][s]["computed"] for s in STAGES] == expected, town
    assert [rec["province"]["computed"][s] for s in STAGES] == PROVINCE
    assert rec["province"]["computed_total"] == 81_712
    assert Decimal(rec["province"]["area_ha"]) == Decimal("130.74")


def test_reconciliation_shows_santa_cruz_plus_940(previewed):
    rec = previewed.summary["reconciliation"]
    santa_cruz = next(m for m in rec["municipalities"] if m["municipality"] == "Santa Cruz")

    assert santa_cruz["diff_total"] == 940
    assert [santa_cruz["stages"][s]["diff_workbook"] for s in STAGES] == [220, 350, 370, 0]
    assert rec["province"]["workbook_total"] == 80_772


def test_mogpog_single_cell_flowering_total(previewed):
    rec = previewed.summary["reconciliation"]
    mogpog = next(m for m in rec["municipalities"] if m["municipality"] == "Mogpog")

    assert mogpog["stages"]["FLOWERING"]["formula"].upper() == "=SUM(L28)"
    assert mogpog["stages"]["FLOWERING"]["uncovered_rows"]  # fragile even though totals agree
    assert any("Mogpog FLOWERING" in d and "does not cover" in d for d in rec["differences"])


def test_commit_gives_official_total_81712(previewed, admin):
    job = services.commit_job(job=previewed, actor=admin)

    assert job.summary["commit"]["official_total"] == 81_712

    from django.db.models import Sum

    from apps.analytics.models import StageTotal
    from apps.analytics.services import refresh_views

    refresh_views()
    assert StageTotal.objects.aggregate(t=Sum("trees"))["t"] == 81_712  # dashboards agree
