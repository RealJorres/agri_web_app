from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.locations.services import load_psgc
from common.exceptions import DomainError
from common.management.commands.seed import find_psgc_file


class Command(BaseCommand):
    help = "Load official PSGC codes for one province's municipalities and barangays."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--province", required=True)
        parser.add_argument(
            "--file", type=Path, help="Defaults to the PSGC file in data/reference/"
        )
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args: Any, **options: Any) -> None:
        path: Path | None = options["file"] or find_psgc_file(settings.DATA_DIR / "reference")
        if path is None or not path.exists():
            raise CommandError("PSGC file not found. Put it in data/reference/ or pass --file.")
        try:
            report = load_psgc(path, province=options["province"], dry_run=options["dry_run"])
        except DomainError as exc:
            raise CommandError(exc.message) from None

        prefix = "[dry run] " if options["dry_run"] else ""
        self.stdout.write(f"{prefix}Municipalities coded: {', '.join(report.municipalities_coded)}")
        if report.municipalities_missing:
            self.stdout.write(
                self.style.WARNING(f"Not in database: {', '.join(report.municipalities_missing)}")
            )
        self.stdout.write(
            f"Barangays verified: {report.barangays_verified}, created: {report.barangays_created}"
        )
        for name in report.barangays_unmatched:
            self.stdout.write(self.style.WARNING(f"Unverified barangay (no PSGC match): {name}"))
