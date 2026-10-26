"""Roles and the capabilities each one grants (brief §7).

Scoping (which municipalities/programs/barangays) comes from the assignment; capabilities say what
the role may do inside that scope. Views and services check capabilities, never role names.
"""

from enum import StrEnum

from django.db import models


class Role(models.TextChoices):
    SYSTEM_ADMIN = "system_admin", "System admin"
    PROVINCIAL_HEAD = "provincial_head", "Provincial head"
    PROGRAM_COORDINATOR = "program_coordinator", "Program coordinator"
    PROVINCIAL_ENCODER = "provincial_encoder", "Provincial encoder"
    MAO_VALIDATOR = "mao_validator", "MAO validator"
    FIELD_ENCODER = "field_encoder", "Field encoder"
    VIEWER = "viewer", "Viewer"


class Cap(StrEnum):
    VIEW_AGGREGATES = "view_aggregates"
    VIEW_RECORDS = "view_records"  # record-level endpoints (ADR-0010)
    VIEW_PERSONAL_DATA = "view_personal_data"
    EDIT_RECORDS = "edit_records"  # create/edit farmers, farms, drafts
    SUBMIT = "submit"
    VALIDATE = "validate"
    APPROVE = "approve"
    REOPEN = "reopen"
    MANAGE_ROUNDS = "manage_rounds"
    RUN_IMPORTS = "run_imports"
    MERGE_FARMERS = "merge_farmers"
    EXPORT_PERSONAL_DATA = "export_personal_data"
    ADMIN = "admin"


_READ = {Cap.VIEW_AGGREGATES, Cap.VIEW_RECORDS, Cap.VIEW_PERSONAL_DATA}

ROLE_CAPABILITIES: dict[str, frozenset[Cap]] = {
    Role.SYSTEM_ADMIN: frozenset(Cap),
    Role.PROVINCIAL_HEAD: frozenset(_READ | {Cap.EXPORT_PERSONAL_DATA}),
    Role.PROGRAM_COORDINATOR: frozenset(
        _READ
        | {
            Cap.APPROVE,
            Cap.REOPEN,
            Cap.MANAGE_ROUNDS,
            Cap.MERGE_FARMERS,
            Cap.EXPORT_PERSONAL_DATA,
        }
    ),
    Role.PROVINCIAL_ENCODER: frozenset(_READ | {Cap.EDIT_RECORDS, Cap.SUBMIT, Cap.RUN_IMPORTS}),
    Role.MAO_VALIDATOR: frozenset(_READ | {Cap.EDIT_RECORDS, Cap.VALIDATE}),
    Role.FIELD_ENCODER: frozenset(_READ | {Cap.EDIT_RECORDS, Cap.SUBMIT}),
    Role.VIEWER: frozenset({Cap.VIEW_AGGREGATES}),
}

# Roles whose assignment may be narrowed to specific barangays.
BARANGAY_SCOPED_ROLES = frozenset({Role.FIELD_ENCODER})
