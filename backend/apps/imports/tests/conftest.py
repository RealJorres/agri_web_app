import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.catalog.services import seed_catalog
from apps.locations.services import seed_municipalities

from .legacy_fixture import build_legacy_workbook


@pytest.fixture
def seeded(db, settings, tmp_path):
    settings.PRIVATE_MEDIA_ROOT = tmp_path / "private"
    seed_municipalities()
    seed_catalog()


@pytest.fixture
def legacy_file(tmp_path, seeded):
    path = tmp_path / "synthetic-cacao-2023.xlsx"
    truth = build_legacy_workbook(path)
    return path, truth


def upload_of(path):
    return SimpleUploadedFile(path.name, path.read_bytes())


@pytest.fixture
def admin(seeded):
    return user_with_role(Role.SYSTEM_ADMIN)
