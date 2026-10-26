import uuid
from typing import Any, ClassVar

from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models
from django.db.models import Q

from common.models import BaseModel

from .roles import Role


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def _create(self, email: str, password: str | None, **extra: Any) -> "User":
        if not email:
            raise ValueError("Email is required")
        user = self.model(email=self.normalize_email(email).lower(), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str | None = None, **extra: Any) -> "User":
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create(email, password, **extra)

    def create_superuser(self, email: str, password: str | None = None, **extra: Any) -> "User":
        extra.update(is_staff=True, is_superuser=True)
        return self._create(email, password, **extra)


class User(AbstractUser):
    """Staff account. Logs in with email; roles and scope come from UserAssignment rows."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    username = None  # type: ignore[assignment]
    email = models.EmailField(unique=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: ClassVar[list[str]] = []

    objects: ClassVar[UserManager] = UserManager()  # type: ignore[assignment]

    class Meta:
        ordering = ["email"]

    def __str__(self) -> str:
        return self.email


class UserAssignment(BaseModel):
    """One role within one scope. NULL municipality/program means "all"."""

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="assignments")
    role = models.CharField(max_length=32, choices=Role.choices)
    municipality = models.ForeignKey(
        "locations.Municipality", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    program = models.ForeignKey(
        "catalog.Program", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    # Optional narrowing for field encoders; must belong to `municipality`.
    barangays = models.ManyToManyField("locations.Barangay", blank=True, related_name="+")

    class Meta:
        ordering = ["user__email", "role"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "role", "municipality", "program"],
                condition=Q(deleted_at__isnull=True),
                nulls_distinct=False,
                name="uniq_user_assignment",
            ),
        ]

    def __str__(self) -> str:
        where = self.municipality.name if self.municipality else "all municipalities"
        return f"{self.user} - {self.get_role_display()} ({where})"
