from typing import Any

from rest_framework.permissions import SAFE_METHODS, BasePermission
from rest_framework.request import Request

from apps.accounts.roles import Cap

from .scoping import scope_for


class HasCapability(BasePermission):
    """Checks the capability the view requires for the current action.

    Views set ``action_capabilities = {"approve": Cap.APPROVE, ...}``; otherwise safe methods need
    ``read_capability`` (default VIEW_RECORDS) and unsafe ones ``write_capability`` (EDIT_RECORDS).
    Row-level access is handled by ScopedQuerySetMixin, not here.
    """

    message = "You do not have permission to perform this action."

    def has_permission(self, request: Request, view: Any) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        return scope_for(request).can(required_capability(request, view))


def required_capability(request: Request, view: Any) -> Cap:
    action = getattr(view, "action", None)
    by_action: dict[str, Cap] = getattr(view, "action_capabilities", {})
    if action in by_action:
        return by_action[action]
    if request.method in SAFE_METHODS:
        return getattr(view, "read_capability", Cap.VIEW_RECORDS)
    return getattr(view, "write_capability", Cap.EDIT_RECORDS)
