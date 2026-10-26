"""Production settings must fail closed. Each case imports settings in a fresh interpreter."""

import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

PROD_ENV = {
    "DJANGO_SETTINGS_MODULE": "config.settings.prod",
    "DJANGO_SECRET_KEY": "x" * 50,
    "DJANGO_ALLOWED_HOSTS": "agri.example.gov.ph",
    "DATABASE_URL": "postgis://u:p@db:5432/agri",
    "REDIS_URL": "redis://redis:6379/0",
}

PROBE = (
    "import django; django.setup(); from django.conf import settings as s; "
    "print(s.DEBUG, s.SECURE_SSL_REDIRECT, s.SECURE_HSTS_SECONDS > 0, "
    "s.SESSION_COOKIE_SECURE, s.CSRF_COOKIE_SECURE)"
)


def run_probe(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    base = {k: v for k, v in os.environ.items() if not k.startswith(("DJANGO_", "DATABASE_"))}
    return subprocess.run(  # noqa: S603
        [sys.executable, "-c", PROBE],
        cwd=BACKEND_DIR,
        env={**base, **env},
        capture_output=True,
        text=True,
        check=False,
    )


def test_prod_settings_are_secure():
    result = run_probe(PROD_ENV)

    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["False", "True", "True", "True", "True"]


def test_prod_ignores_debug_env_var():
    result = run_probe({**PROD_ENV, "DJANGO_DEBUG": "true"})

    assert result.stdout.split()[0] == "False"


def test_prod_requires_secret_key():
    env = {k: v for k, v in PROD_ENV.items() if k != "DJANGO_SECRET_KEY"}

    result = run_probe(env)

    assert result.returncode != 0
    assert "DJANGO_SECRET_KEY" in result.stderr


def test_prod_requires_allowed_hosts():
    env = {k: v for k, v in PROD_ENV.items() if k != "DJANGO_ALLOWED_HOSTS"}

    result = run_probe(env)

    assert result.returncode != 0
    assert "DJANGO_ALLOWED_HOSTS" in result.stderr
