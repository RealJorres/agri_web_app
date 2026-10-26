from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter(trailing_slash=False)
router.register("harvests", views.HarvestViewSet, basename="harvest")

urlpatterns = router.urls
