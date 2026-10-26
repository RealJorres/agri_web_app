from typing import Any

from django.contrib import admin
from django.http import HttpRequest

from .models import ReportSettings, ReportSignoff, Signatory


@admin.register(ReportSettings)
class ReportSettingsAdmin(admin.ModelAdmin[ReportSettings]):
    def has_add_permission(self, request: HttpRequest) -> bool:
        return not ReportSettings.objects.exists()

    def has_delete_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        return False


@admin.register(Signatory)
class SignatoryAdmin(admin.ModelAdmin[Signatory]):
    list_display = ["report_kind", "order", "caption", "name", "title"]
    list_filter = ["report_kind"]
    ordering = ["report_kind", "order"]


@admin.register(ReportSignoff)
class ReportSignoffAdmin(admin.ModelAdmin[ReportSignoff]):
    """Read-only: sign-offs are created by the provincial head in the app and audited."""

    list_display = ["survey_round", "report_kind", "signed_by", "signed_at", "content_sha256"]

    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        return False

    def has_delete_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        return False
