"""Catalog seed for Phase 1 (cacao under HVCDP). Adding a crop = adding an entry here or in admin.

Aliases are the raw spellings observed in the 2023 workbook (brief §3). Codes that are not listed
here (e.g. K18, K19, "PS") are deliberately left unknown so the import sends them to review.
"""

from decimal import Decimal
from typing import Any

PROGRAMS: list[dict[str, str]] = [
    {"code": "HVCDP", "name": "High Value Crops Development Program"},
]

COMMODITIES: list[dict[str, Any]] = [
    {
        "program": "HVCDP",
        "code": "CACAO",
        "name": "Cacao",
        "measure_type": "trees",
        "spacing_m": Decimal("4.00"),
        "plants_per_ha": 625,  # 4 m x 4 m planting distance
        "outlier_multiplier": Decimal(5),
        "attributes_schema": {
            "type": "object",
            "properties": {
                "intercropped_with": {"type": "string", "maxLength": 200},
                "shade_trees": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
        "stages": [
            {"code": "SEEDLING", "label": "Seedling", "sort_order": 1, "aliases": ["Growing"]},
            {"code": "VEGETATIVE", "label": "Vegetative", "sort_order": 2},
            {"code": "FLOWERING", "label": "Flowering", "sort_order": 3},
            {"code": "FRUITING", "label": "Fruiting", "sort_order": 4, "is_bearing": True},
        ],
        "varieties": [
            {"code": "BR25", "name": "BR 25", "aliases": ["BR 25", "BR-25"]},
            {"code": "UF18", "name": "UF 18", "aliases": ["UF 18", "UF-18"]},
            {"code": "W10", "name": "W 10", "aliases": ["W 10", "W-10"]},
            # "KI" is read as a misspelling of K1 (letter I for digit 1). Confirm with the PAO.
            {"code": "K1", "name": "K 1", "aliases": ["K 1", "K-1", "KI"]},
            {"code": "CRIOLLO", "name": "Criollo", "aliases": ["CriolIo", "Criolo", "Creollo"]},
        ],
    },
]

MATERIAL_SOURCES: list[dict[str, Any]] = [
    {
        "code": "DA_RFO",
        "name": "DA Regional Field Office",
        "aliases": ["DA-RFO", "DA- RFO", "DA -RFO", "DA RFO", "DARFO"],
    },
    {"code": "DA", "name": "Department of Agriculture", "aliases": ["D.A."]},
    {"code": "PCA", "name": "Philippine Coconut Authority", "aliases": ["P.C.A."]},
    {
        "code": "OWN_PRODUCED",
        "name": "Own produced",
        "aliases": ["Own Produced", "Own Produce", "Own production", "Own"],
    },
    {"code": "PURCHASED", "name": "Purchased", "aliases": ["Bought"]},
]

UNITS: list[dict[str, Any]] = [
    {
        "code": "KG",
        "name": "Kilogram",
        "kind": "mass",
        "to_base": Decimal(1),
        "aliases": ["kg", "kgs", "kilo", "kilos", "kl", "kls"],
    },
    {
        "code": "SACK",
        "name": "Sack",
        "kind": "container",
        "to_base": None,
        "aliases": ["sack", "sacks", "sako"],
    },
    {
        "code": "HA",
        "name": "Hectare",
        "kind": "area",
        "to_base": Decimal(1),
        "aliases": ["ha", "hectare", "hectares"],
    },
    {
        "code": "TREE",
        "name": "Tree",
        "kind": "count",
        "to_base": Decimal(1),
        "aliases": ["tree", "trees"],
    },
]
