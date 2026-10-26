from django.contrib.gis.db import models as gis
from django.db import models
from django.db.models import Q

from common.models import BaseModel
from common.text import normalize_name


class Municipality(BaseModel):
    # Nullable until the official PSGC file is loaded; codes are never invented (ADR-0005).
    psgc_code = models.CharField(max_length=10, unique=True, null=True, blank=True)
    name = models.CharField(max_length=100)
    normalized_name = models.CharField(max_length=100, editable=False)
    boundary = gis.MultiPolygonField(srid=4326, null=True, blank=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "municipalities"
        constraints = [
            models.UniqueConstraint(
                fields=["normalized_name"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_municipality_name",
            ),
        ]

    def __str__(self) -> str:
        return self.name

    def save(self, *args: object, **kwargs: object) -> None:
        self.normalized_name = normalize_name(self.name)
        super().save(*args, **kwargs)  # type: ignore[arg-type]


class Barangay(BaseModel):
    psgc_code = models.CharField(max_length=10, unique=True, null=True, blank=True)
    name = models.CharField(max_length=100)
    normalized_name = models.CharField(max_length=100, editable=False)
    municipality = models.ForeignKey(
        Municipality, on_delete=models.PROTECT, related_name="barangays"
    )
    boundary = gis.MultiPolygonField(srid=4326, null=True, blank=True)
    # False when created from an import rather than the official PSGC list.
    is_verified = models.BooleanField(default=False)

    class Meta:
        ordering = ["municipality__name", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["municipality", "normalized_name"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_barangay_per_municipality",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name}, {self.municipality.name}"

    def save(self, *args: object, **kwargs: object) -> None:
        self.normalized_name = normalize_name(self.name)
        super().save(*args, **kwargs)  # type: ignore[arg-type]
