from django.contrib.gis import admin

from .models import Barangay, Municipality


@admin.register(Municipality)
class MunicipalityAdmin(admin.GISModelAdmin):
    list_display = ["name", "psgc_code"]
    search_fields = ["name", "psgc_code"]


@admin.register(Barangay)
class BarangayAdmin(admin.GISModelAdmin):
    list_display = ["name", "municipality", "psgc_code", "is_verified"]
    list_filter = ["municipality", "is_verified"]
    search_fields = ["name", "psgc_code"]
