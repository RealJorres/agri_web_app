from dataclasses import dataclass
from uuid import UUID

from django.conf import settings
from django.contrib.postgres.search import TrigramSimilarity
from django.db.models import Q, QuerySet

from apps.accounts.roles import Cap
from apps.accounts.selectors import Scope
from common.scoping import scope_queryset
from common.text import normalize_person_name

from .models import Association, AssociationMember, Farmer


def farmers_for(scope: Scope, capability: Cap = Cap.VIEW_RECORDS) -> QuerySet[Farmer]:
    return scope_queryset(
        Farmer.objects.select_related("home_barangay__municipality"),
        scope,
        capability,
        barangay_path="home_barangay",
    )


def associations_for(scope: Scope, capability: Cap = Cap.VIEW_RECORDS) -> QuerySet[Association]:
    return scope_queryset(
        Association.objects.select_related("municipality"),
        scope,
        capability,
        municipality_path="municipality",
    )


def search_farmers(queryset: QuerySet[Farmer], text: str) -> QuerySet[Farmer]:
    """Name/RSBSA search tolerant of spelling variants, best matches first."""
    needle = normalize_person_name(text)
    if not needle:
        return queryset
    return (
        queryset.annotate(similarity=TrigramSimilarity("normalized_name", needle))
        .filter(
            Q(normalized_name__contains=needle)
            | Q(similarity__gte=0.3)
            | Q(rsbsa_no__iexact=text.strip())
        )
        .order_by("-similarity", "last_name", "first_name")
    )


@dataclass(frozen=True)
class DuplicateCandidate:
    farmer: Farmer
    similarity: float
    reason: str  # "rsbsa" | "name"


def find_duplicate_farmers(
    queryset: QuerySet[Farmer],
    *,
    name: str,
    municipality_id: UUID | None = None,
    rsbsa_no: str | None = None,
    exclude_id: UUID | None = None,
    threshold: float | None = None,
    limit: int = 10,
) -> list[DuplicateCandidate]:
    """Likely duplicates within the municipality (trigram on normalized names) or anywhere with
    the same RSBSA number (ADR-0007). ``queryset`` decides visibility (scope it for API callers)."""
    threshold = settings.DUPLICATE_SUGGEST_SIMILARITY if threshold is None else threshold
    results: dict[UUID, DuplicateCandidate] = {}
    base = queryset.exclude(pk=exclude_id) if exclude_id else queryset

    if rsbsa_no and rsbsa_no.strip():
        for farmer in base.filter(rsbsa_no__iexact=rsbsa_no.strip())[:limit]:
            results[farmer.pk] = DuplicateCandidate(farmer, 1.0, "rsbsa")

    needle = normalize_person_name(name)
    if needle:
        by_name = base.annotate(similarity=TrigramSimilarity("normalized_name", needle)).filter(
            similarity__gte=threshold
        )
        if municipality_id:
            by_name = by_name.filter(home_barangay__municipality_id=municipality_id)
        for farmer in by_name.order_by("-similarity")[:limit]:
            results.setdefault(
                farmer.pk, DuplicateCandidate(farmer, round(farmer.similarity, 3), "name")
            )
    return sorted(results.values(), key=lambda c: -c.similarity)[:limit]


def memberships_of(association: Association) -> QuerySet[AssociationMember]:
    return association.memberships.select_related("farmer__home_barangay").order_by(
        "farmer__last_name", "farmer__first_name"
    )
