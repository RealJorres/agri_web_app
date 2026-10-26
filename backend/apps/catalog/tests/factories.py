import factory

from apps.catalog.models import Program


class ProgramFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Program
        django_get_or_create = ("code",)

    code = factory.Sequence(lambda n: f"PRG{n}")
    name = factory.LazyAttribute(lambda o: f"{o.code} program")
