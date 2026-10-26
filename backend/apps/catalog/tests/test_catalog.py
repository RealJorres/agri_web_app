from types import SimpleNamespace

import pytest

from apps.catalog.models import Commodity, GrowthStage, MaterialSource, Variety
from apps.catalog.selectors import (
    AliasConflictError,
    AliasIndex,
    plants_per_ha,
    source_index,
    stage_index,
    variety_index,
)
from apps.catalog.services import check_attributes_schema, seed_catalog, validate_attributes
from common.exceptions import DomainError

pytestmark = pytest.mark.django_db


@pytest.fixture
def cacao():
    seed_catalog()
    return Commodity.objects.get(code="CACAO")


# Every single-token spelling from brief §3. Multi-value cells ("UF18 & BR25") are split by the
# import normalizers before they reach the index.
@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("BR25", "BR25"),
        ("BR 25", "BR25"),
        ("BR25 ", "BR25"),
        ("UF18", "UF18"),
        ("W10", "W10"),
        ("  W10", "W10"),
        ("Criollo", "CRIOLLO"),
        ("CriolIo", "CRIOLLO"),
        ("KI", "K1"),
        ("K1", "K1"),
        ("K18", None),
        ("K19", None),
        ("", None),
        (None, None),
    ],
)
def test_variety_aliases(cacao, raw, code):
    found = variety_index(cacao).resolve(raw)

    assert (found.code if found else None) == code


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("DA-RFO", "DA_RFO"),
        ("DA- RFO", "DA_RFO"),
        ("DA", "DA"),
        ("PCA", "PCA"),
        ("Own Produced", "OWN_PRODUCED"),
        ("Own Produce", "OWN_PRODUCED"),
        ("own produced ", "OWN_PRODUCED"),
        ("Purchased", "PURCHASED"),
        ("PS", None),
    ],
)
def test_source_aliases(cacao, raw, code):
    found = source_index().resolve(raw)

    assert (found.code if found else None) == code


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("SEEDLING", "SEEDLING"),
        ("GROWING", "SEEDLING"),
        ("Vegetative", "VEGETATIVE"),
        ("FLOWERING", "FLOWERING"),
        ("FRUITING", "FRUITING"),
    ],
)
def test_stage_aliases(cacao, raw, code):
    assert stage_index(cacao).resolve(raw).code == code


def test_cacao_configuration(cacao):
    stages = list(cacao.stages.order_by("sort_order").values_list("code", "is_bearing"))

    assert stages == [
        ("SEEDLING", False),
        ("VEGETATIVE", False),
        ("FLOWERING", False),
        ("FRUITING", True),
    ]
    assert cacao.program.code == "HVCDP"
    assert cacao.measure_type == "trees"
    assert cacao.plants_per_ha == 625


def test_area_from_province_total(cacao):
    """Brief §3: 81,712 trees at 625/ha = 130.74 ha (ADR-0004)."""
    assert round(81_712 / plants_per_ha(cacao), 2) == 130.74
    assert plants_per_ha(cacao, spacing_m=4) == 625
    assert plants_per_ha(cacao, spacing_m=3) == pytest.approx(1111.11, rel=1e-4)


def test_plants_per_ha_unknown():
    assert plants_per_ha(SimpleNamespace(plants_per_ha=None)) is None


def test_seed_is_idempotent_and_keeps_admin_aliases(cacao):
    br25 = Variety.objects.get(commodity=cacao, code="BR25")
    br25.aliases = [*br25.aliases, "BR-25 clone"]
    br25.save()

    seed_catalog()

    assert Commodity.objects.filter(code="CACAO").count() == 1
    assert GrowthStage.objects.filter(commodity=cacao).count() == 4
    assert MaterialSource.objects.count() == 5
    br25.refresh_from_db()
    assert "BR-25 clone" in br25.aliases
    assert br25.aliases.count("BR 25") == 1


def test_alias_conflict_is_detected():
    a = SimpleNamespace(code="A", aliases=["X"], name="Alpha")
    b = SimpleNamespace(code="B", aliases=["x "], name="Beta")

    with pytest.raises(AliasConflictError):
        AliasIndex([a, b])


def test_alias_index_len():
    assert len(AliasIndex([SimpleNamespace(code="A", aliases=["A1"], name="Alpha")])) == 3


def test_invalid_attributes_schema_rejected():
    with pytest.raises(DomainError) as info:
        check_attributes_schema({"type": "not-a-type"})

    assert info.value.code == "invalid_schema"


def test_empty_schema_is_allowed():
    check_attributes_schema({})


def test_validate_attributes(cacao):
    validate_attributes(cacao, {"shade_trees": True})

    with pytest.raises(DomainError) as info:
        validate_attributes(cacao, {"shade_trees": "yes", "colour": "brown"})

    assert set(info.value.fields) == {"attributes.shade_trees", "attributes"}


def test_validate_attributes_without_schema(cacao):
    cacao.attributes_schema = {}

    validate_attributes(cacao, {"anything": 1})
