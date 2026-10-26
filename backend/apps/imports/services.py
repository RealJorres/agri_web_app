"""Import jobs: upload -> preview (validate, plan, reconcile) -> commit (one transaction).

Preview and commit both re-read the stored file, so the plan the user saw is exactly what is
committed, and nothing personal is kept outside the private file and the job summary."""

import datetime as dt
import logging
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.files.uploadedfile import UploadedFile
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.accounts.roles import Cap, Role
from apps.accounts.selectors import Grant, Scope, get_scope
from apps.analytics.services import schedule_refresh
from apps.audit import services as audit
from apps.audit.context import current_meta
from apps.audit.models import AuditLog
from apps.catalog.models import Commodity
from apps.catalog.selectors import stage_index
from apps.farms.models import CropStand, Farm, Planting
from apps.locations.models import Barangay, Municipality
from apps.production.models import Harvest
from apps.registry.models import Association, AssociationMember, Farmer, FarmerStatus
from apps.surveys.models import InventoryRecord, RecordStatus, StageCount, SurveyRound
from apps.surveys.selectors import stage_totals
from common.exceptions import DomainError
from common.scoping import can_reach
from common.text import normalize_name

from . import legacy_cacao_2023, legacy_plan
from .models import ImportJob, ImportKind, ImportRowLink, ImportStatus
from .uploads import check_upload

logger = logging.getLogger(__name__)

LEGACY_COMMODITY = "CACAO"
LEGACY_ROUND_NAME = "Cacao inventory - July 2023"
LEGACY_AS_OF = dt.date(2023, 7, 31)
SYSTEM_EMAIL = "system@agri-dms.invalid"
FULL_SCOPE = Scope(user_id=None, grants=(Grant(Role.SYSTEM_ADMIN, None, None),))


def system_user() -> User:
    """Inactive service account used as the actor for CLI imports (cannot log in)."""
    user, created = User.objects.get_or_create(
        email=SYSTEM_EMAIL,
        defaults={"is_active": False, "first_name": "System", "last_name": "Import"},
    )
    if created:
        user.set_unusable_password()
        user.save(update_fields=["password"])
    return user


# --- Jobs ---------------------------------------------------------------------------------------


@transaction.atomic
def create_job(
    *,
    actor: User,
    upload: UploadedFile[bytes],
    kind: str,
    survey_round: SurveyRound | None = None,
    enforce_scope: bool = True,
) -> ImportJob:
    if enforce_scope and not get_scope(actor).can(Cap.RUN_IMPORTS):
        raise DomainError("forbidden", "You are not allowed to run imports.", status_code=403)
    if kind == ImportKind.LEGACY_CACAO_2023:
        commodity = Commodity.objects.filter(code=LEGACY_COMMODITY).first()
        if commodity is None:
            raise DomainError(
                "catalog_missing", "Seed the catalog first (make seed).", status_code=409
            )
        allowed = {".xlsx"}
    else:
        if survey_round is None:
            raise DomainError(
                "round_required",
                "Choose the survey round to load into.",
                {"survey_round": ["Required."]},
            )
        if survey_round.status != "open":
            raise DomainError(
                "round_closed", "That round is closed.", {"survey_round": ["Closed."]}
            )
        commodity = survey_round.commodity
        allowed = {".xlsx", ".csv"}
    name = Path(upload.name or "upload").name
    stream: Any = upload.file
    digest = check_upload(name, upload.size or 0, stream, allowed)
    job = ImportJob(
        uploaded_by=actor,
        kind=kind,
        original_name=name[:255],
        file_sha256=digest,
        file_size=upload.size or 0,
        commodity=commodity,
        survey_round=survey_round,
        created_by=actor,
        updated_by=actor,
    )
    job.file.save(f"{digest[:16]}{Path(name).suffix.lower()}", upload, save=False)
    job.save()
    audit.record(
        actor=actor,
        action="import.upload",
        obj=job,
        after={"kind": kind, "size": job.file_size, "sha256": digest},
    )
    return job


def _set_status(job: ImportJob, status: str, **fields: Any) -> None:
    job.status = status
    for key, value in fields.items():
        setattr(job, key, value)
    job.save(update_fields=["status", "updated_at", *fields])


def run_preview(job: ImportJob) -> ImportJob:
    """Validate and plan the upload; store the preview in job.summary. Never writes records."""
    _set_status(job, ImportStatus.VALIDATING, error_message="")
    try:
        if job.kind == ImportKind.LEGACY_CACAO_2023:
            summary = _legacy_summary(_legacy_plan(job))
        else:
            from . import template

            summary, report = template.preview(job)
            if report is not None:
                job.error_report.save(f"{job.pk}-errors.xlsx", report, save=False)
        already = ImportRowLink.objects.filter(file_sha256=job.file_sha256).exists()
        summary["already_imported"] = already
        _set_status(job, ImportStatus.READY, summary=summary, error_report=job.error_report)
    except DomainError as exc:
        _set_status(job, ImportStatus.FAILED, error_message=exc.message)
    except Exception:
        logger.exception("Import preview failed for job %s", job.pk)  # no cell values logged
        _set_status(job, ImportStatus.FAILED, error_message="The file could not be read.")
    return job


def commit_job(
    *,
    job: ImportJob,
    actor: User,
    association_overrides: dict[str, str] | None = None,
    enforce_scope: bool = True,
) -> ImportJob:
    """Create everything the preview showed, in one transaction (all or nothing)."""
    with transaction.atomic():
        job = ImportJob.objects.select_for_update().get(pk=job.pk)
        if job.status != ImportStatus.READY:
            raise DomainError(
                "not_ready", f"This import is {job.get_status_display().lower()}.", status_code=409
            )
        if enforce_scope:
            _check_commit_rights(job, actor)
        _set_status(job, ImportStatus.COMMITTING)
    try:
        with transaction.atomic():
            if job.kind == ImportKind.LEGACY_CACAO_2023:
                result = _commit_legacy(job, _legacy_plan(job, association_overrides), actor)
            else:
                from . import template

                result = template.commit(job, actor)
            audit.record(actor=actor, action="import.commit", obj=job, after=result)
            schedule_refresh()
            summary = {**job.summary, "commit": result}
            _set_status(
                job,
                ImportStatus.COMMITTED,
                summary=summary,
                committed_at=timezone.now(),
                committed_by=actor,
            )
    except DomainError as exc:
        _set_status(job, ImportStatus.FAILED, error_message=exc.message)
        raise
    except Exception:
        logger.exception("Import commit failed for job %s", job.pk)
        _set_status(job, ImportStatus.FAILED, error_message="The import failed; nothing was saved.")
        raise
    return job


def _check_commit_rights(job: ImportJob, actor: User) -> None:
    scope = get_scope(actor)
    needed = [Cap.RUN_IMPORTS]
    if job.kind == ImportKind.LEGACY_CACAO_2023:
        needed.append(Cap.APPROVE)  # legacy rows are imported as approved (ADR-0013 §9)
    program_id = job.commodity.program_id if job.commodity else None
    for municipality_id in _job_municipalities(job):
        for cap in needed:
            if not can_reach(scope, cap, municipality_id=municipality_id, program_id=program_id):
                raise DomainError(
                    "forbidden",
                    "This file contains municipalities or a program outside your assignment.",
                    status_code=403,
                )


def _job_municipalities(job: ImportJob) -> Iterable[Any]:
    names = set(job.summary.get("municipalities", []))
    return Municipality.objects.filter(name__in=names).values_list("pk", flat=True)


@transaction.atomic
def purge_old_files(now: dt.datetime | None = None) -> int:
    """Delete stored files of finished jobs after IMPORT_FILE_RETENTION_DAYS (ADR-0009)."""
    cutoff = (now or timezone.now()) - dt.timedelta(days=settings.IMPORT_FILE_RETENTION_DAYS)
    jobs = ImportJob.objects.filter(
        status__in=[ImportStatus.COMMITTED, ImportStatus.FAILED],
        updated_at__lt=cutoff,
        files_purged_at__isnull=True,
    )
    purged = 0
    for job in jobs:
        for f in (job.file, job.error_report):
            if f:
                f.delete(save=False)
        job.files_purged_at = timezone.now()
        job.save(update_fields=["file", "error_report", "files_purged_at", "updated_at"])
        purged += 1
    return purged


# --- Legacy (2023 cacao workbook) ---------------------------------------------------------------


def _legacy_plan(
    job: ImportJob, association_overrides: dict[str, str] | None = None
) -> legacy_plan.LegacyPlan:
    commodity = job.commodity
    assert commodity is not None  # noqa: S101 - set at upload
    workbook = legacy_cacao_2023.read_workbook(
        Path(job.file.path),
        list(Municipality.objects.values_list("name", flat=True)),
        stage_index(commodity).resolve,
    )
    if not workbook.sheets:
        raise DomainError("no_sheets", "No municipal sheets were found in this workbook.")
    return legacy_plan.build_plan(workbook, commodity, association_overrides)


def _legacy_summary(plan: legacy_plan.LegacyPlan) -> dict[str, Any]:
    return {
        "municipalities": sorted({r.municipality for r in plan.rows}),
        "counts": plan.counts,
        "review": plan.review,
        "decisions": plan.decisions,
        "reconciliation": plan.reconciliation,
        "sheet_issues": plan.sheet_issues,
        "errors": [],
    }


class _Cache:
    def __init__(self) -> None:
        self.barangays = {(b.municipality_id, b.normalized_name): b for b in Barangay.objects.all()}
        self.associations = {
            (a.municipality_id, a.normalized_name): a for a in Association.objects.all()
        }
        self.farmers: dict[tuple[str, str, str], Farmer] = {}
        self.new_barangays = 0
        self.new_associations = 0

    def barangay(
        self, municipality: Municipality, name: str, actor: User, create: bool
    ) -> Barangay | None:
        key = (municipality.pk, normalize_name(name))
        found = self.barangays.get(key)
        if found is None and create and name:
            found = Barangay.objects.create(
                municipality=municipality,
                name=name,
                is_verified=False,
                created_by=actor,
                updated_by=actor,
            )
            self.barangays[key] = found
            self.new_barangays += 1
        return found

    def association(
        self, municipality: Municipality, choice: legacy_plan.AssociationChoice, actor: User
    ) -> Association:
        if choice.existing_id:
            return Association.objects.get(pk=choice.existing_id)
        key = (municipality.pk, normalize_name(choice.canonical))
        found = self.associations.get(key)
        if found is None:
            found = Association.objects.create(
                name=choice.canonical, municipality=municipality, created_by=actor, updated_by=actor
            )
            self.associations[key] = found
            self.new_associations += 1
        return found


def _commit_legacy(job: ImportJob, plan: legacy_plan.LegacyPlan, actor: User) -> dict[str, Any]:
    commodity = job.commodity
    assert commodity is not None  # noqa: S101
    survey_round, round_created = SurveyRound.objects.get_or_create(
        commodity=commodity,
        name=LEGACY_ROUND_NAME,
        defaults={
            "as_of_date": LEGACY_AS_OF,
            "is_historical": True,
            "created_by": actor,
            "updated_by": actor,
        },
    )
    if round_created:
        audit.record(actor=actor, action="round.open", obj=survey_round, after={"historical": True})

    linked = set(
        ImportRowLink.objects.filter(file_sha256=job.file_sha256).values_list("sheet", "row")
    )
    municipalities = {m.name: m for m in Municipality.objects.all()}
    stages = {s.code: s for s in commodity.stages.all()}
    cache = _Cache()
    now = timezone.now()
    tally: Counter[str] = Counter()
    created_ids: dict[str, list[str]] = {"farmer": [], "record": []}

    # Pass 1: every home barangay in the file exists before FARM LOCATION is matched, so the
    # result does not depend on row order.
    for p in plan.rows:
        if (p.sheet, p.row) not in linked and p.home_barangay:
            cache.barangay(municipalities[p.municipality], p.home_barangay, actor, create=True)

    for p in plan.rows:
        if (p.sheet, p.row) in linked:
            tally["rows_already_imported"] += 1
            continue
        municipality = municipalities[p.municipality]
        home = cache.barangay(municipality, p.home_barangay or p.farm_barangay, actor, create=True)
        if home is None:
            tally["rows_skipped_no_barangay"] += 1
            continue

        farmer = cache.farmers.get(p.identity)
        if farmer is None:
            farmer = Farmer(
                first_name=p.name.first,
                middle_name=p.name.middle,
                last_name=p.name.last,
                suffix=p.name.suffix,
                full_name_raw=p.full_name_raw,
                contact_no=p.contact,
                home_barangay=home,
                status=FarmerStatus.NEEDS_REVIEW if p.incomplete else FarmerStatus.ACTIVE,
                created_by=actor,
                updated_by=actor,
            )
            farmer.save()
            cache.farmers[p.identity] = farmer
            created_ids["farmer"].append(str(farmer.pk))
            tally["farmers"] += 1
        for choice in p.associations:
            association = cache.association(municipality, choice, actor)
            _, made = AssociationMember.objects.get_or_create(
                farmer=farmer,
                association=association,
                defaults={"created_by": actor, "updated_by": actor},
            )
            tally["memberships"] += made

        farm_barangay = cache.barangay(municipality, p.farm_barangay, actor, create=False) or home
        farm = Farm.objects.create(
            farmer=farmer,
            barangay=farm_barangay,
            location_raw=p.location_raw,
            created_by=actor,
            updated_by=actor,
        )
        stand = CropStand.objects.create(
            farm=farm, commodity=commodity, created_by=actor, updated_by=actor
        )
        tally["farms"] += 1
        tally["plantings"] += _create_plantings(stand, p, actor)

        approved = not p.incomplete
        record = InventoryRecord.objects.create(
            survey_round=survey_round,
            crop_stand=stand,
            status=RecordStatus.APPROVED if approved else RecordStatus.DRAFT,
            encoded_by=actor,
            approved_by=actor if approved else None,
            approved_at=now if approved else None,
            remarks=p.remarks,
            flags={
                "source": "legacy_import",
                "import_job": str(job.pk),
                "sheet": p.sheet,
                "row": p.row,
                "below_total": p.incomplete,
                "missing": p.missing,
                "issues": p.issues,
                "raw": {
                    "variety": p.raw_variety,
                    "source": p.raw_source,
                    "date_planted": p.raw_date,
                },
            },
            created_by=actor,
            updated_by=actor,
        )
        StageCount.objects.bulk_create(
            StageCount(inventory_record=record, growth_stage=stages[code], count=value)
            for code, value in p.counts.items()
            if value is not None and code in stages
        )
        created_ids["record"].append(str(record.pk))
        tally["records_approved" if approved else "records_draft"] += 1
        for h in p.harvests:
            Harvest.objects.create(
                crop_stand=stand,
                harvest_date=None,
                date_estimated=True,
                quantity=h.quantity,
                unit=h.unit,
                product_form=h.product_form,
                raw_text=h.raw_text + (" (recurring)" if h.recurring else ""),
                created_by=actor,
                updated_by=actor,
            )
            tally["harvests"] += 1
        ImportRowLink.objects.create(
            file_sha256=job.file_sha256,
            sheet=p.sheet,
            row=p.row,
            job=job,
            farmer=farmer,
            farm=farm,
            crop_stand=stand,
            record=record,
        )

    _audit_created(actor, job, created_ids)
    tally["new_barangays"] = cache.new_barangays
    tally["new_associations"] = cache.new_associations
    totals = stage_totals(survey_round, FULL_SCOPE)
    return {
        **tally,
        "survey_round": str(survey_round.pk),
        "official_total": sum(t.count for t in totals),
        "official_by_municipality": {
            m: {t.stage_code: t.count for t in totals if t.municipality == m}
            for m in sorted({t.municipality for t in totals})
        },
    }


def _create_plantings(stand: CropStand, p: legacy_plan.PlannedRow, actor: User) -> int:
    """ADR-0013 §2: one planting per year; source only when unambiguous."""
    years: list[int | None] = list(p.years) or ([None] if (p.varieties or p.sources) else [])
    source = p.sources[0] if len(p.sources) == 1 else None
    notes = []
    if len(p.sources) > 1:
        notes.append("Sources: " + ", ".join(s.name for s in p.sources))
    if len(p.years) > 1 and (len(p.varieties) > 1 or len(p.sources) > 1):
        notes.append(
            f"Legacy cells - variety: '{p.raw_variety}', source: '{p.raw_source}', "
            f"planted: '{p.raw_date}' (per-year breakdown unknown)"
        )
    for year in years:
        planting = Planting.objects.create(
            crop_stand=stand,
            year_planted=year,
            source=source,
            notes="; ".join(notes),
            created_by=actor,
            updated_by=actor,
        )
        if p.varieties:
            planting.varieties.set(p.varieties)
    return len(years)


def _audit_created(actor: User, job: ImportJob, ids: dict[str, list[str]]) -> None:
    meta = current_meta()
    labels = {"farmer": Farmer._meta.label_lower, "record": InventoryRecord._meta.label_lower}
    AuditLog.objects.bulk_create(
        AuditLog(
            actor=actor,
            action=f"{kind if kind != 'record' else 'inventory'}.import",
            object_type=labels[kind],
            object_id=pk,
            after={"import_job": str(job.pk)},
            ip=meta.ip,
            user_agent=meta.user_agent,
        )
        for kind, pks in ids.items()
        for pk in pks
    )
