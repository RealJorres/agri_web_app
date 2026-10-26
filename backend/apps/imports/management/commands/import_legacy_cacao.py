"""make import-legacy FILE=data/raw/<file>.xlsx

Uploads, previews and commits the 2023 cacao workbook as the system account, then prints the
reconciliation. Prints counts and totals only: never names or other personal data."""

from pathlib import Path
from typing import Any

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.accounts.models import User
from apps.imports import services
from apps.imports.models import ImportKind, ImportStatus
from common.exceptions import DomainError


class Command(BaseCommand):
    help = "Import the legacy 2023 cacao inventory workbook (preview, then commit)."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("file", type=Path)
        parser.add_argument(
            "--user", help="Email of the user to record as importer (default: system)"
        )
        parser.add_argument("--dry-run", action="store_true", help="Preview only; write nothing")

    def handle(self, *args: Any, **options: Any) -> None:
        path: Path = options["file"]
        if not path.is_file():
            raise CommandError(f"File not found: {path}")
        actor = (
            User.objects.filter(email=options["user"]).first()
            if options["user"]
            else services.system_user()
        )
        if actor is None:
            raise CommandError(f"No user {options['user']}")

        upload = SimpleUploadedFile(path.name, path.read_bytes())
        try:
            job = services.create_job(
                actor=actor, upload=upload, kind=ImportKind.LEGACY_CACAO_2023, enforce_scope=False
            )
        except DomainError as exc:
            raise CommandError(exc.message) from None
        job = services.run_preview(job)
        if job.status != ImportStatus.READY:
            raise CommandError(f"Preview failed: {job.error_message}")
        self._print_preview(job.summary)
        if options["dry_run"]:
            self.stdout.write(self.style.WARNING("Dry run: nothing imported."))
            return
        if job.summary.get("already_imported"):
            self.stdout.write("This file was imported before; only new rows will be added.")
        job = services.commit_job(job=job, actor=actor, enforce_scope=False)
        result = job.summary["commit"]
        self.stdout.write(
            self.style.SUCCESS(
                f"Committed: {result.get('farmers', 0)} farmers, {result.get('farms', 0)} farms, "
                f"{result.get('records_approved', 0)} approved + "
                f"{result.get('records_draft', 0)} draft records, "
                f"{result.get('harvests', 0)} harvests "
                f"({result.get('rows_already_imported', 0)} rows already imported)."
            )
        )
        self.stdout.write(f"Official total for the round: {result['official_total']:,} trees")
        self.stdout.write(f"Import job: {job.pk}")

    def _print_preview(self, summary: dict[str, Any]) -> None:
        counts = summary["counts"]
        self.stdout.write(
            f"Rows: {counts.get('named_rows', 0)} named above TOTAL "
            f"({counts.get('rows_with_trees', 0)} with trees), "
            f"{counts.get('below_total_rows', 0)} below TOTAL, "
            f"{counts.get('name_only_rows', 0)} name-only, "
            f"review items: {counts.get('review_items', 0)}"
        )
        rec = summary["reconciliation"]
        stages = rec["stages"]
        self.stdout.write("\nReconciliation (farmer rows vs workbook TOTAL rows):")
        self.stdout.write(
            f"{'Municipality':<14}"
            + "".join(f"{s:>12}" for s in stages)
            + f"{'Total':>10}{'Diff':>8}"
        )
        for m in rec["municipalities"]:
            cells = "".join(f"{m['stages'][s]['computed']:>12,}" for s in stages)
            self.stdout.write(
                f"{m['municipality']:<14}{cells}{m['computed_total']:>10,}{m['diff_total']:>+8,}"
            )
        p = rec["province"]
        self.stdout.write(
            f"{'Province':<14}"
            + "".join(f"{p['computed'][s]:>12,}" for s in stages)
            + f"{p['computed_total']:>10,}{p['computed_total'] - p['workbook_total']:>+8,}"
        )
        self.stdout.write(
            f"Area at configured density: {p['area_ha']} ha; workbook total {p['workbook_total']:,}"
        )
        for line in rec["differences"]:
            self.stdout.write(self.style.WARNING(f"  - {line}"))
        for issue in summary.get("sheet_issues", []):
            self.stdout.write(self.style.WARNING(f"  ! {issue}"))
