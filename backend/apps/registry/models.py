from django.conf import settings
from django.contrib.postgres.indexes import GinIndex
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import Q

from common.models import BaseModel
from common.text import collapse_spaces, normalize_name, normalize_person_name


class Sex(models.TextChoices):
    MALE = "male", "Male"
    FEMALE = "female", "Female"


class FarmerStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    INACTIVE = "inactive", "Inactive"
    NEEDS_REVIEW = "needs_review", "Needs review"


class Farmer(BaseModel):
    """A person who farms. Every field except status/home_barangay is personal data (RA 10173)."""

    PERSONAL_FIELDS = (
        "first_name",
        "middle_name",
        "last_name",
        "suffix",
        "full_name_raw",
        "sex",
        "birth_year",
        "rsbsa_no",
        "contact_no",
    )

    first_name = models.CharField(max_length=100, blank=True)
    middle_name = models.CharField(max_length=100, blank=True)
    last_name = models.CharField(max_length=100, blank=True)
    suffix = models.CharField(max_length=20, blank=True)
    # The name exactly as captured at the source (e.g. the legacy workbook cell).
    full_name_raw = models.CharField(max_length=300, blank=True)
    normalized_name = models.CharField(max_length=300, editable=False, db_index=True)
    sex = models.CharField(max_length=10, choices=Sex.choices, blank=True)
    birth_year = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(1900), MaxValueValidator(2100)]
    )
    # NULL (not "") when unknown so the partial unique constraint ignores it.
    rsbsa_no = models.CharField("RSBSA number", max_length=40, null=True, blank=True)  # noqa: DJ001
    contact_no = models.CharField(max_length=40, blank=True)
    home_barangay = models.ForeignKey(
        "locations.Barangay", on_delete=models.PROTECT, related_name="farmers"
    )
    consent_at = models.DateTimeField(null=True, blank=True)
    consent_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    status = models.CharField(
        max_length=20, choices=FarmerStatus.choices, default=FarmerStatus.ACTIVE
    )
    merged_into = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="merged_from"
    )

    class Meta:
        ordering = ["last_name", "first_name"]
        indexes = [
            GinIndex(
                fields=["normalized_name"], opclasses=["gin_trgm_ops"], name="farmer_name_trgm"
            )
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["rsbsa_no"],
                condition=Q(deleted_at__isnull=True, rsbsa_no__isnull=False),
                name="uniq_farmer_rsbsa",
            ),
        ]

    def __str__(self) -> str:
        return self.display_name

    @property
    def display_name(self) -> str:
        parts = [self.first_name, self.middle_name, self.last_name, self.suffix]
        return collapse_spaces(" ".join(p for p in parts if p)) or self.full_name_raw

    def save(self, *args: object, **kwargs: object) -> None:
        self.normalized_name = normalize_person_name(self.display_name)
        super().save(*args, **kwargs)  # type: ignore[arg-type]


class AssociationType(models.TextChoices):
    FARMERS_ASSOCIATION = "farmers_association", "Farmers association"
    COOPERATIVE = "cooperative", "Cooperative"
    IRRIGATORS_ASSOCIATION = "irrigators_association", "Irrigators association"
    OTHER = "other", "Other"


class Association(BaseModel):
    name = models.CharField(max_length=200)
    normalized_name = models.CharField(max_length=200, editable=False)
    short_name = models.CharField(max_length=50, blank=True)
    type = models.CharField(
        max_length=30, choices=AssociationType.choices, default=AssociationType.FARMERS_ASSOCIATION
    )
    municipality = models.ForeignKey(
        "locations.Municipality", on_delete=models.PROTECT, related_name="associations"
    )
    registration_body = models.CharField(max_length=100, blank=True)
    registration_no = models.CharField(max_length=60, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["municipality", "normalized_name"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_association_per_municipality",
            ),
        ]

    def __str__(self) -> str:
        return self.name

    def save(self, *args: object, **kwargs: object) -> None:
        self.normalized_name = normalize_name(self.name)
        super().save(*args, **kwargs)  # type: ignore[arg-type]


class AssociationMember(BaseModel):
    farmer = models.ForeignKey(Farmer, on_delete=models.PROTECT, related_name="memberships")
    association = models.ForeignKey(
        Association, on_delete=models.PROTECT, related_name="memberships"
    )
    role = models.CharField(max_length=60, blank=True)
    since = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["association__name"]
        constraints = [
            models.UniqueConstraint(
                fields=["farmer", "association"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_association_member",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.farmer} in {self.association}"
