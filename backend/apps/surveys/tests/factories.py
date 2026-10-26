import datetime
from typing import Any

import factory

from apps.catalog.models import GrowthStage
from apps.farms.models import CropStand
from apps.farms.tests.factories import CropStandFactory, cacao
from apps.surveys.models import InventoryRecord, StageCount, SurveyRound


class SurveyRoundFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = SurveyRound

    commodity = factory.LazyFunction(cacao)
    name = factory.Sequence(lambda n: f"Test round {n}")
    as_of_date = datetime.date(2025, 6, 30)


class InventoryRecordFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = InventoryRecord

    survey_round = factory.SubFactory(SurveyRoundFactory)
    crop_stand = factory.SubFactory(CropStandFactory)


def record_with_counts(
    *,
    counts: dict[str, int | None],
    crop_stand: CropStand | None = None,
    survey_round: SurveyRound | None = None,
    **fields: Any,
) -> InventoryRecord:
    """A record with stage counts keyed by stage code, e.g. {"FRUITING": 120}."""
    extra: dict[str, Any] = dict(fields)
    if crop_stand is not None:
        extra["crop_stand"] = crop_stand
    if survey_round is not None:
        extra["survey_round"] = survey_round
    record = InventoryRecordFactory(**extra)
    stages = {s.code: s for s in GrowthStage.objects.filter(commodity=cacao())}
    for code, value in counts.items():
        StageCount.objects.create(inventory_record=record, growth_stage=stages[code], count=value)
    return record
