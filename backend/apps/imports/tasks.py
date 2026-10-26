import contextlib
from typing import Any

from celery import shared_task

from apps.accounts.models import User

from . import services
from .models import ImportJob


@shared_task(ignore_result=True)
def preview_import(job_id: str) -> None:
    services.run_preview(ImportJob.objects.get(pk=job_id))


@shared_task(ignore_result=True)
def commit_import(
    job_id: str, actor_id: str, association_overrides: dict[str, Any] | None = None
) -> None:
    job = ImportJob.objects.get(pk=job_id)
    actor = User.objects.get(pk=actor_id)
    # The job records the failure (status + message); there is nothing to retry.
    with contextlib.suppress(Exception):
        services.commit_job(job=job, actor=actor, association_overrides=association_overrides)


@shared_task(ignore_result=True)
def purge_import_files() -> int:
    return services.purge_old_files()
