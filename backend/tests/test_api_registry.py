"""HTTP-level behaviour of the registry and farm endpoints (contract, filters, nested routes)."""

import pytest

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.catalog.models import Variety
from apps.farms.tests.factories import CropStandFactory, FarmFactory, cacao
from apps.locations.tests.factories import BarangayFactory
from apps.registry.models import Farmer
from apps.registry.tests.factories import AssociationFactory, FarmerFactory, MemberFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def gasan(municipalities):
    return municipalities["Gasan"]


@pytest.fixture
def brgy(gasan):
    return BarangayFactory(municipality=gasan, name="Synthetic Api Barangay")


@pytest.fixture
def client(auth_client, gasan):
    return auth_client(user_with_role(Role.MAO_VALIDATOR, municipality=gasan))


class TestFarmers:
    def test_create_requires_consent_and_returns_contract_error(self, client, brgy):
        response = client.post(
            "/api/v1/farmers", {"last_name": "Sample", "home_barangay": str(brgy.pk)}
        )

        assert response.status_code == 400
        assert response.json()["code"] == "consent_required"
        assert "consent_given" in response.json()["fields"]

    def test_create_and_read_back(self, client, brgy):
        response = client.post(
            "/api/v1/farmers",
            {
                "first_name": "Juana",
                "last_name": "Sample",
                "home_barangay": str(brgy.pk),
                "contact_no": "0917",
                "consent_given": True,
            },
            format="json",
        )

        assert response.status_code == 201, response.json()
        body = response.json()
        assert body["display_name"] == "Juana Sample"
        assert body["has_consent"] is True
        assert body["municipality"]["name"] == "Gasan"
        assert "consent_given" not in body

    def test_validation_error_contract(self, client, brgy):
        response = client.post(
            "/api/v1/farmers",
            {"home_barangay": str(brgy.pk), "birth_year": 1800, "sex": "x"},
            format="json",
        )

        assert response.status_code == 400
        body = response.json()
        assert body["code"] == "validation_error"
        assert set(body["fields"]) == {"birth_year", "sex"}

    def test_status_is_not_patchable_into_invalid_value(self, client, brgy):
        farmer = FarmerFactory(home_barangay=brgy)

        response = client.patch(f"/api/v1/farmers/{farmer.pk}", {"status": "deleted"})

        assert response.status_code == 400

    def test_list_filters_and_search(self, client, brgy, gasan):
        juan = FarmerFactory(first_name="Juan", last_name="Samplecruz", home_barangay=brgy)
        FarmerFactory(first_name="Ana", last_name="Other", home_barangay=brgy)
        assoc = AssociationFactory(municipality=gasan)
        MemberFactory(farmer=juan, association=assoc)

        def names(params):
            return [r["last_name"] for r in client.get("/api/v1/farmers", params).json()["results"]]

        assert names({"q": "juan samplecrus"}) == ["Samplecruz"]
        assert names({"association": str(assoc.pk)}) == ["Samplecruz"]
        assert names({"barangay": str(brgy.pk), "ordering": "-last_name"}) == [
            "Samplecruz",
            "Other",
        ]
        assert names({"municipality": str(gasan.pk), "status": "needs_review"}) == []

    def test_pagination_is_50(self, client, brgy):
        for _ in range(51):
            FarmerFactory(home_barangay=brgy)

        body = client.get("/api/v1/farmers").json()

        assert body["count"] == 51
        assert len(body["results"]) == 50
        assert body["next"]

    def test_detail_includes_memberships(self, client, brgy):
        member = MemberFactory(farmer__home_barangay=brgy, role="Treasurer")

        body = client.get(f"/api/v1/farmers/{member.farmer.pk}").json()

        assert body["memberships"][0]["role"] == "Treasurer"

    def test_duplicates_endpoint(self, client, brgy):
        FarmerFactory(first_name="Maria Luisa", last_name="Samplereyes", home_barangay=brgy)

        response = client.get(
            "/api/v1/farmers/duplicates",
            {"name": "Ma. Luisa Samplereyes", "barangay": str(brgy.pk)},
        )

        assert response.status_code == 200
        assert response.json()[0]["similarity"] == 1.0

    def test_merge_requires_capability(self, client, auth_client, brgy):
        a, b = FarmerFactory(home_barangay=brgy), FarmerFactory(home_barangay=brgy)
        FarmFactory(farmer=b)

        denied = client.post(f"/api/v1/farmers/{a.pk}/merge", {"duplicate": str(b.pk)})
        coordinator = auth_client(user_with_role(Role.PROGRAM_COORDINATOR))
        merged = coordinator.post(f"/api/v1/farmers/{a.pk}/merge", {"duplicate": str(b.pk)})
        missing = coordinator.post(f"/api/v1/farmers/{a.pk}/merge", {"duplicate": str(b.pk)})

        assert denied.status_code == 403
        assert merged.status_code == 200
        assert merged.json()["farms_moved"] == 1
        assert missing.status_code == 404  # already retired

    def test_audit_trail_endpoint(self, client, brgy):
        farmer = FarmerFactory(home_barangay=brgy)
        client.patch(f"/api/v1/farmers/{farmer.pk}", {"first_name": "Changed"}, format="json")

        entries = client.get(f"/api/v1/farmers/{farmer.pk}/audit").json()["results"]

        assert [e["action"] for e in entries] == ["farmer.update"]
        assert entries[0]["after"] == {"first_name": "[personal]"}

    def test_delete(self, client, brgy):
        farmer = FarmerFactory(home_barangay=brgy)

        assert client.delete(f"/api/v1/farmers/{farmer.pk}").status_code == 204
        assert not Farmer.objects.filter(pk=farmer.pk).exists()
        assert client.get(f"/api/v1/farmers/{farmer.pk}").status_code == 404


class TestAssociations:
    def test_crud_and_members(self, client, gasan, brgy):
        created = client.post(
            "/api/v1/associations", {"name": "Sample Api FA", "municipality": str(gasan.pk)}
        )
        assert created.status_code == 201
        assoc_id = created.json()["id"]
        farmer = FarmerFactory(home_barangay=brgy)

        added = client.post(
            f"/api/v1/associations/{assoc_id}/members", {"farmer": str(farmer.pk), "role": "Member"}
        )
        listed = client.get(f"/api/v1/associations/{assoc_id}/members").json()
        detail = client.get(f"/api/v1/associations/{assoc_id}").json()

        assert added.status_code == 201
        assert listed["results"][0]["farmer_name"] == farmer.display_name
        assert detail["member_count"] == 1

        member_id = added.json()["id"]
        assert (
            client.delete(f"/api/v1/associations/{assoc_id}/members/{member_id}").status_code == 204
        )
        assert client.delete(f"/api/v1/associations/{assoc_id}").status_code == 204

    def test_cannot_add_out_of_scope_farmer(self, client, gasan, municipalities):
        assoc = AssociationFactory(municipality=gasan)
        outsider = FarmerFactory(home_barangay=BarangayFactory(municipality=municipalities["Boac"]))

        response = client.post(
            f"/api/v1/associations/{assoc.pk}/members", {"farmer": str(outsider.pk)}
        )

        assert response.status_code == 404


class TestFarms:
    def test_nested_crop_stands_and_plantings(self, client, brgy):
        farmer = FarmerFactory(home_barangay=brgy)
        farm = client.post(
            "/api/v1/farms",
            {
                "farmer": str(farmer.pk),
                "barangay": str(brgy.pk),
                "location": {"lon": 121.9, "lat": 13.3},
            },
            format="json",
        )
        assert farm.status_code == 201, farm.json()
        farm_id = farm.json()["id"]
        assert farm.json()["location"] == {"lon": 121.9, "lat": 13.3}

        stand = client.post(f"/api/v1/farms/{farm_id}/crop-stands", {"commodity": str(cacao().pk)})
        assert stand.status_code == 201
        stand_id = stand.json()["id"]

        br25 = Variety.objects.get(code="BR25")
        planting = client.post(
            f"/api/v1/crop-stands/{stand_id}/plantings",
            {"year_planted": 2019, "varieties": [str(br25.pk)]},
            format="json",
        )
        assert planting.status_code == 201
        assert planting.json()["varieties"] == ["BR25"]

        listed = client.get("/api/v1/farms", {"farmer": str(farmer.pk)}).json()["results"]
        assert listed[0]["crop_stands"][0]["plantings"][0]["year_planted"] == 2019

        patched = client.patch(
            f"/api/v1/plantings/{planting.json()['id']}", {"qty_planted": 10}, format="json"
        )
        assert patched.json()["qty_planted"] == 10

    def test_location_outside_philippines_rejected(self, client, brgy):
        farmer = FarmerFactory(home_barangay=brgy)

        response = client.post(
            "/api/v1/farms",
            {"farmer": str(farmer.pk), "barangay": str(brgy.pk), "location": {"lon": 0, "lat": 0}},
            format="json",
        )

        assert response.status_code == 400
        assert "location" in response.json()["fields"]

    def test_farm_owner_cannot_change(self, client, brgy):
        farm = FarmFactory(barangay=brgy, farmer__home_barangay=brgy)
        other = FarmerFactory(home_barangay=brgy)

        response = client.patch(f"/api/v1/farms/{farm.pk}", {"farmer": str(other.pk)})

        assert response.json()["code"] == "farmer_immutable"

    def test_plantings_only_via_crop_stand(self, client, brgy):
        CropStandFactory(farm__barangay=brgy, farm__farmer__home_barangay=brgy)

        assert client.get("/api/v1/plantings").status_code == 405
        assert client.post("/api/v1/crop-stands", {}).status_code == 405
