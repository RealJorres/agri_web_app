from uuid import uuid4

import pytest
from django.db.models import Q

from apps.accounts.roles import Cap, Role
from apps.accounts.selectors import EMPTY_SCOPE, Grant, Scope, get_scope
from apps.accounts.tests.factories import UserFactory, user_with_role
from apps.catalog.tests.factories import ProgramFactory
from apps.locations.models import Barangay
from apps.locations.tests.factories import BarangayFactory
from common.scoping import scope_q, scope_queryset

M1, M2, P1, B1 = uuid4(), uuid4(), uuid4(), uuid4()


def scope(*grants: Grant) -> Scope:
    return Scope(user_id=uuid4(), grants=grants)


class TestScopeQ:
    def test_no_grants_means_no_access(self):
        assert scope_q(EMPTY_SCOPE, Cap.VIEW_RECORDS, barangay_path="b") is None

    def test_unrestricted_grant_matches_everything(self):
        s = scope(Grant(Role.PROVINCIAL_HEAD, None, None))

        assert scope_q(s, Cap.VIEW_RECORDS, barangay_path="home_barangay") == Q()

    def test_municipality_grant_filters_through_barangay(self):
        s = scope(Grant(Role.MAO_VALIDATOR, M1, None))

        q = scope_q(s, Cap.VIEW_RECORDS, barangay_path="farm__barangay")

        assert q == Q(farm__barangay__municipality=M1)

    def test_barangay_grant_filters_by_barangay(self):
        s = scope(Grant(Role.FIELD_ENCODER, M1, None, frozenset({B1})))

        assert scope_q(s, Cap.VIEW_RECORDS, barangay_path="home_barangay") == Q(
            home_barangay__in=frozenset({B1})
        )

    def test_barangay_grant_falls_back_to_municipality_for_municipality_only_models(self):
        s = scope(Grant(Role.FIELD_ENCODER, M1, None, frozenset({B1})))

        assert scope_q(s, Cap.VIEW_RECORDS, municipality_path="municipality") == Q(municipality=M1)

    def test_barangay_grant_without_municipality_never_widens(self):
        s = scope(Grant(Role.FIELD_ENCODER, None, None, frozenset({B1})))

        assert scope_q(s, Cap.VIEW_RECORDS, municipality_path="municipality") is None

    def test_location_restricted_grant_cannot_see_location_less_models(self):
        s = scope(Grant(Role.MAO_VALIDATOR, M1, None))

        assert scope_q(s, Cap.VIEW_RECORDS, program_path="program") is None

    def test_program_restriction_applies_when_model_has_program(self):
        s = scope(Grant(Role.PROGRAM_COORDINATOR, None, P1))

        q = scope_q(s, Cap.VIEW_RECORDS, barangay_path="b", program_path="round__program")

        assert q == Q(round__program=P1)

    def test_program_restriction_ignored_for_program_less_models(self):
        s = scope(Grant(Role.PROGRAM_COORDINATOR, None, P1))

        assert scope_q(s, Cap.VIEW_RECORDS, barangay_path="home_barangay") == Q()

    def test_grants_are_ored(self):
        s = scope(Grant(Role.MAO_VALIDATOR, M1, None), Grant(Role.MAO_VALIDATOR, M2, None))

        q = scope_q(s, Cap.VIEW_RECORDS, municipality_path="municipality")

        assert q == Q(municipality=M1) | Q(municipality=M2)

    def test_only_grants_with_capability_count(self):
        s = scope(Grant(Role.VIEWER, None, None), Grant(Role.MAO_VALIDATOR, M1, None))

        assert scope_q(s, Cap.VIEW_RECORDS, municipality_path="municipality") == Q(municipality=M1)
        assert scope_q(s, Cap.APPROVE, municipality_path="municipality") is None


@pytest.mark.django_db
class TestScopeQueryset:
    def test_filters_rows_by_municipality(self, municipalities):
        gasan = BarangayFactory(municipality=municipalities["Gasan"])
        BarangayFactory(municipality=municipalities["Boac"])
        user = user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Gasan"])

        rows = scope_queryset(
            Barangay.objects.all(), get_scope(user), municipality_path="municipality"
        )

        assert list(rows) == [gasan]

    def test_viewer_sees_no_records(self):
        BarangayFactory()
        user = user_with_role(Role.VIEWER)

        rows = scope_queryset(
            Barangay.objects.all(), get_scope(user), municipality_path="municipality"
        )

        assert not rows.exists()


@pytest.mark.django_db
class TestGetScope:
    def test_anonymous_and_inactive_users_have_empty_scope(self):
        from django.contrib.auth.models import AnonymousUser

        assert get_scope(AnonymousUser()) == EMPTY_SCOPE
        user = user_with_role(Role.PROVINCIAL_HEAD)
        user.is_active = False
        assert get_scope(user) == EMPTY_SCOPE

    def test_collects_every_assignment(self, municipalities):
        from apps.accounts.services import create_assignment

        program = ProgramFactory(code="HVCDP")
        user = user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Boac"])
        create_assignment(user=user, role=Role.PROGRAM_COORDINATOR, program=program)

        s = get_scope(user)

        assert s.roles == {Role.MAO_VALIDATOR, Role.PROGRAM_COORDINATOR}
        assert s.can(Cap.APPROVE)
        assert s.can(Cap.VALIDATE)
        assert {g.program_id for g in s.grants} == {None, program.pk}

    def test_user_without_assignments_has_no_capabilities(self):
        assert get_scope(UserFactory()).capabilities == frozenset()
