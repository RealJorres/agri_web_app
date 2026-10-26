from django.core.exceptions import ImproperlyConfigured

from .base import *

# Never configurable: production always runs with DEBUG off.
DEBUG = False

if not ALLOWED_HOSTS:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS must be set in production")

# The schema is not secret, but there is no reason to publish it anonymously.
SPECTACULAR_SETTINGS["SERVE_PERMISSIONS"] = ["rest_framework.permissions.IsAuthenticated"]

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = env.bool("DJANGO_SECURE_SSL_REDIRECT", default=True)
SECURE_HSTS_SECONDS = env.int("DJANGO_HSTS_SECONDS", default=60 * 60 * 24 * 365)
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_SECURE = True
X_FRAME_OPTIONS = "DENY"
