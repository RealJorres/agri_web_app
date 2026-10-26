from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter(trailing_slash=False)
router.register("programs", views.ProgramViewSet, basename="program")
router.register("commodities", views.CommodityViewSet, basename="commodity")
router.register("varieties", views.VarietyViewSet, basename="variety")
router.register("material-sources", views.MaterialSourceViewSet, basename="material-source")
router.register("units", views.UnitViewSet, basename="unit")

urlpatterns = router.urls
