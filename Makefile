.DEFAULT_GOAL := help

# Keep deployment and the existing backup script on the same production stack.
export COMPOSE_FILE := compose.yaml
COMPOSE := docker compose
WAIT_TIMEOUT ?= 300
SERVICE ?= api
TAIL ?= 100
BACKUP_DIR ?= .backups

ifeq ($(OS),Windows_NT)
POWERSHELL ?= powershell
else
POWERSHELL ?= pwsh
endif

# A backup and a deployment must never run concurrently, even with make -j.
.NOTPARALLEL:
.PHONY: help init config preflight build deploy update up stop down restart status logs backup check

help:
	@echo "KBO Workbench - run from the repository root"
	@echo "  make init      Create .env from .env.example if missing; edit passwords next"
	@echo "  make deploy    Build and deploy; wait for migrations and healthy services"
	@echo "  make update    Build, back up DB/workspace, then deploy"
	@echo "  make up        Start existing images and wait for healthy services"
	@echo "  make stop      Stop services, keeping containers and data"
	@echo "  make down      Remove containers and networks, keeping data volumes"
	@echo "  make restart   Restart API/web using existing images"
	@echo "  make status    Show all containers, including the migration result"
	@echo "  make logs      Follow logs; SERVICE=api TAIL=100"
	@echo "  make backup    Back up DB and workspace together; BACKUP_DIR=.backups"
	@echo "  make config    Validate Compose configuration without printing secrets"
	@echo "  make build     Build production API/web images"
	@echo "  make check     Run repository quality gates with Node 24 / pnpm 10.15.1"
	@echo "  WAIT_TIMEOUT=300 controls the startup wait in seconds"

init:
ifeq ($(OS),Windows_NT)
	$(POWERSHELL) -NoProfile -Command "if (Test-Path -LiteralPath '.env') { Write-Output '.env already exists; kept unchanged.' } else { Copy-Item -LiteralPath '.env.example' -Destination '.env' -ErrorAction Stop; Write-Output 'Created .env; set passwords and data paths before deploying.' }"
else
	@if [ -e .env ]; then echo '.env already exists; kept unchanged.'; else cp .env.example .env && echo 'Created .env; set passwords and data paths before deploying.'; fi
endif

.env:
	@echo "Missing .env. Run make init, then set passwords and data paths."
	@exit 1

config: .env
	$(COMPOSE) config --quiet

preflight: config
	docker info --format "{{.ServerVersion}}"

build: preflight
	$(COMPOSE) build api web

deploy: build
update: build backup

# Re-run the one-shot migration with the new image after the old writer stops.
# Compose prevents API/web startup if migration or readiness fails.
deploy update:
	$(COMPOSE) stop web api
	$(COMPOSE) up -d --no-build --force-recreate --wait --wait-timeout $(WAIT_TIMEOUT) migrate api web
	$(COMPOSE) ps --all

up: preflight
	$(COMPOSE) up -d --no-build --wait --wait-timeout $(WAIT_TIMEOUT)

stop: config
	$(COMPOSE) stop

down: config
	$(COMPOSE) down

restart: preflight
	$(COMPOSE) stop web api
	$(COMPOSE) up -d --no-build --wait --wait-timeout $(WAIT_TIMEOUT) api web

status: config
	$(COMPOSE) ps --all

logs: config
	$(COMPOSE) logs --follow --tail $(TAIL) $(SERVICE)

backup: preflight
	$(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1 -DestinationRoot "$(BACKUP_DIR)"

check:
	pnpm lint
	pnpm format:check
	pnpm typecheck
	pnpm test
	pnpm schema:game:check
	pnpm build
