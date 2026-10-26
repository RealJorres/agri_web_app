from django.urls import path

from . import views

urlpatterns = [
    path("analytics/status", views.RefreshStatusView.as_view(), name="analytics-status"),
    path("analytics/harvests", views.HarvestSummaryView.as_view(), name="analytics-harvests"),
    path("analytics/trends", views.TrendsView.as_view(), name="analytics-trends"),
    path(
        "analytics/rounds/<uuid:pk>/overview",
        views.OverviewView.as_view(),
        name="analytics-overview",
    ),
    path(
        "analytics/rounds/<uuid:pk>/breakdown",
        views.BreakdownView.as_view(),
        name="analytics-breakdown",
    ),
    path(
        "analytics/rounds/<uuid:pk>/distribution",
        views.DistributionView.as_view(),
        name="analytics-distribution",
    ),
]
