from rest_framework import serializers

from .models import Barangay, Municipality


class MunicipalitySerializer(serializers.ModelSerializer[Municipality]):
    class Meta:
        model = Municipality
        fields = ["id", "name", "psgc_code"]


class BarangaySerializer(serializers.ModelSerializer[Barangay]):
    class Meta:
        model = Barangay
        fields = ["id", "name", "psgc_code", "municipality", "is_verified"]
