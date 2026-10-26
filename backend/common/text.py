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
