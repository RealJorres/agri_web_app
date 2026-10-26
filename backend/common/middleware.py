from collections.abc import Callable

from django.http import HttpRequest, HttpResponse

# JSON/XLSX API responses never need to run scripts, load resources or be framed.
API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"


class SecurityHeadersMiddleware:
    """Defence-in-depth headers. The SPA's own CSP is set by the web server serving it."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        response.setdefault("Permissions-Policy", PERMISSIONS_POLICY)
        if request.path.startswith(("/api/v1/", "/api/health")):
            response.setdefault("Content-Security-Policy", API_CSP)
            response.setdefault("Cache-Control", "no-store")  # responses may hold personal data
        return response
