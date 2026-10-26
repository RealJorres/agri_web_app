from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.catalog.services import seed_catalog
from apps.locations.services import load_psgc, seed_municipalities


def find_psgc_file(reference_dir: Path) -> Path | None:
    candidates = sorted(
        p
        for p in reference_dir.glob("*")
        if "psgc" in p.name.lower() and p.suffix.lower() in {".xlsx", ".csv"}
    )
    return candidates[-1] if candidates else None


class Command(BaseCommand):
    help = "Seed municipalities and the catalog; load PSGC codes when data/reference/ has the file."

    def handle(self, *args: Any, **options: Any) -> None:
        created = seed_municipalities()
        self.stdout.write(f"Municipalities: {created} created")

        report = seed_catalog()
        self.stdout.write(
            f"Catalog: created {report.created or {}}, updated {report.updated or {}}"
        )

        psgc = find_psgc_file(settings.DATA_DIR / "reference")
        if psgc is None:
            self.stdout.write(
                self.style.WARNING(
                    "No PSGC file in data/reference/: municipality and barangay codes stay empty "
                    "(ADR-0005)."
                )
            )
            return
        result = load_psgc(psgc, province="Marinduque")
        self.stdout.write(
            f"PSGC: {len(result.municipalities_coded)} municipalities coded, "
            f"{result.barangays_verified} barangays verified, {result.barangays_created} created"
        )
