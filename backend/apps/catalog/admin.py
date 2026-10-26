from typing import Any

from django import forms
from django.contrib import admin

from common.exceptions import DomainError

from .models import Commodity, GrowthStage, MaterialSource, Program, Unit, Variety
from .services import check_attributes_schema


@admin.register(Program)
class ProgramAdmin(admin.ModelAdmin[Program]):
    list_display = ["code", "name"]
    search_fields = ["code", "name"]


class CommodityForm(forms.ModelForm[Commodity]):
    class Meta:
        model = Commodity
        fields = [
            "program",
            "code",
            "name",
            "measure_type",
            "spacing_m",
            "plants_per_ha",
            "attributes_schema",
            "outlier_multiplier",
        ]

    def clean_attributes_schema(self) -> dict[str, Any]:
        schema: dict[str, Any] = self.cleaned_data.get("attributes_schema") or {}
        try:
            check_attributes_schema(schema)
        except DomainError as exc:
            raise forms.ValidationError(exc.fields["attributes_schema"]) from None
        return schema


class GrowthStageInline(admin.TabularInline[GrowthStage, Commodity]):
    model = GrowthStage
    extra = 0
    fields = ["sort_order", "code", "label", "is_bearing", "aliases"]


class VarietyInline(admin.TabularInline[Variety, Commodity]):
    model = Variety
    extra = 0
    fields = ["code", "name", "aliases"]


@admin.register(Commodity)
class CommodityAdmin(admin.ModelAdmin[Commodity]):
    form = CommodityForm
    list_display = ["code", "name", "program", "measure_type", "plants_per_ha"]
    list_filter = ["program", "measure_type"]
    search_fields = ["code", "name"]
    inlines = [GrowthStageInline, VarietyInline]


@admin.register(MaterialSource)
class MaterialSourceAdmin(admin.ModelAdmin[MaterialSource]):
    list_display = ["code", "name", "aliases"]
    search_fields = ["code", "name"]


@admin.register(Unit)
class UnitAdmin(admin.ModelAdmin[Unit]):
    list_display = ["code", "name", "kind", "to_base"]
    list_filter = ["kind"]
