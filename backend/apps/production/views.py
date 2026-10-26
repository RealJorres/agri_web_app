from typing import Any

from rest_framework.request import Request
from rest_framework.response import Response

from common.exceptions import DomainError
from common.viewsets import ServiceModelViewSet

from . import services
from .models import Harvest
from .serializers import HarvestSerializer


class HarvestViewSet(ServiceModelViewSet):
    """Detail routes only; list/create live under /crop-stands/{id}/harvests."""

    queryset = Harvest.objects.select_related("crop_stand__farm__barangay", "crop_stand__commodity")
    serializer_class = HarvestSerializer
    scope_barangay_path = "crop_stand__farm__barangay"
    scope_program_path = "crop_stand__commodity__program"

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        raise DomainError(
            "use_crop_stand_endpoint",
            "List harvests via /crop-stands/{id}/harvests.",
            status_code=405,
        )

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return self.list(request)

    def service_update(self, instance: Harvest, data: dict[str, Any]) -> Harvest:
        return services.update_harvest(actor=self.actor, harvest=instance, data=data)

    def service_destroy(self, instance: Harvest) -> None:
        services.delete_harvest(actor=self.actor, harvest=instance)
