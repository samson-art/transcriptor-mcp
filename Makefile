.DEFAULT_GOAL := help

SHELL := /bin/bash

PROJECT_NAME ?= transcriptor-mcp

# Docker publishing defaults (override with `make ... TAG=... IMAGE=...`)
TAG ?= latest
PLATFORMS ?= linux/amd64,linux/arm64
NO_CACHE ?= 1

DOCKER_API_IMAGE ?= artsamsonov/transcriptor-mcp-api
DOCKER_MCP_IMAGE ?= artsamsonov/transcriptor-mcp

.PHONY: help \
	install clean \
	build typecheck lint lint-fix format format-check test test-watch test-coverage check check-no-smoke \
	load-test load-test-health load-test-subtitles load-test-mixed verify-pool \
	docker-build-api docker-build-mcp docker-run-mcp-stdio \
	docker-buildx-setup docker-buildx-api docker-buildx-mcp \
	docker-smoke-api-local smoke \
	publish-docker-api publish-docker-mcp publish

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*##"; printf "\nTargets:\n"} /^[a-zA-Z0-9_.-]+:.*##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install dependencies (clean, from lockfile)
	npm ci

clean: ## Remove build/test artifacts
	rm -rf dist coverage

build: ## Build TypeScript (dist/)
	npm run build

typecheck: ## Type-check without emitting JS
	npm run type-check

lint: ## Run ESLint
	npm run lint

lint-fix: ## Run ESLint with --fix
	npm run lint:fix

format: ## Format code with Prettier
	npm run format

format-check: ## Check formatting (no writes)
	npm run format:check

test: ## Run Jest tests
	npm test

test-watch: ## Run Jest in watch mode
	npm run test:watch

test-coverage: ## Run Jest with coverage
	npm run test:coverage

smoke: docker-smoke-api-local ## Run all Docker-based smoke tests

LOAD_BASE_URL ?= http://127.0.0.1:3000
# Optional: send k6 metrics to InfluxDB (e.g. http://your-vps:8086/k6) for Grafana
LOAD_INFLUXDB_URL ?=
K6_OUT_INFLUXDB := $(if $(LOAD_INFLUXDB_URL),--out influxdb=$(LOAD_INFLUXDB_URL),)

load-test: load-test-health load-test-subtitles load-test-mixed ## Run all load tests (requires API at LOAD_BASE_URL)
load-test-health: ## Light load: GET /health only
	docker run -i --rm -v "$(CURDIR)/load:/scripts" -e BASE_URL="$(LOAD_BASE_URL)" grafana/k6 run $(K6_OUT_INFLUXDB) /scripts/health.js
load-test-subtitles: ## Heavy load: POST /subtitles
	docker run -i --rm -v "$(CURDIR)/load:/scripts" -e BASE_URL="$(LOAD_BASE_URL)" grafana/k6 run $(K6_OUT_INFLUXDB) /scripts/subtitles.js
load-test-mixed: ## Mixed: health + available + subtitles
	docker run -i --rm -v "$(CURDIR)/load:/scripts" -e BASE_URL="$(LOAD_BASE_URL)" grafana/k6 run $(K6_OUT_INFLUXDB) /scripts/mixed.js

verify-pool: ## Verify VIDEO_POOL: call /subtitles/available for each video (requires API at LOAD_BASE_URL)
	LOAD_BASE_URL="$(LOAD_BASE_URL)" node load/verify-pool.js

prepare: lint-fix format ## Run lint, format

check-no-smoke: format-check lint typecheck test build ## CI checks without Docker smoke (used by publish)
check: format-check lint typecheck test build smoke ## Run CI-like checks locally

docker-build-api: ## Build local REST API image (Dockerfile --target api)
	docker build -t $(DOCKER_API_IMAGE):$(TAG) -f Dockerfile --target api .

docker-build-mcp: ## Build local MCP image (Dockerfile --target mcp)
	docker build -t $(DOCKER_MCP_IMAGE):$(TAG) -f Dockerfile --target mcp .

docker-run-mcp-stdio: ## Run MCP image in stdio mode (for Cursor)
	docker run --rm -i $(DOCKER_MCP_IMAGE):$(TAG)

docker-smoke-api-local: ## Run REST API Docker smoke test against local image (MCP smoke skipped; use full smoke after building MCP image)
	SMOKE_IMAGE_API=$(DOCKER_API_IMAGE):$(TAG) SMOKE_SKIP_MCP=1 npm run test:e2e:api

docker-buildx-setup: ## Create/use buildx builder for multi-arch builds
	@docker buildx inspect multiarch >/dev/null 2>&1 || docker buildx create --name multiarch --use
	@docker buildx use multiarch
	@docker buildx inspect --bootstrap >/dev/null

ifeq ($(NO_CACHE),1)
NO_CACHE_FLAG := --no-cache
else
NO_CACHE_FLAG :=
endif

# When TAG is set (e.g. 0.3.5), also push as latest; when TAG=latest, only one tag
docker-buildx-api: docker-buildx-setup ## Multi-arch build & push REST API image
	docker buildx build --platform $(PLATFORMS) -f Dockerfile --target api -t $(DOCKER_API_IMAGE):$(TAG) $(if $(filter-out latest,$(TAG)),-t $(DOCKER_API_IMAGE):latest,) $(NO_CACHE_FLAG) --push .

docker-buildx-mcp: docker-buildx-setup ## Multi-arch build & push MCP image
	docker buildx build --platform $(PLATFORMS) -f Dockerfile --target mcp -t $(DOCKER_MCP_IMAGE):$(TAG) $(if $(filter-out latest,$(TAG)),-t $(DOCKER_MCP_IMAGE):latest,) $(NO_CACHE_FLAG) --push .

publish-docker-api: check-no-smoke docker-build-api docker-smoke-api-local docker-buildx-api ## Publish REST API image to registry (buildx --push)

publish-docker-mcp: check-no-smoke docker-buildx-mcp ## Publish MCP image to registry (buildx --push)

publish: check-no-smoke publish-docker-api publish-docker-mcp smoke ## Run checks, publish npm + MCP docker image
