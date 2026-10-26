from django.db import models
from django.db.models import Q

from common.models import BaseModel


class Program(BaseModel):
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=200)

    class Meta:
        ordering = ["code"]
        constraints = [
            models.UniqueConstraint(
                fields=["code"], condition=Q(deleted_at__isnull=True), name="uniq_program_code"
            ),
        ]

    def __str__(self) -> str:
        return self.code
