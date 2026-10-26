from typing import Any

from rest_framework import serializers

from apps.catalog.models import Commodity
from apps.surveys.models import SurveyRound

from .models import ImportJob, ImportKind


class ImportJobSerializer(serializers.ModelSerializer[ImportJob]):
    uploaded_by = serializers.SerializerMethodField()
    has_error_report = serializers.SerializerMethodField()

    class Meta:
        model = ImportJob
        fields = [
            "id",
            "kind",
            "status",
            "original_name",
            "file_size",
            "commodity",
            "survey_round",
            "uploaded_by",
            "created_at",
            "committed_at",
            "error_message",
            "has_error_report",
            "summary",
        ]

    def get_uploaded_by(self, obj: ImportJob) -> str:
        return obj.uploaded_by.get_full_name() or obj.uploaded_by.email

    def get_has_error_report(self, obj: ImportJob) -> bool:
        return bool(obj.error_report)


class ImportJobListSerializer(ImportJobSerializer):
    class Meta(ImportJobSerializer.Meta):
        fields = [f for f in ImportJobSerializer.Meta.fields if f != "summary"]


class UploadSerializer(serializers.Serializer[Any]):
    file = serializers.FileField()
    kind = serializers.ChoiceField(choices=ImportKind.choices)
    survey_round = serializers.PrimaryKeyRelatedField(
        queryset=SurveyRound.objects.all(), required=False, allow_null=True
    )


class CommitSerializer(serializers.Serializer[Any]):
    association_overrides = serializers.DictField(
        child=serializers.CharField(),
        required=False,
        help_text='Raw association name -> existing association id, or "new".',
    )


class TemplateQuerySerializer(serializers.Serializer[Any]):
    commodity = serializers.PrimaryKeyRelatedField(queryset=Commodity.objects.all())
