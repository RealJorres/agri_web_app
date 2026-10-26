"""Auth endpoints. Access tokens travel in the JSON body (kept in memory by the SPA); refresh tokens
only in an httpOnly cookie scoped to /api/v1/auth/. Cookie-reading endpoints enforce CSRF."""

from typing import Any, cast

from django.conf import settings
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.middleware.csrf import get_token
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.authentication import CSRFCheck
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from common.exceptions import DomainError

from . import services
from .models import User
from .serializers import (
    AccessTokenSerializer,
    LoginResponseSerializer,
    LoginSerializer,
    MeSerializer,
)


def _enforce_csrf(request: Request) -> None:
    """Django's CSRF check (token + Origin/Referer); DRF views are csrf_exempt by default."""

    def no_op(_request: HttpRequest) -> HttpResponse:
        return HttpResponse()

    check = CSRFCheck(no_op)
    check.process_request(request._request)
    reason = check.process_view(request._request, no_op, (), {})
    if reason:
        raise PermissionDenied(f"CSRF failed: {reason}")


def _set_refresh_cookie(response: Response, refresh: str) -> None:
    jwt = settings.SIMPLE_JWT
    response.set_cookie(
        settings.REFRESH_COOKIE_NAME,
        refresh,
        max_age=int(jwt["REFRESH_TOKEN_LIFETIME"].total_seconds()),
        path=settings.REFRESH_COOKIE_PATH,
        secure=settings.REFRESH_COOKIE_SECURE,
        httponly=True,
        samesite="Lax",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        settings.REFRESH_COOKIE_NAME, path=settings.REFRESH_COOKIE_PATH, samesite="Lax"
    )


class AuthView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"


class CsrfView(AuthView):
    """Sets the csrftoken cookie; the SPA calls this once before login/refresh."""

    @extend_schema(responses={200: OpenApiResponse(description="CSRF cookie set")})
    def get(self, request: Request) -> Response:
        return Response({"csrf_token": get_token(request._request)})


class LoginView(AuthView):
    throttle_scope = "login"

    @extend_schema(request=LoginSerializer, responses=LoginResponseSerializer)
    def post(self, request: Request) -> Response:
        _enforce_csrf(request)
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user, tokens = services.login(
            request=request._request,
            email=serializer.validated_data["email"],
            password=serializer.validated_data["password"],
        )
        response = Response({"access": tokens.access, "user": MeSerializer(user).data})
        _set_refresh_cookie(response, tokens.refresh)
        return response


class RefreshView(AuthView):
    @extend_schema(request=None, responses=AccessTokenSerializer)
    def post(self, request: Request) -> Response:
        _enforce_csrf(request)
        raw = request.COOKIES.get(settings.REFRESH_COOKIE_NAME, "")
        try:
            tokens = services.rotate_refresh(raw)
        except DomainError as exc:
            response = Response(
                {"code": exc.code, "message": exc.message, "fields": {}}, status=exc.status_code
            )
            _clear_refresh_cookie(response)
            return response
        response = Response({"access": tokens.access})
        _set_refresh_cookie(response, tokens.refresh)
        return response


class LogoutView(AuthView):
    @extend_schema(request=None, responses={204: None})
    def post(self, request: Request) -> Response:
        _enforce_csrf(request)
        services.revoke_refresh(request.COOKIES.get(settings.REFRESH_COOKIE_NAME))
        response = Response(status=status.HTTP_204_NO_CONTENT)
        _clear_refresh_cookie(response)
        return response


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses=MeSerializer)
    def get(self, request: Request) -> Response:
        return Response(MeSerializer(cast(User, request.user)).data)


def lockout_response(request: HttpRequest, *args: Any, **kwargs: Any) -> JsonResponse:
    """django-axes lockout handler (AXES_LOCKOUT_CALLABLE): same error contract as the API."""
    return JsonResponse(
        {
            "code": "locked_out",
            "message": "Too many failed sign-in attempts. Try again later.",
            "fields": {},
        },
        status=status.HTTP_429_TOO_MANY_REQUESTS,
    )
