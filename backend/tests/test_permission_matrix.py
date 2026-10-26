"""Role x scope matrix for every record-level endpoint (brief §7). New endpoints go in ENDPOINTS."""

import pytest

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.farms.tests.factories import CropStandFactory, FarmFactory, PlantingFactory
from apps.locations.tests.factories import BarangayFactory
from apps.registry.tests.factories import AssociationFactory, FarmerFactory
from apps.surveys.tests.factories import record_with_counts

from .permission_matrix import OTHER, OWN, Endpoint, make_actor

ENDPOINTS: list[Endpoint] = [
    Endpoint(
        name="scoped-barangays (harness self-test)",
        list_url="/test/scoped-barangays/",
        detail_url=lambda obj: f"/test/scoped-barangays/{obj.pk}/",
        make=lambda barangay: barangay,
    ),
    Endpoint(
        name="farmers",
        list_url="/api/v1/farmers",
        detail_url=lambda obj: f"/api/v1/farmers/{obj.pk}",
        make=lambda barangay: FarmerFactory(home_barangay=barangay),
    ),
    Endpoint(
        name="farmer audit trail",
        list_url=None,
        detail_url=lambda obj: f"/api/v1/farmers/{obj.pk}/audit",
        make=lambda barangay: FarmerFactory(home_barangay=barangay),
    ),
    Endpoint(
        name="associations",
        list_url="/api/v1/associations",
        detail_url=lambda obj: f"/api/v1/associations/{obj.pk}",
        make=lambda barangay: AssociationFactory(municipality=barangay.municipality),
    ),
    Endpoint(
        name="association members",
        list_url=None,
        detail_url=lambda obj: f"/api/v1/associations/{obj.pk}/members",
        make=lambda barangay: AssociationFactory(municipality=barangay.municipality),
    ),
    Endpoint(
        name="farms",
        list_url="/api/v1/farms",
        detail_url=lambda obj: f"/api/v1/farms/{obj.pk}",
        make=lambda barangay: FarmFactory(barangay=barangay, farmer__home_barangay=barangay),
    ),
    Endpoint(
        name="crop-stands",
        list_url="/api/v1/crop-stands",
        detail_url=lambda obj: f"/api/v1/crop-stands/{obj.pk}",
        make=lambda barangay: CropStandFactory(
            farm__barangay=barangay, farm__farmer__home_barangay=barangay
        ),
    ),
    Endpoint(
        name="inventory-records",
        list_url="/api/v1/inventory-records",
        detail_url=lambda obj: f"/api/v1/inventory-records/{obj.pk}",
        make=lambda barangay: record_with_counts(
            counts={"FRUITING": 1},
            crop_stand=CropStandFactory(
                farm__barangay=barangay, farm__farmer__home_barangay=barangay
            ),
        ),
    ),
    Endpoint(
        name="crop-stand harvests",
        list_url=None,
        detail_url=lambda obj: f"/api/v1/crop-stands/{obj.pk}/harvests",
        make=lambda barangay: CropStandFactory(
            farm__barangay=barangay, farm__farmer__home_barangay=barangay
        ),
    ),
    Endpoint(
        name="plantings",
        list_url=None,
        detail_url=lambda obj: f"/api/v1/plantings/{obj.pk}",
        make=lambda barangay: PlantingFactory(
            crop_stand__farm__barangay=barangay,
            crop_stand__farm__farmer__home_barangay=barangay,
        ),
    ),
]

pytestmark = [pytest.mark.django_db, pytest.mark.urls("tests.matrix_urls")]


@pytest.fixture
def world(municipalities):
    gasan, boac = municipalities["Gasan"], municipalities["Boac"]
    home_barangay = BarangayFactory(municipality=gasan, name="Synthetic Gasan Barangay")
    other_barangay = BarangayFactory(municipality=boac, name="Synthetic Boac Barangay")
    return {"gasan": gasan, OWN: home_barangay, OTHER: other_barangay}


@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda e: e.name)
@pytest.mark.parametrize("role", list(Role))
@pytest.mark.parametrize("relation", [OWN, OTHER])
def test_read_detail(endpoint, role, relation, world, auth_client):
    obj = endpoint.make(world[relation])
    actor = make_actor(role, world["gasan"], world[OWN])

    response = auth_client(actor).get(endpoint.detail_url(obj))

    assert response.status_code == endpoint.expected(role, relation)


@pytest.mark.parametrize("endpoint", [e for e in ENDPOINTS if e.list_url], ids=lambda e: e.name)
@pytest.mark.parametrize("role", list(Role))
def test_list_only_contains_rows_in_scope(endpoint, role, world, auth_client):
    own, other = endpoint.make(world[OWN]), endpoint.make(world[OTHER])
    actor = make_actor(role, world["gasan"], world[OWN])

    response = auth_client(actor).get(endpoint.list_url)

    if endpoint.expected(role, OWN) == 403:
        assert response.status_code == 403
        return
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()["results"]}
    assert str(own.pk) in ids
    assert (str(other.pk) in ids) == (endpoint.expected(role, OTHER) == 200)


def test_gasan_validator_gets_404_on_boac_farmer(municipalities, auth_client):
    """The brief's named acceptance case (§7)."""
    boac_farmer = FarmerFactory(home_barangay=BarangayFactory(municipality=municipalities["Boac"]))
    validator = user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Gasan"])

    response = auth_client(validator).get(f"/api/v1/farmers/{boac_farmer.pk}")

    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


# Writes: who may create a farmer in their own (Gasan) barangay.
CREATE_FARMER = {
    Role.SYSTEM_ADMIN: 201,
    Role.PROVINCIAL_HEAD: 403,
    Role.PROGRAM_COORDINATOR: 403,
    Role.PROVINCIAL_ENCODER: 201,
    Role.MAO_VALIDATOR: 201,
    Role.FIELD_ENCODER: 201,
    Role.VIEWER: 403,
}


@pytest.mark.parametrize("role", list(Role))
@pytest.mark.parametrize("relation", [OWN, OTHER])
def test_create_farmer(role, relation, world, auth_client):
    actor = make_actor(role, world["gasan"], world[OWN])
    expected = CREATE_FARMER[role]
    if relation == OTHER and role in (Role.MAO_VALIDATOR, Role.FIELD_ENCODER):
        expected = 403  # outside the assignment

    response = auth_client(actor).post(
        "/api/v1/farmers",
        {"last_name": "Sample", "home_barangay": str(world[relation].pk), "consent_given": True},
        format="json",
    )

    assert response.status_code == expected, response.json()


def test_coordinator_of_other_program_cannot_see_cacao_crop_stands(world, auth_client):
    from apps.catalog.tests.factories import ProgramFactory

    stand = CropStandFactory(farm__barangay=world[OWN], farm__farmer__home_barangay=world[OWN])
    coordinator = user_with_role(Role.PROGRAM_COORDINATOR, program=ProgramFactory(code="RICE"))

    response = auth_client(coordinator).get(f"/api/v1/crop-stands/{stand.pk}")

    assert response.status_code == 404


def test_unauthenticated_is_401(world, api_client):
    farmer = FarmerFactory(home_barangay=world[OWN])

    assert api_client.get(f"/api/v1/farmers/{farmer.pk}").status_code == 401
