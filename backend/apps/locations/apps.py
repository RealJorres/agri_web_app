from django.apps import AppConfig


class LocationsConfig(AppConfig):
    name = "apps.locations"
    label = "locations"

    def ready(self) -> None:
        from . import checks  # noqa: F401  (registers system checks)
