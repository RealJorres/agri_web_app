from typing import Any

from django.db.models import Count, Prefetch, Q, QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response

from apps.accounts.roles import Cap
from apps.audit.views import AuditTrailMixin
from apps.locations.models import Barangay
from common.exceptions import DomainError
from common.scoping import scope_for
from common.viewsets import ServiceModelViewSet

from . import selectors, services
from .filters import AssociationFilter, FarmerFilter
from .models import Association, AssociationMember, Farmer
from .serializers import (
    AssociationSerializer,
    DuplicateCandidateSerializer,
    FarmerDetailSerializer,
    FarmerSerializer,
    FarmerWriteSerializer,
    MemberSerializer,
    MergeResultSerializer,
    MergeSerializer,
)


class FarmerViewSet(AuditTrailMixin, ServiceModelViewSet):
    queryset = Farmer.objects.select_related("home_barangay__municipality")
    serializer_class = FarmerSerializer
    write_serializer_class = FarmerWriteSerializer
    filterset_class = FarmerFilter
    ordering_fields = ["last_name", "first_name", "created_at", "updated_at", "status"]
    scope_barangay_path = "home_barangay"
    action_capabilities = {"merge": Cap.MERGE_FARMERS}

    def get_queryset(self) -> QuerySet[Farmer]:
        queryset = super().get_queryset()
        if self.action == "retrieve":
            queryset = queryset.prefetch_related(
                Prefetch(
                    "memberships",
                    queryset=AssociationMember.objects.select_related("association"),
                )
            )
        return queryset

    @extend_schema(responses=FarmerDetailSerializer)
    def retrieve(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        farmer = self.get_object()
        return Response(FarmerDetailSerializer(farmer, context=self.get_serializer_context()).data)

    def service_create(self, data: dict[str, Any]) -> Farmer:
        consent = data.pop("consent_given", False)
        return services.create_farmer(actor=self.actor, data=data, consent_given=consent)

    def service_update(self, instance: Farmer, data: dict[str, Any]) -> Farmer:
        consent = data.pop("consent_given", False)
        return services.update_farmer(
            actor=self.actor, farmer=instance, data=data, consent_given=consent
        )

    def service_destroy(self, instance: Farmer) -> None:
        services.delete_farmer(actor=self.actor, farmer=instance)

    @extend_schema(
        parameters=[
            OpenApiParameter("name", str, required=True),
            OpenApiParameter(
                "barangay", str, description="Barangay id: limits to its municipality"
            ),
            OpenApiParameter("rsbsa_no", str),
            OpenApiParameter("exclude", str, description="Farmer id to ignore (when editing)"),
        ],
        responses=DuplicateCandidateSerializer(many=True),
    )
    @action(detail=False, methods=["get"], pagination_class=None)
    def duplicates(self, request: Request) -> Response:
        """Possible duplicates for the live warning on the farmer form (ADR-0007)."""
        params = request.query_params
        barangay = None
        if params.get("barangay"):
            barangay = get_object_or_404(Barangay, pk=params["barangay"])
        candidates = selectors.find_duplicate_farmers(
            self.get_queryset(),
            name=params.get("name", ""),
            municipality_id=barangay.municipality_id if barangay else None,
            rsbsa_no=params.get("rsbsa_no"),
            exclude_id=params.get("exclude") or None,  # type: ignore[arg-type]
        )
        return Response(DuplicateCandidateSerializer(candidates, many=True).data)

    @extend_schema(request=MergeSerializer, responses=MergeResultSerializer)
    @action(detail=True, methods=["post"])
    def merge(self, request: Request, pk: str | None = None) -> Response:
        target = self.get_object()
        serializer = MergeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        duplicate = self.get_queryset().filter(pk=serializer.validated_data["duplicate"]).first()
        if duplicate is None:
            raise DomainError(
                "not_found", "Duplicate farmer not found.", {"duplicate": ["Not found."]}, 404
            )
        result = services.merge_farmers(actor=self.actor, target=target, duplicate=duplicate)
        return Response(MergeResultSerializer(result, context=self.get_serializer_context()).data)


class AssociationViewSet(AuditTrailMixin, ServiceModelViewSet):
    queryset = Association.objects.select_related("municipality")
    serializer_class = AssociationSerializer
    filterset_class = AssociationFilter
    ordering_fields = ["name", "created_at"]
    scope_municipality_path = "municipality"

    def get_queryset(self) -> QuerySet[Association]:
        return (
            super()
            .get_queryset()
            .annotate(
                member_count=Count("memberships", filter=Q(memberships__deleted_at__isnull=True))
            )
            .order_by("name")
        )

    def service_create(self, data: dict[str, Any]) -> Association:
        association = services.create_association(actor=self.actor, data=data)
        return self.get_queryset().get(pk=association.pk)

    def service_update(self, instance: Association, data: dict[str, Any]) -> Association:
        services.update_association(actor=self.actor, association=instance, data=data)
        return self.get_queryset().get(pk=instance.pk)

    def service_destroy(self, instance: Association) -> None:
        services.delete_association(actor=self.actor, association=instance)

    @extend_schema(request=MemberSerializer, responses=MemberSerializer(many=True))
    @action(detail=True, methods=["get", "post"])
    def members(self, request: Request, pk: str | None = None) -> Response:
        association = self.get_object()
        context = self.get_serializer_context()
        if request.method == "GET":
            page = self.paginate_queryset(selectors.memberships_of(association))
            return self.get_paginated_response(
                MemberSerializer(page, many=True, context=context).data
            )

        serializer = MemberSerializer(data=request.data, context=context)
        serializer.is_valid(raise_exception=True)
        farmer = (
            selectors.farmers_for(scope_for(request))
            .filter(pk=serializer.validated_data["farmer"].pk)
            .first()
        )
        if farmer is None:
            raise DomainError("not_found", "Farmer not found.", {"farmer": ["Not found."]}, 404)
        member = services.add_member(
            actor=self.actor,
            association=association,
            farmer=farmer,
            role=serializer.validated_data.get("role", ""),
            since=serializer.validated_data.get("since"),
        )
        return Response(
            MemberSerializer(member, context=context).data, status=status.HTTP_201_CREATED
        )

    @extend_schema(
        request=None,
        responses={204: None},
        parameters=[OpenApiParameter("member_id", OpenApiTypes.UUID, OpenApiParameter.PATH)],
    )
    @action(detail=True, methods=["delete"], url_path=r"members/(?P<member_id>[^/.]+)")
    def remove_member(
        self, request: Request, pk: str | None = None, member_id: str = ""
    ) -> Response:
        association = self.get_object()
        member = get_object_or_404(
            association.memberships.select_related("association"), pk=member_id
        )
        services.remove_member(actor=self.actor, member=member)
        return Response(status=status.HTTP_204_NO_CONTENT)
