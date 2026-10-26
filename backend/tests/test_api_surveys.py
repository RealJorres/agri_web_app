import pytest

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.catalog.models import GrowthStage
from apps.farms.tests.factories import CropStandFactory, cacao
from apps.locations.tests.factories import BarangayFactory
from apps.surveys.models import RecordStatus
from apps.surveys.tests.factories import SurveyRoundFactory, record_with_counts

pytestmark = pytest.mark.django_db


@pytest.fixture
def brgy(municipalities):
    return BarangayFactory(municipality=municipalities["Gasan"])


@pytest.fixture
def stand(brgy):
    return CropStandFactory(farm__barangay=brgy, farm__farmer__home_barangay=brgy)


@pytest.fixture
def clients(auth_client, municipalities):
    gasan = municipalities["Gasan"]
    return {
        "encoder": auth_client(user_with_role(Role.PROVINCIAL_ENCODER)),
        "validator": auth_client(user_with_role(Role.MAO_VALIDATOR, municipality=gasan)),
        "coordinator": auth_client(
            user_with_role(Role.PROGRAM_COORDINATOR, program=cacao().program)
        ),
        "viewer": auth_client(user_with_role(Role.VIEWER)),
    }


def stage_id(code):
    return str(GrowthStage.objects.get(commodity=cacao(), code=code).pk)


def test_full_workflow_over_http(clients, stand):
    survey_round = SurveyRoundFactory()
    created = clients["encoder"].post(
        "/api/v1/inventory-records",
        {
            "survey_round": str(survey_round.pk),
            "crop_stand": str(stand.pk),
            "counts": [{"growth_stage": stage_id("FRUITING"), "count": 30}],
        },
        format="json",
    )
    assert created.status_code == 201, created.json()
    body = created.json()
    assert body["status"] == "draft"
    assert body["total"] == 30
    assert body["allowed_actions"] == ["edit", "submit"]
    rid = body["id"]

    # Status cannot be changed through PATCH: it is not an input field.
    patched = clients["encoder"].patch(
        f"/api/v1/inventory-records/{rid}", {"status": "approved", "remarks": "ok"}, format="json"
    )
    assert patched.json()["status"] == "draft"
    assert patched.json()["remarks"] == "ok"

    steps = [
        ("encoder", "submit", {}, "submitted"),
        ("validator", "return", {"comment": "Recount seedlings"}, "draft"),
        ("encoder", "submit", {}, "submitted"),
        ("validator", "validate", {}, "validated"),
        ("coordinator", "approve", {"comment": "OK"}, "approved"),
    ]
    for who, action, payload, expected in steps:
        response = clients[who].post(
            f"/api/v1/inventory-records/{rid}/{action}", payload, format="json"
        )
        assert response.status_code == 200, (action, response.json())
        assert response.json()["status"] == expected

    comments = clients["coordinator"].get(f"/api/v1/inventory-records/{rid}/comments").json()
    assert [c["action"] for c in comments] == ["return", "approve"]
    audit = clients["coordinator"].get(f"/api/v1/inventory-records/{rid}/audit").json()["results"]
    assert [e["action"] for e in reversed(audit)] == [
        "inventory.create",
        "inventory.update",
        "inventory.submit",
        "inventory.return",
        "inventory.submit",
        "inventory.validate",
        "inventory.approve",
    ]

    totals = clients["viewer"].get(f"/api/v1/survey-rounds/{survey_round.pk}/totals").json()
    assert totals == [
        {
            "municipality_id": str(stand.farm.barangay.municipality_id),
            "municipality": "Gasan",
            "stage_code": "FRUITING",
            "stage_label": "Fruiting",
            "sort_order": 4,
            "count": 30,
            "area_ha": "0.05",
        }
    ]


def test_wrong_role_gets_403_and_wrong_state_409(clients, stand):
    record = record_with_counts(
        counts={"FRUITING": 1}, crop_stand=stand, status=RecordStatus.SUBMITTED
    )

    forbidden = clients["encoder"].post(f"/api/v1/inventory-records/{record.pk}/validate")
    conflict = clients["validator"].post(
        f"/api/v1/inventory-records/{record.pk}/reopen", {"comment": "x"}
    )
    missing_comment = clients["validator"].post(f"/api/v1/inventory-records/{record.pk}/return")

    assert forbidden.status_code == 403
    assert conflict.status_code == 403  # validators lack REOPEN entirely
    assert missing_comment.status_code == 400
    assert missing_comment.json()["code"] == "comment_required"


def test_submit_validation_error_contract(clients, stand):
    record = record_with_counts(counts={"FRUITING": 0}, crop_stand=stand)

    response = clients["encoder"].post(f"/api/v1/inventory-records/{record.pk}/submit")

    assert response.status_code == 400
    assert response.json()["code"] == "validation_failed"
    assert response.json()["fields"]["counts"]


def test_viewer_sees_aggregates_but_not_records(clients, stand):
    record = record_with_counts(
        counts={"FRUITING": 5}, crop_stand=stand, status=RecordStatus.APPROVED
    )

    assert clients["viewer"].get("/api/v1/inventory-records").status_code == 403
    assert clients["viewer"].get(f"/api/v1/inventory-records/{record.pk}").status_code == 403
    assert clients["viewer"].get("/api/v1/survey-rounds").status_code == 200
    progress = clients["viewer"].get(f"/api/v1/survey-rounds/{record.survey_round_id}/progress")
    assert progress.json()[0]["approved"] == 1
    stats = clients["viewer"].get("/api/v1/stats/home").json()
    assert stats["commodities"][0]["total"] == 5


def test_rounds_open_and_close_over_http(clients):
    created = clients["coordinator"].post(
        "/api/v1/survey-rounds",
        {"commodity": str(cacao().pk), "name": "Cacao 2026", "as_of_date": "2026-06-30"},
    )
    denied = clients["encoder"].post(
        "/api/v1/survey-rounds",
        {"commodity": str(cacao().pk), "name": "Nope", "as_of_date": "2026-06-30"},
    )

    assert created.status_code == 201
    assert created.json()["status"] == "open"
    assert denied.status_code == 403
    rid = created.json()["id"]
    assert clients["encoder"].post(f"/api/v1/survey-rounds/{rid}/close").status_code == 403
    closed = clients["coordinator"].post(f"/api/v1/survey-rounds/{rid}/close")
    assert closed.json() == {"locked": 0}


def test_record_filters(clients, stand, brgy):
    survey_round = SurveyRoundFactory()
    record_with_counts(counts={"FRUITING": 1}, crop_stand=stand, survey_round=survey_round,
                       status=RecordStatus.SUBMITTED)  # fmt: skip
    other = CropStandFactory(farm__barangay=brgy, farm__farmer__home_barangay=brgy)
    record_with_counts(counts={"FRUITING": 1}, crop_stand=other, survey_round=survey_round)

    def count(params):
        return clients["validator"].get("/api/v1/inventory-records", params).json()["count"]

    assert count({"status": ["submitted", "validated"]}) == 1
    assert count({"survey_round": str(survey_round.pk)}) == 2
    assert count({"farmer": str(stand.farm.farmer_id)}) == 1


def test_harvests_over_http(clients, stand, auth_client, municipalities):
    created = clients["encoder"].post(
        f"/api/v1/crop-stands/{stand.pk}/harvests",
        {"quantity": "8", "unit": "kg", "product_form": "dried_beans", "raw_text": "8 kilos dried"},
    )
    assert created.status_code == 201, created.json()
    assert created.json()["date_estimated"] is True
    hid = created.json()["id"]

    listed = clients["encoder"].get(f"/api/v1/crop-stands/{stand.pk}/harvests").json()
    assert [h["quantity"] for h in listed] == ["8.000"]

    patched = clients["encoder"].patch(f"/api/v1/harvests/{hid}", {"quantity": "9"})
    assert patched.json()["quantity"] == "9.000"
    negative = clients["encoder"].patch(f"/api/v1/harvests/{hid}", {"quantity": "-1"})
    assert negative.status_code == 400

    outsider = auth_client(user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Boac"]))
    assert outsider.get(f"/api/v1/harvests/{hid}").status_code == 404
    assert clients["encoder"].get("/api/v1/harvests").status_code == 405
    assert clients["encoder"].delete(f"/api/v1/harvests/{hid}").status_code == 204
