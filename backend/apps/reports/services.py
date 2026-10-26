from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.accounts.roles import Cap
from apps.accounts.selectors import get_scope
from apps.audit import services as audit
from apps.surveys.models import RoundStatus, SurveyRound
from common.exceptions import DomainError
from common.scoping import require_reach

from . import content as report_content
from .models import ReportKind, ReportSignoff


@dataclass(frozen=True)
class SignoffStatus:
    signoff: ReportSignoff | None
    current_sha256: str

    @property
    def state(self) -> str:
        """unsigned | signed | superseded (figures changed after signing, e.g. a reopen)."""
        if self.signoff is None:
            return "unsigned"
        return "signed" if self.signoff.content_sha256 == self.current_sha256 else "superseded"


def province_scope() -> Any:
    from apps.imports.services import FULL_SCOPE

    return FULL_SCOPE


def signoff_status(survey_round: SurveyRound) -> SignoffStatus:
    """The province-wide summary is what gets signed, whatever the viewer's own scope."""
    current = report_content.content_hash(report_content.summary(survey_round, province_scope()))
    latest = ReportSignoff.objects.filter(
        survey_round=survey_round, report_kind=ReportKind.SUMMARY
    ).first()
    return SignoffStatus(latest, current)


@transaction.atomic
def sign_off_summary(*, actor: User, survey_round: SurveyRound) -> ReportSignoff:
    require_reach(
        get_scope(actor),
        Cap.SIGN_REPORTS,
        field="survey_round",
        program_id=survey_round.commodity.program_id,
    )
    if survey_round.status != RoundStatus.CLOSED:
        raise DomainError(
            "round_open", "Close the round before signing its report.", status_code=409
        )
    status = signoff_status(survey_round)
    if status.state == "signed":
        raise DomainError("already_signed", "This report is already signed.", status_code=409)
    signoff = ReportSignoff.objects.create(
        survey_round=survey_round,
        report_kind=ReportKind.SUMMARY,
        content_sha256=status.current_sha256,
        signed_by=actor,
        signed_at=timezone.now(),
        created_by=actor,
        updated_by=actor,
    )
    audit.record(
        actor=actor,
        action="report.sign_off",
        obj=signoff,
        after={"round": str(survey_round.pk), "sha256": signoff.content_sha256},
    )
    return signoff
