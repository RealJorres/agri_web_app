import io
import zipfile

import pytest

from apps.imports.uploads import MAX_UPLOAD_BYTES, check_upload
from common.exceptions import DomainError


def xlsx_bytes(extra: dict[str, bytes] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", "<workbook/>")
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buffer.getvalue()


def check(name, data, allowed=None):
    return check_upload(name, len(data), io.BytesIO(data), allowed)


def test_valid_xlsx_returns_sha256():
    data = xlsx_bytes()

    digest = check("ok.xlsx", data)

    assert len(digest) == 64


@pytest.mark.parametrize(
    ("name", "data", "message"),
    [
        ("book.xls", b"x", "Only"),
        ("book.xlsm", xlsx_bytes(), "Only"),
        ("empty.xlsx", b"", "empty"),
        ("fake.xlsx", b"not a zip at all", "not a valid"),
        ("macro.xlsx", xlsx_bytes({"xl/vbaProject.bin": b"\x00" * 10}), "macros"),
        ("bomb.xlsx", xlsx_bytes({"xl/big.xml": b"0" * (5 * 1024 * 1024)}), "unsafe size"),
    ],
)
def test_rejected(name, data, message):
    with pytest.raises(DomainError) as info:
        check(name, data)

    assert message in info.value.message
    assert info.value.fields["file"]


def test_size_limit():
    with pytest.raises(DomainError, match="10 MB"):
        check_upload("big.xlsx", MAX_UPLOAD_BYTES + 1, io.BytesIO(b""))


def test_zip_without_workbook_parts_rejected():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("hello.txt", "hi")

    with pytest.raises(DomainError, match="not a valid"):
        check("odd.xlsx", buffer.getvalue())


def test_csv_allowed_only_where_permitted():
    assert check("rows.csv", b"a,b\n1,2\n")
    with pytest.raises(DomainError):
        check("rows.csv", b"a,b\n", allowed={".xlsx"})
