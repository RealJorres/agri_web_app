"""Per-request metadata (IP, user agent) for audit entries, set by AuditContextMiddleware."""

from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass

from django.conf import settings
from django.http import HttpRequest, HttpResponse


@dataclass(frozen=True)
class RequestMeta:
    ip: str | None = None
    user_agent: str = ""


_EMPTY = RequestMeta()
_current: ContextVar[RequestMeta | None] = ContextVar("audit_request_meta", default=None)


def current_meta() -> RequestMeta:
    return _current.get() or _EMPTY


def client_ip(request: HttpRequest) -> str | None:
    proxies: int = getattr(settings, "AUDIT_TRUSTED_PROXY_COUNT", 0)
    if proxies:
        forwarded = [p.strip() for p in request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")]
        if len(forwarded) >= proxies and forwarded[-proxies]:
            return forwarded[-proxies]
    return request.META.get("REMOTE_ADDR") or None


class AuditContextMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        token = _current.set(
            RequestMeta(
                ip=client_ip(request),
                user_agent=request.META.get("HTTP_USER_AGENT", "")[:300],
            )
        )
        try:
            return self.get_response(request)
        finally:
            _current.reset(token)
