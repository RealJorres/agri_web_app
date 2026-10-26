from pathlib import Path

import pytest
from rest_framework.test import APIClient

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


@pytest.fixture(autouse=True)
def _clear_cache():
    """Throttle counters live in the cache; never let them leak between tests."""
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def api_client() -> APIClient:
    return APIClient()


@pytest.fixture
def auth_client():
    """auth_client(user) -> APIClient authenticated as that user (bypasses JWT/axes)."""

    def make(user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    return make


@pytest.fixture
def municipalities(db):
    """The six real Marinduque municipality names (public information, no personal data)."""
    from apps.locations.tests.factories import MunicipalityFactory

    names = ["Boac", "Buenavista", "Gasan", "Mogpog", "Santa Cruz", "Torrijos"]
    return {name: MunicipalityFactory(name=name) for name in names}
