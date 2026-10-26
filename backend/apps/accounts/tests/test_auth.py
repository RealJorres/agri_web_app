import pytest
from django.conf import settings
from django.urls import reverse
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from apps.accounts.roles import Role

from .factories import TEST_PASSWORD, UserFactory, user_with_role

pytestmark = pytest.mark.django_db

ORIGIN = "http://testserver"
COOKIE = settings.REFRESH_COOKIE_NAME


@pytest.fixture
def browser() -> APIClient:
    """A client that behaves like the SPA: CSRF enforced, Origin header sent."""
    client = APIClient(enforce_csrf_checks=True, HTTP_ORIGIN=ORIGIN)
    token = client.get(reverse("v1:auth-csrf")).json()["csrf_token"]
    client.credentials(HTTP_X_CSRFTOKEN=token)
    return client


def login(client: APIClient, email: str, password: str = TEST_PASSWORD):
    return client.post(reverse("v1:auth-login"), {"email": email, "password": password})


def test_login_returns_access_token_and_sets_refresh_cookie(browser, municipalities):
    user = user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Gasan"])

    response = login(browser, user.email)

    assert response.status_code == 200
    body = response.json()
    assert body["access"]
    assert "refresh" not in body
    assert body["user"]["roles"] == ["mao_validator"]
    assert body["user"]["assignments"][0]["municipality"]["name"] == "Gasan"
    cookie = response.cookies[COOKIE]
    assert cookie["httponly"] is True
    assert cookie["secure"] is True
    assert cookie["samesite"] == "Lax"
    assert cookie["path"] == "/api/v1/auth/"
    assert int(cookie["max-age"]) == 7 * 24 * 3600


def test_login_email_is_case_insensitive(browser):
    user = UserFactory(email="mixed@example.test")

    assert login(browser, "  MIXED@example.test").status_code == 200
    assert user.pk


def test_login_wrong_password_uses_error_contract(browser):
    user = UserFactory()

    response = login(browser, user.email, "wrong-password")

    assert response.status_code == 401
    assert response.json() == {
        "code": "invalid_credentials",
        "message": "Email or password is incorrect.",
        "fields": {},
    }
    assert COOKIE not in response.cookies


def test_login_inactive_user_rejected(browser):
    user = UserFactory(is_active=False)

    assert login(browser, user.email).status_code == 401


def test_login_requires_csrf_token():
    client = APIClient(enforce_csrf_checks=True, HTTP_ORIGIN=ORIGIN)
    user = UserFactory()

    response = login(client, user.email)

    assert response.status_code == 403
    assert response.json()["code"] == "permission_denied"


def test_login_rejects_foreign_origin(browser):
    user = UserFactory()
    browser.credentials(
        HTTP_X_CSRFTOKEN=browser.cookies["csrftoken"].value, HTTP_ORIGIN="https://evil.example"
    )

    assert login(browser, user.email).status_code == 403


def test_lockout_after_five_failures(browser):
    user = UserFactory()
    for _ in range(5):
        login(browser, user.email, "wrong-password")

    response = login(browser, user.email)  # correct password, but locked

    assert response.status_code == 429
    assert response.json()["code"] == "locked_out"


def test_refresh_rotates_token_and_blacklists_old_one(browser):
    user = UserFactory()
    login(browser, user.email)
    first = browser.cookies[COOKIE].value

    response = browser.post(reverse("v1:auth-refresh"))

    assert response.status_code == 200
    assert response.json()["access"]
    second = response.cookies[COOKIE].value
    assert second != first
    assert BlacklistedToken.objects.filter(token__token=first).exists()


def test_reusing_rotated_refresh_token_revokes_all_sessions(browser):
    user = UserFactory()
    login(browser, user.email)
    stolen = browser.cookies[COOKIE].value
    browser.post(reverse("v1:auth-refresh"))  # legitimate rotation
    current = browser.cookies[COOKIE].value

    browser.cookies[COOKIE] = stolen
    reuse = browser.post(reverse("v1:auth-refresh"))

    assert reuse.status_code == 401
    assert reuse.cookies[COOKIE].value == ""  # cookie cleared
    live = OutstandingToken.objects.filter(user=user, blacklistedtoken__isnull=True)
    assert not live.exists()
    browser.cookies[COOKIE] = current
    assert browser.post(reverse("v1:auth-refresh")).status_code == 401


def test_refresh_without_cookie_is_401(browser):
    response = browser.post(reverse("v1:auth-refresh"))

    assert response.status_code == 401
    assert response.json()["code"] == "token_invalid"


def test_refresh_with_garbage_cookie_is_401(browser):
    browser.cookies[COOKIE] = "not-a-jwt"

    assert browser.post(reverse("v1:auth-refresh")).status_code == 401


def test_refresh_fails_after_user_deactivated(browser):
    user = UserFactory()
    login(browser, user.email)
    user.is_active = False
    user.save()

    assert browser.post(reverse("v1:auth-refresh")).status_code == 401


def test_refresh_requires_csrf(browser):
    user = UserFactory()
    login(browser, user.email)
    browser.credentials(HTTP_ORIGIN=ORIGIN)  # drop the CSRF header

    assert browser.post(reverse("v1:auth-refresh")).status_code == 403


def test_logout_blacklists_refresh_and_clears_cookie(browser):
    user = UserFactory()
    login(browser, user.email)
    refresh = browser.cookies[COOKIE].value

    response = browser.post(reverse("v1:auth-logout"))

    assert response.status_code == 204
    assert response.cookies[COOKIE].value == ""
    assert BlacklistedToken.objects.filter(token__token=refresh).exists()


def test_logout_without_session_is_harmless(browser):
    assert browser.post(reverse("v1:auth-logout")).status_code == 204


def test_access_token_authenticates_me(browser, municipalities):
    user = user_with_role(Role.FIELD_ENCODER, municipality=municipalities["Boac"])
    access = login(browser, user.email).json()["access"]

    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    response = client.get(reverse("v1:auth-me"))

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == user.email
    assert "edit_records" in body["capabilities"]
    assert "approve" not in body["capabilities"]


def test_me_requires_authentication(api_client):
    response = api_client.get(reverse("v1:auth-me"))

    assert response.status_code == 401
    assert response.json()["code"] == "not_authenticated"


def test_superuser_acts_as_system_admin(auth_client):
    admin = UserFactory(is_superuser=True, is_staff=True)

    body = auth_client(admin).get(reverse("v1:auth-me")).json()

    assert body["roles"] == ["system_admin"]
    assert "admin" in body["capabilities"]
