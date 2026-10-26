import contextlib
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.contrib.auth import authenticate
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone
from rest_framework import status
from rest_framework_simplejwt.exceptions import TokenBackendError, TokenError
from rest_framework_simplejwt.state import token_backend
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.locations.models import Barangay, Municipality
from common.exceptions import DomainError

from .models import User, UserAssignment
from .roles import BARANGAY_SCOPED_ROLES, Role


@dataclass(frozen=True)
class TokenPair:
    access: str
    refresh: str


def _invalid_token() -> DomainError:
    return DomainError("token_invalid", "Session expired. Please sign in again.", status_code=401)


def login(*, request: HttpRequest, email: str, password: str) -> tuple[User, TokenPair]:
    """Authenticate through django-axes (lockout) and issue a fresh token pair."""
    user = authenticate(request=request, username=email.strip().lower(), password=password)
    if getattr(request, "axes_locked_out", False):
        raise DomainError(
            "locked_out",
            "Too many failed sign-in attempts. Try again later.",
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        )
    if not isinstance(user, User) or not user.is_active:
        raise DomainError("invalid_credentials", "Email or password is incorrect.", status_code=401)
    user.last_login = timezone.now()
    user.save(update_fields=["last_login"])
    return user, issue_tokens(user)


def issue_tokens(user: User) -> TokenPair:
    refresh = RefreshToken.for_user(user)
    return TokenPair(access=str(refresh.access_token), refresh=str(refresh))


def rotate_refresh(raw: str) -> TokenPair:
    """Single-use refresh tokens. Presenting an already-rotated token revokes the whole family.

    Not wrapped in one transaction: revocations must persist even though we then raise.
    """
    try:
        token = RefreshToken(raw)  # type: ignore[arg-type]
    except TokenError:
        _revoke_on_reuse(raw)
        raise _invalid_token() from None

    user_id = token.payload.get("user_id")
    user = User.objects.filter(pk=user_id, is_active=True).first() if user_id else None
    if user is None:
        token.blacklist()
        raise _invalid_token()
    with transaction.atomic():
        token.blacklist()
        return issue_tokens(user)


def revoke_refresh(raw: str | None) -> None:
    if not raw:
        return
    with contextlib.suppress(TokenError):  # already invalid: nothing to revoke
        RefreshToken(raw).blacklist()  # type: ignore[arg-type]


def revoke_all_tokens(user_id: UUID | str) -> int:
    """Blacklist every live refresh token of the user. Returns how many were revoked."""
    live = OutstandingToken.objects.filter(
        user_id=user_id, expires_at__gt=timezone.now(), blacklistedtoken__isnull=True
    )
    tokens = list(live)
    BlacklistedToken.objects.bulk_create(
        [BlacklistedToken(token=t) for t in tokens], ignore_conflicts=True
    )
    return len(tokens)


def _revoke_on_reuse(raw: str) -> None:
    try:
        # Stubs type the argument as Token, but the backend decodes the raw string.
        payload: dict[str, Any] = token_backend.decode(raw, verify=True)  # type: ignore[arg-type]
    except TokenBackendError:
        return  # forged or expired: not a reuse signal
    jti = payload.get("jti")
    user_id = payload.get("user_id")
    if jti and user_id and BlacklistedToken.objects.filter(token__jti=jti).exists():
        revoke_all_tokens(user_id)


def validate_assignment(
    *,
    role: str,
    municipality: Municipality | None,
    barangays: Iterable[Barangay],
) -> dict[str, list[str]]:
    """Field errors for an assignment (empty when valid). Used by services and the admin form."""
    errors: dict[str, list[str]] = {}
    barangay_list = list(barangays)
    if role == Role.MAO_VALIDATOR and municipality is None:
        errors["municipality"] = ["An MAO validator must be assigned to one municipality."]
    if barangay_list:
        if role not in BARANGAY_SCOPED_ROLES:
            errors["barangays"] = ["Only field encoders can be limited to barangays."]
        elif municipality is None:
            errors["municipality"] = ["Choose the municipality the barangays belong to."]
        elif any(b.municipality_id != municipality.pk for b in barangay_list):
            errors["barangays"] = [f"All barangays must be in {municipality.name}."]
    elif role in BARANGAY_SCOPED_ROLES and municipality is None:
        errors["municipality"] = ["A field encoder must be assigned to a municipality."]
    return errors


@transaction.atomic
def create_assignment(
    *,
    user: User,
    role: str,
    municipality: Municipality | None = None,
    program: Any = None,
    barangays: Iterable[Barangay] = (),
    actor: User | None = None,
) -> UserAssignment:
    barangay_list = list(barangays)
    errors = validate_assignment(role=role, municipality=municipality, barangays=barangay_list)
    if errors:
        raise DomainError("invalid_assignment", "The assignment is not valid.", errors)
    assignment = UserAssignment.objects.create(
        user=user,
        role=role,
        municipality=municipality,
        program=program,
        created_by=actor,
        updated_by=actor,
    )
    assignment.barangays.set(barangay_list)
    return assignment
