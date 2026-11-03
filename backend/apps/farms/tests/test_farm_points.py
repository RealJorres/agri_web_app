"""Farm points on the map are personal data; the role x scope matrix covers who sees which row."""

import pytest
from django.contrib.gis.geos import Point

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.locations.tests.factories import BarangayFactory

from .factories import FarmFactory

pytestmark = pytest.mark.django_db

URL = "/api/v1/farms/points"


def located_farm(barangay=None, lon=121.9, lat=13.4):
    barangay = barangay or BarangayFactory()
    return FarmFactory(
        barangay=barangay, farmer__home_barangay=barangay, location=Point(lon, lat, srid=4326)
    )


def test_points_carry_coordinates_but_no_names(auth_client):
    farm = located_farm()

    body = auth_client(user_with_role(Role.PROVINCIAL_HEAD)).get(URL).json()

    assert body["total_farms"] == 1
    assert body["located"] == 1
    assert body["results"] == [
        {
            "id": str(farm.pk),
            "farmer": str(farm.farmer_id),
            "lon": 121.9,
            "lat": 13.4,
            "barangay": farm.barangay.name,
            "municipality": farm.barangay.municipality.name,
        }
    ]
    assert farm.farmer.display_name not in str(body)


def test_counts_farms_still_without_a_location(auth_client):
    located_farm()
    barangay = BarangayFactory()
    FarmFactory(barangay=barangay, farmer__home_barangay=barangay, location=None)

    body = auth_client(user_with_role(Role.PROVINCIAL_HEAD)).get(URL).json()

    assert (body["total_farms"], body["located"]) == (2, 1)


def test_municipality_filter(auth_client):
    wanted = located_farm()
    located_farm()

    body = (
        auth_client(user_with_role(Role.PROVINCIAL_HEAD))
        .get(URL, {"municipality": str(wanted.barangay.municipality_id)})
        .json()
    )

    assert [row["id"] for row in body["results"]] == [str(wanted.pk)]
    assert body["total_farms"] == 1


def test_soft_deleted_farm_is_not_drawn(auth_client):
    farm = located_farm()
    actor = user_with_role(Role.SYSTEM_ADMIN, is_superuser=True, is_staff=True)
    farm.mark_deleted(actor)

    assert auth_client(actor).get(URL).json()["results"] == []


def test_viewer_is_refused_even_with_a_filter(auth_client):
    farm = located_farm()

    response = auth_client(user_with_role(Role.VIEWER)).get(
        URL, {"municipality": str(farm.barangay.municipality_id)}
    )

    assert response.status_code == 403


def test_location_can_be_set_alone_and_is_audited_masked(auth_client):
    barangay = BarangayFactory()
    farm = FarmFactory(barangay=barangay, farmer__home_barangay=barangay, location=None)
    encoder = user_with_role(Role.PROVINCIAL_ENCODER)

    response = auth_client(encoder).patch(
        f"/api/v1/farms/{farm.pk}", {"location": {"lon": 121.95, "lat": 13.45}}, format="json"
    )

    assert response.status_code == 200, response.json()
    assert response.json()["location"] == {"lon": 121.95, "lat": 13.45}
    entry = AuditLog.objects.get(action="farm.update", object_id=str(farm.pk))
    assert entry.after == {"location": "[personal]"}
    assert "121.95" not in str(entry.after)


def test_location_can_be_cleared(auth_client):
    farm = located_farm()

    response = auth_client(user_with_role(Role.PROVINCIAL_ENCODER)).patch(
        f"/api/v1/farms/{farm.pk}", {"location": None}, format="json"
    )

    assert response.status_code == 200, response.json()
    assert response.json()["location"] is None


def test_location_outside_the_philippines_is_refused(auth_client):
    barangay = BarangayFactory()
    farm = FarmFactory(barangay=barangay, farmer__home_barangay=barangay)

    response = auth_client(user_with_role(Role.PROVINCIAL_ENCODER)).patch(
        f"/api/v1/farms/{farm.pk}", {"location": {"lon": 10.0, "lat": 50.0}}, format="json"
    )

    assert response.status_code == 400
