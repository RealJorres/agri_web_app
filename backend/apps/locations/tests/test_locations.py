"""PSGC loader tests use a synthetic file with obviously fake codes (region 99); real PSGC codes are
only ever loaded from the PAO-supplied file (ADR-0005)."""

from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from openpyxl import Workbook

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.locations.checks import municipalities_have_psgc_codes
from apps.locations.models import Barangay, Municipality
from apps.locations.services import load_psgc, seed_municipalities
from common.exceptions import DomainError

from .factories import BarangayFactory

pytestmark = pytest.mark.django_db

HEADER = ["10-digit PSGC", "Name", "Correspondence Code", "Geographic Level"]
ROWS = [
    ["9904000000", "Marinduque", "", "Prov"],
    ["9904001000", "Boac (Capital)", "", "Mun"],
    ["9904001001", "Synthetic Alpha", "", "Bgy"],
    ["9904001002", "Synthetic Beta", "", "Bgy"],
    ["9904002000", "Gasan", "", "Mun"],
    ["9904002001", "Synthetic Gamma", "", "Bgy"],
    ["9904099000", "Not In Database", "", "Mun"],
    ["9905000000", "Other Province", "", "Prov"],
    ["9905001000", "Elsewhere", "", "Mun"],
]


@pytest.fixture
def psgc_xlsx(tmp_path):
    wb = Workbook()
    ws = wb.active
    ws.title = "PSGC"
    ws.append(["Philippine Standard Geographic Code (synthetic test file)"])
    ws.append(HEADER)
    for row in ROWS:
        ws.append(row)
    path = tmp_path / "psgc-synthetic.xlsx"
    wb.save(path)
    return path


@pytest.fixture
def psgc_csv(tmp_path):
    path = tmp_path / "psgc-synthetic.csv"
    path.write_text("\n".join(",".join(r) for r in [HEADER, *ROWS]), encoding="utf-8")
    return path


def test_seed_municipalities_is_idempotent():
    assert seed_municipalities() == 6
    assert seed_municipalities() == 0
    assert set(Municipality.objects.values_list("name", flat=True)) == {
        "Boac",
        "Buenavista",
        "Gasan",
        "Mogpog",
        "Santa Cruz",
        "Torrijos",
    }
    assert not Municipality.objects.exclude(psgc_code=None).exists()


def test_barangay_normalized_name_is_unique_per_municipality(municipalities):
    from django.db import IntegrityError

    BarangayFactory(municipality=municipalities["Boac"], name="Sta. Rosa")
    BarangayFactory(municipality=municipalities["Gasan"], name="Sta. Rosa")  # other town: fine

    with pytest.raises(IntegrityError):
        BarangayFactory(municipality=municipalities["Boac"], name="sta rosa")


def test_load_psgc_codes_and_verifies(psgc_xlsx, municipalities):
    imported = BarangayFactory(
        municipality=municipalities["Boac"], name="Synthetic Alpha", is_verified=False
    )
    orphan = BarangayFactory(
        municipality=municipalities["Gasan"], name="Typo Barangay", is_verified=False
    )

    report = load_psgc(psgc_xlsx, province="Marinduque")

    assert sorted(report.municipalities_coded) == ["Boac", "Gasan"]
    assert report.municipalities_missing == ["Not In Database"]
    assert report.barangays_verified == 1
    assert report.barangays_created == 2
    assert report.barangays_unmatched == [str(orphan)]
    imported.refresh_from_db()
    assert (imported.psgc_code, imported.is_verified) == ("9904001001", True)
    assert Municipality.objects.get(name="Boac").psgc_code == "9904001000"
    assert not Barangay.objects.filter(name="Elsewhere").exists()


def test_load_psgc_dry_run_changes_nothing(psgc_xlsx, municipalities):
    report = load_psgc(psgc_xlsx, province="Marinduque", dry_run=True)

    assert report.barangays_created == 3
    assert not Barangay.objects.exists()
    assert Municipality.objects.get(name="Boac").psgc_code is None


def test_load_psgc_from_csv(psgc_csv, municipalities):
    report = load_psgc(psgc_csv, province="marinduque")

    assert report.barangays_created == 3


def test_load_psgc_unknown_province(psgc_xlsx, municipalities):
    with pytest.raises(DomainError) as info:
        load_psgc(psgc_xlsx, province="Nowhere")

    assert info.value.code == "psgc_province"


def test_load_psgc_bad_header(tmp_path):
    path = tmp_path / "psgc.csv"
    path.write_text("a,b,c\n1,2,3\n", encoding="utf-8")

    with pytest.raises(DomainError) as info:
        load_psgc(path, province="Marinduque")

    assert info.value.code == "psgc_format"


def test_seed_psgc_command(psgc_xlsx, municipalities):
    out = StringIO()

    call_command("seed_psgc", province="Marinduque", file=psgc_xlsx, stdout=out)

    assert "Boac" in out.getvalue()
    assert "Not in database: Not In Database" in out.getvalue()


def test_seed_psgc_command_errors(psgc_xlsx, tmp_path, municipalities, settings):
    settings.DATA_DIR = tmp_path
    with pytest.raises(CommandError, match="not found"):
        call_command("seed_psgc", province="Marinduque")
    with pytest.raises(CommandError, match="Nowhere"):
        call_command("seed_psgc", province="Nowhere", file=psgc_xlsx)


def test_seed_command_uses_reference_file(psgc_xlsx, settings, tmp_path):
    reference = tmp_path / "reference"
    reference.mkdir()
    psgc_xlsx.rename(reference / psgc_xlsx.name)
    settings.DATA_DIR = tmp_path
    out = StringIO()

    call_command("seed", stdout=out)

    assert "PSGC: 2 municipalities coded" in out.getvalue()


def test_seed_command_without_reference_file(settings, tmp_path):
    settings.DATA_DIR = tmp_path
    out = StringIO()

    call_command("seed", stdout=out)

    assert "No PSGC file" in out.getvalue()
    assert Municipality.objects.count() == 6


def test_psgc_system_check(municipalities):
    assert municipalities_have_psgc_codes()[0].id == "locations.W001"
    Municipality.objects.update(psgc_code=None)
    for i, m in enumerate(Municipality.objects.all()):
        m.psgc_code = f"99{i:08d}"
        m.save()
    assert municipalities_have_psgc_codes() == []


def test_barangay_api_filters(auth_client, municipalities):
    BarangayFactory(municipality=municipalities["Boac"], name="Synthetic One")
    BarangayFactory(municipality=municipalities["Gasan"], name="Synthetic Two")
    client = auth_client(user_with_role(Role.VIEWER))

    by_town = client.get("/api/v1/barangays", {"municipality": municipalities["Gasan"].pk})
    by_text = client.get("/api/v1/barangays", {"q": "one"})

    assert [b["name"] for b in by_town.json()] == ["Synthetic Two"]
    assert [b["name"] for b in by_text.json()] == ["Synthetic One"]
    assert len(client.get("/api/v1/municipalities").json()) == 6
