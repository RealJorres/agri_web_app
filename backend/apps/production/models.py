from django.core.validators import MinValueValidator
from django.db import models

from common.models import BaseModel


class HarvestUnit(models.TextChoices):
    KG = "kg", "Kilogram"
    SACK = "sack", "Sack"
    OTHER = "other", "Other"


class ProductForm(models.TextChoices):
    WET_BEANS = "wet_beans", "Wet beans"
    DRIED_BEANS = "dried_beans", "Dried beans"
    PODS = "pods", "Pods"
    UNKNOWN = "unknown", "Unknown"


class Harvest(BaseModel):
    """A reported harvest. Phase 1: model + API only (UI in Phase 2)."""

    crop_stand = models.ForeignKey(
        "farms.CropStand", on_delete=models.PROTECT, related_name="harvests"
    )
    harvest_date = models.DateField(null=True, blank=True)
    # True when the date is unknown or approximate (e.g. extracted from legacy remarks).
    date_estimated = models.BooleanField(default=False)
    quantity = models.DecimalField(
        max_digits=12, decimal_places=3, validators=[MinValueValidator(0)]
    )
    unit = models.CharField(max_length=10, choices=HarvestUnit.choices)
    product_form = models.CharField(
        max_length=15, choices=ProductForm.choices, default=ProductForm.UNKNOWN
    )
    price_per_unit = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True, validators=[MinValueValidator(0)]
    )
    buyer = models.CharField(max_length=150, blank=True)
    # Source text the harvest was parsed from, e.g. "8 kilos harvest".
    raw_text = models.TextField(blank=True)

    class Meta:
        ordering = ["-harvest_date", "-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(quantity__gte=0), name="harvest_qty_non_negative"
            )
        ]

    def __str__(self) -> str:
        return f"{self.quantity} {self.unit} ({self.crop_stand_id})"
