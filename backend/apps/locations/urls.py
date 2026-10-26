from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter(trailing_slash=False)
router.register("municipalities", views.MunicipalityViewSet, basename="municipality")
router.register("barangays", views.BarangayViewSet, basename="barangay")

urlpatterns = router.urls
