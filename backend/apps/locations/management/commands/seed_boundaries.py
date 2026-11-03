from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.locations.boundaries import LEVELS, load_boundaries
from common.exceptions import DomainError


class Command(BaseCommand):
    help = "Load official municipality or barangay boundaries (GeoJSON or shapefile, ADR-0016)."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--file", type=Path, required=True)
        parser.add_argument("--level", choices=LEVELS, required=True)
        parser.add_argument("--province", required=True)
        parser.add_argument("--code-field", help="Attribute holding the 10-digit PSGC code")
        parser.add_argument("--name-field", help="Attribute holding the area's name")
        parser.add_argument("--parent-field", help="Barangay level: the municipality's attribute")
        parser.add_argument("--province-field", help="Attribute holding the province's name")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            report = load_boundaries(
                options["file"],
                level=options["level"],
                province=options["province"],
                code_field=options["code_field"],
                name_field=options["name_field"],
                parent_field=options["parent_field"],
                province_field=options["province_field"],
                dry_run=options["dry_run"],
            )
        except DomainError as exc:
            raise CommandError(exc.message) from None

        prefix = "[dry run] " if options["dry_run"] else ""
        self.stdout.write(
            f"{prefix}Features read: {report.features_read}, "
            f"outside the province: {report.features_outside_province}"
        )
        self.stdout.write(f"{prefix}Boundaries loaded: {len(report.loaded)}")
        for title, items in (
            ("No match in the database", report.unmatched),
            ("Ambiguous, not loaded", report.ambiguous),
            ("Unusable shape, not loaded", report.invalid),
            ("In the database, no shape in this file", report.without_shape),
        ):
            for item in items:
                self.stdout.write(self.style.WARNING(f"{title}: {item}"))
