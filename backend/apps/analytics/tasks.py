from celery import shared_task
from django.core.cache import cache

from . import services


@shared_task(ignore_result=True)
def refresh_analytics() -> None:
    # Clear the debounce flag first: changes committed during the refresh schedule another one.
    cache.delete(services.DEBOUNCE_KEY)
    services.refresh_views()
