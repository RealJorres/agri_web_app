from collections.abc import Iterable
from typing import Any

from django.db.models import QuerySet

from common.text import normalize_code

from .models import Commodity, GrowthStage, MaterialSource, Program, Variety


class AliasConflictError(ValueError):
    pass


class AliasIndex[T]:
    """Exact lookup by normalized code, name/label or alias of catalog rows. Never fuzzy: unknown
    values return None and go to the import review list (brief §6 "Never guess")."""

    def __init__(self, items: Iterable[T]) -> None:
        self._by_key: dict[str, T] = {}
        for item in items:
            row: Any = item
            keys = {row.code, *row.aliases}
            name = getattr(row, "name", None) or getattr(row, "label", None)
            if name:
                keys.add(name)
            for key in filter(None, (normalize_code(k) for k in keys)):
                existing: Any = self._by_key.get(key)
                if existing is not None and existing is not item:
                    raise AliasConflictError(f"'{key}' maps to both {existing.code} and {row.code}")
                self._by_key[key] = item

    def resolve(self, raw: str | None) -> T | None:
        return self._by_key.get(normalize_code(raw)) if raw else None

    def __len__(self) -> int:
        return len(self._by_key)


def programs() -> QuerySet[Program]:
    return Program.objects.order_by("code")


def commodities() -> QuerySet[Commodity]:
    return Commodity.objects.select_related("program").order_by("name")


def stages_for(commodity: Commodity) -> QuerySet[GrowthStage]:
    return GrowthStage.objects.filter(commodity=commodity).order_by("sort_order")


def varieties(commodity: Commodity | None = None) -> QuerySet[Variety]:
    qs = Variety.objects.select_related("commodity")
    return qs.filter(commodity=commodity) if commodity else qs


def material_sources() -> QuerySet[MaterialSource]:
    return MaterialSource.objects.order_by("code")


def variety_index(commodity: Commodity) -> AliasIndex[Variety]:
    return AliasIndex(varieties(commodity))


def stage_index(commodity: Commodity) -> AliasIndex[GrowthStage]:
    return AliasIndex(stages_for(commodity))


def source_index() -> AliasIndex[MaterialSource]:
    return AliasIndex(material_sources())


def plants_per_ha(commodity: Commodity, spacing_m: float | None = None) -> float | None:
    """Plants per hectare: from a stand's spacing override (square planting), else the commodity's
    configured density (ADR-0004)."""
    if spacing_m:
        return 10_000 / (float(spacing_m) ** 2)
    return float(commodity.plants_per_ha) if commodity.plants_per_ha else None
