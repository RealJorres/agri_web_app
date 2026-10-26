"""Registry writes. Every change is scope-checked against the actor and audited (PII masked)."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.accounts.roles import Cap
from apps.accounts.selectors import get_scope
from apps.audit import services as audit
from apps.locations.models import Barangay
from common.exceptions import DomainError
from common.scoping import require_reach
from common.text import collapse_spaces

from .models import Association, AssociationMember, Farmer, FarmerStatus

FARMER_FIELDS = (
    "first_name",
    "middle_name",
    "last_name",
    "suffix",
    "full_name_raw",
    "sex",
    "birth_year",
    "rsbsa_no",
    "contact_no",
    "home_barangay",
    "status",
)
# Capturing these requires a recorded consent (privacy notice shown on the form).
CONSENT_FIELDS = ("rsbsa_no", "contact_no", "birth_year", "sex")
ASSOCIATION_FIELDS = (
    "name",
    "short_name",
    "type",
    "municipality",
    "registration_body",
    "registration_no",
)


def _clean_farmer_values(data: Mapping[str, Any]) -> dict[str, Any]:
    values = {k: data[k] for k in FARMER_FIELDS if k in data}
    for key in ("first_name", "middle_name", "last_name", "suffix", "full_name_raw"):
        if key in values:
            values[key] = collapse_spaces(values[key])
    if "rsbsa_no" in values:
        values["rsbsa_no"] = collapse_spaces(values["rsbsa_no"]).upper() or None
    if "contact_no" in values:
        values["contact_no"] = collapse_spaces(values["contact_no"])
    if "sex" in values and values["sex"] is None:
        values["sex"] = ""
    return values


def _check_name(farmer: Farmer) -> None:
    if not (farmer.first_name or farmer.last_name or farmer.full_name_raw):
        raise DomainError(
            "name_required", "Enter the farmer's name.", {"last_name": ["This field is required."]}
        )


def _save_farmer(farmer: Farmer) -> None:
    try:
        with transaction.atomic():
            farmer.save()
    except IntegrityError as exc:
        if "uniq_farmer_rsbsa" in str(exc):
            raise DomainError(
                "duplicate_rsbsa",
                "Another farmer already has this RSBSA number.",
                {"rsbsa_no": ["Already registered to another farmer."]},
                status_code=409,
            ) from None
        raise


def _apply_consent(farmer: Farmer, *, actor: User, consent_given: bool) -> None:
    if consent_given:
        farmer.consent_at = timezone.now()
        farmer.consent_by = actor
        return
    captured = [f for f in CONSENT_FIELDS if getattr(farmer, f) not in (None, "")]
    if captured and farmer.consent_at is None:
        raise DomainError(
            "consent_required",
            "Record the farmer's consent before saving contact or identity details.",
            {"consent_given": ["Consent is required for: " + ", ".join(captured)]},
        )


@transaction.atomic
def create_farmer(
    *,
    actor: User,
    data: Mapping[str, Any],
    consent_given: bool,
    require_consent: bool = True,
) -> Farmer:
    """Create a farmer. Office/field forms must capture consent (require_consent=True);
    legacy imports pass require_consent=False and leave consent_at empty."""
    scope = get_scope(actor)
    values = _clean_farmer_values(data)
    barangay: Barangay | None = values.get("home_barangay")
    if barangay is None:
        raise DomainError(
            "barangay_required", "Choose the home barangay.", {"home_barangay": ["Required."]}
        )
    require_reach(scope, Cap.EDIT_RECORDS, field="home_barangay", barangay=barangay)
    if require_consent and not consent_given:
        raise DomainError(
            "consent_required",
            "Show the privacy notice and record the farmer's consent.",
            {"consent_given": ["Consent is required to register a farmer."]},
        )
    farmer = Farmer(**values, created_by=actor, updated_by=actor)
    _check_name(farmer)
    if require_consent or consent_given:
        _apply_consent(farmer, actor=actor, consent_given=consent_given)
    _save_farmer(farmer)
    audit.record(
        actor=actor,
        action="farmer.create",
        obj=farmer,
        after=audit.mask(audit.snapshot(farmer, FARMER_FIELDS), Farmer.PERSONAL_FIELDS),
    )
    return farmer


@transaction.atomic
def update_farmer(
    *, actor: User, farmer: Farmer, data: Mapping[str, Any], consent_given: bool = False
) -> Farmer:
    scope = get_scope(actor)
    require_reach(scope, Cap.EDIT_RECORDS, field="home_barangay", barangay=farmer.home_barangay)
    before = audit.snapshot(farmer, FARMER_FIELDS)
    for key, value in _clean_farmer_values(data).items():
        setattr(farmer, key, value)
    require_reach(scope, Cap.EDIT_RECORDS, field="home_barangay", barangay=farmer.home_barangay)
    _check_name(farmer)
    _apply_consent(farmer, actor=actor, consent_given=consent_given)
    farmer.updated_by = actor
    _save_farmer(farmer)
    old, new = audit.changes(before, audit.snapshot(farmer, FARMER_FIELDS), Farmer.PERSONAL_FIELDS)
    if consent_given:
        new["consent_at"] = farmer.consent_at
    if new:
        audit.record(actor=actor, action="farmer.update", obj=farmer, before=old, after=new)
    return farmer


@transaction.atomic
def delete_farmer(*, actor: User, farmer: Farmer) -> None:
    require_reach(
        get_scope(actor), Cap.EDIT_RECORDS, field="home_barangay", barangay=farmer.home_barangay
    )
    if farmer.farms.exists():
        raise DomainError(
            "has_farms",
            "This farmer still has farms. Delete or merge them first.",
            status_code=409,
        )
    for membership in farmer.memberships.all():
        membership.mark_deleted(actor)
    farmer.mark_deleted(actor)
    audit.record(actor=actor, action="farmer.delete", obj=farmer)


@dataclass
class MergeResult:
    target: Farmer
    farms_moved: int = 0
    memberships_moved: int = 0
    fields_filled: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)  # field names where both had values


MERGE_FILL_FIELDS = ("middle_name", "suffix", "sex", "birth_year", "rsbsa_no", "contact_no")


@transaction.atomic
def merge_farmers(*, actor: User, target: Farmer, duplicate: Farmer) -> MergeResult:
    """Fold ``duplicate`` into ``target``: farms and memberships move, blank target fields are
    filled from the duplicate (target wins on conflicts), the duplicate is retired."""
    scope = get_scope(actor)
    for farmer, name in ((target, "target"), (duplicate, "duplicate")):
        require_reach(scope, Cap.MERGE_FARMERS, field=name, barangay=farmer.home_barangay)
    if target.pk == duplicate.pk:
        raise DomainError("merge_self", "Choose two different farmers.", status_code=400)
    target = Farmer.objects.select_for_update().get(pk=target.pk)
    duplicate = Farmer.objects.select_for_update().get(pk=duplicate.pk)

    result = MergeResult(target=target)
    result.farms_moved = duplicate.farms.update(farmer=target, updated_by=actor)
    existing = set(target.memberships.values_list("association_id", flat=True))
    for membership in duplicate.memberships.all():
        if membership.association_id in existing:
            membership.mark_deleted(actor)
        else:
            membership.farmer = target
            membership.save(update_fields=["farmer", "updated_at"])
            result.memberships_moved += 1

    moved_rsbsa = duplicate.rsbsa_no
    duplicate.rsbsa_no = None  # free the unique value before copying it
    duplicate.status = FarmerStatus.INACTIVE
    duplicate.merged_into = target
    duplicate.updated_by = actor
    duplicate.save()
    for name in MERGE_FILL_FIELDS:
        theirs = moved_rsbsa if name == "rsbsa_no" else getattr(duplicate, name)
        ours = getattr(target, name)
        if theirs in (None, ""):
            continue
        if ours in (None, ""):
            setattr(target, name, theirs)
            result.fields_filled.append(name)
        elif ours != theirs:
            result.conflicts.append(name)
    if target.consent_at is None and duplicate.consent_at is not None:
        target.consent_at, target.consent_by = duplicate.consent_at, duplicate.consent_by
    target.updated_by = actor
    _save_farmer(target)
    duplicate.mark_deleted(actor)

    summary = {
        "duplicate": str(duplicate.pk),
        "farms_moved": result.farms_moved,
        "memberships_moved": result.memberships_moved,
        "fields_filled": result.fields_filled,
        "conflicts": result.conflicts,
    }
    audit.record(actor=actor, action="farmer.merge", obj=target, after=summary)
    audit.record(
        actor=actor, action="farmer.merged_into", obj=duplicate, after={"target": str(target.pk)}
    )
    return result


@transaction.atomic
def erase_farmer_personal_data(*, actor: User, farmer: Farmer) -> Farmer:
    """RA 10173 erasure request: blank PII, keep anonymous inventory history (ADR-0006)."""
    require_reach(get_scope(actor), Cap.ADMIN, field="farmer", barangay=farmer.home_barangay)
    for name in ("first_name", "middle_name", "last_name", "suffix"):
        setattr(farmer, name, "")
    farmer.full_name_raw = "[erased]"
    farmer.sex = farmer.contact_no = ""
    farmer.birth_year = farmer.rsbsa_no = None
    farmer.status = FarmerStatus.INACTIVE
    farmer.updated_by = actor
    farmer.save()
    for farm in farmer.farms.all():
        farm.sitio, farm.location, farm.location_raw = "", None, ""
        farm.save(update_fields=["sitio", "location", "location_raw", "updated_at"])
    audit.record(actor=actor, action="farmer.erase", obj=farmer)
    return farmer


# --- Associations -----------------------------------------------------------------------------


def _save_association(association: Association) -> None:
    try:
        with transaction.atomic():
            association.save()
    except IntegrityError as exc:
        if "uniq_association_per_municipality" in str(exc):
            raise DomainError(
                "duplicate_association",
                "An association with this name already exists in the municipality.",
                {"name": ["Already exists in this municipality."]},
                status_code=409,
            ) from None
        raise


@transaction.atomic
def create_association(*, actor: User, data: Mapping[str, Any]) -> Association:
    values = {k: data[k] for k in ASSOCIATION_FIELDS if k in data}
    values["name"] = collapse_spaces(values.get("name"))
    if not values["name"]:
        raise DomainError("name_required", "Enter the association name.", {"name": ["Required."]})
    municipality = values.get("municipality")
    require_reach(
        get_scope(actor),
        Cap.EDIT_RECORDS,
        field="municipality",
        municipality_id=getattr(municipality, "pk", None),
    )
    association = Association(**values, created_by=actor, updated_by=actor)
    _save_association(association)
    audit.record(
        actor=actor,
        action="association.create",
        obj=association,
        after=audit.snapshot(association, ASSOCIATION_FIELDS),
    )
    return association


@transaction.atomic
def update_association(
    *, actor: User, association: Association, data: Mapping[str, Any]
) -> Association:
    scope = get_scope(actor)
    require_reach(
        scope, Cap.EDIT_RECORDS, field="municipality", municipality_id=association.municipality_id
    )
    before = audit.snapshot(association, ASSOCIATION_FIELDS)
    for key in ASSOCIATION_FIELDS:
        if key in data:
            setattr(association, key, data[key])
    association.name = collapse_spaces(association.name)
    require_reach(
        scope, Cap.EDIT_RECORDS, field="municipality", municipality_id=association.municipality_id
    )
    association.updated_by = actor
    _save_association(association)
    old, new = audit.changes(before, audit.snapshot(association, ASSOCIATION_FIELDS))
    if new:
        audit.record(
            actor=actor, action="association.update", obj=association, before=old, after=new
        )
    return association


@transaction.atomic
def delete_association(*, actor: User, association: Association) -> None:
    require_reach(
        get_scope(actor),
        Cap.EDIT_RECORDS,
        field="municipality",
        municipality_id=association.municipality_id,
    )
    if association.memberships.exists():
        raise DomainError(
            "has_members", "Remove the members before deleting the association.", status_code=409
        )
    association.mark_deleted(actor)
    audit.record(actor=actor, action="association.delete", obj=association)


@transaction.atomic
def add_member(
    *,
    actor: User,
    association: Association,
    farmer: Farmer,
    role: str = "",
    since: date | None = None,
) -> AssociationMember:
    scope = get_scope(actor)
    require_reach(
        scope, Cap.EDIT_RECORDS, field="association", municipality_id=association.municipality_id
    )
    require_reach(scope, Cap.EDIT_RECORDS, field="farmer", barangay=farmer.home_barangay)
    if association.memberships.filter(farmer=farmer).exists():
        raise DomainError(
            "already_member",
            "This farmer is already a member.",
            {"farmer": ["Already a member."]},
            status_code=409,
        )
    member = AssociationMember.objects.create(
        association=association,
        farmer=farmer,
        role=collapse_spaces(role),
        since=since,
        created_by=actor,
        updated_by=actor,
    )
    audit.record(
        actor=actor,
        action="association.add_member",
        obj=association,
        after={"farmer": str(farmer.pk), "role": member.role},
    )
    return member


@transaction.atomic
def remove_member(*, actor: User, member: AssociationMember) -> None:
    require_reach(
        get_scope(actor),
        Cap.EDIT_RECORDS,
        field="association",
        municipality_id=member.association.municipality_id,
    )
    member.mark_deleted(actor)
    audit.record(
        actor=actor,
        action="association.remove_member",
        obj=member.association,
        before={"farmer": str(member.farmer_id)},
    )
