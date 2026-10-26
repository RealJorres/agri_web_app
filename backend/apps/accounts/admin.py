from typing import Any

from django import forms
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import User, UserAssignment
from .services import validate_assignment


class UserAssignmentForm(forms.ModelForm[UserAssignment]):
    class Meta:
        model = UserAssignment
        fields = ["role", "municipality", "program", "barangays"]

    def clean(self) -> dict[str, Any]:
        data = super().clean() or {}
        errors = validate_assignment(
            role=data.get("role", ""),
            municipality=data.get("municipality"),
            barangays=data.get("barangays") or [],
        )
        for field, messages in errors.items():
            for message in messages:
                self.add_error(field, message)
        return data


class UserAssignmentInline(admin.TabularInline[UserAssignment, User]):
    model = UserAssignment
    form = UserAssignmentForm
    fk_name = "user"
    extra = 0
    autocomplete_fields = ["barangays"]


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    ordering = ["email"]
    list_display = ["email", "first_name", "last_name", "is_active", "is_staff", "last_login"]
    search_fields = ["email", "first_name", "last_name"]
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Profile", {"fields": ("first_name", "last_name")}),
        ("Access", {"fields": ("is_active", "is_staff", "is_superuser")}),
        ("Dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = ((None, {"classes": ("wide",), "fields": ("email", "password1", "password2")}),)
    inlines = [UserAssignmentInline]
