from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from django.contrib.auth.models import AnonymousUser

from .models import User, UserAssignment
from .roles import ROLE_CAPABILITIES, Cap, Role


@dataclass(frozen=True)
class Grant:
    """One assignment, flattened. None means unrestricted on that dimension."""

    role: str
    municipality_id: UUID | None
    program_id: UUID | None
    barangay_ids: frozenset[UUID] = field(default_factory=frozenset)

    @property
    def capabilities(self) -> frozenset[Cap]:
        return ROLE_CAPABILITIES.get(self.role, frozenset())


@dataclass(frozen=True)
class Scope:
    user_id: UUID | None
    grants: tuple[Grant, ...]

    @property
    def roles(self) -> frozenset[str]:
        return frozenset(g.role for g in self.grants)

    @property
    def capabilities(self) -> frozenset[Cap]:
        caps: set[Cap] = set()
        for grant in self.grants:
            caps |= grant.capabilities
        return frozenset(caps)

    def can(self, capability: Cap) -> bool:
        return capability in self.capabilities

    def grants_with(self, capability: Cap) -> tuple[Grant, ...]:
        return tuple(g for g in self.grants if capability in g.capabilities)


EMPTY_SCOPE = Scope(user_id=None, grants=())


def get_scope(user: User | AnonymousUser | Any) -> Scope:
    """Resolve the user's active grants. Superusers act as system_admin everywhere."""
    if not getattr(user, "is_authenticated", False) or not user.is_active:
        return EMPTY_SCOPE
    grants: list[Grant] = []
    if user.is_superuser:
        grants.append(Grant(role=Role.SYSTEM_ADMIN, municipality_id=None, program_id=None))
    assignments = UserAssignment.objects.filter(user=user).prefetch_related("barangays")
    for assignment in assignments:
        grants.append(
            Grant(
                role=assignment.role,
                municipality_id=assignment.municipality_id,
                program_id=assignment.program_id,
                barangay_ids=frozenset(b.id for b in assignment.barangays.all()),
            )
        )
    return Scope(user_id=user.pk, grants=tuple(grants))


def assignments_for(user: User) -> list[UserAssignment]:
    return list(
        UserAssignment.objects.filter(user=user)
        .select_related("municipality", "program")
        .prefetch_related("barangays")
    )
