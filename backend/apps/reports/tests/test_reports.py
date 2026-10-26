import datetime as dt
import io
from decimal import Decimal

import pytest
from openpyxl import load_workbook

from apps.accounts.roles import Role
from apps.accounts.selectors import get_scope
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.farms.tests.factories import CropStandFactory, cacao
from apps.imports.services import FULL_SCOPE
from apps.locations.tests.factories import BarangayFactory
from apps.reports import content, render, services
from apps.reports.models import ReportSignoff
from apps.surveys import services as survey_services
from apps.surveys.models import RecordStatus, RoundStatus
from apps.surveys.tests.factories import SurveyRoundFactory, record_with_counts
from common.exceptions import DomainError

pytestmark = pytest.mark.django_db
S = RecordStatus


def stand_in(barangay, farmer=None):
    if farmer is not None:
        return CropStandFactory(farm__barangay=barangay, farm__farmer=farmer)
    return CropStandFactory(farm__barangay=barangay, farm__farmer__home_barangay=barangay)


@pytest.fixture
def world(municipalities):
    gasan = BarangayFactory(municipality=municipalities["Gasan"], name="Synthetic Gasan")
    boac = BarangayFactory(municipality=municipalities["Boac"], name="Synthetic Boac")
    survey_round = SurveyRoundFactory(name="Synthetic 2023", as_of_date=dt.date(2023, 7, 31))
    a = record_with_counts(
        counts={"SEEDLING": 100, "FRUITING": 300},
        crop_stand=stand_in(gasan),
        survey_round=survey_round,
        status=S.APPROVED,
    )
    # Same farmer, second farm: one farmer, not two.
    record_with_counts(
        counts={"FRUITING": 25},
        crop_stand=stand_in(gasan, farmer=a.crop_stand.farm.farmer),
        survey_round=survey_round,
        status=S.APPROVED,
    )
    record_with_counts(  # no counts at all: not a farmer "with trees"
        counts={}, crop_stand=stand_in(gasan), survey_round=survey_round, status=S.APPROVED
    )
    record_with_counts(
        counts={"VEGETATIVE": 1250},
        crop_stand=stand_in(boac),
        survey_round=survey_round,
        status=S.APPROVED,
    )
    record_with_counts(  # never in an official report
        counts={"FRUITING": 9999},
        crop_stand=stand_in(boac),
        survey_round=survey_round,
        status=S.DRAFT,
    )
    return {"round": survey_round, "gasan": municipalities["Gasan"], "boac": municipalities["Boac"]}


def head():
    return user_with_role(Role.PROVINCIAL_HEAD)


def close(survey_round):
    survey_services.close_round(
        actor=user_with_role(Role.PROGRAM_COORDINATOR, program=cacao().program),
        survey_round=survey_round,
    )
    survey_round.refresh_from_db()


def test_summary_figures_from_official_records_only(world):
    c = content.summary(world["round"], FULL_SCOPE)
    rows = {r["municipality"]: r for r in c["rows"]}
    assert rows["Gasan"]["trees_total"] == 425
    assert rows["Gasan"]["farmers"] == 1  # duplicate farmer merged; empty record not counted
    assert rows["Boac"]["trees_total"] == 1250
    assert rows["Boac"]["area_total"] == Decimal("2.000")  # 1,250 / 625 per ha
    assert c["total"]["trees_total"] == 1675
    assert c["total"]["farmers"] == 2
    assert c["density_note"] == "625 cacao trees/hectare with 4x4 planting distance"
    assert c["final"] is False


def test_summary_is_scoped(world):
    validator = user_with_role(Role.MAO_VALIDATOR, municipality=world["boac"])
    c = content.summary(world["round"], get_scope(validator))
    assert [r["municipality"] for r in c["rows"]] == ["Boac"]


def test_content_hash_is_stable_and_ignores_draft_state(world):
    before = content.content_hash(content.summary(world["round"], FULL_SCOPE))
    assert before == content.content_hash(content.summary(world["round"], FULL_SCOPE))
    close(world["round"])
    after = content.summary(world["round"], FULL_SCOPE)
    assert after["final"] is True
    assert content.content_hash(after) == before


def test_xlsx_and_pdf_render(world):
    c = content.summary(world["round"], FULL_SCOPE)
    ws = load_workbook(io.BytesIO(render.summary_xlsx(c))).active
    values = [cell for row in ws.iter_rows(values_only=True) for cell in row]
    assert "TOTAL" in values
    assert 1675 in values
    assert render.pdf("reports/summary.html", c).startswith(b"%PDF")


def test_open_round_cannot_be_signed(world):
    with pytest.raises(DomainError) as err:
        services.sign_off_summary(actor=head(), survey_round=world["round"])
    assert err.value.code == "round_open"


def test_sign_off_then_superseded_by_reopen(world):
    close(world["round"])
    assert world["round"].status == RoundStatus.CLOSED
    signer = head()
    signoff = services.sign_off_summary(actor=signer, survey_round=world["round"])
    assert services.signoff_status(world["round"]).state == "signed"
    assert AuditLog.objects.filter(action="report.sign_off", object_id=str(signoff.pk)).exists()
    with pytest.raises(DomainError) as err:
        services.sign_off_summary(actor=signer, survey_round=world["round"])
    assert err.value.code == "already_signed"

    record = world["round"].records.get(
        crop_stand__farm__barangay__municipality=world["boac"], status=S.LOCKED
    )
    survey_services.reopen(
        actor=user_with_role(Role.PROGRAM_COORDINATOR, program=cacao().program),
        record=record,
        comment="Synthetic correction",
    )
    assert services.signoff_status(world["round"]).state == "superseded"


@pytest.mark.parametrize("who", [Role.PROGRAM_COORDINATOR, Role.VIEWER, Role.MAO_VALIDATOR])
def test_only_sign_reports_capability_can_sign(world, auth_client, who):
    close(world["round"])
    user = user_with_role(who, municipality=world["boac"], program=cacao().program)
    response = auth_client(user).post(f"/api/v1/reports/rounds/{world['round'].pk}/sign-off")
    assert response.status_code == 403
    assert not ReportSignoff.objects.exists()


def test_signoff_api(world, auth_client):
    close(world["round"])
    client = auth_client(head())
    url = f"/api/v1/reports/rounds/{world['round'].pk}/sign-off"
    assert client.get(url).json()["state"] == "unsigned"
    response = client.post(url)
    assert response.status_code == 201
    assert response.json()["state"] == "signed"


def test_summary_download(world, auth_client):
    client = auth_client(user_with_role(Role.VIEWER))
    for fmt, magic in (("xlsx", b"PK"), ("pdf", b"%PDF")):
        response = client.get(f"/api/v1/reports/rounds/{world['round'].pk}/summary.{fmt}")
        assert response.status_code == 200
        assert response.content.startswith(magic)
        assert response["Cache-Control"] == "no-store"


def test_municipal_list_needs_export_capability(world, auth_client):
    url = f"/api/v1/reports/rounds/{world['round'].pk}/municipal-list.xlsx"
    viewer = auth_client(user_with_role(Role.VIEWER))
    assert viewer.get(url, {"municipality": world["gasan"].pk}).status_code == 403


def test_municipal_list_for_municipal_staff_is_refused(world, auth_client):
    # Municipal roles have no export_personal_data; the view also re-checks reach (404).
    url = f"/api/v1/reports/rounds/{world['round'].pk}/municipal-list.pdf"
    assert auth_client(head()).get(url, {"municipality": world["gasan"].pk}).status_code == 200
    validator = user_with_role(Role.MAO_VALIDATOR, municipality=world["boac"])
    response = auth_client(validator).get(url, {"municipality": world["gasan"].pk})
    assert response.status_code == 403


def test_municipal_list_export_is_audited(world, auth_client):
    url = f"/api/v1/reports/rounds/{world['round'].pk}/municipal-list.xlsx"
    response = auth_client(head()).get(url, {"municipality": world["gasan"].pk})
    assert response.status_code == 200
    ws = load_workbook(io.BytesIO(response.content)).active
    assert ws.title == "GASAN"
    log = AuditLog.objects.get(action="export.municipal_list")
    assert log.after["municipality"] == "Gasan"
    assert log.after["rows"] == 3  # official records only; the draft is excluded
