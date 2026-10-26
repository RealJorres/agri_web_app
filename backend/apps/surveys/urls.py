from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter(trailing_slash=False)
router.register("survey-rounds", views.SurveyRoundViewSet, basename="survey-round")
router.register("inventory-records", views.InventoryRecordViewSet, basename="inventory-record")

urlpatterns = [
    path("stats/home", views.HomeStatsView.as_view(), name="stats-home"),
    *router.urls,
]
