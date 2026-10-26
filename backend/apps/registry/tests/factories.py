"""Synthetic people only: surnames are 'Sample<n>' so fixtures can never pass for real records."""

import factory

from apps.locations.tests.factories import BarangayFactory
from apps.registry.models import Association, AssociationMember, Farmer


class FarmerFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Farmer

    first_name = factory.Iterator(["Juan", "Maria", "Jose", "Ana", "Pedro", "Rosa"])
    last_name = factory.Sequence(lambda n: f"Sample{n}")
    home_barangay = factory.SubFactory(BarangayFactory)


class AssociationFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Association

    name = factory.Sequence(lambda n: f"Sample Farmers Association {n}")
    municipality = factory.SubFactory("apps.locations.tests.factories.MunicipalityFactory")


class MemberFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = AssociationMember

    farmer = factory.SubFactory(FarmerFactory)
    association = factory.SubFactory(AssociationFactory)
