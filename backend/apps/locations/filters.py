import django_filters
from django.db.models import QuerySet

from common.text import normalize_name

from .models import Barangay


class BarangayFilter(django_filters.FilterSet):
    municipality = django_filters.UUIDFilter(field_name="municipality_id")
    q = django_filters.CharFilter(method="filter_q")
    is_verified = django_filters.BooleanFilter()

    class Meta:
        model = Barangay
        fields = ["municipality", "is_verified"]

    def filter_q(self, queryset: QuerySet[Barangay], name: str, value: str) -> QuerySet[Barangay]:
        return queryset.filter(normalized_name__contains=normalize_name(value))
