import pytest

from apps.accounts.roles import ROLE_CAPABILITIES, Cap, Role
from apps.accounts.services import create_assignment, revoke_all_tokens, validate_assignment
from apps.locations.tests.factories import BarangayFactory
from common.exceptions import DomainError

from .factories import UserFactory


def test_viewer_has_only_aggregate_access():
    assert ROLE_CAPABILITIES[Role.VIEWER] == {Cap.VIEW_AGGREGATES}


def test_every_role_has_capabilities_defined():
    assert set(ROLE_CAPABILITIES) == set(Role)


def test_only_validators_validate_and_only_coordinators_approve():
    validators = {r for r, caps in ROLE_CAPABILITIES.items() if Cap.VALIDATE in caps}
    approvers = {r for r, caps in ROLE_CAPABILITIES.items() if Cap.APPROVE in caps}

    assert validators == {Role.SYSTEM_ADMIN, Role.MAO_VALIDATOR}
    assert approvers == {Role.SYSTEM_ADMIN, Role.PROGRAM_COORDINATOR}


@pytest.mark.django_db
class TestValidateAssignment:
    def test_mao_validator_needs_municipality(self):
        errors = validate_assignment(role=Role.MAO_VALIDATOR, municipality=None, barangays=[])

        assert "municipality" in errors

    def test_field_encoder_needs_municipality(self):
        errors = validate_assignment(role=Role.FIELD_ENCODER, municipality=None, barangays=[])

        assert "municipality" in errors

    def test_barangays_only_for_field_encoders(self, municipalities):
        b = BarangayFactory(municipality=municipalities["Boac"])

        errors = validate_assignment(
            role=Role.MAO_VALIDATOR, municipality=municipalities["Boac"], barangays=[b]
        )

        assert "barangays" in errors

    def test_barangays_need_a_municipality(self, municipalities):
        b = BarangayFactory(municipality=municipalities["Boac"])

        errors = validate_assignment(role=Role.FIELD_ENCODER, municipality=None, barangays=[b])

        assert "municipality" in errors

    def test_barangays_must_be_in_municipality(self, municipalities):
        b = BarangayFactory(municipality=municipalities["Boac"])

        errors = validate_assignment(
            role=Role.FIELD_ENCODER, municipality=municipalities["Gasan"], barangays=[b]
        )

        assert errors == {"barangays": ["All barangays must be in Gasan."]}

    def test_valid_field_encoder(self, municipalities):
        b = BarangayFactory(municipality=municipalities["Gasan"])

        assert (
            validate_assignment(
                role=Role.FIELD_ENCODER, municipality=municipalities["Gasan"], barangays=[b]
            )
            == {}
        )

    def test_create_assignment_raises_domain_error(self):
        with pytest.raises(DomainError) as info:
            create_assignment(user=UserFactory(), role=Role.MAO_VALIDATOR)

        assert info.value.code == "invalid_assignment"
        assert "municipality" in info.value.fields


@pytest.mark.django_db
def test_revoke_all_tokens_counts_only_live_tokens():
    from apps.accounts.services import issue_tokens

    user = UserFactory()
    issue_tokens(user)
    issue_tokens(user)

    assert revoke_all_tokens(user.pk) == 2
    assert revoke_all_tokens(user.pk) == 0
