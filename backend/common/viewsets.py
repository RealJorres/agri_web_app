"""Base viewset for record-level resources: scoped reads, writes only through service functions."""

from typing import Any

from rest_framework import serializers, status, viewsets
from rest_framework.request import Request
from rest_framework.response import Response

from apps.accounts.models import User
from apps.accounts.roles import Cap

from .permissions import HasCapability
from .schema import ServiceAutoSchema
from .scoping import ScopedQuerySetMixin, scope_for


class PersonalFieldsMixin:
    """Drops ``personal_fields`` unless the requester may view personal data (ADR-0010).
    Without a request in context, personal fields are always dropped (safe default)."""

    personal_fields: tuple[str, ...] = ()
    context: dict[str, Any]

    def to_representation(self, instance: Any) -> Any:
        data = super().to_representation(instance)  # type: ignore[misc]
        request = self.context.get("request")
        if request is None or not scope_for(request).can(Cap.VIEW_PERSONAL_DATA):
            for name in self.personal_fields:
                data.pop(name, None)
        return data


class ServiceModelViewSet(ScopedQuerySetMixin, viewsets.ModelViewSet):  # type: ignore[type-arg]
    """Subclasses implement service_create / service_update / service_destroy.

    ``serializer_class`` renders responses; ``write_serializer_class`` validates input only.
    """

    permission_classes = [HasCapability]
    schema = ServiceAutoSchema()
    write_serializer_class: type[serializers.Serializer[Any]] | None = None
    ordering = None  # keep the queryset's own order (e.g. best search match first)

    @property
    def actor(self) -> User:
        user = self.request.user
        assert isinstance(user, User)  # noqa: S101 - HasCapability guarantees authentication
        return user

    def get_serializer_class(self) -> Any:
        if self.action in ("create", "update", "partial_update") and self.write_serializer_class:
            return self.write_serializer_class
        return self.serializer_class

    def render(self, obj: Any, status_code: int = status.HTTP_200_OK) -> Response:
        assert self.serializer_class is not None  # noqa: S101
        data = self.serializer_class(obj, context=self.get_serializer_context()).data
        return Response(data, status=status_code)

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        obj = self.service_create(serializer.validated_data)
        return self.render(obj, status.HTTP_201_CREATED)

    def update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        instance = self.get_object()
        serializer = self.get_serializer(
            instance, data=request.data, partial=kwargs.get("partial", False)
        )
        serializer.is_valid(raise_exception=True)
        return self.render(self.service_update(instance, serializer.validated_data))

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        self.service_destroy(self.get_object())
        return Response(status=status.HTTP_204_NO_CONTENT)

    def service_create(self, data: dict[str, Any]) -> Any:
        raise NotImplementedError

    def service_update(self, instance: Any, data: dict[str, Any]) -> Any:
        raise NotImplementedError

    def service_destroy(self, instance: Any) -> None:
        raise NotImplementedError
