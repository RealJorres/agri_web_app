import io

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from openpyxl import load_workbook

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.catalog.models import Commodity
from apps.imports import services, template
from apps.imports.models import ImportJob, ImportKind, ImportStatus
from apps.locations.models import Municipality
from apps.locations.tests.factories import BarangayFactory
from apps.registry.models import Farmer
from apps.surveys.models import InventoryRecord, RecordStatus
from apps.surveys.tests.factories import SurveyRoundFactory

from .conftest import upload_of

pytestmark = pytest.mark.django_db


@pytest.fixture
def cacao(seeded):
    return Commodity.objects.get(code="CACAO")


@pytest.fixture
def gasan_brgy(seeded):
    return BarangayFactory(
        municipality=Municipality.objects.get(name="Gasan"), name="Synthetic Tpl"
    )


def filled_template(cacao, rows):
    wb = load_workbook(io.BytesIO(template.generate(cacao)))
    ws = wb[template.SHEET]
    headers = [c.value.rstrip(" *") for c in ws[1]]
    for r, values in enumerate(rows, start=2):
        for key, value in values.items():
            col = next(i for i, c in enumerate(template.columns_for(cacao)) if c.key == key)
            assert headers[col]
            ws.cell(row=r, column=col + 1, value=value)
    buffer = io.BytesIO()
    wb.save(buffer)
    return SimpleUploadedFile("filled.xlsx", buffer.getvalue())


GOOD = {
    "municipality": "Gasan",
    "barangay": "Synthetic Tpl (Gasan)",
    "first_name": "Juana",
    "last_name": "Sampletpl",
    "consent": "Y",
    "contact_no": "09000000002",
    "varieties": "BR25, UF18",
    "years": "2020",
    "source": "DA Regional Field Office",
    "stage:FRUITING": 40,
    "associations": "Sample Template FA",
}


def test_generated_template_has_headers_lists_and_dropdowns(cacao, gasan_brgy):
    wb = load_workbook(io.BytesIO(template.generate(cacao)))

    assert wb.sheetnames == ["Instructions", template.SHEET, template.LISTS]
    assert wb[template.LISTS].sheet_state == "hidden"
    headers = [c.value for c in wb[template.SHEET][1]]
    assert headers[:3] == ["Municipality *", "Home barangay *", "First name *"]
    assert {"Seedling", "Vegetative", "Flowering", "Fruiting"} <= set(headers)
    assert len(wb[template.SHEET].data_validations.dataValidation) >= 5
    assert "PRIVACY NOTICE" in "".join(str(c.value) for c in wb["Instructions"]["A"])


def test_template_import_creates_submitted_records(cacao, gasan_brgy):
    encoder = user_with_role(Role.PROVINCIAL_ENCODER)
    survey_round = SurveyRoundFactory(commodity=cacao)
    bad = {
        **GOOD,
        "last_name": "Samplebad",
        "consent": "N",
        "varieties": "K19",
        "stage:FRUITING": -5,
    }
    upload = filled_template(cacao, [GOOD, bad])

    job = services.run_preview(
        services.create_job(
            actor=encoder, upload=upload, kind=ImportKind.TEMPLATE, survey_round=survey_round
        )
    )

    assert job.status == ImportStatus.READY, job.error_message
    assert job.summary["counts"] == {
        "rows": 2,
        "valid_rows": 1,
        "rows_with_errors": 1,
        "existing_farmers": 0,
    }
    messages = " ".join(job.summary["errors"][0]["messages"])
    assert "Consent must be 'Y'" in messages
    assert "Unknown variety: K19" in messages
    assert "negative" in messages
    report = load_workbook(job.error_report.path)
    assert report.active.cell(row=2, column=1).value == 3

    job = services.commit_job(job=job, actor=encoder)

    assert job.summary["commit"]["records_submitted"] == 1
    record = InventoryRecord.objects.get()
    assert record.status == RecordStatus.SUBMITTED
    farmer = Farmer.objects.get()
    assert farmer.consent_by == encoder
    assert farmer.memberships.get().association.name == "Sample Template FA"
    planting = record.crop_stand.plantings.get()
    assert planting.year_planted == 2020
    assert {v.code for v in planting.varieties.all()} == {"BR25", "UF18"}


def test_template_requires_open_round(cacao):
    encoder = user_with_role(Role.PROVINCIAL_ENCODER)
    upload = SimpleUploadedFile("x.csv", b"Municipality\n")
    from common.exceptions import DomainError

    with pytest.raises(DomainError) as info:
        services.create_job(actor=encoder, upload=upload, kind=ImportKind.TEMPLATE)
    assert info.value.code == "round_required"


def test_template_with_wrong_headers_fails_preview(cacao):
    encoder = user_with_role(Role.PROVINCIAL_ENCODER)
    upload = SimpleUploadedFile("x.csv", b"Name,Town\nA,B\n")
    job = services.create_job(
        actor=encoder,
        upload=upload,
        kind=ImportKind.TEMPLATE,
        survey_round=SurveyRoundFactory(commodity=cacao),
    )

    job = services.run_preview(job)

    assert job.status == ImportStatus.FAILED
    assert "Missing columns" in job.error_message


class TestApi:
    def test_upload_preview_commit_flow(
        self, auth_client, legacy_file, admin, django_capture_on_commit_callbacks
    ):
        path, _ = legacy_file
        client = auth_client(admin)

        with django_capture_on_commit_callbacks(execute=True):
            created = client.post(
                "/api/v1/imports",
                {"file": upload_of(path), "kind": ImportKind.LEGACY_CACAO_2023},
                format="multipart",
            )
        assert created.status_code == 201, created.json()
        job_id = created.json()["id"]
        detail = client.get(f"/api/v1/imports/{job_id}").json()
        assert detail["status"] == "ready"
        assert detail["summary"]["reconciliation"]["province"]["computed_total"] > 0

        with django_capture_on_commit_callbacks(execute=True):
            accepted = client.post(f"/api/v1/imports/{job_id}/commit", {}, format="json")
        assert accepted.status_code == 202
        assert client.get(f"/api/v1/imports/{job_id}").json()["status"] == "committed"
        assert "summary" not in client.get("/api/v1/imports").json()["results"][0]

    def test_permissions(self, auth_client, legacy_file, admin):
        path, _ = legacy_file
        job = services.create_job(
            actor=admin, upload=upload_of(path), kind=ImportKind.LEGACY_CACAO_2023
        )
        encoder = auth_client(user_with_role(Role.PROVINCIAL_ENCODER))
        viewer = auth_client(user_with_role(Role.VIEWER))

        assert viewer.get("/api/v1/imports").status_code == 403
        assert encoder.get(f"/api/v1/imports/{job.pk}").status_code == 404  # not their job
        bad = encoder.post(
            "/api/v1/imports",
            {"file": SimpleUploadedFile("a.xls", b"x"), "kind": "legacy_cacao_2023"},
            format="multipart",
        )
        assert bad.status_code == 400
        assert bad.json()["fields"]["file"]

    def test_commit_rights_checked_before_queueing(self, auth_client, legacy_file, seeded):
        path, _ = legacy_file
        encoder_user = user_with_role(Role.PROVINCIAL_ENCODER)
        job = services.run_preview(
            services.create_job(
                actor=encoder_user, upload=upload_of(path), kind=ImportKind.LEGACY_CACAO_2023
            )
        )

        response = auth_client(encoder_user).post(
            f"/api/v1/imports/{job.pk}/commit", {}, format="json"
        )

        assert response.status_code == 403

    def test_template_download(self, auth_client, cacao):
        client = auth_client(user_with_role(Role.PROVINCIAL_ENCODER))

        response = client.get("/api/v1/imports/template", {"commodity": str(cacao.pk)})

        assert response.status_code == 200
        assert response["Content-Disposition"] == 'attachment; filename="cacao-template.xlsx"'

    def test_error_report_download_is_audited(self, auth_client, cacao, gasan_brgy):
        encoder = user_with_role(Role.PROVINCIAL_ENCODER)
        job = services.run_preview(
            services.create_job(
                actor=encoder,
                upload=filled_template(cacao, [{**GOOD, "consent": "N"}]),
                kind=ImportKind.TEMPLATE,
                survey_round=SurveyRoundFactory(commodity=cacao),
            )
        )
        client = auth_client(encoder)

        response = client.get(f"/api/v1/imports/{job.pk}/error-report")

        assert response.status_code == 200
        assert AuditLog.objects.filter(action="import.download_error_report").exists()


class TestExports:
    def test_personal_data_export_needs_capability_and_is_audited(self, auth_client, gasan_brgy):
        from apps.registry.tests.factories import FarmerFactory

        FarmerFactory(home_barangay=gasan_brgy, last_name="Sampleexport")
        coordinator = auth_client(user_with_role(Role.PROGRAM_COORDINATOR))
        encoder = auth_client(user_with_role(Role.PROVINCIAL_ENCODER))

        assert encoder.get("/api/v1/exports/farmers.xlsx").status_code == 403
        response = coordinator.get("/api/v1/exports/farmers.xlsx", {"q": "sampleexport"})

        assert response.status_code == 200
        sheet = load_workbook(io.BytesIO(response.content)).active
        assert sheet.cell(row=2, column=1).value == "Sampleexport"
        entry = AuditLog.objects.get(action="export.farmers")
        assert entry.after == {"rows": 1, "filters": {"q": ["sampleexport"]}}

    def test_inventory_export(self, auth_client, legacy_file, admin):
        path, _ = legacy_file
        job = services.run_preview(
            services.create_job(
                actor=admin, upload=upload_of(path), kind=ImportKind.LEGACY_CACAO_2023
            )
        )
        services.commit_job(job=job, actor=admin)
        client = auth_client(user_with_role(Role.PROVINCIAL_HEAD))

        response = client.get("/api/v1/exports/inventory.xlsx", {"status": "approved"})

        sheet = load_workbook(io.BytesIO(response.content)).active
        headers = [c.value for c in sheet[1]]
        assert headers[5:9] == ["Seedling", "Vegetative", "Flowering", "Fruiting"]
        assert sheet.max_row - 1 == InventoryRecord.objects.filter(status="approved").count()
        assert AuditLog.objects.filter(action="export.inventory").exists()


def test_purge_old_files(legacy_file, admin):
    import datetime as dt

    from django.utils import timezone

    path, _ = legacy_file
    job = services.run_preview(
        services.create_job(actor=admin, upload=upload_of(path), kind=ImportKind.LEGACY_CACAO_2023)
    )
    services.commit_job(job=job, actor=admin)
    stored = job.file.path

    assert services.purge_old_files(now=timezone.now() + dt.timedelta(days=31)) == 1
    job.refresh_from_db()
    assert not job.file
    assert job.files_purged_at is not None
    import os

    assert not os.path.exists(stored)
    assert ImportJob.objects.filter(pk=job.pk).exists()
