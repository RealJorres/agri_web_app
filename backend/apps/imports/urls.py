from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter(trailing_slash=False)
router.register("imports", views.ImportJobViewSet, basename="import")

urlpatterns = [
    path("exports/farmers.xlsx", views.FarmerExportView.as_view(), name="export-farmers"),
    path("exports/inventory.xlsx", views.InventoryExportView.as_view(), name="export-inventory"),
    *router.urls,
]
