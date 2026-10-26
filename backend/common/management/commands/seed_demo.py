"""make seed-demo: SYNTHETIC demo data and one user per role, for local demos and UI work.

Everything is created through the real services (scope checks, workflow, audit), so the demo
shows realistic states: draft, submitted, validated and approved records in an open round.
Refuses to run unless DEBUG is on, and never touches real data.
"""

import datetime as dt
import os
from itertools import cycle
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import transaction

from apps.accounts.models import User
from apps.accounts.roles import Role
from apps.accounts.services import create_assignment
from apps.catalog.models import Commodity, GrowthStage, Variety
from apps.catalog.services import seed_catalog
from apps.farms import services as farm_services
from apps.locations.models import Barangay, Municipality
from apps.locations.services import seed_municipalities
from apps.registry import services as registry_services
from apps.surveys import services as survey_services
from apps.surveys.models import SurveyRound

DEMO_DOMAIN = "demo.test"
FIRST = ["Juan", "Maria", "Jose", "Ana", "Pedro", "Rosa", "Carlos", "Elena"]
ROUND_NAME = "Cacao inventory - demo"


class Command(BaseCommand):
    help = "Create synthetic demo users and data (DEBUG only)."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--farmers-per-town", type=int, default=6)

    def handle(self, *args: Any, **options: Any) -> None:
        if not settings.DEBUG:
            raise CommandError("seed_demo only runs with DEBUG on (never in production).")
        password = os.environ.get("DEMO_PASSWORD", "")
        if len(password) < 12:
            raise CommandError("Set DEMO_PASSWORD (12+ characters) in .env for the demo users.")
        if User.objects.filter(email__endswith=f"@{DEMO_DOMAIN}").exists():
            self.stdout.write("Demo data already present; nothing to do.")
            return
        with transaction.atomic():
            self._seed(password, options["farmers_per_town"])

    def _user(self, email: str, password: str, role: str, **scope: Any) -> User:
        user = User.objects.create_user(
            email=f"{email}@{DEMO_DOMAIN}",
            password=password,
            first_name=email.split(".")[0].title(),
            last_name="Demo",
            is_staff=role == Role.SYSTEM_ADMIN,
            is_superuser=role == Role.SYSTEM_ADMIN,
        )
        if role != Role.SYSTEM_ADMIN:
            create_assignment(user=user, role=role, **scope)
        return user

    def _seed(self, password: str, per_town: int) -> None:
        seed_municipalities()
        seed_catalog()
        cacao = Commodity.objects.get(code="CACAO")
        towns = list(Municipality.objects.order_by("name"))
        barangays: dict[str, list[Barangay]] = {}
        for town in towns:
            barangays[town.name] = [
                Barangay.objects.get_or_create(
                    municipality=town,
                    normalized_name=f"demo barangay {letter.lower()}",
                    defaults={"name": f"Demo Barangay {letter}"},
                )[0]
                for letter in "AB"
            ]
        gasan = next(t for t in towns if t.name == "Gasan")
        boac = next(t for t in towns if t.name == "Boac")

        admin = self._user("admin", password, Role.SYSTEM_ADMIN)
        users = {
            "admin": admin,
            "head": self._user("head", password, Role.PROVINCIAL_HEAD),
            "coordinator": self._user(
                "coordinator", password, Role.PROGRAM_COORDINATOR, program=cacao.program
            ),
            "encoder": self._user("encoder", password, Role.PROVINCIAL_ENCODER),
            "validator": self._user(
                "validator.gasan", password, Role.MAO_VALIDATOR, municipality=gasan
            ),
            "field": self._user(
                "field.boac",
                password,
                Role.FIELD_ENCODER,
                municipality=boac,
                barangays=barangays["Boac"][:1],
            ),
            "viewer": self._user("viewer", password, Role.VIEWER),
        }

        survey_round = survey_services.open_round(
            actor=users["coordinator"],
            commodity=cacao,
            name=ROUND_NAME,
            as_of_date=dt.date.today().replace(day=1),
        )
        stages = list(GrowthStage.objects.filter(commodity=cacao).order_by("sort_order"))
        varieties = list(Variety.objects.filter(commodity=cacao).order_by("code"))
        names = cycle(FIRST)
        states = cycle(["draft", "submitted", "validated", "approved", "approved", "approved"])
        number = 0
        for town in towns:
            association = registry_services.create_association(
                actor=admin, data={"name": f"Demo {town.name} Cacao Growers", "municipality": town}
            )
            for i in range(per_town):
                number += 1
                brgy = barangays[town.name][i % 2]
                farmer = registry_services.create_farmer(
                    actor=users["encoder"],
                    data={
                        "first_name": next(names),
                        "last_name": f"Demo{number:03d}",
                        "home_barangay": brgy,
                    },
                    consent_given=True,
                )
                if i % 2 == 0:
                    registry_services.add_member(
                        actor=admin, association=association, farmer=farmer
                    )
                farm = farm_services.create_farm(
                    actor=users["encoder"], farmer=farmer, data={"barangay": brgy}
                )
                stand = farm_services.create_crop_stand(
                    actor=users["encoder"], farm=farm, commodity=cacao, data={}
                )
                farm_services.create_planting(
                    actor=users["encoder"],
                    stand=stand,
                    data={"year_planted": 2015 + number % 9},
                    varieties=[varieties[number % len(varieties)]],
                )
                counts = [
                    survey_services.CountInput(stage, (number * (s + 3) * 7) % 120 + 5 * s)
                    for s, stage in enumerate(stages)
                ]
                record = survey_services.create_record(
                    actor=users["encoder"],
                    survey_round=survey_round,
                    crop_stand=stand,
                    counts=counts,
                )
                target = next(states)
                if target == "draft":
                    continue
                record = survey_services.submit(actor=users["encoder"], record=record)
                if target == "submitted":
                    continue
                record = survey_services.validate(actor=admin, record=record)
                if target == "validated":
                    continue
                survey_services.approve(actor=users["coordinator"], record=record)

        total = SurveyRound.objects.get(pk=survey_round.pk).records.count()
        self.stdout.write(self.style.SUCCESS(f"Demo data: {number} farmers, {total} records."))
        self.stdout.write("Demo users (password = DEMO_PASSWORD):")
        for user in users.values():
            self.stdout.write(f"  {user.email}")
