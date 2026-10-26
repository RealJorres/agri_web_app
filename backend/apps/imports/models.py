from django.conf import settings
from django.core.files.storage import FileSystemStorage
from django.db import models

from common.models import BaseModel


def private_storage() -> FileSystemStorage:
    """Uploaded workbooks and error reports contain personal data: never publicly served
    (ADR-0009). Files are reachable only through authenticated, scoped, audited endpoints."""
    return FileSystemStorage(location=settings.PRIVATE_MEDIA_ROOT, base_url=None)


class ImportKind(models.TextChoices):
    TEMPLATE = "template", "Clean template"
    LEGACY_CACAO_2023 = "legacy_cacao_2023", "Legacy cacao workbook (2023)"


class ImportStatus(models.TextChoices):
    UPLOADED = "uploaded", "Uploaded"
    VALIDATING = "validating", "Validating"
    READY = "ready", "Ready to commit"
    COMMITTING = "committing", "Committing"
    COMMITTED = "committed", "Committed"
    FAILED = "failed", "Failed"


class ImportJob(BaseModel):
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="import_jobs"
    )
    kind = models.CharField(max_length=30, choices=ImportKind.choices)
    status = models.CharField(
        max_length=12, choices=ImportStatus.choices, default=ImportStatus.UPLOADED, db_index=True
    )
    file = models.FileField(upload_to="imports/%Y/%m/", storage=private_storage, blank=True)
    original_name = models.CharField(max_length=255)
    file_sha256 = models.CharField(max_length=64, db_index=True)
    file_size = models.PositiveIntegerField(default=0)
    commodity = models.ForeignKey(
        "catalog.Commodity", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    # Template imports load into this (open) round.
    survey_round = models.ForeignKey(
        "surveys.SurveyRound", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    # Preview + commit results: counts, row errors/warnings, normalization decisions,
    # review list, reconciliation. Contains raw cell values -> treated as personal data.
    summary = models.JSONField(default=dict, blank=True)
    error_report = models.FileField(
        upload_to="import-errors/%Y/%m/", storage=private_storage, null=True, blank=True
    )
    error_message = models.TextField(blank=True)
    committed_at = models.DateTimeField(null=True, blank=True)
    committed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    files_purged_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.get_kind_display()}: {self.original_name} ({self.status})"


class ImportRowLink(models.Model):
    """What one source row created. Makes re-importing the same file a no-op (brief §10.A.8)."""

    file_sha256 = models.CharField(max_length=64)
    sheet = models.CharField(max_length=100)
    row = models.PositiveIntegerField()
    job = models.ForeignKey(ImportJob, on_delete=models.PROTECT, related_name="row_links")
    farmer = models.ForeignKey(
        "registry.Farmer", null=True, on_delete=models.PROTECT, related_name="+"
    )
    farm = models.ForeignKey("farms.Farm", null=True, on_delete=models.PROTECT, related_name="+")
    crop_stand = models.ForeignKey(
        "farms.CropStand", null=True, on_delete=models.PROTECT, related_name="+"
    )
    record = models.ForeignKey(
        "surveys.InventoryRecord", null=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["file_sha256", "sheet", "row"], name="uniq_import_row")
        ]

    def __str__(self) -> str:
        return f"{self.sheet}!{self.row}"
