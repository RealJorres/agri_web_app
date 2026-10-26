import pytest

from apps.accounts.roles import Role
from apps.accounts.tests.factories import user_with_role
from apps.audit.models import AuditLog
from apps.catalog.models import GrowthStage
from apps.catalog.tests.factories import ProgramFactory
from apps.farms.tests.factories import CropStandFactory, cacao
from apps.locations.tests.factories import BarangayFactory
from apps.surveys import services
from apps.surveys.models import RecordStatus, RoundStatus, WorkflowComment
from apps.surveys.services import CountInput
from common.exceptions import DomainError

from .factories import SurveyRoundFactory, record_with_counts

pytestmark = pytest.mark.django_db
S = RecordStatus


@pytest.fixture
def gasan(municipalities):
    return municipalities["Gasan"]


@pytest.fixture
def stand(gasan):
    brgy = BarangayFactory(municipality=gasan)
    return CropStandFactory(farm__barangay=brgy, farm__farmer__home_barangay=brgy)


@pytest.fixture
def people(gasan, municipalities):
    return {
        "encoder": user_with_role(Role.PROVINCIAL_ENCODER),
        "validator": user_with_role(Role.MAO_VALIDATOR, municipality=gasan),
        "other_validator": user_with_role(Role.MAO_VALIDATOR, municipality=municipalities["Boac"]),
        "coordinator": user_with_role(Role.PROGRAM_COORDINATOR, program=cacao().program),
        "other_coordinator": user_with_role(
            Role.PROGRAM_COORDINATOR, program=ProgramFactory(code="RICE")
        ),
        "head": user_with_role(Role.PROVINCIAL_HEAD),
        "viewer": user_with_role(Role.VIEWER),
    }


def stage(code):
    return GrowthStage.objects.get(commodity=cacao(), code=code)


def test_happy_path_with_audit_and_comments(people, stand):
    survey_round = SurveyRoundFactory()
    record = services.create_record(
        actor=people["encoder"],
        survey_round=survey_round,
        crop_stand=stand,
        counts=[CountInput(stage("FRUITING"), 40), CountInput(stage("SEEDLING"), 5)],
    )
    assert record.status == S.DRAFT

    record = services.submit(actor=people["encoder"], record=record)
    assert record.status == S.SUBMITTED
    assert record.submitted_at

    record = services.validate(actor=people["validator"], record=record, comment="Checked on site")
    assert record.status == S.VALIDATED
    assert record.validated_by == people["validator"]

    record = services.approve(actor=people["coordinator"], record=record)
    assert record.status == S.APPROVED
    assert record.approved_by == people["coordinator"]

    assert services.close_round(actor=people["coordinator"], survey_round=survey_round) == 1
    record.refresh_from_db()
    assert record.status == S.LOCKED
    survey_round.refresh_from_db()
    assert survey_round.status == RoundStatus.CLOSED

    actions = list(
        AuditLog.objects.filter(object_id=str(record.pk))
        .order_by("created_at")
        .values_list("action", flat=True)
    )
    assert actions == [
        "inventory.create",
        "inventory.submit",
        "inventory.validate",
        "inventory.approve",
        "inventory.lock",
    ]
    assert list(record.comments.values_list("action", "body")) == [("validate", "Checked on site")]


# Who may perform each action on a record in the given status (Gasan record, cacao program).
# MAO validators may edit drafts but do not submit them: they validate what encoders submit.
ALLOWED = {
    ("submit", S.DRAFT): {"encoder"},
    ("validate", S.SUBMITTED): {"validator"},
    ("approve", S.VALIDATED): {"coordinator"},
    ("return", S.SUBMITTED): {"validator"},
    ("return", S.VALIDATED): {"coordinator"},
    ("reopen", S.APPROVED): {"coordinator"},
    ("reopen", S.LOCKED): {"coordinator"},
}

ACTIONS = {
    "submit": lambda actor, record: services.submit(actor=actor, record=record),
    "validate": lambda actor, record: services.validate(actor=actor, record=record),
    "approve": lambda actor, record: services.approve(actor=actor, record=record),
    "return": lambda actor, record: services.return_record(actor=actor, record=record, comment="x"),
    "reopen": lambda actor, record: services.reopen(actor=actor, record=record, comment="x"),
}


@pytest.mark.parametrize("action", list(ACTIONS))
@pytest.mark.parametrize("status", list(S))
@pytest.mark.parametrize(
    "who",
    [
        "encoder",
        "validator",
        "other_validator",
        "coordinator",
        "other_coordinator",
        "head",
        "viewer",
    ],
)
def test_transition_matrix(action, status, who, people, stand):
    record = record_with_counts(counts={"FRUITING": 10}, crop_stand=stand, status=status)
    allowed = who in ALLOWED.get((action, status), set())

    if allowed:
        ACTIONS[action](people[who], record)
        return
    with pytest.raises(DomainError) as info:
        ACTIONS[action](people[who], record)
    assert info.value.status_code in (403, 409)
    record.refresh_from_db()
    assert record.status == status  # nothing changed


@pytest.mark.parametrize(
    ("status", "action", "who"),
    [
        (S.SUBMITTED, "return", "validator"),
        (S.VALIDATED, "return", "coordinator"),
        (S.APPROVED, "reopen", "coordinator"),
    ],
)
def test_return_and_reopen_require_comment(status, action, who, people, stand):
    record = record_with_counts(counts={"FRUITING": 10}, crop_stand=stand, status=status)
    fn = services.return_record if action == "return" else services.reopen

    with pytest.raises(DomainError) as info:
        fn(actor=people[who], record=record, comment="   ")

    assert info.value.code == "comment_required"


def test_reopen_bumps_version_clears_stamps_and_keeps_comment(people, stand):
    record = record_with_counts(counts={"FRUITING": 10}, crop_stand=stand, status=S.LOCKED)
    record.approved_by = people["coordinator"]
    record.save()

    record = services.reopen(actor=people["coordinator"], record=record, comment="Recount needed")

    assert (record.status, record.version, record.approved_by) == (S.DRAFT, 2, None)
    assert WorkflowComment.objects.get(inventory_record=record).body == "Recount needed"
    entry = AuditLog.objects.get(action="inventory.reopen")
    assert entry.before == {"status": "locked", "version": 1}
    assert entry.after["version"] == 2


def test_reopened_record_can_be_corrected_in_closed_round_and_locks_on_approval(people, stand):
    survey_round = SurveyRoundFactory(status=RoundStatus.CLOSED)
    record = record_with_counts(
        counts={"FRUITING": 10}, crop_stand=stand, survey_round=survey_round, status=S.LOCKED
    )
    record = services.reopen(actor=people["coordinator"], record=record, comment="fix")

    services.update_record(
        actor=people["encoder"], record=record, counts=[CountInput(stage("FRUITING"), 12)]
    )
    record = services.submit(actor=people["encoder"], record=record)
    record = services.validate(actor=people["validator"], record=record)
    record = services.approve(actor=people["coordinator"], record=record)

    assert record.status == S.LOCKED


class TestEditing:
    def test_draft_editable_by_encoder_and_audited(self, people, stand):
        record = record_with_counts(counts={"FRUITING": 10}, crop_stand=stand)

        services.update_record(
            actor=people["encoder"],
            record=record,
            counts=[CountInput(stage("FRUITING"), 15), CountInput(stage("VEGETATIVE"), 3)],
            remarks=" New remark ",
        )

        entry = AuditLog.objects.get(action="inventory.update")
        assert entry.before == {"counts": {"FRUITING": 10}, "remarks": ""}
        assert entry.after == {"counts": {"FRUITING": 15, "VEGETATIVE": 3}, "remarks": "New remark"}

    def test_validator_may_edit_submitted_but_encoder_may_not(self, people, stand):
        record = record_with_counts(counts={"FRUITING": 10}, crop_stand=stand, status=S.SUBMITTED)

        services.update_record(actor=people["validator"], record=record, remarks="corrected")
        with pytest.raises(DomainError) as info:
            services.update_record(actor=people["encoder"], record=record, remarks="nope")

        assert info.value.code == "not_editable"

    @pytest.mark.parametrize("status", [S.VALIDATED, S.APPROVED, S.LOCKED])
    def test_nobody_edits_after_validation(self, status, people, stand):
        record = record_with_counts(counts={"FRUITING": 10}, crop_stand=stand, status=status)

        for who in ("encoder", "validator", "coordinator"):
            with pytest.raises(DomainError):
                services.update_record(actor=people[who], record=record, remarks="x")

    def test_counts_must_belong_to_commodity_and_be_unique(self, people, stand):
        from apps.catalog.models import Commodity

        record = record_with_counts(counts={}, crop_stand=stand)
        coffee = Commodity.objects.create(
            program=cacao().program, code="COFFEE", name="Coffee", measure_type="trees"
        )
        foreign = GrowthStage.objects.create(commodity=coffee, code="X", label="X", sort_order=1)

        with pytest.raises(DomainError) as info:
            services.update_record(
                actor=people["encoder"], record=record, counts=[CountInput(foreign, 1)]
            )
        assert info.value.code == "stage_mismatch"
        with pytest.raises(DomainError) as info:
            services.update_record(
                actor=people["encoder"],
                record=record,
                counts=[CountInput(stage("FRUITING"), 1), CountInput(stage("FRUITING"), 2)],
            )
        assert info.value.code == "duplicate_stage"
        with pytest.raises(DomainError) as info:
            services.update_record(
                actor=people["encoder"], record=record, counts=[CountInput(stage("FRUITING"), -1)]
            )
        assert info.value.code == "negative_count"

    def test_delete_only_drafts(self, people, stand):
        draft = record_with_counts(counts={}, crop_stand=stand)
        services.delete_record(actor=people["encoder"], record=draft)
        assert draft.__class__.all_objects.get(pk=draft.pk).is_deleted

        submitted = record_with_counts(
            counts={"FRUITING": 1},
            crop_stand=CropStandFactory(farm=stand.farm, commodity=_coffee()),
            status=S.SUBMITTED,
        )
        with pytest.raises(DomainError):
            services.delete_record(actor=people["validator"], record=submitted)


def _coffee():
    from apps.catalog.models import Commodity

    return Commodity.objects.get_or_create(
        code="COFFEE",
        defaults={"program": cacao().program, "name": "Coffee", "measure_type": "trees"},
    )[0]


class TestCreate:
    def test_round_must_be_open(self, people, stand):
        with pytest.raises(DomainError) as info:
            services.create_record(
                actor=people["encoder"],
                survey_round=SurveyRoundFactory(status=RoundStatus.CLOSED),
                crop_stand=stand,
            )
        assert info.value.code == "round_closed"

    def test_commodity_must_match_round(self, people, stand):
        coffee_round = SurveyRoundFactory(commodity=_coffee())

        with pytest.raises(DomainError) as info:
            services.create_record(
                actor=people["encoder"], survey_round=coffee_round, crop_stand=stand
            )
        assert info.value.code == "commodity_mismatch"

    def test_one_record_per_stand_per_round(self, people, stand):
        survey_round = SurveyRoundFactory()
        services.create_record(actor=people["encoder"], survey_round=survey_round, crop_stand=stand)

        with pytest.raises(DomainError) as info:
            services.create_record(
                actor=people["encoder"], survey_round=survey_round, crop_stand=stand
            )
        assert info.value.status_code == 409

    def test_scope(self, people, stand):
        with pytest.raises(DomainError):
            services.create_record(
                actor=people["other_validator"], survey_round=SurveyRoundFactory(), crop_stand=stand
            )


class TestSubmitRules:
    def test_empty_record_is_blocked(self, people, stand):
        record = record_with_counts(counts={"FRUITING": 0}, crop_stand=stand)

        with pytest.raises(DomainError) as info:
            services.submit(actor=people["encoder"], record=record)

        assert info.value.code == "validation_failed"
        assert "counts" in info.value.fields
        record.refresh_from_db()
        assert record.status == S.DRAFT

    def test_remark_allows_zero_counts(self, people, stand):
        record = record_with_counts(
            counts={}, crop_stand=stand, remarks="All trees lost to typhoon"
        )

        assert services.submit(actor=people["encoder"], record=record).status == S.SUBMITTED

    def test_warnings_saved_in_flags(self, people, stand):
        survey_round = SurveyRoundFactory()
        brgy = stand.farm.barangay
        for _ in range(5):
            peer = CropStandFactory(farm__barangay=brgy, farm__farmer__home_barangay=brgy)
            record_with_counts(
                counts={"FRUITING": 100},
                crop_stand=peer,
                survey_round=survey_round,
                status=S.APPROVED,
            )
        record = record_with_counts(
            counts={"VEGETATIVE": 10_500}, crop_stand=stand, survey_round=survey_round
        )

        record = services.submit(actor=people["encoder"], record=record)

        codes = [w["code"] for w in record.flags["warnings"]]
        assert codes == ["outlier"]
        assert record.flags["warnings"][0]["data"]["median"] == "100"

    def test_closed_round_blocks_submit_of_original_drafts(self, people, stand):
        record = record_with_counts(
            counts={"FRUITING": 1},
            crop_stand=stand,
            survey_round=SurveyRoundFactory(status=RoundStatus.CLOSED),
        )

        with pytest.raises(DomainError) as info:
            services.submit(actor=people["encoder"], record=record)
        assert info.value.code == "round_closed"


class TestRounds:
    def test_open_requires_manage_rounds_for_program(self, people):
        import datetime

        with pytest.raises(DomainError):
            services.open_round(
                actor=people["other_coordinator"],
                commodity=cacao(),
                name="X",
                as_of_date=datetime.date(2025, 1, 1),
            )
        survey_round = services.open_round(
            actor=people["coordinator"],
            commodity=cacao(),
            name=" Cacao 2025 ",
            as_of_date=datetime.date(2025, 1, 1),
        )
        assert survey_round.name == "Cacao 2025"
        with pytest.raises(DomainError) as info:
            services.open_round(
                actor=people["coordinator"],
                commodity=cacao(),
                name="Cacao 2025",
                as_of_date=datetime.date(2025, 1, 1),
            )
        assert info.value.code == "duplicate_round"

    def test_close_refuses_with_pending_records(self, people, stand):
        survey_round = SurveyRoundFactory()
        record_with_counts(
            counts={"FRUITING": 1}, crop_stand=stand, survey_round=survey_round, status=S.VALIDATED
        )

        with pytest.raises(DomainError) as info:
            services.close_round(actor=people["coordinator"], survey_round=survey_round)
        assert info.value.code == "pending_records"

    def test_close_twice(self, people):
        survey_round = SurveyRoundFactory()
        services.close_round(actor=people["coordinator"], survey_round=survey_round)

        with pytest.raises(DomainError) as info:
            services.close_round(actor=people["coordinator"], survey_round=survey_round)
        assert info.value.code == "round_closed"


@pytest.mark.parametrize(
    ("status", "who", "expected"),
    [
        (S.DRAFT, "encoder", ["edit", "submit"]),
        (S.DRAFT, "validator", ["edit"]),
        (S.SUBMITTED, "validator", ["edit", "validate", "return"]),
        (S.SUBMITTED, "encoder", []),
        (S.VALIDATED, "coordinator", ["approve", "return"]),
        (S.APPROVED, "coordinator", ["reopen"]),
        (S.LOCKED, "viewer", []),
    ],
)
def test_allowed_actions(status, who, expected, people, stand):
    from apps.accounts.selectors import get_scope

    record = record_with_counts(counts={"FRUITING": 1}, crop_stand=stand, status=status)

    assert services.allowed_actions(get_scope(people[who]), record) == expected
