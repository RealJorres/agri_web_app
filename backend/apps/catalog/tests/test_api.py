import pytest

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.catalog.models import Commodity
from apps.catalog.services import seed_catalog

pytestmark = pytest.mark.django_db


@pytest.fixture
def viewer_client(auth_client):
    seed_catalog()
    return auth_client(user_with_role(Role.VIEWER))


def test_reference_endpoints_need_authentication(api_client):
    assert api_client.get("/api/v1/commodities").status_code == 401


@pytest.mark.parametrize(
    "url", ["/api/v1/programs", "/api/v1/commodities", "/api/v1/material-sources", "/api/v1/units"]
)
def test_reference_endpoints_readable_by_viewer(viewer_client, url):
    response = viewer_client.get(url)

    assert response.status_code == 200
    assert isinstance(response.json(), list)  # unpaginated reference data


def test_reference_endpoints_are_read_only(viewer_client):
    assert viewer_client.post("/api/v1/programs", {"code": "X", "name": "X"}).status_code in (
        403,
        405,
    )


def test_commodity_stages_in_order(viewer_client):
    cacao = Commodity.objects.get(code="CACAO")

    response = viewer_client.get(f"/api/v1/commodities/{cacao.pk}/stages")

    assert [s["code"] for s in response.json()] == [
        "SEEDLING",
        "VEGETATIVE",
        "FLOWERING",
        "FRUITING",
    ]


def test_commodity_detail_embeds_program_and_stages(viewer_client):
    cacao = Commodity.objects.get(code="CACAO")

    body = viewer_client.get(f"/api/v1/commodities/{cacao.pk}").json()

    assert body["program"]["code"] == "HVCDP"
    assert body["plants_per_ha"] == 625
    assert len(body["stages"]) == 4


def test_varieties_filtered_by_commodity(viewer_client):
    cacao = Commodity.objects.get(code="CACAO")

    response = viewer_client.get("/api/v1/varieties", {"commodity": cacao.pk})

    assert {v["code"] for v in response.json()} == {"BR25", "UF18", "W10", "K1", "CRIOLLO"}
