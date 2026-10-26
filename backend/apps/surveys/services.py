"""Survey rounds and the inventory workflow (brief §8). The only code that changes record status.

draft -> submitted -> validated -> approved -> locked (on round close)
returns: submitted -> draft (validator), validated -> draft (coordinator); reopen: approved/locked
-> draft (coordinator, version + 1). Every transition is scope-checked, row-locked and audited.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.accounts.roles import Cap
from apps.accounts.selectors import Scope, get_scope
from apps.audit import services as audit
from apps.audit.context import current_meta
from apps.audit.models import AuditLog
from apps.catalog.models import Commodity, GrowthStage
from apps.farms.models import CropStand
from common.exceptions import DomainError
from common.scoping import can_reach, require_reach

from . import rules
from .models import (
    InventoryRecord,
    RecordStatus,
    RoundStatus,
    StageCount,
    SurveyRound,
    WorkflowComment,
)

S = RecordStatus


@dataclass(frozen=True)
class Transition:
    action: str
    sources: frozenset[str]
    target: str
    capability: Cap
    comment_required: bool = False


TRANSITIONS: dict[str, Transition] = {
    t.action: t
    for t in (
        Transition("submit", frozenset({S.DRAFT}), S.SUBMITTED, Cap.SUBMIT),
        Transition("validate", frozenset({S.SUBMITTED}), S.VALIDATED, Cap.VALIDATE),
        Transition("approve", frozenset({S.VALIDATED}), S.APPROVED, Cap.APPROVE),
        Transition("return_submitted", frozenset({S.SUBMITTED}), S.DRAFT, Cap.VALIDATE, True),
        Transition("return_validated", frozenset({S.VALIDATED}), S.DRAFT, Cap.APPROVE, True),
        Transition("reopen", frozenset({S.APPROVED, S.LOCKED}), S.DRAFT, Cap.REOPEN, True),
    )
}
# The API exposes one "return" action; which rule applies depends on the current status.
RETURN_BY_STATUS = {S.SUBMITTED: "return_submitted", S.VALIDATED: "return_validated"}


@dataclass(frozen=True)
class CountInput:
    growth_stage: GrowthStage
    count: int | None = None
    area_ha: Decimal | None = None


# --- Permissions helpers ----------------------------------------------------------------------


def _reach(scope: Scope, capability: Cap, record: InventoryRecord) -> bool:
    stand = record.crop_stand
    return can_reach(
        scope, capability, barangay=stand.farm.barangay, program_id=stand.commodity.program_id
    )


def _round_accepts_changes(record: InventoryRecord) -> bool:
    # Reopened records (version > 1) may be corrected even after the round has closed.
    return record.survey_round.status == RoundStatus.OPEN or record.version > 1


def can_edit(scope: Scope, record: InventoryRecord) -> bool:
    if record.status == S.DRAFT:
        return _round_accepts_changes(record) and _reach(scope, Cap.EDIT_RECORDS, record)
    if record.status == S.SUBMITTED:  # MAO validator may correct before validating
        return _reach(scope, Cap.VALIDATE, record)
    return False


def allowed_actions(scope: Scope, record: InventoryRecord) -> list[str]:
    """Actions the user can take now, for the UI (the services re-check everything)."""
    actions = ["edit"] if can_edit(scope, record) else []
    for name, t in TRANSITIONS.items():
        if record.status not in t.sources or not _reach(scope, t.capability, record):
            continue
        if name == "submit" and not _round_accepts_changes(record):
            continue
        actions.append("return" if name.startswith("return_") else name)
    return actions


# --- Rounds -------------------------------------------------------------------------------------


@transaction.atomic
def open_round(
    *,
    actor: User,
    commodity: Commodity,
    name: str,
    as_of_date: date,
    deadline: date | None = None,
    is_historical: bool = False,
) -> SurveyRound:
    require_reach(
        get_scope(actor), Cap.MANAGE_ROUNDS, field="commodity", program_id=commodity.program_id
    )
    try:
        with transaction.atomic():
            survey_round = SurveyRound.objects.create(
                commodity=commodity,
                name=name.strip(),
                as_of_date=as_of_date,
                deadline=deadline,
                is_historical=is_historical,
                created_by=actor,
                updated_by=actor,
            )
    except IntegrityError:
        raise DomainError(
            "duplicate_round",
            "A round with this name already exists for the commodity.",
            {"name": ["Already used."]},
            status_code=409,
        ) from None
    audit.record(
        actor=actor,
        action="round.open",
        obj=survey_round,
        after={"name": survey_round.name, "commodity": commodity.code, "as_of": as_of_date},
    )
    return survey_round


@transaction.atomic
def close_round(*, actor: User, survey_round: SurveyRound) -> int:
    """Close the round and lock its approved records. Returns how many were locked.

    Refuses while records are awaiting review, so nothing is silently left half-way."""
    require_reach(
        get_scope(actor),
        Cap.MANAGE_ROUNDS,
        field="survey_round",
        program_id=survey_round.commodity.program_id,
    )
    survey_round = SurveyRound.objects.select_for_update().get(pk=survey_round.pk)
    if survey_round.status == RoundStatus.CLOSED:
        raise DomainError("round_closed", "This round is already closed.", status_code=409)
    pending = survey_round.records.filter(status__in=[S.SUBMITTED, S.VALIDATED]).count()
    if pending:
        raise DomainError(
            "pending_records",
            f"{pending} records are still awaiting validation or approval.",
            {"records": [f"{pending} pending"]},
            status_code=409,
        )
    to_lock = list(
        survey_round.records.select_for_update()
        .filter(status=S.APPROVED)
        .values_list("pk", flat=True)
    )
    InventoryRecord.objects.filter(pk__in=to_lock).update(
        status=S.LOCKED, updated_at=timezone.now(), updated_by=actor
    )
    _audit_many(actor, "inventory.lock", to_lock, {"status": S.APPROVED}, {"status": S.LOCKED})
    survey_round.status = RoundStatus.CLOSED
    survey_round.closed_at = timezone.now()
    survey_round.closed_by = actor
    survey_round.updated_by = actor
    survey_round.save()
    audit.record(
        actor=actor, action="round.close", obj=survey_round, after={"locked": len(to_lock)}
    )
    return len(to_lock)


def _audit_many(
    actor: User, action: str, ids: Iterable[Any], before: dict[str, Any], after: dict[str, Any]
) -> None:
    meta = current_meta()
    AuditLog.objects.bulk_create(
        AuditLog(
            actor=actor,
            action=action,
            object_type=InventoryRecord._meta.label_lower,
            object_id=str(pk),
            before=before,
            after=after,
            ip=meta.ip,
            user_agent=meta.user_agent,
        )
        for pk in ids
    )


# --- Records ------------------------------------------------------------------------------------


def _counts_snapshot(record: InventoryRecord) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for c in record.stage_counts.select_related("growth_stage"):
        out[c.growth_stage.code] = c.count if c.area_ha is None else str(c.area_ha)
    return out


def _record_snapshot(record: InventoryRecord) -> dict[str, Any]:
    return {"counts": _counts_snapshot(record), "remarks": record.remarks}


def _write_counts(record: InventoryRecord, counts: Iterable[CountInput]) -> None:
    """Replace the record's stage counts with ``counts`` (the full set for the form)."""
    items = list(counts)
    commodity_id = record.crop_stand.commodity_id
    seen: set[Any] = set()
    for item in items:
        if item.growth_stage.commodity_id != commodity_id:
            raise DomainError(
                "stage_mismatch",
                "A stage does not belong to this crop.",
                {"counts": [f"{item.growth_stage.code} is not a stage of this commodity."]},
            )
        if item.growth_stage.pk in seen:
            raise DomainError(
                "duplicate_stage", "Each stage can appear once.", {"counts": ["Duplicate stage."]}
            )
        seen.add(item.growth_stage.pk)
        for value in (item.count, item.area_ha):
            if value is not None and value < 0:
                raise DomainError(
                    "negative_count",
                    "Counts cannot be negative.",
                    {f"counts.{item.growth_stage.code}": ["Must be 0 or more."]},
                )
    record.stage_counts.exclude(growth_stage_id__in=seen).delete()
    for item in items:
        StageCount.objects.update_or_create(
            inventory_record=record,
            growth_stage=item.growth_stage,
            defaults={"count": item.count, "area_ha": item.area_ha},
        )


@transaction.atomic
def create_record(
    *,
    actor: User,
    survey_round: SurveyRound,
    crop_stand: CropStand,
    counts: Iterable[CountInput] = (),
    remarks: str = "",
) -> InventoryRecord:
    scope = get_scope(actor)
    require_reach(
        scope,
        Cap.EDIT_RECORDS,
        field="crop_stand",
        barangay=crop_stand.farm.barangay,
        program_id=crop_stand.commodity.program_id,
    )
    if survey_round.status != RoundStatus.OPEN:
        raise DomainError("round_closed", "This round is closed.", status_code=409)
    if crop_stand.commodity_id != survey_round.commodity_id:
        raise DomainError(
            "commodity_mismatch",
            f"This round is for {survey_round.commodity.name}.",
            {"crop_stand": ["Different commodity from the round."]},
        )
    try:
        with transaction.atomic():
            record = InventoryRecord.objects.create(
                survey_round=survey_round,
                crop_stand=crop_stand,
                remarks=remarks.strip(),
                encoded_by=actor,
                created_by=actor,
                updated_by=actor,
            )
    except IntegrityError:
        raise DomainError(
            "duplicate_record",
            "This crop stand already has a record in this round.",
            {"crop_stand": ["Already recorded in this round."]},
            status_code=409,
        ) from None
    _write_counts(record, counts)
    audit.record(actor=actor, action="inventory.create", obj=record, after=_record_snapshot(record))
    return record


@transaction.atomic
def update_record(
    *,
    actor: User,
    record: InventoryRecord,
    counts: Iterable[CountInput] | None = None,
    remarks: str | None = None,
) -> InventoryRecord:
    record = _locked(record)
    if not can_edit(get_scope(actor), record):
        raise DomainError(
            "not_editable",
            f"A {record.get_status_display().lower()} record cannot be edited by you.",
            status_code=409 if _reach(get_scope(actor), Cap.EDIT_RECORDS, record) else 403,
        )
    before = _record_snapshot(record)
    if counts is not None:
        _write_counts(record, counts)
    if remarks is not None:
        record.remarks = remarks.strip()
    record.updated_by = actor
    record.save()
    old, new = audit.changes(before, _record_snapshot(record))
    if new:
        audit.record(actor=actor, action="inventory.update", obj=record, before=old, after=new)
    return record


@transaction.atomic
def delete_record(*, actor: User, record: InventoryRecord) -> None:
    record = _locked(record)
    if record.status != S.DRAFT or not can_edit(get_scope(actor), record):
        raise DomainError(
            "not_editable", "Only your draft records can be deleted.", status_code=409
        )
    record.mark_deleted(actor)
    audit.record(
        actor=actor, action="inventory.delete", obj=record, before=_record_snapshot(record)
    )


def _locked(record: InventoryRecord) -> InventoryRecord:
    return (
        InventoryRecord.objects.select_for_update(of=("self",))
        .select_related("survey_round", "crop_stand__commodity", "crop_stand__farm__barangay")
        .get(pk=record.pk)
    )


def _transition(
    *, actor: User, record: InventoryRecord, action: str, comment: str = ""
) -> InventoryRecord:
    t = TRANSITIONS[action]
    record = _locked(record)
    scope = get_scope(actor)
    if not _reach(scope, t.capability, record):
        raise DomainError(
            "forbidden", "You are not allowed to do this for this record.", status_code=403
        )
    if record.status not in t.sources:
        raise DomainError(
            "invalid_transition",
            f"Cannot {action.split('_')[0]} a {record.get_status_display().lower()} record.",
            status_code=409,
        )
    comment = comment.strip()
    if t.comment_required and not comment:
        raise DomainError(
            "comment_required", "Please explain why in a comment.", {"comment": ["Required."]}
        )

    before = {"status": record.status, "version": record.version}
    now = timezone.now()
    record.status = t.target
    if action == "submit":
        record.submitted_at = now
    elif action == "validate":
        record.validated_by, record.validated_at = actor, now
    elif action == "approve":
        record.approved_by, record.approved_at = actor, now
        if record.survey_round.status == RoundStatus.CLOSED:
            record.status = S.LOCKED  # corrections approved after close are locked at once
    elif action == "reopen":
        record.version += 1
    if t.target == S.DRAFT:  # returned or reopened: clear review stamps (history is audited)
        record.submitted_at = record.validated_at = record.approved_at = None
        record.validated_by = record.approved_by = None
    record.updated_by = actor
    record.save()
    if comment:
        WorkflowComment.objects.create(
            inventory_record=record, author=actor, action=action.split("_")[0], body=comment
        )
    audit.record(
        actor=actor,
        action=f"inventory.{action.split('_')[0]}",
        obj=record,
        before=before,
        after={"status": record.status, "version": record.version, "comment": bool(comment)},
    )
    return record


@transaction.atomic
def submit(*, actor: User, record: InventoryRecord, comment: str = "") -> InventoryRecord:
    """Run validation rules: errors block, warnings are stored in record.flags."""
    record = _locked(record)
    if not _round_accepts_changes(record):
        raise DomainError("round_closed", "This round is closed.", status_code=409)
    if record.status in TRANSITIONS["submit"].sources and _reach(
        get_scope(actor), Cap.SUBMIT, record
    ):
        issues = rules.evaluate(record)
        errors = [i for i in issues if i.level == "error"]
        if errors:
            fields: dict[str, list[str]] = {}
            for issue in errors:
                fields.setdefault(issue.field or "non_field_errors", []).append(issue.message)
            raise DomainError(
                "validation_failed", "Please fix the errors before submitting.", fields
            )
        record.flags = {
            **record.flags,
            "warnings": [i.as_dict() for i in issues if i.level == "warning"],
            "checked_at": timezone.now().isoformat(),
        }
        record.save(update_fields=["flags", "updated_at"])
    return _transition(actor=actor, record=record, action="submit", comment=comment)


def validate(*, actor: User, record: InventoryRecord, comment: str = "") -> InventoryRecord:
    return _transition(actor=actor, record=record, action="validate", comment=comment)


def approve(*, actor: User, record: InventoryRecord, comment: str = "") -> InventoryRecord:
    return _transition(actor=actor, record=record, action="approve", comment=comment)


def return_record(*, actor: User, record: InventoryRecord, comment: str) -> InventoryRecord:
    action = RETURN_BY_STATUS.get(record.status)  # type: ignore[call-overload]
    if action is None:
        raise DomainError(
            "invalid_transition",
            f"Cannot return a {record.get_status_display().lower()} record.",
            status_code=409,
        )
    return _transition(actor=actor, record=record, action=action, comment=comment)


def reopen(*, actor: User, record: InventoryRecord, comment: str) -> InventoryRecord:
    return _transition(actor=actor, record=record, action="reopen", comment=comment)
