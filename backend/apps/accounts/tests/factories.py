from collections.abc import Iterable
from typing import Any

import factory

from apps.accounts.models import User, UserAssignment
from apps.accounts.services import create_assignment
from apps.locations.models import Barangay, Municipality

TEST_PASSWORD = "synthetic-Passw0rd!"


class UserFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = User

    email = factory.Sequence(lambda n: f"user{n}@example.test")
    first_name = "Test"
    last_name = factory.Sequence(lambda n: f"User{n}")
    is_active = True
    password = factory.django.Password(TEST_PASSWORD)


def user_with_role(
    role: str,
    *,
    municipality: Municipality | None = None,
    program: Any = None,
    barangays: Iterable[Barangay] = (),
    **user_fields: Any,
) -> User:
    user = UserFactory(**user_fields)
    create_assignment(
        user=user, role=role, municipality=municipality, program=program, barangays=barangays
    )
    return user


def assignment(user: User) -> UserAssignment:
    return UserAssignment.objects.get(user=user)
