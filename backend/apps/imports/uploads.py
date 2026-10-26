"""Upload safety checks (brief §12): .xlsx/.csv only, 10 MB, no macros, no zip bombs."""

import hashlib
import zipfile
from pathlib import Path
from typing import IO

from common.exceptions import DomainError

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
MAX_ZIP_MEMBERS = 2000
ALLOWED_SUFFIXES = {".xlsx", ".csv"}


def _reject(message: str) -> DomainError:
    return DomainError("invalid_upload", message, {"file": [message]})


def check_upload(name: str, size: int, stream: IO[bytes], allowed: set[str] | None = None) -> str:
    """Validate an uploaded file and return its SHA-256. The stream is rewound afterwards."""
    suffix = Path(name).suffix.lower()
    if suffix not in (allowed or ALLOWED_SUFFIXES):
        raise _reject(f"Only {', '.join(sorted(allowed or ALLOWED_SUFFIXES))} files are accepted.")
    if size > MAX_UPLOAD_BYTES:
        raise _reject("The file is larger than 10 MB.")
    if size == 0:
        raise _reject("The file is empty.")

    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    stream.seek(0)

    if suffix == ".xlsx":
        _check_xlsx(stream)
        stream.seek(0)
    return digest.hexdigest()


def _check_xlsx(stream: IO[bytes]) -> None:
    if not zipfile.is_zipfile(stream):
        raise _reject("This is not a valid .xlsx workbook.")
    stream.seek(0)
    with zipfile.ZipFile(stream) as archive:
        members = archive.infolist()
        if len(members) > MAX_ZIP_MEMBERS:
            raise _reject("The workbook has too many parts.")
        names = {m.filename.lower() for m in members}
        if "[content_types].xml" not in names or not any(n.startswith("xl/") for n in names):
            raise _reject("This is not a valid .xlsx workbook.")
        if any(n.endswith("vbaproject.bin") for n in names):
            raise _reject("Workbooks with macros are not accepted. Save as .xlsx without macros.")
        total = sum(m.file_size for m in members)
        packed = sum(m.compress_size for m in members) or 1
        if total > MAX_UNCOMPRESSED_BYTES or total / packed > MAX_COMPRESSION_RATIO:
            raise _reject("The workbook expands to an unsafe size.")
