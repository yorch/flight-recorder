# Flight Recorder — task runner. `just` with no arguments lists the recipes.
# Recipes wrap the canonical commands (package.json scripts, compose files,
# scripts/) rather than re-implementing them; SPEC §14 is the gate contract.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Optional narrowing for `just acceptance`; the recipe arguments of this just
# version are positional only, so these come from the environment:
#   ONLY=5,7 just acceptance     SKIP=29,32 just acceptance
only := env("ONLY", "")
skip := env("SKIP", "")

# FIXTURES=1 points the runner's runs at the bundled fixture internet
# (app.test, other.test, ...) instead of the public one — required for the
# specs under tests/specs.
fixtures := env("FIXTURES", "")
overlays := if fixtures == "" { "" } else { "tests/acceptance/compose.fixtures.yml" }

# List the recipes
default:
    @just --list

alias b := check

# --------------------------------------------------------------------------
# setup
# --------------------------------------------------------------------------

# Install the workspace dependencies from the committed lockfile
[group('setup')]
install:
    bun install --frozen-lockfile

# Write the fixture test credentials into ./secrets (never touches API keys)
[group('setup')]
secrets:
    sh scripts/setup-test-secrets.sh

# Show the toolchain versions, whether Docker is up and which secrets exist (never their values)
[group('setup')]
doctor:
    #!/usr/bin/env bash
    set -euo pipefail
    printf 'bun      %s\n' "$(bun --version)"
    printf 'node     %s\n' "$(node --version)"
    printf 'just     %s\n' "$(just --version | awk '{print $2}')"
    server=$(docker version 2>/dev/null | awk '/^Server:/{s=1} s && /Version:/{print $2; exit}' || true)
    printf 'docker   %s\n' "${server:-not running}"
    printf 'compose  %s\n' "$(docker compose version --short 2>/dev/null || echo 'missing')"
    for f in ANTHROPIC_API_KEY OPENAI_API_KEY RUNNER_TOKEN; do
      if [ -s "secrets/$f" ]; then printf 'secret   %-20s present\n' "$f"; else printf 'secret   %-20s absent\n' "$f"; fi
    done

# --------------------------------------------------------------------------
# gates (SPEC §14)
# --------------------------------------------------------------------------

# All fast gates: lint, typecheck, unit tests + coverage, UI, shellcheck, hadolint
[group('gates')]
check:
    bun run check

# Biome (format + lint, warnings are errors)
[group('gates')]
lint:
    bun run lint

# Rewrite formatting
[group('gates')]
format:
    bun run format

# tsc --noEmit (root)
[group('gates')]
typecheck:
    bun run typecheck

# bun:test over tests/unit
[group('gates')]
test:
    bun run test

# Unit tests + aggregate coverage gate (scripts/coverage-gate.ts)
[group('gates')]
cover:
    bun run test:coverage

# shellcheck + hadolint over docker/ and scripts/ (pinned images)
[group('gates')]
lint-docker:
    bun run lint:shell
    bun run lint:docker

# --------------------------------------------------------------------------
# console (React + Vite)
# --------------------------------------------------------------------------

# Vite dev server on :5173 (UI only; API calls need the compose stack)
[group('console')]
ui-dev:
    bun run --cwd ui dev

# Production build of the SPA (baked into the console image)
[group('console')]
ui-build:
    bun run ui:build

# vitest over the console
[group('console')]
ui-test:
    bun run ui:test

# --------------------------------------------------------------------------
# docs site (GitHub Pages)
# --------------------------------------------------------------------------

# Regenerate the site documents from README/SPEC/docs and build the static site
[group('site')]
site:
    bun run site:build

# Astro dev server for the site on :4321 (regenerates the docs first)
[group('site')]
site-dev:
    bun run site:dev

# Regenerate the published documents without building the site
[group('site')]
site-docs:
    bun run site:docs

# --------------------------------------------------------------------------
# app (runner daemon + control plane)
# --------------------------------------------------------------------------

# Run the host runner daemon on 127.0.0.1:7071 (foreground, needs Docker; FIXTURES=1 for the fixture sites)
[group('app')]
runner:
    COMPOSE_OVERLAYS={{overlays}} bun run runner

# Build and start the console + control-plane API on http://127.0.0.1:7070
[group('app')]
up:
    docker compose -f docker-compose.ui.yml up -d --build --wait
    @echo "console: http://127.0.0.1:7070"

# Stop the console (volumes included)
[group('app')]
down:
    docker compose -f docker-compose.ui.yml down -v

# Follow the console container logs
[group('app')]
logs:
    docker compose -f docker-compose.ui.yml logs -f --tail 100 ui

# Runner + console together; Ctrl-C stops both (FIXTURES=1 for the fixture sites)
[group('app')]
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    COMPOSE_OVERLAYS={{overlays}} bun run runner &
    runner=$!
    trap 'kill "$runner" 2>/dev/null || true' EXIT INT TERM
    docker compose -f docker-compose.ui.yml up --build

# --------------------------------------------------------------------------
# runs
# --------------------------------------------------------------------------

# One run against the fixture site: just run [spec] [model] (defaults: login + stub)
[group('runs')]
run spec="specs/login.json" model="stub//tests/stub/login.json":
    COMPOSE_OVERLAYS=tests/acceptance/compose.fixtures.yml scripts/run-test.sh {{spec}} {{model}}

# Acceptance suite, ~20 min, needs Docker (ONLY=5,7 or SKIP=29,32)
[group('runs')]
acceptance:
    #!/usr/bin/env bash
    set -euo pipefail
    args=()
    if [ -n "{{only}}" ]; then args+=(--only "{{only}}"); fi
    if [ -n "{{skip}}" ]; then args+=(--skip "{{skip}}"); fi
    node tests/acceptance/run.ts "${args[@]}"

# Print the newest run's report (or its run.json) and where the artifact lives
[group('runs')]
last:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=$(ls -1dt artifacts/*/ 2>/dev/null | head -1 || true)
    if [ -z "$dir" ]; then echo "no runs under artifacts/"; exit 0; fi
    echo "run: $dir"
    if [ -f "$dir/report.md" ]; then cat "$dir/report.md"; else cat "$dir/run.json"; fi

# --------------------------------------------------------------------------
# housekeeping
# --------------------------------------------------------------------------

# Remove run artifacts, request state, coverage output and the built UI
[group('housekeeping')]
[confirm("Delete artifacts/, data/, coverage/ and ui/dist/?")]
clean:
    rm -rf artifacts/* data/* coverage ui/dist
