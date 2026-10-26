"""End-to-end legacy import on the SYNTHETIC workbook (same layout/defects as the real file)."""

from decimal import Decimal

import pytest

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.farms.models import Farm, Planting
from apps.imports import services
from apps.imports.models import ImportKind, ImportStatus
from apps.locations.models import Barangay
from apps.production.models import Harvest
from apps.registry.models import Association, Farmer, FarmerStatus
from apps.surveys.models import InventoryRecord, RecordStatus, SurveyRound
from common.exceptions import DomainError

from .conftest import upload_of

pytestmark = pytest.mark.django_db
STAGES = ["SEEDLING", "VEGETATIVE", "FLOWERING", "FRUITING"]


@pytest.fixture
def previewed(legacy_file, admin):
    path, truth = legacy_file
    job = services.create_job(
        actor=admin, upload=upload_of(path), kind=ImportKind.LEGACY_CACAO_2023
    )
    return services.run_preview(job), truth


@pytest.fixture
def committed(previewed, admin):
    job, truth = previewed
    return services.commit_job(job=job, actor=admin), truth


def kinds(summary):
    return [r["kind"] for r in summary["review"]]


class TestPreview:
    def test_counts(self, previewed):
        job, truth = previewed

        assert job.status == ImportStatus.READY, job.error_message
        counts = job.summary["counts"]
        assert counts["named_rows"] == truth.named_rows
        assert counts["rows_with_trees"] == truth.rows_with_trees
        assert counts["below_total_rows"] == truth.below_total_with_barangay
        assert counts["name_only_rows"] == truth.name_only_rows
        assert job.summary["already_imported"] is False
        assert job.summary["municipalities"] == [
            "Boac",
            "Buenavista",
            "Gasan",
            "Mogpog",
            "Santa Cruz",
            "Torrijos",
        ]

    def test_reconciliation_finds_santa_cruz_and_mogpog_formula_defects(self, previewed):
        job, truth = previewed
        rec = job.summary["reconciliation"]
        by_town = {m["municipality"]: m for m in rec["municipalities"]}

        sc = by_town["Santa Cruz"]
        expected_diff = [
            t - w
            for t, w in zip(
                truth.true_totals["Santa Cruz"], truth.workbook_totals["Santa Cruz"], strict=True
            )
        ]
        assert [sc["stages"][s]["diff_workbook"] for s in STAGES] == expected_diff
        assert sc["diff_total"] == sum(expected_diff) == 940
        assert sc["stages"]["SEEDLING"]["skipped_rows"] == [16, 17, 18]
        assert sc["stages"]["FRUITING"]["skipped_rows"] == []
        mogpog = by_town["Mogpog"]["stages"]["FLOWERING"]
        assert mogpog["formula"] == "=SUM(L13)"
        assert mogpog["skipped_rows"] == [14, 15]
        assert any(
            "Santa Cruz SEEDLING" in d and "skips rows 16-18" in d for d in rec["differences"]
        )
        # Mogpog's single-cell SUM also leaves out rows 14-15: reported as fragile.
        assert by_town["Mogpog"]["stages"]["FLOWERING"]["uncovered_rows"] == [14, 15]
        for town, totals in truth.true_totals.items():
            assert [by_town[town]["stages"][s]["computed"] for s in STAGES] == totals
        province_true = sum(sum(t) for t in truth.true_totals.values())
        assert rec["province"]["computed_total"] == province_true
        assert rec["province"]["area_ha"] == str(round(Decimal(province_true) / 625, 2))

    def test_review_list(self, previewed):
        job, _ = previewed
        review = job.summary["review"]

        assert {
            "unknown_variety",
            "unknown_source",
            "unparsed_year",
            "name_only_row",
            "same_name_twice",
            "possible_duplicate",
        } <= set(kinds(job.summary))
        assert {r["value"] for r in review if r["kind"] == "unknown_variety"} == {"K18"}
        assert {r["value"] for r in review if r["kind"] == "unknown_source"} == {"PS"}
        assert [r["value"] for r in review if r["kind"] == "unparsed_year"] == ["unknown"]

    def test_normalization_decisions(self, previewed):
        job, _ = previewed
        decisions = job.summary["decisions"]

        variety = {d["raw"]: d["result"] for d in decisions["variety"]}
        assert variety["UF18 & BR25"] == "UF18, BR25"
        assert variety["CriolIo"] == "CRIOLLO"
        assert variety["KI & K18"] == "K1"
        source = {d["raw"]: d["result"] for d in decisions["source"]}
        assert source["DA- RFO"] == "DA_RFO"
        assert source["DA/PCA/Own Produced"] == "DA, PCA, OWN_PRODUCED"
        barangay = {d["raw"]: d["result"] for d in decisions["barangay"]}
        assert barangay["Synthetic Beta, Boac"] == "Synthetic Beta"
        assoc = {d["raw"]: d["decision"] for d in decisions["associations"]}
        assert assoc["Mat Sample Gasan FA"] == "same_as_file"

    def test_preview_writes_nothing(self, previewed):
        assert not Farmer.objects.exists()
        assert not SurveyRound.objects.exists()


class TestCommit:
    def test_official_totals_equal_farmer_rows(self, committed):
        job, truth = committed
        result = job.summary["commit"]

        assert job.status == ImportStatus.COMMITTED
        assert result["official_total"] == sum(sum(t) for t in truth.true_totals.values())
        for town, totals in truth.true_totals.items():
            by_stage = result["official_by_municipality"][town]
            assert [by_stage.get(s, 0) for s in STAGES] == totals

    def test_records_and_round(self, committed):
        _, truth = committed
        survey_round = SurveyRound.objects.get()

        assert (survey_round.name, survey_round.is_historical) == (
            "Cacao inventory - July 2023",
            True,
        )
        assert survey_round.status == "open"  # ADR-0013 §6
        assert (
            InventoryRecord.objects.filter(status=RecordStatus.APPROVED).count() == truth.named_rows
        )
        draft = InventoryRecord.objects.get(status=RecordStatus.DRAFT)
        assert draft.flags["below_total"] is True
        assert draft.crop_stand.farm.farmer.status == FarmerStatus.NEEDS_REVIEW
        record = InventoryRecord.objects.filter(flags__sheet="BOAC", flags__row=13).get()
        assert record.flags["source"] == "legacy_import"
        assert record.approved_by is not None

    def test_people_places_and_plantings(self, committed):
        rosa = Farmer.objects.get(last_name="Sampleduo")  # same name+barangay twice -> one farmer
        assert rosa.farms.count() == 2
        assert {f.barangay.name for f in rosa.farms.all()} == {"Synthetic Gamma", "Synthetic Beta"}
        assert Farmer.objects.filter(last_name="Samplecruz").count() == 2  # different towns
        assert not Farmer.objects.exclude(consent_at=None).exists()

        juan = Farmer.objects.get(last_name="Samplecruz", home_barangay__municipality__name="Boac")
        assert (juan.first_name, juan.middle_name) == ("Juan", "A.")
        assert juan.contact_no == "09000000001"
        plantings = Planting.objects.filter(crop_stand__farm__farmer=juan).order_by("year_planted")
        assert [p.year_planted for p in plantings] == [2016, 2018, 2021, 2022]
        assert {v.code for v in plantings[0].varieties.all()} == {"UF18", "BR25"}
        assert plantings[0].source.code == "DA_RFO"
        assert "per-year breakdown unknown" in plantings[0].notes

        carlos = Farm.objects.get(farmer__last_name="Samplegas", farmer__first_name="Carlos")
        assert carlos.barangay.name == "Synthetic Tabionan"  # no site matched -> home barangay
        assert carlos.location_raw == "Pulong Parang/Masalukot"

        placeholder = Farmer.objects.get(last_name="Samplenobrgy").home_barangay
        assert (placeholder.name, placeholder.is_verified) == ("(Barangay not recorded)", False)
        assert (
            Farmer.objects.get(last_name="Samplefarmloc").home_barangay.name == "Synthetic Poctoy"
        )
        flagged = InventoryRecord.objects.get(crop_stand__farm__farmer__last_name="Samplenobrgy")
        assert flagged.status == RecordStatus.APPROVED
        assert "barangay" in flagged.flags["missing"]

        lito_planting = Planting.objects.get(crop_stand__farm__farmer__first_name="Lito")
        assert lito_planting.source is None
        assert lito_planting.notes.startswith("Sources: ")

        assert not Barangay.objects.filter(is_verified=True).exists()
        assert Barangay.objects.filter(name="Synthetic Beta").count() == 1

    def test_associations_and_harvests(self, committed):
        assert Association.objects.filter(municipality__name="Gasan").count() == 1
        assert Association.objects.filter(municipality__name="Buenavista").count() == 2
        assert Harvest.objects.count() == 5
        dried = Harvest.objects.get(product_form="dried_beans")
        assert (dried.quantity, dried.unit, dried.date_estimated) == (Decimal(6), "kg", True)
        losses = InventoryRecord.objects.get(crop_stand__farm__farmer__first_name="Elena")
        assert losses.remarks == "325 trees died in May 2023, 80 now"

    def test_audited(self, committed):
        job, _ = committed

        assert AuditLog.objects.filter(action="import.commit", object_id=str(job.pk)).exists()
        assert AuditLog.objects.filter(action="farmer.import").count() == Farmer.objects.count()
        assert (
            AuditLog.objects.filter(action="inventory.import").count()
            == InventoryRecord.objects.count()
        )

    def test_reimporting_same_file_creates_nothing(self, committed, legacy_file, admin):
        path, _ = legacy_file
        before = (Farmer.objects.count(), InventoryRecord.objects.count(), Harvest.objects.count())

        again = services.run_preview(
            services.create_job(
                actor=admin, upload=upload_of(path), kind=ImportKind.LEGACY_CACAO_2023
            )
        )
        assert again.summary["already_imported"] is True
        again = services.commit_job(job=again, actor=admin)

        assert (
            Farmer.objects.count(),
            InventoryRecord.objects.count(),
            Harvest.objects.count(),
        ) == before
        assert again.summary["commit"]["rows_already_imported"] == InventoryRecord.objects.count()

    def test_commit_twice_is_refused(self, committed, admin):
        job, _ = committed

        with pytest.raises(DomainError) as info:
            services.commit_job(job=job, actor=admin)
        assert info.value.code == "not_ready"


def test_legacy_commit_needs_approve_capability(previewed):
    job, _ = previewed
    encoder = user_with_role(Role.PROVINCIAL_ENCODER)

    with pytest.raises(DomainError) as info:
        services.commit_job(job=job, actor=encoder)

    assert info.value.status_code == 403
    job.refresh_from_db()
    assert job.status == ImportStatus.READY


def test_association_override_maps_to_existing(legacy_file, admin):
    path, _ = legacy_file
    from apps.locations.models import Municipality

    existing = Association.objects.create(
        name="Sample BV Cooperative", municipality=Municipality.objects.get(name="Buenavista")
    )
    job = services.run_preview(
        services.create_job(actor=admin, upload=upload_of(path), kind=ImportKind.LEGACY_CACAO_2023)
    )

    services.commit_job(
        job=job, actor=admin, association_overrides={"Sample BV Coop": str(existing.pk)}
    )

    jose = Farmer.objects.get(last_name="Samplebv", first_name="Jose")
    assert existing.memberships.filter(farmer=jose).exists()


def test_cli_command(legacy_file, capsys):
    from io import StringIO

    from django.core.management import call_command

    path, truth = legacy_file
    out = StringIO()

    call_command("import_legacy_cacao", str(path), stdout=out)

    text = out.getvalue()
    assert "Santa Cruz" in text
    assert "+940" in text
    total = sum(sum(t) for t in truth.true_totals.values())
    assert f"Official total for the round: {total:,} trees" in text
    assert "Sample" not in text  # no names printed


def test_cli_dry_run(legacy_file):
    from io import StringIO

    from django.core.management import call_command

    path, _ = legacy_file
    out = StringIO()

    call_command("import_legacy_cacao", str(path), "--dry-run", stdout=out)

    assert "Dry run" in out.getvalue()
    assert not Farmer.objects.exists()
