import pytest

from apps.locations.tests.factories import BarangayFactory
from apps.registry.models import Farmer
from apps.registry.selectors import find_duplicate_farmers, search_farmers
from common.text import normalize_person_name

from .factories import FarmerFactory

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Ma. Luisa Reyes", "maria luisa reyes"),
        ("Maria Luisa Reyes Jr.", "maria luisa reyes"),
        ("Engr. Juan V. Cruz", "juan v cruz"),
        ("Sto. Tomas", "santo tomas"),
        ("JR", "jr"),  # a lone token is never dropped
        ("", ""),
    ],
)
def test_normalize_person_name(raw, expected):
    assert normalize_person_name(raw) == expected


@pytest.fixture
def town(municipalities):
    return BarangayFactory(municipality=municipalities["Gasan"])


def test_normalization_makes_abbreviations_exact_matches(town):
    existing = FarmerFactory(first_name="Maria Luisa", last_name="Samplereyes", home_barangay=town)

    found = find_duplicate_farmers(
        Farmer.objects.all(),
        name="Ma. Luisa Samplereyes",
        municipality_id=town.municipality_id,
        threshold=0.85,
    )

    assert [(c.farmer, c.similarity, c.reason) for c in found] == [(existing, 1.0, "name")]


def test_typo_found_at_suggest_threshold_but_not_at_warn_threshold(town):
    existing = FarmerFactory(first_name="Maria Luisa", last_name="Samplereyes", home_barangay=town)
    name = "Maria Luiza Samplereyez"

    suggest = find_duplicate_farmers(
        Farmer.objects.all(), name=name, municipality_id=town.municipality_id
    )
    warn = find_duplicate_farmers(
        Farmer.objects.all(), name=name, municipality_id=town.municipality_id, threshold=0.85
    )

    assert [c.farmer for c in suggest] == [existing]
    assert 0.6 <= suggest[0].similarity < 0.85
    assert warn == []


def test_name_matches_limited_to_municipality(town, municipalities):
    FarmerFactory(
        first_name="Pedro",
        last_name="Sampleton",
        home_barangay=BarangayFactory(municipality=municipalities["Boac"]),
    )

    found = find_duplicate_farmers(
        Farmer.objects.all(), name="Pedro Sampleton", municipality_id=town.municipality_id
    )

    assert found == []


def test_rsbsa_match_anywhere_and_exclude(town, municipalities):
    other_town = BarangayFactory(municipality=municipalities["Boac"])
    same = FarmerFactory(rsbsa_no="R-77", home_barangay=other_town, last_name="Different")
    editing = FarmerFactory(rsbsa_no=None, home_barangay=town, last_name="Sampleton")

    found = find_duplicate_farmers(
        Farmer.objects.all(),
        name="Pedro Sampleton",
        municipality_id=town.municipality_id,
        rsbsa_no=" r-77 ",
        exclude_id=editing.pk,
    )

    assert [(c.farmer, c.reason) for c in found] == [(same, "rsbsa")]


def test_search_ranks_best_match_first(town):
    exact = FarmerFactory(first_name="Rosa", last_name="Sampleira", home_barangay=town)
    near = FarmerFactory(first_name="Rosa", last_name="Sampleiro", home_barangay=town)
    FarmerFactory(first_name="Pedro", last_name="Unrelated", home_barangay=town)

    results = list(search_farmers(Farmer.objects.all(), "rosa sampleira"))

    assert results[:2] == [exact, near]
    assert len(results) == 2


def test_search_by_rsbsa_and_blank(town):
    farmer = FarmerFactory(rsbsa_no="17-40-01-001", home_barangay=town)

    assert list(search_farmers(Farmer.objects.all(), "17-40-01-001")) == [farmer]
    assert search_farmers(Farmer.objects.all(), "  ").count() == 1
