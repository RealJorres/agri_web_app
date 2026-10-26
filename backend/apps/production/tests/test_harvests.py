import datetime as dt
from decimal import Decimal

import pytest

from apps.accounts.roles import Role
from apps.accounts.selectors import get_scope
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.farms.tests.factories import CropStandFactory
from apps.locations.tests.factories import BarangayFactory
from apps.production import selectors
from apps.production.models import Harvest

pytestmark = pytest.mark.django_db


def stand_in(barangay, farmer=None):
    if farmer is not None:
        return CropStandFactory(farm__barangay=barangay, farm__farmer=farmer)
    return CropStandFactory(farm__barangay=barangay, farm__farmer__home_barangay=barangay)


def harvest(stand, quantity, unit="kg", form="dried_beans", date=None, **extra):
    return Harvest.objects.create(
        crop_stand=stand,
        quantity=Decimal(quantity),
        unit=unit,
        product_form=form,
        harvest_date=date,
        date_estimated=date is None,
        **extra,
    )


@pytest.fixture
def world(municipalities):
    gasan = BarangayFactory(municipality=municipalities["Gasan"], name="Synthetic Gasan")
    boac = BarangayFactory(municipality=municipalities["Boac"], name="Synthetic Boac")
    g1 = stand_in(gasan)
    g2 = stand_in(gasan, farmer=g1.farm.farmer)  # same farmer, second farm
    g3 = stand_in(gasan)
    b1 = stand_in(boac)
    harvest(g1, "8", form="unknown")  # undated, from legacy remarks
    harvest(g1, "6", date=dt.date(2025, 3, 1))
    harvest(g2, "20", form="wet_beans", date=dt.date(2025, 4, 1))
    harvest(g3, "1", unit="sack", date=dt.date(2025, 5, 1))
    harvest(g3, "3", unit="other", form="pods", date=dt.date(2024, 5, 1))
    harvest(b1, "2.5", date=dt.date(2025, 6, 1))
    deleted = harvest(b1, "999", date=dt.date(2025, 6, 2))
    deleted.mark_deleted(None)
    return {"gasan": gasan, "boac": boac, "g1": g1, "municipalities": municipalities}


def rows_by_town(summary):
    return {r["municipality"]: r for r in summary["rows"]}


class TestSummary:
    def test_all_years(self, world):
        s = selectors.harvest_summary(get_scope(user_with_role(Role.PROVINCIAL_HEAD)))
        gasan = rows_by_town(s)["Gasan"]
        assert gasan["harvests"] == 5
        assert gasan["farmers"] == 2
        assert gasan["kg"] == {
            "wet_beans": Decimal("20"),
            "dried_beans": Decimal("6"),
            "pods": Decimal("0"),
            "unknown": Decimal("8"),
        }
        assert gasan["sacks"] == Decimal("1")  # never converted to kg
        assert gasan["other_entries"] == 1
        assert gasan["estimated_dates"] == 1
        assert rows_by_town(s)["Boac"]["kg"]["dried_beans"] == Decimal("2.5")  # deleted excluded
        assert s["years"] == [2024, 2025]
        assert s["undated_excluded"] == 0

    def test_year_filter_reports_undated_separately(self, world):
        scope = get_scope(user_with_role(Role.PROVINCIAL_HEAD))
        s = selectors.harvest_summary(scope, year=2025)
        gasan = rows_by_town(s)["Gasan"]
        assert gasan["harvests"] == 3
        assert gasan["kg"]["unknown"] == Decimal("0")
        assert gasan["other_entries"] == 0
        assert s["undated_excluded"] == 1

    def test_scoped_to_assignment(self, world):
        validator = user_with_role(Role.MAO_VALIDATOR, municipality=world["municipalities"]["Boac"])
        s = selectors.harvest_summary(get_scope(validator))
        assert list(rows_by_town(s)) == ["Boac"]

    def test_api(self, world, auth_client):
        client = auth_client(user_with_role(Role.VIEWER))
        response = client.get("/api/v1/analytics/harvests", {"year": 2025})
        assert response.status_code == 200
        body = response.json()
        assert body["year"] == 2025
        assert {r["municipality"] for r in body["rows"]} == {"Gasan", "Boac"}
        assert "buyer" not in str(body)  # aggregates only
        assert client.get("/api/v1/analytics/harvests", {"year": "x"}).status_code == 400


class TestCrud:
    def url(self, stand):
        return f"/api/v1/crop-stands/{stand.pk}/harvests"

    def test_create_without_date_is_estimated_and_audited(self, world, auth_client):
        encoder = user_with_role(
            Role.FIELD_ENCODER,
            municipality=world["municipalities"]["Gasan"],
            barangays=[world["gasan"]],
        )
        client = auth_client(encoder)
        response = client.post(
            self.url(world["g1"]),
            {"quantity": "4.5", "unit": "kg", "product_form": "dried_beans", "buyer": "Synthetic"},
            format="json",
        )
        assert response.status_code == 201, response.json()
        assert response.json()["date_estimated"] is True
        log = AuditLog.objects.get(action="harvest.create")
        assert log.after["buyer"] != "Synthetic"  # masked in the audit log

    def test_update_and_delete(self, world, auth_client):
        client = auth_client(user_with_role(Role.PROVINCIAL_ENCODER))
        target = world["g1"].harvests.get(quantity=Decimal("6"))
        response = client.patch(f"/api/v1/harvests/{target.pk}", {"quantity": "7"}, format="json")
        assert response.status_code == 200
        assert response.json()["quantity"] == "7.000"
        assert client.delete(f"/api/v1/harvests/{target.pk}").status_code == 204
        assert not Harvest.objects.filter(pk=target.pk).exists()
        assert Harvest.all_objects.filter(pk=target.pk).exists()  # soft delete
        actions = set(AuditLog.objects.values_list("action", flat=True))
        assert {"harvest.update", "harvest.delete"} <= actions

    def test_negative_quantity_rejected(self, world, auth_client):
        client = auth_client(user_with_role(Role.PROVINCIAL_ENCODER))
        response = client.post(
            self.url(world["g1"]), {"quantity": "-1", "unit": "kg"}, format="json"
        )
        assert response.status_code == 400

    def test_other_barangay_is_404(self, world, auth_client):
        encoder = user_with_role(
            Role.FIELD_ENCODER,
            municipality=world["municipalities"]["Boac"],
            barangays=[world["boac"]],
        )
        response = auth_client(encoder).post(
            self.url(world["g1"]), {"quantity": "1", "unit": "kg"}, format="json"
        )
        assert response.status_code == 404

    def test_viewer_cannot_write(self, world, auth_client):
        response = auth_client(user_with_role(Role.VIEWER)).post(
            self.url(world["g1"]), {"quantity": "1", "unit": "kg"}, format="json"
        )
        assert response.status_code in (403, 404)
