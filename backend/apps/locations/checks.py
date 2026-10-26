from typing import Any

from django.core.checks import CheckMessage, Tags, Warning, register
from django.db import DatabaseError


@register(Tags.database, deploy=True)
def municipalities_have_psgc_codes(**kwargs: Any) -> list[CheckMessage]:
    """ADR-0005: codes come only from the official PSGC file; warn until it has been loaded."""
    from .models import Municipality

    try:
        missing = list(
            Municipality.objects.filter(psgc_code__isnull=True).values_list("name", flat=True)
        )
    except DatabaseError:
        return []  # database not migrated yet
    if not missing:
        return []
    return [
        Warning(
            f"{len(missing)} municipalities have no PSGC code: {', '.join(missing)}.",
            hint="Put the PSA PSGC file in data/reference/ and run: manage.py seed_psgc "
            "--province=Marinduque",
            id="locations.W001",
        )
    ]
