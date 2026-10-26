"""Farm, crop stand and planting writes. Scope is checked on the farm's barangay and, for crop
stands, on the commodity's program."""

from collections.abc import Iterable, Mapping
from typing import Any

from django.db import IntegrityError, transaction

from apps.accounts.models import User
from apps.accounts.roles import Cap
from apps.accounts.selectors import Scope, get_scope
from apps.audit import services as audit
from apps.catalog.models import Commodity, Variety
from apps.catalog.services import validate_attributes
from apps.registry.models import Farmer
from common.exceptions import DomainError
from common.scoping import require_reach
from common.text import collapse_spaces

from .models import CropStand, Farm, Planting

FARM_FIELDS = ("barangay", "sitio", "location", "declared_area_ha", "tenure", "location_raw")
STAND_FIELDS = ("spacing_m", "attributes")
PLANTING_FIELDS = ("year_planted", "source", "qty_planted", "notes")


def _require_farm_scope(scope: Scope, farm: Farm, program_id: Any = None) -> None:
    require_reach(
        scope, Cap.EDIT_RECORDS, field="barangay", barangay=farm.barangay, program_id=program_id
    )


@transaction.atomic
def create_farm(*, actor: User, farmer: Farmer, data: Mapping[str, Any]) -> Farm:
    scope = get_scope(actor)
    require_reach(scope, Cap.EDIT_RECORDS, field="farmer", barangay=farmer.home_barangay)
    values = {k: data[k] for k in FARM_FIELDS if k in data}
    if values.get("barangay") is None:
        raise DomainError(
            "barangay_required", "Choose the farm's barangay.", {"barangay": ["Required."]}
        )
    values["sitio"] = collapse_spaces(values.get("sitio"))
    farm = Farm(farmer=farmer, **values, created_by=actor, updated_by=actor)
    _require_farm_scope(scope, farm)
    farm.save()
    audit.record(
        actor=actor,
        action="farm.create",
        obj=farm,
        after=audit.mask(
            {"farmer": str(farmer.pk), **audit.snapshot(farm, FARM_FIELDS)}, Farm.PERSONAL_FIELDS
        ),
    )
    return farm


@transaction.atomic
def update_farm(*, actor: User, farm: Farm, data: Mapping[str, Any]) -> Farm:
    scope = get_scope(actor)
    _require_farm_scope(scope, farm)
    before = audit.snapshot(farm, FARM_FIELDS)
    for key in FARM_FIELDS:
        if key in data:
            setattr(farm, key, data[key])
    farm.sitio = collapse_spaces(farm.sitio)
    _require_farm_scope(scope, farm)
    farm.updated_by = actor
    farm.save()
    old, new = audit.changes(before, audit.snapshot(farm, FARM_FIELDS), Farm.PERSONAL_FIELDS)
    if new:
        audit.record(actor=actor, action="farm.update", obj=farm, before=old, after=new)
    return farm


@transaction.atomic
def delete_farm(*, actor: User, farm: Farm) -> None:
    _require_farm_scope(get_scope(actor), farm)
    if farm.crop_stands.exists():
        raise DomainError(
            "has_crop_stands", "Delete the farm's crop stands first.", status_code=409
        )
    farm.mark_deleted(actor)
    audit.record(actor=actor, action="farm.delete", obj=farm)


@transaction.atomic
def create_crop_stand(
    *, actor: User, farm: Farm, commodity: Commodity, data: Mapping[str, Any]
) -> CropStand:
    _require_farm_scope(get_scope(actor), farm, program_id=commodity.program_id)
    attributes = data.get("attributes") or {}
    validate_attributes(commodity, attributes)
    stand = CropStand(
        farm=farm,
        commodity=commodity,
        spacing_m=data.get("spacing_m"),
        attributes=attributes,
        created_by=actor,
        updated_by=actor,
    )
    try:
        with transaction.atomic():
            stand.save()
    except IntegrityError as exc:
        if "uniq_crop_stand" in str(exc):
            raise DomainError(
                "duplicate_crop_stand",
                f"This farm already has a {commodity.name} crop stand.",
                {"commodity": ["Already recorded on this farm."]},
                status_code=409,
            ) from None
        raise
    audit.record(
        actor=actor,
        action="crop_stand.create",
        obj=stand,
        after={
            "farm": str(farm.pk),
            "commodity": commodity.code,
            **audit.snapshot(stand, STAND_FIELDS),
        },
    )
    return stand


@transaction.atomic
def update_crop_stand(*, actor: User, stand: CropStand, data: Mapping[str, Any]) -> CropStand:
    _require_farm_scope(get_scope(actor), stand.farm, program_id=stand.commodity.program_id)
    before = audit.snapshot(stand, STAND_FIELDS)
    if "attributes" in data:
        validate_attributes(stand.commodity, data["attributes"] or {})
        stand.attributes = data["attributes"] or {}
    if "spacing_m" in data:
        stand.spacing_m = data["spacing_m"]
    stand.updated_by = actor
    stand.save()
    old, new = audit.changes(before, audit.snapshot(stand, STAND_FIELDS))
    if new:
        audit.record(actor=actor, action="crop_stand.update", obj=stand, before=old, after=new)
    return stand


@transaction.atomic
def delete_crop_stand(*, actor: User, stand: CropStand) -> None:
    _require_farm_scope(get_scope(actor), stand.farm, program_id=stand.commodity.program_id)
    if stand.plantings.exists():
        raise DomainError("has_plantings", "Delete the plantings first.", status_code=409)
    if hasattr(stand, "inventory_records") and stand.inventory_records.exists():
        raise DomainError(
            "has_inventory",
            "This crop stand has inventory records and cannot be deleted.",
            status_code=409,
        )
    stand.mark_deleted(actor)
    audit.record(actor=actor, action="crop_stand.delete", obj=stand)


def _check_varieties(stand: CropStand, varieties: Iterable[Variety]) -> list[Variety]:
    chosen = list(varieties)
    wrong = [v.code for v in chosen if v.commodity_id != stand.commodity_id]
    if wrong:
        raise DomainError(
            "variety_mismatch",
            f"Varieties must be {stand.commodity.name} varieties.",
            {"varieties": [f"Not a {stand.commodity.name} variety: {', '.join(wrong)}"]},
        )
    return chosen


def _planting_snapshot(planting: Planting) -> dict[str, Any]:
    snap = audit.snapshot(planting, PLANTING_FIELDS)
    snap["varieties"] = sorted(v.code for v in planting.varieties.all())
    return snap


@transaction.atomic
def create_planting(
    *,
    actor: User,
    stand: CropStand,
    data: Mapping[str, Any],
    varieties: Iterable[Variety] = (),
) -> Planting:
    _require_farm_scope(get_scope(actor), stand.farm, program_id=stand.commodity.program_id)
    chosen = _check_varieties(stand, varieties)
    planting = Planting(
        crop_stand=stand,
        **{k: data[k] for k in PLANTING_FIELDS if k in data},
        created_by=actor,
        updated_by=actor,
    )
    planting.save()
    planting.varieties.set(chosen)
    audit.record(
        actor=actor, action="planting.create", obj=planting, after=_planting_snapshot(planting)
    )
    return planting


@transaction.atomic
def update_planting(
    *,
    actor: User,
    planting: Planting,
    data: Mapping[str, Any],
    varieties: Iterable[Variety] | None = None,
) -> Planting:
    stand = planting.crop_stand
    _require_farm_scope(get_scope(actor), stand.farm, program_id=stand.commodity.program_id)
    before = _planting_snapshot(planting)
    for key in PLANTING_FIELDS:
        if key in data:
            setattr(planting, key, data[key])
    planting.updated_by = actor
    planting.save()
    if varieties is not None:
        planting.varieties.set(_check_varieties(stand, varieties))
    old, new = audit.changes(before, _planting_snapshot(planting))
    if new:
        audit.record(actor=actor, action="planting.update", obj=planting, before=old, after=new)
    return planting


@transaction.atomic
def delete_planting(*, actor: User, planting: Planting) -> None:
    stand = planting.crop_stand
    _require_farm_scope(get_scope(actor), stand.farm, program_id=stand.commodity.program_id)
    planting.mark_deleted(actor)
    audit.record(actor=actor, action="planting.delete", obj=planting)
