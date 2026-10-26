from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter(trailing_slash=False)
router.register("farmers", views.FarmerViewSet, basename="farmer")
router.register("associations", views.AssociationViewSet, basename="association")

urlpatterns = router.urls
