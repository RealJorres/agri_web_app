from decimal import Decimal

import pytest

from apps.accounts.roles import Role
from apps.accounts.selectors import get_scope
from apps.accounts.tests.factories import user_with_role
from apps.catalog.models import Commodity, GrowthStage
from apps.catalog.tests.factories import ProgramFactory
from apps.farms.tests.factories import CropStandFactory, cacao
from apps.locations.tests.factories import BarangayFactory
from apps.registry.tests.factories import FarmerFactory
from apps.surveys import rules, selectors
from apps.surveys.models import InventoryRecord, RecordStatus, StageCount

from .factories import SurveyRoundFactory, record_with_counts

pytestmark = pytest.mark.django_db
S = RecordStatus


@pytest.fixture
def towns(municipalities):
    return {name: BarangayFactory(municipality=municipalities[name]) for name in ("Gasan", "Boac")}


def stand_in(barangay):
    return CropStandFactory(farm__barangay=barangay, farm__farmer__home_barangay=barangay)


@pytest.fixture
def survey_round(towns):
    r = SurveyRoundFactory()
    record_with_counts(
        counts={"SEEDLING": 100, "FRUITING": 525},
        crop_stand=stand_in(towns["Gasan"]),
        survey_round=r,
        status=S.APPROVED,
    )
    record_with_counts(
        counts={"FRUITING": 625},
        crop_stand=stand_in(towns["Gasan"]),
        survey_round=r,
        status=S.LOCKED,
    )
    record_with_counts(
        counts={"FRUITING": 1250},
        crop_stand=stand_in(towns["Boac"]),
        survey_round=r,
        status=S.APPROVED,
    )
    # Not official yet: must never be counted.
    for status in (S.DRAFT, S.SUBMITTED, S.VALIDATED):
        record_with_counts(
            counts={"FRUITING": 9999},
            crop_stand=stand_in(towns["Gasan"]),
            survey_round=r,
            status=status,
        )
    return r


def as_table(rows):
    return {(r.municipality, r.stage_code): (r.count, r.area_ha) for r in rows}


def test_stage_totals_use_only_official_records_and_derive_area(survey_round):
    head = user_with_role(Role.PROVINCIAL_HEAD)

    table = as_table(selectors.stage_totals(survey_round, get_scope(head)))

    assert table == {
        ("Boac", "FRUITING"): (1250, Decimal(2)),
        ("Gasan", "SEEDLING"): (100, Decimal("0.16")),
        ("Gasan", "FRUITING"): (1150, Decimal("1.84")),
    }


def test_stage_totals_scoped_for_validator_and_viewer(survey_round, municipalities):
    validator = user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Boac"])
    viewer = user_with_role(Role.VIEWER)

    assert set(as_table(selectors.stage_totals(survey_round, get_scope(validator)))) == {
        ("Boac", "FRUITING")
    }
    assert len(selectors.stage_totals(survey_round, get_scope(viewer))) == 3  # aggregates allowed


def test_deleted_records_are_excluded(survey_round):
    InventoryRecord.objects.filter(status=S.LOCKED).update(deleted_at="2025-01-01T00:00Z")

    table = as_table(selectors.stage_totals(survey_round, get_scope(user_with_role(Role.VIEWER))))

    assert table[("Gasan", "FRUITING")][0] == 525


def test_no_scope_no_totals(survey_round):
    from apps.accounts.tests.factories import UserFactory

    assert selectors.stage_totals(survey_round, get_scope(UserFactory())) == []


def test_round_progress(survey_round, towns):
    stand_in(towns["Boac"])  # expected but not yet recorded

    rows = selectors.round_progress(survey_round, get_scope(user_with_role(Role.VIEWER)))

    by_town = {r["municipality"]: r for r in rows}
    assert by_town["Gasan"]["expected"] == 5
    assert (
        by_town["Gasan"]["approved"],
        by_town["Gasan"]["locked"],
        by_town["Gasan"]["draft"],
    ) == (1, 1, 1)
    assert (by_town["Boac"]["expected"], by_town["Boac"]["approved"]) == (2, 1)


def test_home_stats(survey_round, towns):
    stats = selectors.home_stats(get_scope(user_with_role(Role.PROVINCIAL_HEAD)))

    assert stats["farmers"] == 6
    cacao_stats = stats["commodities"][0]
    assert cacao_stats["round"]["name"] == survey_round.name
    assert cacao_stats["total"] == 100 + 525 + 625 + 1250
    assert cacao_stats["total_area_ha"] == Decimal("4.00")
    assert [s["code"] for s in cacao_stats["stages"]] == [
        "SEEDLING",
        "VEGETATIVE",
        "FLOWERING",
        "FRUITING",
    ]


def test_rounds_for_filters_by_program():
    cacao_round = SurveyRoundFactory()
    rice = Commodity.objects.create(
        program=ProgramFactory(code="RICE"), code="RICE", name="Rice", measure_type="area"
    )
    rice_round = SurveyRoundFactory(commodity=rice)

    coordinator = user_with_role(Role.PROGRAM_COORDINATOR, program=cacao().program)

    assert list(selectors.rounds_for(get_scope(coordinator))) == [cacao_round]
    assert set(selectors.rounds_for(get_scope(user_with_role(Role.VIEWER)))) == {
        cacao_round,
        rice_round,
    }


def test_area_commodity_totals_use_area(towns):
    rice = Commodity.objects.create(
        program=ProgramFactory(code="RICE"), code="RICE", name="Rice", measure_type="area"
    )
    planted = GrowthStage.objects.create(
        commodity=rice, code="PLANTED", label="Planted", sort_order=1
    )
    r = SurveyRoundFactory(commodity=rice)
    stand = CropStandFactory(
        commodity=rice, farm__barangay=towns["Gasan"], farm__farmer__home_barangay=towns["Gasan"]
    )
    record = InventoryRecord.objects.create(survey_round=r, crop_stand=stand, status=S.APPROVED)
    StageCount.objects.create(inventory_record=record, growth_stage=planted, area_ha=Decimal("1.5"))

    rows = selectors.stage_totals(r, get_scope(user_with_role(Role.VIEWER)))

    assert as_table(rows) == {("Gasan", "PLANTED"): (0, Decimal("1.5000"))}
    assert rules.check_not_empty(list(record.stage_counts.all()), "area", "") == []


def test_outlier_needs_minimum_sample(towns):
    r = SurveyRoundFactory()
    for _ in range(4):
        record_with_counts(
            counts={"FRUITING": 10},
            crop_stand=stand_in(towns["Gasan"]),
            survey_round=r,
            status=S.APPROVED,
        )
    big = record_with_counts(
        counts={"FRUITING": 10_000}, crop_stand=stand_in(towns["Gasan"]), survey_round=r
    )

    assert rules.check_outlier(big, list(big.stage_counts.all())) == []


def test_duplicate_farmer_warning_lists_ids_not_names(towns):
    brgy = towns["Gasan"]
    FarmerFactory(first_name="Rosa", last_name="Sampleduplicate", home_barangay=brgy)
    stand = CropStandFactory(
        farm__barangay=brgy,
        farm__farmer=FarmerFactory(
            first_name="Rosa", last_name="Sampleduplicate", home_barangay=brgy
        ),
    )

    issues = rules.check_duplicate_farmer(stand.farm.farmer)

    assert [i.code for i in issues] == ["possible_duplicate_farmer"]
    assert "Rosa" not in str(issues[0].as_dict())
