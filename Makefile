# Git Bash on Windows rewrites /container/paths passed to docker.exe; keep them as written.
export MSYS_NO_PATHCONV := 1

COMPOSE := docker compose -f infra/docker-compose.yml --env-file .env
API     := $(COMPOSE) run --rm api
WEB     := $(COMPOSE) run --rm --no-deps frontend

.DEFAULT_GOAL := help
.PHONY: help env up down logs build migrate makemigrations seed seed-demo import-legacy \
        test test-backend test-frontend coverage docs lint lint-backend lint-frontend fmt schema shell superuser

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

env: ## Create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example")

up: env ## Start db, redis, api, worker, frontend
	$(COMPOSE) up -d --build

down: ## Stop all services
	$(COMPOSE) down

logs: ## Follow service logs
	$(COMPOSE) logs -f

build: env ## Rebuild images
	$(COMPOSE) build

migrate: ## Apply migrations
	$(API) python manage.py migrate

makemigrations: ## Create migrations
	$(API) python manage.py makemigrations

seed: ## Seed municipalities, catalog (+ PSGC when data/reference/ has the file)
	$(API) python manage.py seed

seed-demo: ## Load synthetic demo data
	$(API) python manage.py seed_demo

import-legacy: ## Import the 2023 cacao workbook: make import-legacy FILE=data/raw/x.xlsx
	@test -n "$(FILE)" || (echo "Usage: make import-legacy FILE=data/raw/<file>.xlsx" && exit 1)
	$(API) python manage.py import_legacy_cacao /$(FILE)

test: test-backend test-frontend ## Run all tests

test-backend:
	$(API) pytest

coverage: ## Backend tests + the 85% gate on services/selectors/permissions/scoping (DoD)
	$(API) sh -c "pytest && coverage report --include='*/services.py,*/selectors.py,*/permissions.py,common/scoping.py,apps/surveys/rules.py' --fail-under=85"

test-frontend:
	$(WEB) npm test

lint: lint-backend lint-frontend ## Lint + type-check everything

lint-backend:
	$(API) sh -c "ruff check . && ruff format --check . && mypy"

lint-frontend:
	$(WEB) sh -c "npm run lint && npm run typecheck && npm run format:check"

fmt: ## Auto-format backend and frontend
	$(API) sh -c "ruff check --fix . && ruff format ."
	$(WEB) npm run format

schema: ## Export OpenAPI schema and regenerate the frontend client types
	$(COMPOSE) run --rm -T api python manage.py spectacular --validate --format openapi-json \n		--settings=config.settings.test > frontend/openapi.json
	$(WEB) npm run gen:api

docs: ## Regenerate docs/data-dictionary.md from the models
	$(COMPOSE) run --rm -T api python manage.py data_dictionary > docs/data-dictionary.md

shell: ## Django shell
	$(API) python manage.py shell

superuser: ## Create a Django superuser
	$(API) python manage.py createsuperuser
