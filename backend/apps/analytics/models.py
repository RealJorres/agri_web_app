"""Read-only models over the analytics materialized views (ADR-0014).

The views are derived caches of approved/locked records: never written by application code,
always rebuildable. Official figures elsewhere still come from the live surveys selectors.
"""

from django.db import models


class StageTotal(models.Model):
    """Round x barangay x growth stage."""

    id = models.UUIDField(primary_key=True)
    survey_round = models.ForeignKey(
        "surveys.SurveyRound", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    barangay = models.ForeignKey(
        "locations.Barangay", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    municipality = models.ForeignKey(
        "locations.Municipality", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    growth_stage = models.ForeignKey(
        "catalog.GrowthStage", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    trees = models.BigIntegerField()
    area_ha = models.DecimalField(max_digits=14, decimal_places=4, null=True)
    records = models.IntegerField()
    farmers = models.IntegerField()

    class Meta:
        managed = False
        db_table = "analytics_stage_totals"

    def __str__(self) -> str:
        return f"{self.survey_round_id}/{self.barangay_id}/{self.growth_stage_id}: {self.trees}"


class RecordFact(models.Model):
    """One row per official (approved/locked) inventory record."""

    id = models.UUIDField(primary_key=True)  # the inventory record id
    survey_round = models.ForeignKey(
        "surveys.SurveyRound", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    barangay = models.ForeignKey(
        "locations.Barangay", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    municipality = models.ForeignKey(
        "locations.Municipality", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    farmer = models.ForeignKey(
        "registry.Farmer", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    crop_stand = models.ForeignKey(
        "farms.CropStand", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    commodity = models.ForeignKey(
        "catalog.Commodity", on_delete=models.DO_NOTHING, db_constraint=False, related_name="+"
    )
    trees = models.BigIntegerField()
    bearing_trees = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = "analytics_record_facts"

    def __str__(self) -> str:
        return f"{self.id}: {self.trees}"


class AnalyticsRefresh(models.Model):
    """Single row: when the views were last rebuilt (shown as "data as of" on dashboards)."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    refreshed_at = models.DateTimeField(null=True)
    duration_ms = models.PositiveIntegerField(default=0)

    def __str__(self) -> str:
        return f"refreshed {self.refreshed_at}"
