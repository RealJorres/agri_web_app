from rest_framework import exceptions

from common.exceptions import DomainError, _flatten_fields, exception_handler


def test_domain_error_renders_contract():
    response = exception_handler(
        DomainError("comment_required", "A comment is required.", {"body": ["Required."]}), {}
    )

    assert response is not None
    assert response.status_code == 400
    assert response.data == {
        "code": "comment_required",
        "message": "A comment is required.",
        "fields": {"body": ["Required."]},
    }


def test_validation_error_flattens_nested_fields():
    exc = exceptions.ValidationError({"stages": [{"count": ["Must be >= 0."]}], "name": ["Bad."]})

    response = exception_handler(exc, {})

    assert response is not None
    assert response.data["code"] == "validation_error"
    assert response.data["fields"] == {"stages.0.count": ["Must be >= 0."], "name": ["Bad."]}


def test_api_exception_uses_default_code():
    response = exception_handler(exceptions.NotAuthenticated(), {})

    assert response is not None
    assert response.status_code == 401
    assert response.data["code"] == "not_authenticated"
    assert response.data["fields"] == {}


def test_flatten_scalar_detail():
    assert _flatten_fields("oops") == {"non_field_errors": ["oops"]}
