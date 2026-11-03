"""Load official municipality/barangay boundaries from a PAO-supplied file (ADR-0016).

Shapes are only ever taken from the file, and a feature is only applied when it can be tied to one
location without guessing: by PSGC code, or by name inside the requested province. Everything else
is reported for a person to resolve.
"""

import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from django.contrib.gis.gdal import DataSource, GDALException
from django.contrib.gis.gdal.feature import Feature
from django.contrib.gis.geos import GEOSGeometry, MultiPolygon, Polygon
from django.db import transaction

from apps.audit import services as audit
from common.exceptions import DomainError
from common.text import collapse_spaces, normalize_name

from .models import Barangay, Municipality

MUNICIPALITY, BARANGAY = "municipality", "barangay"
LEVELS = (MUNICIPALITY, BARANGAY)
SUPPORTED_SUFFIXES = {".geojson", ".json", ".shp"}
# Every location served is in the Philippines; anything else means a wrong coordinate system.
PH_BBOX = (116.0, 4.0, 127.0, 22.0)

# Attribute names used by the usual sources (OCHA/NAMRIA COD, GADM, PSA exports), most specific
# first. Any of them can be overridden from the command line.
CODE_FIELDS = {
    MUNICIPALITY: ("adm3_pcode", "psgc", "psgc_code", "mun_code", "code"),
    BARANGAY: ("adm4_pcode", "psgc", "psgc_code", "bgy_code", "brgy_code", "code"),
}
NAME_FIELDS = {
    MUNICIPALITY: ("adm3_en", "name_2", "municipality", "municipal", "mun_name", "name"),
    BARANGAY: ("adm4_en", "name_3", "barangay", "brgy_name", "bgy_name", "name"),
}
PARENT_FIELDS = ("adm3_en", "name_2", "municipality", "municipal", "mun_name")
PROVINCE_FIELDS = ("adm2_en", "name_1", "province", "prov_name")

_PARENTHETICAL = re.compile(r"\s*\(.*?\)\s*")
_NON_DIGITS = re.compile(r"\D")


@dataclass
class BoundaryReport:
    level: str
    features_read: int = 0
    features_outside_province: int = 0
    loaded: list[str] = field(default_factory=list)
    # In the file, but not tied to one location in the database.
    unmatched: list[str] = field(default_factory=list)
    ambiguous: list[str] = field(default_factory=list)
    invalid: list[str] = field(default_factory=list)
    # In the database (and in the province), with no shape from this file.
    without_shape: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class FieldNames:
    code: str | None
    name: str | None
    parent: str | None
    province: str | None


def _pick(available: dict[str, str], explicit: str | None, candidates: tuple[str, ...]) -> Any:
    if explicit:
        found = available.get(explicit.lower())
        if found is None:
            raise DomainError("boundary_field", f"The file has no attribute named '{explicit}'.")
        return found
    return next((available[c] for c in candidates if c in available), None)


def _resolve_fields(
    layer_fields: list[str],
    level: str,
    code_field: str | None,
    name_field: str | None,
    parent_field: str | None,
    province_field: str | None,
) -> FieldNames:
    available = {name.lower(): name for name in layer_fields}
    names = FieldNames(
        code=_pick(available, code_field, CODE_FIELDS[level]),
        name=_pick(available, name_field, NAME_FIELDS[level]),
        parent=_pick(available, parent_field, PARENT_FIELDS) if level == BARANGAY else None,
        province=_pick(available, province_field, PROVINCE_FIELDS),
    )
    if names.code is None and names.name is None:
        listed = ", ".join(layer_fields)
        raise DomainError(
            "boundary_field",
            f"No code or name attribute recognised. The file has: {listed}. "
            "Name them with --code-field / --name-field.",
        )
    return names


def _text(feature: Feature, name: str | None) -> str:
    if name is None:
        return ""
    value = feature.get(name)
    return "" if value is None else collapse_spaces(str(value))


def _name_key(raw: str) -> str:
    """'Boac (Capital)' -> 'boac'."""
    return normalize_name(_PARENTHETICAL.sub(" ", raw))


def _code_key(raw: str) -> str:
    return _NON_DIGITS.sub("", raw)


def _multipolygon(feature: Feature) -> MultiPolygon | None:
    """The feature's shape as a valid WGS84 multipolygon inside the Philippines, or None."""
    try:
        geom = feature.geom
        geom.transform(4326)
        shape: GEOSGeometry = geom.geos
    except GDALException:
        return None
    if not shape.valid:
        shape = shape.make_valid()
    polygons = _polygons(shape)
    if not polygons:
        return None
    result = MultiPolygon(*polygons, srid=4326)
    west, south, east, north = result.extent
    if west < PH_BBOX[0] or south < PH_BBOX[1] or east > PH_BBOX[2] or north > PH_BBOX[3]:
        return None
    return result


def _polygons(shape: Any) -> list[Polygon]:
    if isinstance(shape, Polygon):
        return [shape]
    # make_valid() can return a collection holding stray lines; keep only the areas.
    if shape.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [part for child in shape for part in _polygons(child)]
    return []


def _open_layer(path: Path) -> Any:
    if not path.exists():
        raise DomainError("boundary_file", f"File not found: {path.name}")
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise DomainError("boundary_file", "Use a GeoJSON file or a shapefile (.shp).")
    try:
        source = DataSource(str(path))
    except GDALException:
        raise DomainError("boundary_file", f"Could not read {path.name}.") from None
    layer = source[0]
    if path.suffix.lower() == ".shp" and layer.srs is None:
        raise DomainError(
            "boundary_crs",
            "The shapefile has no coordinate system (.prj). Ask for the complete shapefile.",
        )
    return source, layer


def _in_province(
    feature: Feature, names: FieldNames, province: str, report: BoundaryReport
) -> bool:
    if names.province is None:
        return True
    if _name_key(_text(feature, names.province)) == normalize_name(province):
        return True
    report.features_outside_province += 1
    return False


def _label(feature: Feature, names: FieldNames) -> str:
    parts = [_text(feature, names.name), _text(feature, names.parent), _text(feature, names.code)]
    return " / ".join(p for p in parts if p) or "(unnamed feature)"


@transaction.atomic
def load_boundaries(
    path: Path,
    *,
    level: str,
    province: str,
    code_field: str | None = None,
    name_field: str | None = None,
    parent_field: str | None = None,
    province_field: str | None = None,
    dry_run: bool = False,
) -> BoundaryReport:
    """Set Municipality/Barangay.boundary from the file. Audited; replaces earlier shapes."""
    if level not in LEVELS:
        raise DomainError("boundary_level", f"Level must be one of {', '.join(LEVELS)}.")
    _source, layer = _open_layer(path)  # the layer is only valid while its source is referenced
    names = _resolve_fields(
        list(layer.fields), level, code_field, name_field, parent_field, province_field
    )

    targets: list[Any]
    if level == MUNICIPALITY:
        targets = list(Municipality.objects.all())
    else:
        targets = list(Barangay.objects.select_related("municipality"))
    by_code = {t.psgc_code: t for t in targets if t.psgc_code}
    by_name: dict[tuple[str, str], list[Any]] = defaultdict(list)
    for target in targets:
        # A barangay is findable with its municipality or, when the file has no such attribute,
        # by name alone (several hits then count as ambiguous).
        by_name[("", target.normalized_name)].append(target)
        if level == BARANGAY:
            by_name[(target.municipality.normalized_name, target.normalized_name)].append(target)

    report = BoundaryReport(level=level)
    shapes: dict[Any, list[MultiPolygon]] = defaultdict(list)
    matched: dict[Any, Any] = {}
    named_rows: dict[Any, int] = defaultdict(int)

    for feature in layer:
        report.features_read += 1
        if not _in_province(feature, names, province, report):
            continue
        label = _label(feature, names)
        target = by_code.get(_code_key(_text(feature, names.code)))
        if target is None:
            parent_key = _name_key(_text(feature, names.parent))
            found = by_name.get((parent_key, _name_key(_text(feature, names.name))), [])
            if len(found) > 1:
                report.ambiguous.append(label)
                continue
            if not found:
                report.unmatched.append(label)
                continue
            target = found[0]
            named_rows[target.pk] += 1
        shape = _multipolygon(feature)
        if shape is None:
            report.invalid.append(label)
            continue
        matched[target.pk] = target
        shapes[target.pk].append(shape)

    for pk, target in matched.items():
        # A file with no province attribute may hold same-named places from other provinces, so
        # repeated names cannot be assumed to be parts of one area. Codes need no such caution.
        if names.province is None and named_rows[pk] > 1:
            report.ambiguous.append(str(target))
            continue
        target.boundary = _merge(shapes[pk])
        target.save(update_fields=["boundary", "updated_at"])
        report.loaded.append(str(target))

    report.without_shape = sorted(
        str(t) for t in targets if t.pk not in matched and _expected(t, level)
    )
    report.loaded.sort()
    audit.record(
        actor=None,
        action="boundaries.load",
        object_type=f"locations.{level}",
        after={
            "file": path.name,
            "loaded": len(report.loaded),
            "unmatched": len(report.unmatched),
            "ambiguous": len(report.ambiguous),
            "invalid": len(report.invalid),
        },
    )
    if dry_run:
        transaction.set_rollback(True)
    return report


def _expected(target: Any, level: str) -> bool:
    # Barangays created by an import may be misspellings; only verified ones are expected to match.
    return level == MUNICIPALITY or bool(target.is_verified)


def _merge(parts: list[MultiPolygon]) -> MultiPolygon:
    polygons = [polygon for part in parts for polygon in part]
    return MultiPolygon(*polygons, srid=4326)
