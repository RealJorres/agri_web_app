import json

import pytest

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.farms.tests.factories import FarmFactory
from apps.locations.tests.factories import BarangayFactory
from apps.registry import services
from apps.registry.models import AssociationMember, Farmer, FarmerStatus
from common.exceptions import DomainError

from .factories import AssociationFactory, FarmerFactory, MemberFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def gasan(municipalities):
    return municipalities["Gasan"]


@pytest.fixture
def brgy(gasan):
    return BarangayFactory(municipality=gasan, name="Synthetic Gasan One")


@pytest.fixture
def encoder(gasan):
    return user_with_role(Role.MAO_VALIDATOR, municipality=gasan)


def farmer_data(brgy, **extra):
    return {"first_name": "Juana", "last_name": "Sample", "home_barangay": brgy, **extra}


class TestCreateFarmer:
    def test_requires_consent(self, encoder, brgy):
        with pytest.raises(DomainError) as info:
            services.create_farmer(actor=encoder, data=farmer_data(brgy), consent_given=False)

        assert info.value.code == "consent_required"

    def test_records_consent_and_audits_without_personal_values(self, encoder, brgy):
        farmer = services.create_farmer(
            actor=encoder,
            data=farmer_data(brgy, contact_no=" 0917 000 0000 ", rsbsa_no=" ab-123 "),
            consent_given=True,
        )

        assert farmer.consent_by == encoder
        assert farmer.consent_at is not None
        assert farmer.contact_no == "0917 000 0000"
        assert farmer.rsbsa_no == "AB-123"
        assert farmer.normalized_name == "juana sample"
        entry = AuditLog.objects.get(action="farmer.create", object_id=str(farmer.pk))
        assert entry.actor == encoder
        dumped = json.dumps(entry.after)
        assert "Juana" not in dumped
        assert "0917" not in dumped
        assert entry.after["home_barangay"] == str(brgy.pk)

    def test_import_path_skips_consent(self, encoder, brgy):
        farmer = services.create_farmer(
            actor=encoder, data=farmer_data(brgy), consent_given=False, require_consent=False
        )

        assert farmer.consent_at is None

    def test_name_required(self, encoder, brgy):
        with pytest.raises(DomainError) as info:
            services.create_farmer(
                actor=encoder, data={"home_barangay": brgy, "first_name": "  "}, consent_given=True
            )

        assert info.value.code == "name_required"

    def test_barangay_required(self, encoder):
        with pytest.raises(DomainError) as info:
            services.create_farmer(actor=encoder, data={"last_name": "X"}, consent_given=True)

        assert info.value.code == "barangay_required"

    def test_out_of_scope_barangay_is_403(self, encoder, municipalities):
        boac = BarangayFactory(municipality=municipalities["Boac"])

        with pytest.raises(DomainError) as info:
            services.create_farmer(actor=encoder, data=farmer_data(boac), consent_given=True)

        assert (info.value.code, info.value.status_code) == ("out_of_scope", 403)

    def test_field_encoder_limited_to_barangays(self, gasan, brgy):
        other = BarangayFactory(municipality=gasan)
        user = user_with_role(Role.FIELD_ENCODER, municipality=gasan, barangays=[brgy])

        services.create_farmer(actor=user, data=farmer_data(brgy), consent_given=True)
        with pytest.raises(DomainError):
            services.create_farmer(actor=user, data=farmer_data(other), consent_given=True)

    def test_roles_without_edit_capability_rejected(self, brgy):
        for role in (Role.VIEWER, Role.PROVINCIAL_HEAD, Role.PROGRAM_COORDINATOR):
            with pytest.raises(DomainError):
                services.create_farmer(
                    actor=user_with_role(role), data=farmer_data(brgy), consent_given=True
                )

    def test_duplicate_rsbsa_is_409(self, encoder, brgy):
        FarmerFactory(rsbsa_no="RSBSA-1", home_barangay=brgy, consent_at="2024-01-01T00:00Z")

        with pytest.raises(DomainError) as info:
            services.create_farmer(
                actor=encoder, data=farmer_data(brgy, rsbsa_no="rsbsa-1"), consent_given=True
            )

        assert (info.value.code, info.value.status_code) == ("duplicate_rsbsa", 409)


class TestUpdateFarmer:
    def test_adding_contact_needs_consent_when_none_recorded(self, encoder, brgy):
        farmer = FarmerFactory(home_barangay=brgy)  # e.g. imported, no consent yet

        with pytest.raises(DomainError) as info:
            services.update_farmer(actor=encoder, farmer=farmer, data={"contact_no": "0917"})
        assert info.value.code == "consent_required"

        services.update_farmer(
            actor=encoder, farmer=farmer, data={"contact_no": "0917"}, consent_given=True
        )
        assert farmer.consent_at is not None

    def test_name_fix_allowed_without_consent(self, encoder, brgy):
        farmer = FarmerFactory(home_barangay=brgy, first_name="Jaun")

        services.update_farmer(actor=encoder, farmer=farmer, data={"first_name": "Juan"})

        farmer.refresh_from_db()
        assert farmer.first_name == "Juan"
        entry = AuditLog.objects.get(action="farmer.update")
        assert entry.before == {"first_name": "[personal]"}
        assert entry.after == {"first_name": "[personal]"}

    def test_no_audit_when_nothing_changed(self, encoder, brgy):
        farmer = FarmerFactory(home_barangay=brgy)

        services.update_farmer(actor=encoder, farmer=farmer, data={"status": farmer.status})

        assert not AuditLog.objects.filter(action="farmer.update").exists()

    def test_cannot_move_farmer_out_of_scope(self, encoder, brgy, municipalities):
        farmer = FarmerFactory(home_barangay=brgy)
        boac = BarangayFactory(municipality=municipalities["Boac"])

        with pytest.raises(DomainError):
            services.update_farmer(actor=encoder, farmer=farmer, data={"home_barangay": boac})


class TestDeleteFarmer:
    def test_blocked_while_farms_exist(self, encoder, brgy):
        farm = FarmFactory(farmer__home_barangay=brgy)

        with pytest.raises(DomainError) as info:
            services.delete_farmer(actor=encoder, farmer=farm.farmer)

        assert info.value.code == "has_farms"

    def test_soft_deletes_farmer_and_memberships(self, encoder, brgy):
        member = MemberFactory(farmer__home_barangay=brgy)

        services.delete_farmer(actor=encoder, farmer=member.farmer)

        assert not Farmer.objects.filter(pk=member.farmer.pk).exists()
        assert Farmer.all_objects.get(pk=member.farmer.pk).deleted_by == encoder
        assert not AssociationMember.objects.filter(pk=member.pk).exists()
        assert AuditLog.objects.filter(action="farmer.delete").exists()


class TestMerge:
    @pytest.fixture
    def coordinator(self):
        return user_with_role(Role.PROGRAM_COORDINATOR)

    def test_moves_farms_and_memberships_and_fills_blanks(self, coordinator, brgy):
        target = FarmerFactory(home_barangay=brgy, contact_no="", sex="male")
        dup = FarmerFactory(
            home_barangay=brgy, contact_no="0917", rsbsa_no="R-9", sex="female", birth_year=1970
        )
        FarmFactory(farmer=dup)
        FarmFactory(farmer=dup)
        shared = AssociationFactory(municipality=brgy.municipality)
        MemberFactory(farmer=target, association=shared)
        MemberFactory(farmer=dup, association=shared)
        MemberFactory(farmer=dup)

        result = services.merge_farmers(actor=coordinator, target=target, duplicate=dup)

        assert result.farms_moved == 2
        assert result.memberships_moved == 1
        assert sorted(result.fields_filled) == ["birth_year", "contact_no", "rsbsa_no"]
        assert result.conflicts == ["sex"]
        target.refresh_from_db()
        assert (target.rsbsa_no, target.contact_no, target.sex) == ("R-9", "0917", "male")
        assert target.farms.count() == 2
        assert target.memberships.count() == 2
        retired = Farmer.all_objects.get(pk=dup.pk)
        assert retired.is_deleted
        assert retired.merged_into_id == target.pk
        assert retired.status == FarmerStatus.INACTIVE
        assert retired.rsbsa_no is None
        assert AuditLog.objects.filter(action="farmer.merge", object_id=str(target.pk)).exists()
        assert AuditLog.objects.filter(action="farmer.merged_into", object_id=str(dup.pk)).exists()

    def test_requires_merge_capability(self, encoder, brgy):
        a, b = FarmerFactory(home_barangay=brgy), FarmerFactory(home_barangay=brgy)

        with pytest.raises(DomainError) as info:
            services.merge_farmers(actor=encoder, target=a, duplicate=b)

        assert info.value.status_code == 403

    def test_cannot_merge_into_self(self, coordinator, brgy):
        a = FarmerFactory(home_barangay=brgy)

        with pytest.raises(DomainError) as info:
            services.merge_farmers(actor=coordinator, target=a, duplicate=a)

        assert info.value.code == "merge_self"


class TestErase:
    def test_blanks_personal_data_keeps_record(self, brgy):
        admin = user_with_role(Role.SYSTEM_ADMIN)
        farmer = FarmerFactory(
            home_barangay=brgy, contact_no="0917", rsbsa_no="R-1", birth_year=1960
        )
        farm = FarmFactory(farmer=farmer, sitio="Synthetic sitio", location_raw="near the river")

        services.erase_farmer_personal_data(actor=admin, farmer=farmer)

        farmer.refresh_from_db()
        farm.refresh_from_db()
        assert farmer.display_name == "[erased]"
        assert (farmer.contact_no, farmer.rsbsa_no, farmer.birth_year) == ("", None, None)
        assert (farm.sitio, farm.location_raw) == ("", "")
        assert Farmer.objects.filter(pk=farmer.pk).exists()
        assert AuditLog.objects.filter(action="farmer.erase").exists()

    def test_admin_only(self, encoder, brgy):
        with pytest.raises(DomainError):
            services.erase_farmer_personal_data(
                actor=encoder, farmer=FarmerFactory(home_barangay=brgy)
            )


class TestAssociations:
    def test_create_update_delete(self, encoder, gasan):
        assoc = services.create_association(
            actor=encoder, data={"name": "  Sample  Gasan FA ", "municipality": gasan}
        )
        assert assoc.name == "Sample Gasan FA"

        services.update_association(actor=encoder, association=assoc, data={"short_name": "SGFA"})
        assert AuditLog.objects.filter(action="association.update").count() == 1

        services.delete_association(actor=encoder, association=assoc)
        assert AuditLog.objects.filter(action="association.delete").exists()

    def test_duplicate_name_in_municipality_is_409(self, encoder, gasan):
        services.create_association(
            actor=encoder, data={"name": "Sample FA", "municipality": gasan}
        )

        with pytest.raises(DomainError) as info:
            services.create_association(
                actor=encoder, data={"name": "sample fa.", "municipality": gasan}
            )

        assert info.value.status_code == 409

    def test_name_required(self, encoder, gasan):
        with pytest.raises(DomainError):
            services.create_association(actor=encoder, data={"name": " ", "municipality": gasan})

    def test_out_of_scope_municipality(self, encoder, municipalities):
        with pytest.raises(DomainError):
            services.create_association(
                actor=encoder, data={"name": "X", "municipality": municipalities["Boac"]}
            )

    def test_members(self, encoder, gasan, brgy):
        assoc = AssociationFactory(municipality=gasan)
        farmer = FarmerFactory(home_barangay=brgy)

        member = services.add_member(actor=encoder, association=assoc, farmer=farmer, role=" Pres ")
        assert member.role == "Pres"
        with pytest.raises(DomainError) as info:
            services.add_member(actor=encoder, association=assoc, farmer=farmer)
        assert info.value.code == "already_member"
        with pytest.raises(DomainError) as info:
            services.delete_association(actor=encoder, association=assoc)
        assert info.value.code == "has_members"

        services.remove_member(actor=encoder, member=member)
        assert not assoc.memberships.exists()
