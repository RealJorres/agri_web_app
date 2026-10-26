import factory

from apps.catalog.models import Commodity
from apps.farms.models import CropStand, Farm, Planting
from apps.registry.tests.factories import FarmerFactory


def cacao() -> Commodity:
    """The seeded cacao commodity (seeds the catalog on first use)."""
    from apps.catalog.services import seed_catalog

    found = Commodity.objects.filter(code="CACAO").first()
    if found is None:
        seed_catalog()
        found = Commodity.objects.get(code="CACAO")
    return found


class FarmFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Farm

    farmer = factory.SubFactory(FarmerFactory)
    barangay = factory.LazyAttribute(lambda o: o.farmer.home_barangay)


class CropStandFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = CropStand

    farm = factory.SubFactory(FarmFactory)
    commodity = factory.LazyFunction(cacao)


class PlantingFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Planting

    crop_stand = factory.SubFactory(CropStandFactory)
    year_planted = 2020
