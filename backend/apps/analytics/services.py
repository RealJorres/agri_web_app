"""Refresh of the analytics views (ADR-0014). The only writer: REFRESH MATERIALIZED VIEW."""

import time

from django.core.cache import cache
from django.db import connection, transaction
from django.utils import timezone

from .models import AnalyticsRefresh

VIEWS = ("analytics_stage_totals", "analytics_record_facts")
DEBOUNCE_KEY = "analytics:refresh-scheduled"
DEBOUNCE_SECONDS = 30
BATCH_DELAY_SECONDS = 5


def refresh_views() -> AnalyticsRefresh:
    """Rebuild both views without blocking readers (needs their unique indexes)."""
    started = time.monotonic()
    with connection.cursor() as cursor:
        for view in VIEWS:
            cursor.execute(f"REFRESH MATERIALIZED VIEW CONCURRENTLY {view}")
    state, _ = AnalyticsRefresh.objects.get_or_create(pk=1)
    state.refreshed_at = timezone.now()
    state.duration_ms = int((time.monotonic() - started) * 1000)
    state.save()
    return state


def schedule_refresh() -> None:
    """Call from any service that changes official numbers. Runs after the transaction commits,
    at most once per debounce window, so a bulk approval triggers one refresh."""

    def enqueue() -> None:
        if cache.add(DEBOUNCE_KEY, 1, timeout=DEBOUNCE_SECONDS):
            from .tasks import refresh_analytics

            refresh_analytics.apply_async(countdown=BATCH_DELAY_SECONDS)

    transaction.on_commit(enqueue)


def last_refresh() -> AnalyticsRefresh | None:
    return AnalyticsRefresh.objects.filter(pk=1).first()
