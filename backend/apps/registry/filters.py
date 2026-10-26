from uuid import UUID

import django_filters
from django.db.models import QuerySet

from common.text import normalize_name

from .models import Association, Farmer, FarmerStatus
from .selectors import search_farmers


class FarmerFilter(django_filters.FilterSet):
    q = django_filters.CharFilter(method="filter_q", label="Name or RSBSA number")
    municipality = django_filters.UUIDFilter(field_name="home_barangay__municipality_id")
    barangay = django_filters.UUIDFilter(field_name="home_barangay_id")
    association = django_filters.UUIDFilter(method="filter_association")
    status = django_filters.ChoiceFilter(choices=FarmerStatus.choices)

    class Meta:
        model = Farmer
        fields = ["status"]

    def filter_q(self, queryset: QuerySet[Farmer], name: str, value: str) -> QuerySet[Farmer]:
        return search_farmers(queryset, value)

    def filter_association(
        self, queryset: QuerySet[Farmer], name: str, value: UUID
    ) -> QuerySet[Farmer]:
        return queryset.filter(
            memberships__association_id=value, memberships__deleted_at__isnull=True
        ).distinct()


class AssociationFilter(django_filters.FilterSet):
    municipality = django_filters.UUIDFilter(field_name="municipality_id")
    q = django_filters.CharFilter(method="filter_q")

    class Meta:
        model = Association
        fields = ["type"]

    def filter_q(
        self, queryset: QuerySet[Association], name: str, value: str
    ) -> QuerySet[Association]:
        return queryset.filter(normalized_name__contains=normalize_name(value))
