from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter(trailing_slash=False)
router.register("farms", views.FarmViewSet, basename="farm")
router.register("crop-stands", views.CropStandViewSet, basename="crop-stand")
router.register("plantings", views.PlantingViewSet, basename="planting")

urlpatterns = router.urls
