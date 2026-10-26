import pytest

from apps.accounts.roles import Role
from apps.accounts.services import create_assignment
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.catalog.models import Commodity, Variety
from apps.catalog.tests.factories import ProgramFactory
from apps.farms import services
from apps.locations.tests.factories import BarangayFactory
from apps.registry.tests.factories import FarmerFactory
from common.exceptions import DomainError

from .factories import CropStandFactory, FarmFactory, PlantingFactory, cacao

pytestmark = pytest.mark.django_db


@pytest.fixture
def brgy(municipalities):
    return BarangayFactory(municipality=municipalities["Gasan"])


@pytest.fixture
def encoder(municipalities):
    return user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Gasan"])


def test_create_farm_audits_with_masked_location(encoder, brgy):
    farmer = FarmerFactory(home_barangay=brgy)

    farm = services.create_farm(
        actor=encoder,
        farmer=farmer,
        data={"barangay": brgy, "sitio": "  Synthetic  Sitio ", "location_raw": "x"},
    )

    assert farm.sitio == "Synthetic Sitio"
    entry = AuditLog.objects.get(action="farm.create")
    assert entry.after["sitio"] == "[personal]"
    assert entry.after["farmer"] == str(farmer.pk)


def test_farm_barangay_must_be_in_scope(encoder, brgy, municipalities):
    farmer = FarmerFactory(home_barangay=brgy)
    boac = BarangayFactory(municipality=municipalities["Boac"])

    with pytest.raises(DomainError) as info:
        services.create_farm(actor=encoder, farmer=farmer, data={"barangay": boac})
    assert info.value.status_code == 403

    with pytest.raises(DomainError) as info:
        services.create_farm(actor=encoder, farmer=farmer, data={})
    assert info.value.code == "barangay_required"


def test_update_and_delete_farm(encoder, brgy):
    farm = FarmFactory(barangay=brgy, farmer__home_barangay=brgy)

    services.update_farm(actor=encoder, farm=farm, data={"tenure": "owner"})
    assert AuditLog.objects.get(action="farm.update").after == {"tenure": "owner"}

    stand = CropStandFactory(farm=farm)
    with pytest.raises(DomainError) as info:
        services.delete_farm(actor=encoder, farm=farm)
    assert info.value.code == "has_crop_stands"

    services.delete_crop_stand(actor=encoder, stand=stand)
    services.delete_farm(actor=encoder, farm=farm)
    assert farm.is_deleted


def test_crop_stand_unique_per_commodity(encoder, brgy):
    farm = FarmFactory(barangay=brgy, farmer__home_barangay=brgy)

    services.create_crop_stand(actor=encoder, farm=farm, commodity=cacao(), data={})
    with pytest.raises(DomainError) as info:
        services.create_crop_stand(actor=encoder, farm=farm, commodity=cacao(), data={})

    assert (info.value.code, info.value.status_code) == ("duplicate_crop_stand", 409)


def test_crop_stand_attributes_validated_against_commodity_schema(encoder, brgy):
    farm = FarmFactory(barangay=brgy, farmer__home_barangay=brgy)

    with pytest.raises(DomainError) as info:
        services.create_crop_stand(
            actor=encoder, farm=farm, commodity=cacao(), data={"attributes": {"colour": "x"}}
        )
    assert info.value.code == "invalid_attributes"

    stand = services.create_crop_stand(
        actor=encoder, farm=farm, commodity=cacao(), data={"attributes": {"shade_trees": True}}
    )
    services.update_crop_stand(actor=encoder, stand=stand, data={"spacing_m": 3})
    with pytest.raises(DomainError):
        services.update_crop_stand(actor=encoder, stand=stand, data={"attributes": {"x": 1}})


def test_program_restricted_grant_cannot_touch_other_programs(municipalities, brgy):
    other = ProgramFactory(code="OTHER")
    user = user_with_role(Role.PROVINCIAL_ENCODER, program=other)
    farm = FarmFactory(barangay=brgy, farmer__home_barangay=brgy)

    with pytest.raises(DomainError):
        services.create_crop_stand(actor=user, farm=farm, commodity=cacao(), data={})

    create_assignment(user=user, role=Role.PROVINCIAL_ENCODER, program=cacao().program)
    services.create_crop_stand(actor=user, farm=farm, commodity=cacao(), data={})


def test_planting_varieties_must_match_commodity(encoder, brgy):
    stand = CropStandFactory(farm__barangay=brgy, farm__farmer__home_barangay=brgy)
    br25 = Variety.objects.get(commodity=cacao(), code="BR25")
    coffee = Commodity.objects.create(
        program=cacao().program, code="COFFEE", name="Coffee", measure_type="trees"
    )
    robusta = Variety.objects.create(commodity=coffee, code="ROBUSTA", name="Robusta")

    planting = services.create_planting(
        actor=encoder, stand=stand, data={"year_planted": 2018}, varieties=[br25]
    )
    assert [v.code for v in planting.varieties.all()] == ["BR25"]
    with pytest.raises(DomainError) as info:
        services.create_planting(actor=encoder, stand=stand, data={}, varieties=[robusta])
    assert info.value.code == "variety_mismatch"

    services.update_planting(
        actor=encoder, planting=planting, data={"qty_planted": 50}, varieties=[]
    )
    entry = AuditLog.objects.get(action="planting.update")
    assert entry.after == {"qty_planted": 50, "varieties": []}

    with pytest.raises(DomainError) as info:
        services.delete_crop_stand(actor=encoder, stand=stand)
    assert info.value.code == "has_plantings"
    services.delete_planting(actor=encoder, planting=planting)
    assert AuditLog.objects.filter(action="planting.delete").exists()


def test_planting_out_of_scope(municipalities):
    planting = PlantingFactory()
    user = user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Boac"])

    with pytest.raises(DomainError):
        services.update_planting(actor=user, planting=planting, data={"notes": "x"})
