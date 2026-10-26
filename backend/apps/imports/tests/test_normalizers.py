"""One test per messy example in brief §3 (plus close variants). Pure functions: no database."""

import datetime as dt
from decimal import Decimal
from types import SimpleNamespace

import pytest

from apps.imports.normalizers import (
    NameParts,
    clean_barangay,
    clean_text,
    map_tokens,
    parse_associations,
    parse_contact,
    parse_count,
    parse_person_name,
    parse_remarks,
    parse_years,
    split_sites,
    split_values,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, ""), ("  BR25 ", "BR25"), (2016.0, "2016"), (9171234567.0, "9171234567"), (1.5, "1.5")],
)
def test_clean_text(raw, expected):
    assert clean_text(raw) == expected


class TestYears:
    @pytest.mark.parametrize(
        ("raw", "years"),
        [
            (2016, [2016]),
            (2016.0, [2016]),
            ("2016", [2016]),
            ("2016, 2018,2021 & 2022", [2016, 2018, 2021, 2022]),
            ("2017& 2019", [2017, 2019]),
            ("2017 and 2019", [2017, 2019]),
            ("2015/2016", [2015, 2016]),
            ("May 2015", [2015]),
            ("2018, 2018", [2018]),
            (dt.date(2019, 6, 1), [2019]),
            (dt.datetime(2020, 1, 15, 8, 0), [2020]),
            (42736, [2017]),  # Excel serial for 2017-01-01
            (None, []),
            ("  ", []),
        ],
    )
    def test_parses(self, raw, years):
        result = parse_years(raw)

        assert result.years == years
        assert result.issue == ""

    @pytest.mark.parametrize("raw", ["unknown", "June", 2016.5, 123, "1899"])
    def test_reports_unparseable(self, raw):
        result = parse_years(raw)

        assert result.years == []
        assert result.issue


class TestCounts:
    @pytest.mark.parametrize(
        ("raw", "value"),
        [
            (25, 25),
            (25.0, 25),
            ("1,200", 1200),
            (" 40 ", 40),
            (0, 0),
            (None, None),
            ("-", None),
            ("", None),
            (10_500, 10_500),
        ],
    )
    def test_parses(self, raw, value):
        assert parse_count(raw).value == value
        assert parse_count(raw).issue == ""

    @pytest.mark.parametrize("raw", ["about 50", 12.5, -3, True])
    def test_rejects(self, raw):
        result = parse_count(raw)

        assert result.value is None
        assert result.issue


class TestCodes:
    @pytest.mark.parametrize(
        ("raw", "tokens"),
        [
            ("UF18 & BR25", ["UF18", "BR25"]),
            ("BR25&UF18", ["BR25", "UF18"]),
            ("BR 25", ["BR 25"]),
            ("BR25 ", ["BR25"]),
            ("CriolIo", ["CriolIo"]),
            ("KI & K18", ["KI", "K18"]),
            ("W10 &  Criollo", ["W10", "Criollo"]),
            ("DA-RFO", ["DA-RFO"]),
            ("DA- RFO", ["DA- RFO"]),
            ("DA/PCA/Own Produced", ["DA", "PCA", "Own Produced"]),
            ("Own Produce", ["Own Produce"]),
            ("BR25 and UF18", ["BR25", "UF18"]),
            (None, []),
        ],
    )
    def test_split_values(self, raw, tokens):
        assert split_values(raw) == tokens

    def test_map_tokens_keeps_unknown_for_review(self):
        index = {"BR25": "br25-obj", "K1": "k1-obj"}

        result = map_tokens(["BR25", "K18", "K1", "BR25"], index.get)

        assert result.found == ["br25-obj", "k1-obj"]
        assert result.unknown == ["K18"]


class TestPlaces:
    @pytest.mark.parametrize(
        ("raw", "town", "expected"),
        [
            ("Lamesa, Mogpog", "Mogpog", "Lamesa"),
            ("Lamesa,Mogpog", "MOGPOG", "Lamesa"),
            ("Brgy. Lamesa", "Mogpog", "Lamesa"),
            ("Lamesa, Mogpog, Marinduque", "Mogpog", "Lamesa"),
            ("Sta. Cruz Poblacion", "Santa Cruz", "Sta. Cruz Poblacion"),
            ("Lamesa, Boac", "Mogpog", "Lamesa, Boac"),  # other town: kept for review
        ],
    )
    def test_clean_barangay(self, raw, town, expected):
        assert clean_barangay(raw, town) == expected

    def test_split_sites(self):
        assert split_sites("Pulong Parang/Masalukot", "Gasan") == ["Pulong Parang", "Masalukot"]
        assert split_sites("Masalukot, Gasan", "Gasan") == ["Masalukot"]
        assert split_sites("", "Gasan") == []


class TestNames:
    @pytest.mark.parametrize(
        ("raw", "parts"),
        [
            ("Juan Sample", NameParts("Juan", "", "Sample")),
            ("Juan A. Dela Cruz Jr.", NameParts("Juan", "A.", "Dela Cruz", "Jr.")),
            ("Ma. Luisa Reyes", NameParts("Ma. Luisa", "", "Reyes")),
            ("Dela Cruz, Juan A.", NameParts("Juan", "A.", "Dela Cruz")),
            ("Santos, Maria Clara Jr.", NameParts("Maria Clara", "", "Santos", "Jr.")),
            ("Jose De los Santos", NameParts("Jose", "", "De los Santos")),
            ("Engr. Pedro Sample III", NameParts("Pedro", "", "Sample", "III")),
            ("Sample", NameParts(last="Sample")),
            ("  ", NameParts()),
        ],
    )
    def test_parse_person_name(self, raw, parts):
        assert parse_person_name(raw) == parts


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (9171234567.0, "09171234567"),
        ("0917-123-4567", "09171234567"),
        ("+63 917 123 4567", "09171234567"),
        ("09171234567 / 09281234567", "09171234567; 09281234567"),
        (None, ""),
    ],
)
def test_parse_contact(raw, expected):
    assert parse_contact(raw) == expected


@pytest.mark.parametrize(
    ("raw", "names"),
    [
        ("None Member", []),
        ("none", []),
        ("", []),
        (None, []),
        ("Mat. Gasan FA", ["Mat. Gasan FA"]),
        ("Tambangan FA, SAGANA", ["Tambangan FA", "SAGANA"]),
        ("Sample FA; Other Coop", ["Sample FA", "Other Coop"]),
    ],
)
def test_parse_associations(raw, names):
    assert parse_associations(raw) == names


class TestRemarks:
    @pytest.mark.parametrize(
        ("raw", "qty", "unit", "form", "recurring"),
        [
            ("8 kilos harvest", "8", "kg", "unknown", False),
            ("3 kls.", "3", "kg", "unknown", False),
            ("1 sack", "1", "sack", "unknown", False),
            ("6 kilos dried", "6", "kg", "dried_beans", False),
            ("1 kilo every other month", "1", "kg", "unknown", True),
            ("2.5 kg", "2.5", "kg", "unknown", False),
        ],
    )
    def test_harvests(self, raw, qty, unit, form, recurring):
        result = parse_remarks(raw)

        assert len(result.harvests) == 1
        h = result.harvests[0]
        assert (h.quantity, h.unit, h.product_form, h.recurring) == (
            Decimal(qty),
            unit,
            form,
            recurring,
        )
        assert h.raw_text
        assert result.remaining == ""

    def test_tree_losses_stay_in_remarks(self):
        raw = "325 trees died in May 2023, 80 now"

        result = parse_remarks(raw)

        assert result.harvests == []
        assert result.remaining == raw

    def test_mixed_remark_keeps_the_rest(self):
        result = parse_remarks("8 kilos harvest; needs rehabilitation")

        assert [h.quantity for h in result.harvests] == [Decimal(8)]
        assert result.remaining == "needs rehabilitation"

    def test_empty(self):
        assert parse_remarks(None).harvests == []


def test_map_tokens_with_catalog_index_shape():
    index = SimpleNamespace(resolve=lambda t: {"DA": "da"}.get(t))

    assert map_tokens(["DA", "PS"], index.resolve).unknown == ["PS"]
