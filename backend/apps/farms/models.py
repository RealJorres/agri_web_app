from django.contrib.gis.db import models as gis
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import Q

from common.models import BaseModel


class Tenure(models.TextChoices):
    OWNER = "owner", "Owner"
    TENANT = "tenant", "Tenant"
    LESSEE = "lessee", "Lessee"
    ARB = "arb", "Agrarian reform beneficiary"
    OTHER = "other", "Other"


class Farm(BaseModel):
    # Farm location is personal data (it locates a person's land).
    PERSONAL_FIELDS = ("sitio", "location", "location_raw")

    farmer = models.ForeignKey("registry.Farmer", on_delete=models.PROTECT, related_name="farms")
    barangay = models.ForeignKey(
        "locations.Barangay", on_delete=models.PROTECT, related_name="farms"
    )
    sitio = models.CharField(max_length=100, blank=True)
    location = gis.PointField(srid=4326, null=True, blank=True)
    declared_area_ha = models.DecimalField(
        max_digits=9, decimal_places=4, null=True, blank=True, validators=[MinValueValidator(0)]
    )
    tenure = models.CharField(max_length=10, choices=Tenure.choices, blank=True)
    # Location text as written at the source (e.g. "Pulong Parang/Masalukot").
    location_raw = models.TextField(blank=True)

    class Meta:
        ordering = ["barangay__name"]

    def __str__(self) -> str:
        return f"Farm in {self.barangay}"


class CropStand(BaseModel):
    """One commodity grown on one farm. Inventory counts attach here (brief §6)."""

    farm = models.ForeignKey(Farm, on_delete=models.PROTECT, related_name="crop_stands")
    commodity = models.ForeignKey(
        "catalog.Commodity", on_delete=models.PROTECT, related_name="crop_stands"
    )
    spacing_m = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True, validators=[MinValueValidator(0)]
    )
    attributes = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["commodity__name"]
        constraints = [
            models.UniqueConstraint(
                fields=["farm", "commodity"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_crop_stand",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.commodity} at {self.farm}"


class Planting(BaseModel):
    """A planting batch: when, from what source, which varieties. Not counted per stage."""

    crop_stand = models.ForeignKey(CropStand, on_delete=models.PROTECT, related_name="plantings")
    year_planted = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(1900), MaxValueValidator(2100)]
    )
    source = models.ForeignKey(
        "catalog.MaterialSource",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="plantings",
    )
    qty_planted = models.PositiveIntegerField(null=True, blank=True)
    notes = models.TextField(blank=True)
    varieties = models.ManyToManyField(
        "catalog.Variety", through="PlantingVariety", related_name="plantings", blank=True
    )

    class Meta:
        ordering = ["year_planted"]

    def __str__(self) -> str:
        return f"Planting {self.year_planted or '?'} ({self.crop_stand})"


class PlantingVariety(models.Model):
    planting = models.ForeignKey(Planting, on_delete=models.CASCADE)
    variety = models.ForeignKey("catalog.Variety", on_delete=models.PROTECT)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["planting", "variety"], name="uniq_planting_variety")
        ]

    def __str__(self) -> str:
        return f"{self.planting_id}:{self.variety_id}"
