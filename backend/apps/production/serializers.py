from rest_framework import serializers

from .models import Harvest


class HarvestSerializer(serializers.ModelSerializer[Harvest]):
    class Meta:
        model = Harvest
        fields = [
            "id",
            "crop_stand",
            "harvest_date",
            "date_estimated",
            "quantity",
            "unit",
            "product_form",
            "price_per_unit",
            "buyer",
            "raw_text",
            "created_at",
        ]
        read_only_fields = ["crop_stand", "created_at"]
