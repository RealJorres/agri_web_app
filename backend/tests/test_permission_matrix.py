"""Role x scope matrix for every record-level endpoint. New endpoints are added to ENDPOINTS."""

import pytest

from apps.accounts.roles import Role
from apps.locations.tests.factories import BarangayFactory

from .permission_matrix import OTHER, OWN, Endpoint, make_actor

ENDPOINTS: list[Endpoint] = [
    Endpoint(
        name="scoped-barangays (harness self-test)",
        list_url="/test/scoped-barangays/",
        detail_url=lambda obj: f"/test/scoped-barangays/{obj.pk}/",
        make=lambda barangay: barangay,
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


@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda e: e.name)
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


def test_unauthenticated_is_401(world, api_client):
    endpoint = ENDPOINTS[0]
    obj = endpoint.make(world[OWN])

    assert api_client.get(endpoint.detail_url(obj)).status_code == 401
