import factory

from apps.locations.models import Barangay, Municipality


class MunicipalityFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Municipality
        django_get_or_create = ("name",)

    name = factory.Sequence(lambda n: f"Test Municipality {n}")


class BarangayFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Barangay

    name = factory.Sequence(lambda n: f"Test Barangay {n}")
    municipality = factory.SubFactory(MunicipalityFactory)
    is_verified = True
