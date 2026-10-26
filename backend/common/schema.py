"""OpenAPI generation tweaks so the generated TypeScript client matches real responses."""

from typing import Any

from drf_spectacular.openapi import AutoSchema


class ServiceAutoSchema(AutoSchema):
    """ServiceModelViewSet validates input with ``write_serializer_class`` but always answers with
    ``serializer_class``. Document exactly that (default spectacular uses one for both)."""

    def get_response_serializers(self) -> Any:
        view: Any = self.view
        if getattr(view, "action", None) in {"create", "update", "partial_update"}:
            serializer_class = getattr(view, "serializer_class", None)
            if serializer_class is not None:
                return serializer_class
        return super().get_response_serializers()
