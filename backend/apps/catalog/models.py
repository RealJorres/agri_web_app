"""Commodity catalog. New crops are rows here, not code (brief §1)."""

from decimal import Decimal

from django.contrib.postgres.fields import ArrayField
from django.contrib.postgres.indexes import GinIndex
from django.core.validators import MinValueValidator
from django.db import models
from django.db.models import Q

from common.models import BaseModel


def _aliases() -> ArrayField:
    return ArrayField(
        models.CharField(max_length=100),
        default=list,
        blank=True,
        help_text="Other spellings seen in source data. Matched after normalization.",
    )


class Program(BaseModel):
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=200)

    class Meta:
        ordering = ["code"]
        constraints = [
            models.UniqueConstraint(
                fields=["code"], condition=Q(deleted_at__isnull=True), name="uniq_program_code"
            ),
        ]

    def __str__(self) -> str:
        return self.code


class MeasureType(models.TextChoices):
    TREES = "trees", "Trees (counted per stage)"
    AREA = "area", "Area (hectares per stage)"


class Commodity(BaseModel):
    program = models.ForeignKey(Program, on_delete=models.PROTECT, related_name="commodities")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=100)
    measure_type = models.CharField(max_length=10, choices=MeasureType.choices)
    spacing_m = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True, validators=[MinValueValidator(0)]
    )
    plants_per_ha = models.PositiveIntegerField(null=True, blank=True)
    # JSON Schema for crop_stand.attributes (validated in catalog.services).
    attributes_schema = models.JSONField(default=dict, blank=True)
    outlier_multiplier = models.DecimalField(
        max_digits=5, decimal_places=2, default=Decimal(5), validators=[MinValueValidator(1)]
    )

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "commodities"
        constraints = [
            models.UniqueConstraint(
                fields=["code"], condition=Q(deleted_at__isnull=True), name="uniq_commodity_code"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class GrowthStage(BaseModel):
    commodity = models.ForeignKey(Commodity, on_delete=models.PROTECT, related_name="stages")
    code = models.CharField(max_length=30)
    label = models.CharField(max_length=100)
    sort_order = models.PositiveSmallIntegerField()
    is_bearing = models.BooleanField(default=False)
    aliases = _aliases()

    class Meta:
        ordering = ["commodity", "sort_order"]
        constraints = [
            models.UniqueConstraint(
                fields=["commodity", "code"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_stage_code",
            ),
            models.UniqueConstraint(
                fields=["commodity", "sort_order"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_stage_order",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.commodity.code} {self.label}"


class Variety(BaseModel):
    commodity = models.ForeignKey(Commodity, on_delete=models.PROTECT, related_name="varieties")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=100)
    aliases = _aliases()

    class Meta:
        ordering = ["commodity", "code"]
        verbose_name_plural = "varieties"
        indexes = [GinIndex(fields=["aliases"], name="variety_aliases_gin")]
        constraints = [
            models.UniqueConstraint(
                fields=["commodity", "code"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_variety_code",
            ),
        ]

    def __str__(self) -> str:
        return self.code


class MaterialSource(BaseModel):
    """Where planting materials came from (DA-RFO, PCA, own produced...)."""

    code = models.CharField(max_length=30)
    name = models.CharField(max_length=100)
    aliases = _aliases()

    class Meta:
        ordering = ["code"]
        indexes = [GinIndex(fields=["aliases"], name="source_aliases_gin")]
        constraints = [
            models.UniqueConstraint(
                fields=["code"], condition=Q(deleted_at__isnull=True), name="uniq_source_code"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class UnitKind(models.TextChoices):
    MASS = "mass", "Mass"
    AREA = "area", "Area"
    COUNT = "count", "Count"
    CONTAINER = "container", "Container (sack, basket)"


class Unit(BaseModel):
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=50)
    kind = models.CharField(max_length=10, choices=UnitKind.choices)
    # Conversion to the kind's base unit (kg, ha). NULL when it varies, e.g. a sack.
    to_base = models.DecimalField(max_digits=12, decimal_places=6, null=True, blank=True)
    aliases = _aliases()

    class Meta:
        ordering = ["kind", "code"]
        constraints = [
            models.UniqueConstraint(
                fields=["code"], condition=Q(deleted_at__isnull=True), name="uniq_unit_code"
            ),
        ]

    def __str__(self) -> str:
        return self.code
