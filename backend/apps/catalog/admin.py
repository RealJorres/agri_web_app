from django.contrib import admin

from .models import Program


@admin.register(Program)
class ProgramAdmin(admin.ModelAdmin[Program]):
    list_display = ["code", "name"]
    search_fields = ["code", "name"]
