from django.conf import settings
from django.db import models
from django.db.models import Q

from common.models import BaseModel


class RoundStatus(models.TextChoices):
    OPEN = "open", "Open"
    CLOSED = "closed", "Closed"


class SurveyRound(BaseModel):
    """One inventory campaign for one commodity, e.g. "Cacao inventory - July 2023"."""

    commodity = models.ForeignKey(
        "catalog.Commodity", on_delete=models.PROTECT, related_name="survey_rounds"
    )
    name = models.CharField(max_length=150)
    as_of_date = models.DateField()
    deadline = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=RoundStatus.choices, default=RoundStatus.OPEN)
    # True for rounds reconstructed from legacy workbooks.
    is_historical = models.BooleanField(default=False)
    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        ordering = ["-as_of_date"]
        constraints = [
            models.UniqueConstraint(
                fields=["commodity", "name"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_round_name",
            ),
        ]

    def __str__(self) -> str:
        return self.name


class RecordStatus(models.TextChoices):
    DRAFT = "draft", "Draft"
    SUBMITTED = "submitted", "Submitted"
    VALIDATED = "validated", "Validated"
    APPROVED = "approved", "Approved"
    LOCKED = "locked", "Locked"


# Statuses whose numbers are official (brief rule: summaries use approved records only).
OFFICIAL_STATUSES = (RecordStatus.APPROVED, RecordStatus.LOCKED)


class InventoryRecord(BaseModel):
    """Stage counts for one crop stand in one round. Status changes only via surveys.services."""

    survey_round = models.ForeignKey(SurveyRound, on_delete=models.PROTECT, related_name="records")
    crop_stand = models.ForeignKey(
        "farms.CropStand", on_delete=models.PROTECT, related_name="inventory_records"
    )
    status = models.CharField(
        max_length=10, choices=RecordStatus.choices, default=RecordStatus.DRAFT, db_index=True
    )
    version = models.PositiveIntegerField(default=1)
    encoded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    submitted_at = models.DateTimeField(null=True, blank=True)
    validated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    validated_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    remarks = models.TextField(blank=True)
    # {"warnings": [...], "missing": [...], "source": "legacy_import", ...}
    flags = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["survey_round", "crop_stand"],
                condition=Q(deleted_at__isnull=True),
                name="uniq_record_per_round",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.survey_round} / {self.crop_stand_id} ({self.status})"


class StageCount(models.Model):
    inventory_record = models.ForeignKey(
        InventoryRecord, on_delete=models.CASCADE, related_name="stage_counts"
    )
    growth_stage = models.ForeignKey(
        "catalog.GrowthStage", on_delete=models.PROTECT, related_name="+"
    )
    count = models.PositiveIntegerField(null=True, blank=True)
    # Only for measure_type=area commodities; tree areas are derived (ADR-0004).
    area_ha = models.DecimalField(max_digits=10, decimal_places=4, null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["inventory_record", "growth_stage"], name="uniq_stage_count"
            ),
            models.CheckConstraint(
                condition=Q(count__isnull=True) | Q(count__gte=0), name="stage_count_non_negative"
            ),
            models.CheckConstraint(
                condition=Q(area_ha__isnull=True) | Q(area_ha__gte=0),
                name="stage_area_non_negative",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.growth_stage_id}: {self.count}"


class WorkflowComment(models.Model):
    inventory_record = models.ForeignKey(
        InventoryRecord, on_delete=models.CASCADE, related_name="comments"
    )
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    action = models.CharField(max_length=20)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"{self.action}: {self.body[:40]}"
