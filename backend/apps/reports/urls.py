from django.urls import path

from . import views

urlpatterns = [
    path(
        "reports/rounds/<uuid:pk>/summary.<str:fmt>",
        views.SummaryFileView.as_view(),
        name="report-summary",
    ),
    path(
        "reports/rounds/<uuid:pk>/municipal-list.<str:fmt>",
        views.MunicipalListFileView.as_view(),
        name="report-municipal-list",
    ),
    path(
        "reports/rounds/<uuid:pk>/sign-off",
        views.SignoffView.as_view(),
        name="report-signoff",
    ),
]
