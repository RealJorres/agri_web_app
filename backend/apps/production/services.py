from collections.abc import Mapping
from typing import Any

from django.db import transaction

from apps.accounts.models import User
from apps.accounts.roles import Cap
from apps.accounts.selectors import get_scope
from apps.audit import services as audit
from apps.farms.models import CropStand
from common.scoping import require_reach

from .models import Harvest

HARVEST_FIELDS = (
    "harvest_date",
    "date_estimated",
    "quantity",
    "unit",
    "product_form",
    "price_per_unit",
    "buyer",
    "raw_text",
)


def _require(actor: User, stand: CropStand) -> None:
    require_reach(
        get_scope(actor),
        Cap.EDIT_RECORDS,
        field="crop_stand",
        barangay=stand.farm.barangay,
        program_id=stand.commodity.program_id,
    )


@transaction.atomic
def create_harvest(*, actor: User, stand: CropStand, data: Mapping[str, Any]) -> Harvest:
    _require(actor, stand)
    values = {k: data[k] for k in HARVEST_FIELDS if k in data}
    if values.get("harvest_date") is None:
        values["date_estimated"] = True
    harvest = Harvest.objects.create(crop_stand=stand, **values, created_by=actor, updated_by=actor)
    audit.record(
        actor=actor,
        action="harvest.create",
        obj=harvest,
        after=audit.mask(audit.snapshot(harvest, HARVEST_FIELDS), ["buyer"]),
    )
    return harvest


@transaction.atomic
def update_harvest(*, actor: User, harvest: Harvest, data: Mapping[str, Any]) -> Harvest:
    _require(actor, harvest.crop_stand)
    before = audit.snapshot(harvest, HARVEST_FIELDS)
    for key in HARVEST_FIELDS:
        if key in data:
            setattr(harvest, key, data[key])
    harvest.updated_by = actor
    harvest.save()
    old, new = audit.changes(before, audit.snapshot(harvest, HARVEST_FIELDS), ["buyer"])
    if new:
        audit.record(actor=actor, action="harvest.update", obj=harvest, before=old, after=new)
    return harvest


@transaction.atomic
def delete_harvest(*, actor: User, harvest: Harvest) -> None:
    _require(actor, harvest.crop_stand)
    harvest.mark_deleted(actor)
    audit.record(actor=actor, action="harvest.delete", obj=harvest)
