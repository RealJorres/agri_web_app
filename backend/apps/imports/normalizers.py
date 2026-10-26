"""Pure normalizers for messy spreadsheet cells (brief §3). No database access here.

Every function is total: it never raises on bad input, it returns a value plus issues so the
pipeline can report them on the preview screen.
"""

import datetime as dt
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from common.text import collapse_spaces, normalize_name

# --- Generic ------------------------------------------------------------------------------------


def clean_text(value: Any) -> str:
    """Cell -> trimmed single-spaced text. Whole floats lose their '.0' (Excel numbers)."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return collapse_spaces(str(value))


_SPLIT = re.compile(r"\s*(?:,|&|/|\+|;|\band\b)\s*", flags=re.IGNORECASE)


def split_values(raw: Any) -> list[str]:
    """'UF18 & BR25' / 'BR25&UF18' / 'DA/PCA/Own Produced' / 'W10 &  Criollo' -> tokens.
    Hyphens are not separators ('DA-RFO', 'DA- RFO' stay whole)."""
    text = clean_text(raw)
    return [t for t in (collapse_spaces(p) for p in _SPLIT.split(text)) if t] if text else []


# --- Years planted ------------------------------------------------------------------------------

YEAR_MIN, YEAR_MAX = 1950, 2030
_YEAR = re.compile(r"(?<!\d)(19\d{2}|20\d{2})(?!\d)")
_EXCEL_EPOCH = dt.date(1899, 12, 30)


@dataclass(frozen=True)
class YearsResult:
    years: list[int]
    issue: str = ""  # empty when the cell parsed cleanly


def parse_years(value: Any) -> YearsResult:
    """DATE PLANTED cell -> planting years.

    Numbers: 2016 / 2016.0 -> [2016]; an Excel date serial (e.g. 42736) -> its year.
    Dates/datetimes -> their year. Text: every 4-digit year, e.g. "2016, 2018,2021 & 2022",
    "2017& 2019", "May 2015" -> years in order, without duplicates.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return YearsResult([])
    if isinstance(value, dt.datetime | dt.date):
        return _checked([value.year])
    if isinstance(value, int | float | Decimal):
        number = float(value)
        if not number.is_integer():
            return YearsResult([], f"not a year: {value}")
        whole = int(number)
        if YEAR_MIN <= whole <= YEAR_MAX:
            return YearsResult([whole])
        if 10_000 < whole < 80_000:  # Excel serial date
            return _checked([(_EXCEL_EPOCH + dt.timedelta(days=whole)).year])
        return YearsResult([], f"not a year: {whole}")
    text = clean_text(value)
    found: list[int] = []
    for match in _YEAR.findall(text):
        year = int(match)
        if year not in found:
            found.append(year)
    if not found:
        return YearsResult([], f"no year found in '{text}'")
    return _checked(found)


def _checked(years: list[int]) -> YearsResult:
    bad = [y for y in years if not YEAR_MIN <= y <= YEAR_MAX]
    good = [y for y in years if YEAR_MIN <= y <= YEAR_MAX]
    return YearsResult(good, f"year out of range: {bad}" if bad else "")


# --- Counts -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CountResult:
    value: int | None
    issue: str = ""


_EMPTY_MARKERS = {"", "-", "--", "n/a", "na", "none"}


def parse_count(value: Any) -> CountResult:
    """Stage cell -> non-negative integer. '1,200' -> 1200; '-' / blank -> None."""
    if value is None:
        return CountResult(None)
    if isinstance(value, bool):
        return CountResult(None, f"not a number: {value}")
    if isinstance(value, int | float | Decimal):
        number = Decimal(str(value))
    else:
        text = clean_text(value).replace(",", "")
        if text.lower() in _EMPTY_MARKERS:
            return CountResult(None)
        try:
            number = Decimal(text)
        except InvalidOperation:
            return CountResult(None, f"not a number: '{clean_text(value)}'")
    if number < 0:
        return CountResult(None, f"negative: {number}")
    if number != number.to_integral_value():
        return CountResult(None, f"not a whole number: {number}")
    return CountResult(int(number))


# --- Places -------------------------------------------------------------------------------------

_BRGY_PREFIX = re.compile(r"^(?:brgy|bgy|barangay|bo)\.?\s+", flags=re.IGNORECASE)


def clean_barangay(raw: Any, municipality: str) -> str:
    """'Lamesa, Mogpog' -> 'Lamesa'; 'Brgy. Lamesa' -> 'Lamesa'. Keeps other text as is."""
    text = _BRGY_PREFIX.sub("", clean_text(raw))
    town = normalize_name(municipality)
    parts = [p.strip() for p in text.split(",")]
    while len(parts) > 1 and normalize_name(parts[-1]) in {town, "marinduque"}:
        parts.pop()
    return collapse_spaces(", ".join(parts))


def split_sites(raw: Any, municipality: str) -> list[str]:
    """FARM LOCATION -> candidate barangay names: 'Pulong Parang/Masalukot' -> both."""
    text = clean_barangay(raw, municipality)
    return [
        clean_barangay(p, municipality) for p in re.split(r"\s*/\s*|\s*&\s*", text) if p.strip()
    ]


# --- People -------------------------------------------------------------------------------------

_SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}
_SURNAME_PARTICLES = {"de", "dela", "del", "delos", "los", "la", "san", "sta", "sto", "di", "y"}
_HONORIFICS = {"mr", "mrs", "ms", "dr", "engr", "atty", "hon", "kgd", "capt"}


@dataclass(frozen=True)
class NameParts:
    first: str = ""
    middle: str = ""
    last: str = ""
    suffix: str = ""


def _is_initial(token: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z]\.?", token))


def _norm_token(token: str) -> str:
    return token.lower().rstrip(".,")


def parse_person_name(raw: Any) -> NameParts:
    """Best-effort split of a Filipino full name; the raw text is always kept separately.

    'Dela Cruz, Juan A.' -> (Juan, A., Dela Cruz); 'Juan A. Dela Cruz Jr.' -> (Juan, A., Dela Cruz,
    Jr.); 'Ma. Luisa Reyes' -> (Ma. Luisa, '', Reyes)."""
    text = clean_text(raw)
    if not text:
        return NameParts()
    if "," in text:
        last_part, _, rest = text.partition(",")
        tokens = rest.split()
        suffix = ""
        if tokens and _norm_token(tokens[-1]) in _SUFFIXES:
            suffix = tokens.pop()
        middle = tokens.pop() if len(tokens) > 1 and _is_initial(tokens[-1]) else ""
        return NameParts(" ".join(tokens), middle, collapse_spaces(last_part), suffix)

    tokens = text.split()
    while len(tokens) > 1 and _norm_token(tokens[0]) in _HONORIFICS:
        tokens.pop(0)
    suffix = tokens.pop() if len(tokens) > 1 and _norm_token(tokens[-1]) in _SUFFIXES else ""
    if len(tokens) == 1:
        return NameParts(last=tokens[0], suffix=suffix)
    # Surname: last token plus any particles before it ("Dela Cruz", "De los Santos").
    start = len(tokens) - 1
    while start > 1 and _norm_token(tokens[start - 1]) in _SURNAME_PARTICLES:
        start -= 1
    last = " ".join(tokens[start:])
    given = tokens[:start]
    middle = given.pop() if len(given) > 1 and _is_initial(given[-1]) else ""
    return NameParts(" ".join(given), middle, last, suffix)


def parse_contact(raw: Any) -> str:
    """'9171234567' (Excel number) -> '09171234567'; several numbers -> '; '-joined."""
    text = clean_text(raw)
    if not text:
        return ""
    numbers = []
    for part in re.split(r"\s*(?:/|;|,|&|\bor\b)\s*", text):
        digits = re.sub(r"\D", "", part)
        if len(digits) == 10 and digits.startswith("9"):
            digits = "0" + digits
        if len(digits) == 12 and digits.startswith("639"):
            digits = "0" + digits[2:]
        if digits:
            numbers.append(digits)
    return "; ".join(numbers)


# --- Associations -------------------------------------------------------------------------------

_NO_ASSOCIATION = {
    "",
    "none",
    "none member",
    "non member",
    "non-member",
    "not member",
    "n/a",
    "na",
    "-",
}


def parse_associations(raw: Any) -> list[str]:
    """'None Member' / blank -> []; 'Tambangan FA, SAGANA' -> two names."""
    text = clean_text(raw)
    if normalize_name(text) in {normalize_name(n) for n in _NO_ASSOCIATION}:
        return []
    names = [collapse_spaces(p) for p in re.split(r"\s*[,;]\s*|\s+/\s+", text)]
    return [n for n in names if n and normalize_name(n) not in _NO_ASSOCIATION]


# --- Remarks / harvests -------------------------------------------------------------------------


@dataclass(frozen=True)
class HarvestInfo:
    quantity: Decimal
    unit: str  # kg | sack
    product_form: str  # dried_beans | unknown
    raw_text: str
    recurring: bool = False


@dataclass(frozen=True)
class RemarksResult:
    harvests: list[HarvestInfo] = field(default_factory=list)
    remaining: str = ""


_QTY = r"(\d+(?:[.,]\d+)?)"
_UNITS = {
    "kg": "kg",
    "kgs": "kg",
    "kilo": "kg",
    "kilos": "kg",
    "kl": "kg",
    "kls": "kg",
    "sack": "sack",
    "sacks": "sack",
    "sako": "sack",
}
_HARVEST = re.compile(
    rf"{_QTY}\s*(kilos?|kgs?|kls?|sacks?|sako)\b\.?"
    r"(?P<tail>[^,;]*)",
    flags=re.IGNORECASE,
)
_RECURRING = re.compile(r"\bevery\b|\bper\s+(?:week|month|harvest)\b|\bmonthly\b", re.IGNORECASE)


def parse_remarks(raw: Any) -> RemarksResult:
    """'8 kilos harvest' / '3 kls.' / '1 sack' / '6 kilos dried' / '1 kilo every other month' ->
    harvests; other text (e.g. tree losses) stays in ``remaining``."""
    text = clean_text(raw)
    if not text:
        return RemarksResult()
    harvests = []
    spans: list[tuple[int, int]] = []
    for match in _HARVEST.finditer(text):
        quantity = Decimal(match.group(1).replace(",", "."))
        unit = _UNITS[match.group(2).lower().rstrip(".")]
        phrase = match.group(0).strip()
        tail = match.group("tail") or ""
        harvests.append(
            HarvestInfo(
                quantity=quantity,
                unit=unit,
                product_form="dried_beans" if re.search(r"\bdried?\b", phrase, re.I) else "unknown",
                raw_text=phrase,
                recurring=bool(_RECURRING.search(tail)),
            )
        )
        spans.append(match.span())
    remaining = text
    for start, end in reversed(spans):
        remaining = remaining[:start] + " " + remaining[end:]
    remaining = collapse_spaces(re.sub(r"^[\s,;.]+|[\s,;]+$", "", remaining))
    if normalize_name(remaining) in {"", "harvest", "harvested"}:
        remaining = ""
    return RemarksResult(harvests, remaining)


# --- Catalog mapping ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Mapped[T]:
    found: list[T]
    unknown: list[str]


def map_tokens[T](tokens: Iterable[str], resolve: Any) -> Mapped[T]:
    """Resolve each token through an AliasIndex.resolve; keep unknown tokens for review."""
    found: list[T] = []
    unknown: list[str] = []
    for token in tokens:
        obj = resolve(token)
        if obj is None:
            unknown.append(token)
        elif obj not in found:
            found.append(obj)
    return Mapped(found, unknown)
