from django.conf import settings
from django.db import models

from apps.imports.models import private_storage
from common.models import BaseModel

DEFAULT_LETTERHEAD = (
    "Republic of the Philippines\n"
    "Provincial Government of Marinduque\n"
    "PROVINCIAL AGRICULTURE OFFICE\n"
    "Capitol Compound, Santol, Boac, Marinduque"
)


class ReportKind(models.TextChoices):
    SUMMARY = "summary", "Provincial summary"
    MUNICIPAL_LIST = "municipal_list", "Municipal farmer list"


class ReportSettings(models.Model):
    """Single row (id=1) edited in Django admin: the letterhead on every official report."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    letterhead = models.TextField(default=DEFAULT_LETTERHEAD, help_text="One line per row.")
    program_line = models.CharField(
        max_length=200, default="HIGH VALUE CROPS DEVELOPMENT PROGRAM (HVCDP)", blank=True
    )
    logo = models.ImageField(upload_to="report-logo/", storage=private_storage, blank=True)

    class Meta:
        verbose_name_plural = "report settings"

    def __str__(self) -> str:
        return "Report settings"

    @classmethod
    def current(cls) -> "ReportSettings":
        return cls.objects.get_or_create(pk=1)[0]


class Signatory(BaseModel):
    """A signature block on a report, e.g. "Prepared by:" / name / title (ADR-0015)."""

    report_kind = models.CharField(max_length=20, choices=ReportKind.choices)
    order = models.PositiveSmallIntegerField(default=1)
    caption = models.CharField(max_length=60, help_text='e.g. "Prepared by:", "Noted:"')
    name = models.CharField(max_length=120)
    title = models.CharField(max_length=160, blank=True)

    class Meta:
        ordering = ["report_kind", "order"]
        verbose_name_plural = "signatories"

    def __str__(self) -> str:
        return f"{self.get_report_kind_display()}: {self.caption} {self.name}"


class ReportSignoff(BaseModel):
    """The provincial head's sign-off: who, when, and a hash of the report's content."""

    survey_round = models.ForeignKey(
        "surveys.SurveyRound", on_delete=models.PROTECT, related_name="report_signoffs"
    )
    report_kind = models.CharField(max_length=20, choices=ReportKind.choices)
    content_sha256 = models.CharField(max_length=64)
    signed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    signed_at = models.DateTimeField()

    class Meta:
        ordering = ["-signed_at"]

    def __str__(self) -> str:
        return f"{self.survey_round} {self.report_kind} signed {self.signed_at:%Y-%m-%d}"
