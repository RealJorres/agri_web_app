from dataclasses import dataclass, field
from typing import Any

from django.db import transaction
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from common.exceptions import DomainError

from .models import Commodity, GrowthStage, MaterialSource, Program, Unit, Variety
from .seed_data import COMMODITIES, MATERIAL_SOURCES, PROGRAMS, UNITS
from .selectors import AliasIndex


def check_attributes_schema(schema: dict[str, Any]) -> None:
    """Reject a commodity.attributes_schema that is not valid JSON Schema (2020-12)."""
    if not schema:
        return
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        raise DomainError(
            "invalid_schema",
            "The attributes schema is not valid JSON Schema.",
            {"attributes_schema": [exc.message]},
        ) from None


def validate_attributes(commodity: Commodity, attributes: dict[str, Any]) -> None:
    """Validate crop_stand.attributes against the commodity's schema; errors keyed by JSON path."""
    if not commodity.attributes_schema:
        return
    validator = Draft202012Validator(commodity.attributes_schema)
    errors: dict[str, list[str]] = {}
    for error in validator.iter_errors(attributes):
        path = ".".join(str(p) for p in error.absolute_path)
        key = f"attributes.{path}" if path else "attributes"
        errors.setdefault(key, []).append(error.message)
    if errors:
        raise DomainError("invalid_attributes", "Some crop attributes are invalid.", errors)


# --- Seeding: idempotent. Re-running updates seeded fields and adds missing aliases, but never
# removes aliases or rows added by administrators.


@dataclass
class SeedReport:
    created: dict[str, int] = field(default_factory=dict)
    updated: dict[str, int] = field(default_factory=dict)

    def count(self, model: type, created: bool) -> None:
        bucket = self.created if created else self.updated
        bucket[model.__name__] = bucket.get(model.__name__, 0) + 1


def _merge_aliases(existing: list[str], seeded: list[str]) -> list[str]:
    return existing + [a for a in seeded if a not in existing]


def _upsert(
    model: type[Any], lookup: dict[str, Any], values: dict[str, Any], report: SeedReport
) -> Any:
    aliases = values.pop("aliases", None)
    obj, created = model.objects.update_or_create(**lookup, defaults=values)
    if aliases is not None:
        merged = _merge_aliases(obj.aliases, aliases)
        if merged != obj.aliases:
            obj.aliases = merged
            obj.save(update_fields=["aliases", "updated_at"])
    report.count(model, created)
    return obj


@transaction.atomic
def seed_catalog() -> SeedReport:
    report = SeedReport()
    programs = {
        p["code"]: _upsert(Program, {"code": p["code"]}, {"name": p["name"]}, report)
        for p in PROGRAMS
    }
    for spec in COMMODITIES:
        spec = dict(spec)
        stages, varieties = spec.pop("stages"), spec.pop("varieties")
        check_attributes_schema(spec["attributes_schema"])
        program = programs[spec.pop("program")]
        commodity = _upsert(
            Commodity, {"code": spec.pop("code")}, {**spec, "program": program}, report
        )
        for stage in stages:
            stage = dict(stage)
            _upsert(GrowthStage, {"commodity": commodity, "code": stage.pop("code")}, stage, report)
        for variety in varieties:
            variety = dict(variety)
            _upsert(Variety, {"commodity": commodity, "code": variety.pop("code")}, variety, report)
        # Fail the seed (and roll back) if any alias is ambiguous.
        AliasIndex(commodity.stages.all())
        AliasIndex(commodity.varieties.all())
    for source in MATERIAL_SOURCES:
        source = dict(source)
        _upsert(MaterialSource, {"code": source.pop("code")}, source, report)
    AliasIndex(MaterialSource.objects.all())
    for unit in UNITS:
        unit = dict(unit)
        _upsert(Unit, {"code": unit.pop("code")}, unit, report)
    return report
