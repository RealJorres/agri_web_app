"""Boundary loader and map endpoints. Files are synthetic squares with made-up codes (region 99)."""

import json
from io import StringIO

import pytest
from django.contrib.gis.geos import MultiPolygon, Polygon
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.locations.boundaries import load_boundaries
from common.exceptions import DomainError

from .factories import BarangayFactory, MunicipalityFactory

pytestmark = pytest.mark.django_db


def square(lon=121.9, lat=13.4, size=0.1):
    return [
        [
            [lon, lat],
            [lon + size, lat],
            [lon + size, lat + size],
            [lon, lat + size],
            [lon, lat],
        ]
    ]


def feature(properties, coordinates=None, kind="Polygon"):
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {"type": kind, "coordinates": coordinates or square()},
    }


@pytest.fixture
def write(tmp_path):
    def _write(*features, name="shapes.geojson", **extra):
        path = tmp_path / name
        path.write_text(
            json.dumps({"type": "FeatureCollection", "features": list(features), **extra}),
            encoding="utf-8",
        )
        return path

    return _write


def load(path, level="municipality", **kwargs):
    return load_boundaries(path, level=level, province="Synthetic Province", **kwargs)


def test_loads_by_name_and_strips_parenthetical(write):
    town = MunicipalityFactory(name="Alpha Town")
    path = write(feature({"ADM3_EN": "Alpha Town (Capital)", "ADM2_EN": "Synthetic Province"}))

    report = load(path)

    town.refresh_from_db()
    assert report.loaded == ["Alpha Town"]
    assert isinstance(town.boundary, MultiPolygon)
    assert town.boundary.srid == 4326


def test_code_match_wins_over_a_different_name(write):
    town = MunicipalityFactory(name="Alpha Town", psgc_code="9904001000")
    path = write(feature({"PSGC": "9904001000", "NAME": "Spelled Differently"}))

    assert load(path).loaded == ["Alpha Town"]
    town.refresh_from_db()
    assert town.boundary is not None


def test_other_provinces_are_ignored_even_with_the_same_name(write):
    town = MunicipalityFactory(name="Alpha Town")
    path = write(
        feature({"ADM3_EN": "Alpha Town", "ADM2_EN": "Another Province"}, square(lon=120.0)),
        feature({"ADM3_EN": "Alpha Town", "ADM2_EN": "Synthetic Province"}),
    )

    report = load(path)

    town.refresh_from_db()
    assert report.features_outside_province == 1
    assert town.boundary.extent[0] == pytest.approx(121.9)


def test_repeated_rows_of_one_province_merge_into_one_area(write):
    town = MunicipalityFactory(name="Alpha Town")
    path = write(
        feature({"ADM3_EN": "Alpha Town", "ADM2_EN": "Synthetic Province"}),
        feature({"ADM3_EN": "Alpha Town", "ADM2_EN": "Synthetic Province"}, square(lon=122.2)),
    )

    load(path)

    town.refresh_from_db()
    assert len(town.boundary) == 2


def test_repeated_name_without_a_province_attribute_is_not_guessed(write):
    town = MunicipalityFactory(name="Alpha Town")
    path = write(
        feature({"NAME": "Alpha Town"}),
        feature({"NAME": "Alpha Town"}, square(lon=120.0)),
    )

    report = load(path)

    town.refresh_from_db()
    assert town.boundary is None
    assert report.ambiguous == ["Alpha Town"]


def test_barangay_uses_parent_to_separate_same_names(write):
    alpha = BarangayFactory(name="Poblacion", municipality=MunicipalityFactory(name="Alpha Town"))
    beta = BarangayFactory(name="Poblacion", municipality=MunicipalityFactory(name="Beta Town"))
    path = write(
        feature(
            {"ADM4_EN": "Poblacion", "ADM3_EN": "Beta Town", "ADM2_EN": "Synthetic Province"},
        )
    )

    report = load(path, level="barangay")

    alpha.refresh_from_db()
    beta.refresh_from_db()
    assert report.loaded == ["Poblacion, Beta Town"]
    assert alpha.boundary is None
    assert beta.boundary is not None


def test_barangay_name_alone_is_ambiguous_across_municipalities(write):
    BarangayFactory(name="Poblacion", municipality=MunicipalityFactory(name="Alpha Town"))
    BarangayFactory(name="Poblacion", municipality=MunicipalityFactory(name="Beta Town"))
    path = write(feature({"BARANGAY": "Poblacion"}))

    report = load(path, level="barangay")

    assert report.loaded == []
    assert report.ambiguous == ["Poblacion"]


def test_reports_unmatched_and_areas_left_without_a_shape(write):
    MunicipalityFactory(name="Alpha Town")
    path = write(feature({"NAME": "Nowhere"}))

    report = load(path)

    assert report.unmatched == ["Nowhere"]
    assert "Alpha Town" in report.without_shape


def test_shape_outside_the_philippines_is_refused(write):
    town = MunicipalityFactory(name="Alpha Town")
    path = write(feature({"NAME": "Alpha Town"}, square(lon=10.0, lat=50.0)))

    report = load(path)

    town.refresh_from_db()
    assert report.invalid == ["Alpha Town"]
    assert town.boundary is None


def test_swapped_coordinates_are_refused(write):
    town = MunicipalityFactory(name="Alpha Town")
    path = write(feature({"NAME": "Alpha Town"}, square(lon=13.4, lat=121.9)))

    assert load(path).invalid == ["Alpha Town"]
    town.refresh_from_db()
    assert town.boundary is None


def test_projected_coordinates_are_converted_to_wgs84(write):
    town = MunicipalityFactory(name="Alpha Town")
    # UTM zone 51N: roughly 121.9 E, 13.4 N.
    x, y = 380000, 1481000
    coordinates = [[[x, y], [x + 1000, y], [x + 1000, y + 1000], [x, y + 1000], [x, y]]]
    path = write(
        feature({"NAME": "Alpha Town"}, coordinates),
        crs={"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::32651"}},
    )

    report = load(path)

    town.refresh_from_db()
    assert report.loaded == ["Alpha Town"]
    west, south, _, _ = town.boundary.extent
    assert 121.5 < west < 122.5
    assert 13.0 < south < 13.8


def test_self_intersecting_shape_is_repaired(write):
    town = MunicipalityFactory(name="Alpha Town")
    bowtie = [
        [[121.9, 13.4], [122.0, 13.5], [122.0, 13.4], [121.9, 13.5], [121.9, 13.4]],
    ]
    path = write(feature({"NAME": "Alpha Town"}, bowtie))

    load(path)

    town.refresh_from_db()
    assert town.boundary.valid


def test_dry_run_changes_nothing_and_writes_no_audit(write):
    town = MunicipalityFactory(name="Alpha Town")
    report = load(write(feature({"NAME": "Alpha Town"})), dry_run=True)

    town.refresh_from_db()
    assert report.loaded == ["Alpha Town"]
    assert town.boundary is None
    assert not AuditLog.objects.filter(action="boundaries.load").exists()


def test_load_is_audited_without_coordinates(write):
    MunicipalityFactory(name="Alpha Town")
    load(write(feature({"NAME": "Alpha Town"})))

    entry = AuditLog.objects.get(action="boundaries.load")
    assert entry.after["loaded"] == 1
    assert "coordinates" not in json.dumps(entry.after)


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"level": "province"}, "boundary_level"),
        ({"level": "municipality", "name_field": "MISSING"}, "boundary_field"),
    ],
)
def test_bad_arguments(write, kwargs, code):
    path = write(feature({"NAME": "Alpha Town"}))

    with pytest.raises(DomainError) as exc:
        load_boundaries(path, province="Synthetic Province", **kwargs)

    assert exc.value.code == code


def test_file_with_no_usable_attribute_names_what_it_has(write):
    with pytest.raises(DomainError) as exc:
        load(write(feature({"WIDGET": "x"})))

    assert "WIDGET" in exc.value.message


def test_rejects_unsupported_file_type(tmp_path):
    path = tmp_path / "shapes.csv"
    path.write_text("a,b\n", encoding="utf-8")

    with pytest.raises(DomainError) as exc:
        load(path)

    assert exc.value.code == "boundary_file"


def test_command_reports_and_fails_cleanly(write):
    MunicipalityFactory(name="Alpha Town")
    out = StringIO()

    call_command(
        "seed_boundaries",
        file=write(feature({"NAME": "Alpha Town"})),
        level="municipality",
        province="Synthetic Province",
        stdout=out,
    )

    assert "Boundaries loaded: 1" in out.getvalue()
    with pytest.raises(CommandError):
        call_command(
            "seed_boundaries",
            "--file=missing.geojson",
            "--level=municipality",
            "--province=Synthetic Province",
        )


# --- Map endpoints -------------------------------------------------------------------------------


def _with_shape(**kwargs):
    return MunicipalityFactory(
        boundary=MultiPolygon(Polygon(square()[0]), srid=4326),
        **kwargs,
    )


def test_boundaries_endpoint_returns_geojson(auth_client):
    town = _with_shape(name="Alpha Town")
    MunicipalityFactory(name="No Shape Yet")

    response = auth_client(user_with_role(Role.VIEWER)).get("/api/v1/map/boundaries")

    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert [f["properties"] for f in body["features"]] == [
        {"id": str(town.pk), "name": "Alpha Town"}
    ]
    # Simplifying may unwrap a one-part shape; MapLibre draws either.
    assert body["features"][0]["geometry"]["type"] in ("Polygon", "MultiPolygon")


def test_boundaries_endpoint_filters_barangays_by_municipality(auth_client):
    shape = MultiPolygon(Polygon(square()[0]), srid=4326)
    wanted = BarangayFactory(name="Wanted", boundary=shape)
    BarangayFactory(name="Elsewhere", boundary=shape)

    response = auth_client(user_with_role(Role.VIEWER)).get(
        "/api/v1/map/boundaries",
        {"level": "barangay", "municipality": str(wanted.municipality_id)},
    )

    assert [f["properties"]["name"] for f in response.json()["features"]] == ["Wanted"]


def test_map_config_reports_tiles_and_loaded_counts(auth_client, settings):
    settings.MAP_TILE_URL = "https://tiles.example.test/{z}/{x}/{y}.png"
    _with_shape(name="Alpha Town")

    body = auth_client(user_with_role(Role.VIEWER)).get("/api/v1/map/config").json()

    assert body["tile_url"] == settings.MAP_TILE_URL
    assert body["municipality_boundaries"] == 1
    assert body["barangay_boundaries"] == 0


@pytest.mark.parametrize("url", ["/api/v1/map/config", "/api/v1/map/boundaries"])
def test_map_endpoints_need_a_login(api_client, url):
    assert api_client.get(url).status_code == 401
