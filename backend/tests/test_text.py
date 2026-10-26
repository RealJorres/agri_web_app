import pytest

from common.text import collapse_spaces, normalize_code, normalize_name


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Lamesa   ", "Lamesa"),
        ("W10 &  Criollo", "W10 & Criollo"),
        (None, ""),
        ("\tBR25\n", "BR25"),
    ],
)
def test_collapse_spaces(raw, expected):
    assert collapse_spaces(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Sta. Niño", "sta nino"),
        ("  Mat. Gasan FA ", "mat gasan fa"),
        ("DELA CRUZ, Juan", "dela cruz juan"),
        ("snake_case", "snake case"),
        ("", ""),
    ],
)
def test_normalize_name(raw, expected):
    assert normalize_name(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("BR 25", "BR25"),
        ("BR25 ", "BR25"),
        ("br25", "BR25"),
        ("DA-RFO", "DARFO"),
        ("DA- RFO", "DARFO"),
        ("DA_RFO", "DARFO"),
        ("CriolIo", "CRIOLIO"),
        ("Own Produce", "OWNPRODUCE"),
    ],
)
def test_normalize_code(raw, expected):
    assert normalize_code(raw) == expected
