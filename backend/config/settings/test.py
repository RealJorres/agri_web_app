import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-insecure-key-at-least-32-bytes-long")
os.environ.setdefault("DATABASE_URL", "postgis://agri:agri-dev-password@db:5432/agri")
os.environ.setdefault("REDIS_URL", "redis://redis:6379/0")

from .base import *

DEBUG = False
ALLOWED_HOSTS = ["testserver", "localhost"]

# Fast hashing in tests only; production uses Argon2 (see base.PASSWORD_HASHERS).
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True

PRIVATE_MEDIA_ROOT = Path("/tmp/agri-test-private")  # noqa: S108

CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
