"""Shared permission-matrix definitions (brief §7).

Every record-level endpoint registers an ``Endpoint`` here. The test builds one actor per role, with
the location-restricted roles assigned to Gasan, then checks each role against a Gasan object
("own") and a Boac object ("other").
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from apps.accounts.models import User
from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.locations.models import Barangay, Municipality

OWN, OTHER = "own", "other"

# Expected HTTP status for GET detail of a personal/record-level object.
READ_DETAIL: dict[str, dict[str, int]] = {
    Role.SYSTEM_ADMIN: {OWN: 200, OTHER: 200},
    Role.PROVINCIAL_HEAD: {OWN: 200, OTHER: 200},
    Role.PROGRAM_COORDINATOR: {OWN: 200, OTHER: 200},
    Role.PROVINCIAL_ENCODER: {OWN: 200, OTHER: 200},
    Role.MAO_VALIDATOR: {OWN: 200, OTHER: 404},
    Role.FIELD_ENCODER: {OWN: 200, OTHER: 404},
    Role.VIEWER: {OWN: 403, OTHER: 403},  # ADR-0010: aggregates only
}


@dataclass(frozen=True)
class Endpoint:
    name: str
    list_url: str | None  # None when the endpoint has no list (nested or detail-only)
    detail_url: Callable[[Any], str]
    # Creates an object located in the given barangay.
    make: Callable[[Barangay], Any]
    read_detail: dict[str, dict[str, int]] | None = None  # override READ_DETAIL when needed

    def expected(self, role: str, relation: str) -> int:
        return (self.read_detail or READ_DETAIL)[role][relation]


def make_actor(role: str, home: Municipality, home_barangay: Barangay) -> User:
    """One user per role; location-restricted roles are assigned to ``home``."""
    if role == Role.SYSTEM_ADMIN:
        return user_with_role(role, is_superuser=True, is_staff=True)
    if role == Role.MAO_VALIDATOR:
        return user_with_role(role, municipality=home)
    if role == Role.FIELD_ENCODER:
        return user_with_role(role, municipality=home, barangays=[home_barangay])
    return user_with_role(role)
