from pathlib import Path

import pytest

# Real PAO workbooks are mounted read-only at /data in containers (gitignored on the host).
RAW_DATA_DIR = Path("/data/raw")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    has_real_data = RAW_DATA_DIR.is_dir() and any(RAW_DATA_DIR.glob("*.xlsx"))
    if has_real_data:
        return
    skip = pytest.mark.skip(reason="real PAO workbook not present in data/raw/")
    for item in items:
        if "real_data" in item.keywords:
            item.add_marker(skip)
