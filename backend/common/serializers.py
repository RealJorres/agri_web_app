"""Typed reference serializers shared by read endpoints (they also type the OpenAPI schema)."""

from typing import Any

from rest_framework import serializers


class RefSerializer(serializers.Serializer[Any]):
    """{id, name} of a related object (barangay, municipality, round, association...)."""

    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)


class CodeRefSerializer(RefSerializer):
    code = serializers.CharField(read_only=True)
