"""Text normalization shared by models (normalized_name), duplicate detection and imports."""

import re
import unicodedata

_NON_WORD = re.compile(r"[^\w\s]", flags=re.UNICODE)
_SPACES = re.compile(r"\s+")


def collapse_spaces(value: str | None) -> str:
    """Trim and collapse internal whitespace; None becomes ''."""
    return _SPACES.sub(" ", value or "").strip()


def normalize_name(value: str | None) -> str:
    """Lowercase, strip accents and punctuation, collapse spaces. 'Sta. Niño ' -> 'sta nino'."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    without_accents = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return collapse_spaces(_NON_WORD.sub(" ", without_accents.lower()).replace("_", " "))


def normalize_code(value: str | None) -> str:
    """Key for catalog codes/aliases: 'BR 25', 'br25 ' -> 'BR25'; 'DA- RFO', 'DA_RFO' -> 'DARFO'."""
    return normalize_name(value).replace(" ", "").upper()


# Person names (duplicate detection, ADR-0007). Only leading honorifics and a trailing suffix are
# dropped, so a middle initial such as "V." is kept.
_HONORIFICS = frozenset({"mr", "mrs", "ms", "dr", "engr", "atty", "hon", "kgd", "capt", "gng"})
_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv"})
_EXPANSIONS = {"ma": "maria", "sto": "santo", "sta": "santa"}


def normalize_person_name(value: str | None) -> str:
    """'Ma. Luisa Reyes Jr.' -> 'maria luisa reyes'; 'Engr. Juan V. Cruz' -> 'juan v cruz'."""
    tokens = normalize_name(value).split()
    while tokens and tokens[0] in _HONORIFICS:
        tokens.pop(0)
    if len(tokens) > 1 and tokens[-1] in _SUFFIXES:
        tokens.pop()
    return " ".join(_EXPANSIONS.get(t, t) for t in tokens)
