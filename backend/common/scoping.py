"""Server-side row scoping. Every record-level viewset and selector goes through ``scope_queryset``.

A row is visible when ANY of the user's grants that carry the required capability covers it:
- location: grant.barangay_ids (field encoders) > grant.municipality_id > unrestricted;
- program:  grant.program_id, applied only when the model has a program path.
Out-of-scope rows simply do not exist for the user, so detail views answer 404.
"""

from typing import Any

from django.db.models import Model, Q, QuerySet
from rest_framework.request import Request

from apps.accounts.roles import Cap
from apps.accounts.selectors import Scope, get_scope

_REQUEST_ATTR = "_agri_scope"


def scope_for(request: Request | Any) -> Scope:
    """The request user's scope, computed once per request."""
    cached = getattr(request, _REQUEST_ATTR, None)
    if cached is None:
        cached = get_scope(request.user)
        setattr(request, _REQUEST_ATTR, cached)
    return cached


def scope_q(
    scope: Scope,
    capability: Cap,
    *,
    barangay_path: str | None = None,
    municipality_path: str | None = None,
    program_path: str | None = None,
) -> Q | None:
    """Q matching the rows the scope may access, or None when no grant applies."""
    if municipality_path is None and barangay_path is not None:
        municipality_path = f"{barangay_path}__municipality"

    combined: Q | None = None
    for grant in scope.grants_with(capability):
        q = Q()
        if grant.barangay_ids and barangay_path is not None:
            q &= Q(**{f"{barangay_path}__in": grant.barangay_ids})
        elif grant.municipality_id is not None:
            if municipality_path is None:
                continue  # location-restricted grants cannot see location-less models
            q &= Q(**{municipality_path: grant.municipality_id})
        elif grant.barangay_ids:
            continue  # barangay-restricted grant, model has no barangay path: deny
        if grant.program_id is not None and program_path is not None:
            q &= Q(**{program_path: grant.program_id})
        combined = q if combined is None else combined | q
    return combined


def scope_queryset[M: Model](
    queryset: QuerySet[M],
    scope: Scope,
    capability: Cap = Cap.VIEW_RECORDS,
    *,
    barangay_path: str | None = None,
    municipality_path: str | None = None,
    program_path: str | None = None,
) -> QuerySet[M]:
    q = scope_q(
        scope,
        capability,
        barangay_path=barangay_path,
        municipality_path=municipality_path,
        program_path=program_path,
    )
    if q is None:
        return queryset.none()
    # Scope paths must be to-one relations, so the filter never duplicates rows.
    return queryset.filter(q)


class ScopedQuerySetMixin:
    """Mixin for DRF generic views. Set the paths that lead from the model to its location.

    scope_barangay_path:     e.g. "home_barangay", "farm__barangay", "crop_stand__farm__barangay"
    scope_municipality_path: for models that only know their municipality (e.g. Association)
    scope_program_path:      e.g. "survey_round__commodity__program"
    """

    scope_barangay_path: str | None = None
    scope_municipality_path: str | None = None
    scope_program_path: str | None = None
    scope_capability: Cap = Cap.VIEW_RECORDS
    request: Request

    def get_queryset(self) -> QuerySet[Any]:
        queryset: QuerySet[Any] = super().get_queryset()  # type: ignore[misc]
        return scope_queryset(
            queryset,
            scope_for(self.request),
            self.scope_capability,
            barangay_path=self.scope_barangay_path,
            municipality_path=self.scope_municipality_path,
            program_path=self.scope_program_path,
        )
