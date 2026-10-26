import datetime as dt
from decimal import Decimal
from unittest import mock

import pytest

from apps.accounts.roles import Role
from apps.accounts.selectors import get_scope
from apps.accounts.tests.factories import user_with_role
from apps.analytics import selectors, services
from apps.analytics.models import AnalyticsRefresh, RecordFact, StageTotal
from apps.catalog.models import Variety
from apps.farms.models import PlantingVariety
from apps.farms.tests.factories import CropStandFactory, PlantingFactory, cacao
from apps.locations.tests.factories import BarangayFactory
from apps.surveys import selectors as survey_selectors
from apps.surveys import services as survey_services
from apps.surveys.models import RecordStatus
from apps.surveys.tests.factories import SurveyRoundFactory, record_with_counts

pytestmark = pytest.mark.django_db
S = RecordStatus


def stand_in(barangay):
    return CropStandFactory(farm__barangay=barangay, farm__farmer__home_barangay=barangay)


@pytest.fixture
def world(municipalities):
    gasan_a = BarangayFactory(municipality=municipalities["Gasan"], name="Synthetic Gasan A")
    gasan_b = BarangayFactory(municipality=municipalities["Gasan"], name="Synthetic Gasan B")
    boac = BarangayFactory(municipality=municipalities["Boac"], name="Synthetic Boac")
    old = SurveyRoundFactory(name="Old", as_of_date=dt.date(2023, 7, 31))
    new = SurveyRoundFactory(name="New", as_of_date=dt.date(2025, 7, 31))
    record_with_counts(
        counts={"SEEDLING": 100, "FRUITING": 300},
        crop_stand=stand_in(gasan_a),
        survey_round=old,
        status=S.LOCKED,
    )
    record_with_counts(
        counts={"FRUITING": 500}, crop_stand=stand_in(gasan_a), survey_round=new, status=S.APPROVED
    )
    record_with_counts(
        counts={"VEGETATIVE": 200, "FRUITING": 50},
        crop_stand=stand_in(gasan_b),
        survey_round=new,
        status=S.LOCKED,
    )
    record_with_counts(
        counts={"SEEDLING": 1250}, crop_stand=stand_in(boac), survey_round=new, status=S.APPROVED
    )
    for status in (S.DRAFT, S.SUBMITTED, S.VALIDATED):  # never in analytics
        record_with_counts(
            counts={"FRUITING": 9999}, crop_stand=stand_in(boac), survey_round=new, status=status
        )
    services.refresh_views()
    return {"old": old, "new": new, "gasan_a": gasan_a, "boac": boac}


@pytest.mark.parametrize(
    "who", [Role.PROVINCIAL_HEAD, Role.VIEWER, Role.MAO_VALIDATOR, Role.PROGRAM_COORDINATOR]
)
def test_views_equal_live_official_totals_for_every_scope(world, municipalities, who):
    kwargs = {"municipality": municipalities["Gasan"]} if who == Role.MAO_VALIDATOR else {}
    if who == Role.PROGRAM_COORDINATOR:
        kwargs = {"program": cacao().program}
    scope = get_scope(user_with_role(who, **kwargs))

    for survey_round in (world["old"], world["new"]):
        live = {
            (t.municipality, t.stage_code): t.count
            for t in survey_selectors.stage_totals(survey_round, scope)
        }
        cached = {}
        for row in selectors.stage_rows(scope, survey_round=survey_round).select_related(
            "municipality", "growth_stage"
        ):
            key = (row.municipality.name, row.growth_stage.code)
            cached[key] = cached.get(key, 0) + row.trees
        assert cached == live


def test_unrefreshed_changes_appear_after_refresh(world):
    record = record_with_counts(
        counts={"FRUITING": 7},
        crop_stand=stand_in(world["boac"]),
        survey_round=world["new"],
        status=S.APPROVED,
    )
    assert not RecordFact.objects.filter(pk=record.pk).exists()

    state = services.refresh_views()

    assert RecordFact.objects.filter(pk=record.pk).exists()
    assert AnalyticsRefresh.objects.get().refreshed_at == state.refreshed_at


def test_overview_with_change_vs_previous_round(world):
    scope = get_scope(user_with_role(Role.VIEWER))

    data = selectors.overview(world["new"], scope)

    assert data["trees"] == 500 + 250 + 1250
    assert data["records"] == 3
    assert data["farmers"] == 3
    assert data["bearing_trees"] == 550
    assert data["bearing_share"] == round(550 / 2000, 4)
    assert data["area_ha"] == Decimal("3.20")  # 2000 / 625
    assert data["previous_round"] == world["old"]
    assert data["change"]["trees"] == 2000 - 400
    fruiting = next(s for s in data["stages"] if s["code"] == "FRUITING")
    assert (fruiting["trees"], fruiting["change"], fruiting["is_bearing"]) == (550, 250, True)


def test_overview_without_previous_round(world):
    data = selectors.overview(world["old"], get_scope(user_with_role(Role.VIEWER)))

    assert data["previous_round"] is None
    assert data["change"] == {"trees": None, "farmers": None, "bearing_share": None}


def test_breakdown_by_municipality_and_barangay(world, municipalities):
    scope = get_scope(user_with_role(Role.PROVINCIAL_HEAD))

    towns = selectors.breakdown(world["new"], scope, level="municipality")
    barangays = selectors.breakdown(
        world["new"], scope, level="barangay", municipality=municipalities["Gasan"].pk
    )

    assert [(r["name"], r["trees"], r["records"]) for r in towns] == [
        ("Boac", 1250, 1),
        ("Gasan", 750, 2),
    ]
    assert towns[1]["stages"] == {"FRUITING": 550, "VEGETATIVE": 200}
    assert towns[0]["bearing_share"] == 0.0
    assert [(r["name"], r["trees"]) for r in barangays] == [
        ("Synthetic Gasan A", 500),
        ("Synthetic Gasan B", 250),
    ]


def test_validator_sees_only_own_municipality(world, municipalities):
    scope = get_scope(user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Gasan"]))

    assert selectors.overview(world["new"], scope)["trees"] == 750
    assert [r["name"] for r in selectors.breakdown(world["new"], scope, level="municipality")] == [
        "Gasan"
    ]


def test_municipality_filter_applies_to_overview_and_distribution(world, municipalities):
    scope = get_scope(user_with_role(Role.VIEWER))
    gasan = municipalities["Gasan"].pk

    data = selectors.overview(world["new"], scope, municipality=gasan)
    dist = selectors.distribution(world["new"], scope, municipality=gasan)

    assert (data["trees"], data["records"]) == (750, 2)
    assert data["change"]["trees"] == 750 - 400  # previous round compared within Gasan too
    assert dist["stands"] == 2


def test_trends_oldest_first(world):
    points = selectors.trends(cacao(), get_scope(user_with_role(Role.VIEWER)))

    assert [(p["round"].name, p["trees"]) for p in points] == [("Old", 400), ("New", 2000)]


def test_distribution(world):
    facts = RecordFact.objects.filter(survey_round=world["new"])
    stand = facts.get(trees=500).crop_stand
    planting = PlantingFactory(crop_stand=stand, year_planted=2019)
    PlantingVariety.objects.create(planting=planting, variety=Variety.objects.get(code="BR25"))

    data = selectors.distribution(world["new"], get_scope(user_with_role(Role.VIEWER)))

    sizes = {b["label"]: b["farms"] for b in data["farm_sizes"]}
    assert sizes["250-499"] == 1
    assert sizes["500-999"] == 1
    assert sizes["1,000+"] == 1
    assert data["planting_years"] == [{"year": 2019, "stands": 1}]
    assert data["planting_year_unknown"] == 2
    assert data["varieties"] == [{"code": "BR25", "name": "BR 25", "stands": 1}]
    assert data["variety_unknown"] == 2
    assert data["stands"] == 3


class TestRefreshScheduling:
    def test_debounced_after_commit(self, django_capture_on_commit_callbacks):
        with (
            mock.patch("apps.analytics.tasks.refresh_analytics.apply_async") as task,
            django_capture_on_commit_callbacks(execute=True),
        ):
            services.schedule_refresh()
            services.schedule_refresh()

        assert task.call_count == 1

    def test_approval_and_close_schedule_refresh(self, municipalities):
        brgy = BarangayFactory(municipality=municipalities["Gasan"])
        record = record_with_counts(
            counts={"FRUITING": 1}, crop_stand=stand_in(brgy), status=S.VALIDATED
        )
        coordinator = user_with_role(Role.PROGRAM_COORDINATOR, program=cacao().program)

        with mock.patch("apps.surveys.services.schedule_refresh") as hook:
            survey_services.approve(actor=coordinator, record=record)
            survey_services.close_round(actor=coordinator, survey_round=record.survey_round)

        assert hook.call_count == 2

    def test_non_official_transitions_do_not_refresh(self, municipalities):
        brgy = BarangayFactory(municipality=municipalities["Gasan"])
        record = record_with_counts(counts={"FRUITING": 1}, crop_stand=stand_in(brgy))

        with mock.patch("apps.surveys.services.schedule_refresh") as hook:
            survey_services.submit(actor=user_with_role(Role.PROVINCIAL_ENCODER), record=record)

        hook.assert_not_called()


class TestApi:
    def test_endpoints_for_viewer(self, world, auth_client):
        client = auth_client(user_with_role(Role.VIEWER))
        rid = world["new"].pk

        overview = client.get(f"/api/v1/analytics/rounds/{rid}/overview")
        breakdown = client.get(f"/api/v1/analytics/rounds/{rid}/breakdown", {"level": "barangay"})
        distribution = client.get(f"/api/v1/analytics/rounds/{rid}/distribution")
        trends = client.get("/api/v1/analytics/trends", {"commodity": str(cacao().pk)})
        status = client.get("/api/v1/analytics/status")

        assert overview.status_code == 200
        assert overview.json()["trees"] == 2000
        assert overview.json()["area_ha"] == "3.20"
        assert overview.json()["previous_round"]["name"] == "Old"
        assert len(breakdown.json()) == 3
        assert distribution.json()["stands"] == 3
        assert [p["trees"] for p in trends.json()] == [400, 2000]
        assert status.json()["refreshed_at"]

    def test_errors(self, world, auth_client, api_client):
        from apps.accounts.tests.factories import UserFactory

        rid = world["new"].pk
        assert api_client.get(f"/api/v1/analytics/rounds/{rid}/overview").status_code == 401
        assert (
            auth_client(UserFactory()).get(f"/api/v1/analytics/rounds/{rid}/overview").status_code
            == 403
        )
        viewer = auth_client(user_with_role(Role.VIEWER))
        assert (
            viewer.get(f"/api/v1/analytics/rounds/{rid}/breakdown", {"level": "sitio"}).status_code
            == 400
        )
        assert viewer.get("/api/v1/analytics/trends").status_code == 400
        import uuid

        assert viewer.get(f"/api/v1/analytics/rounds/{uuid.uuid4()}/overview").status_code == 404


def test_stage_totals_rows_have_unique_keys(world):
    keys = list(StageTotal.objects.values_list("survey_round", "barangay", "growth_stage"))

    assert len(keys) == len(set(keys))
