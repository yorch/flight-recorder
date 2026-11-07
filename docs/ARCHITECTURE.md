# Architecture: repository structure reassessment

`SPEC.md` is the source of truth for behaviour and interfaces; this file only
records how the repository is laid out, why, and what should move next. The
structure was reassessed when the toolchain moved from npm to bun.

## Toolchain (as of the bun migration)

| Job | Tool | Why |
|---|---|---|
| Dependencies | **bun 1.4.1**, single workspace lock (`bun.lock`) | One lock for `flight-recorder` + `ui`; install is ~1.5 s locally and in CI. |
| Unit tests | **`bun test`** (`bun:test` + `node:assert`) | Faster than `node --test`, same assertions; the per-test retry timeout is explicit. |
| Coverage floors | `scripts/coverage-gate.ts` over the lcov report | Bun's `coverageThreshold` is per-file and bun has no branch metric; SPEC §14's floors are aggregate (lines ≥90 %, functions ≥90 %). |
| Runtime (orchestrator, runner, server, acceptance driver, e2e scripts) | **Node 26** | SPEC §2.3 relies on Node's type stripping and `NODE_USE_ENV_PROXY`; the container images stay `node:26-trixie-slim` with bun copied in only to install. |
| Console tests | vitest (`bun run ui:test`) | jsdom + React; unchanged by the migration. |

Rule of thumb: **bun is the toolchain, node is the runtime**. Anything that runs
inside a container or spawns a long-lived process is node; anything that installs,
lints, type-checks or runs unit tests is bun.

## Current inventory

```text
src/                 11 files at the top level + 5 subdirs
  main.ts config.ts secrets.ts events.ts geometry.ts      run lifecycle + inputs
  session.ts recorder.ts cursor.ts interaction.ts          browser control + recording
  agent/                                                 planner, loop, actions, verdict, providers
  postprocess/                                           timemap, zoom, chapters, render, cli
  report/                                                report.json/md/html
  runner/                                                host daemon (queue, compose)
  server/                                                control-plane HTTP API
  network.ts                                             request/response log
ui/                  React + Vite console (workspace package)
tests/
  unit/              17 bun:test files
  acceptance/        run.ts driver, criteria 1-32, overlays, tools/ run inside e2e image
  fixtures/sites/    the fake internet (own container + ground-truth request log)
  specs/ stub/       TestSpecs and stub-model scripts used by the suite
docker/              browser/ proxy/ ui/ e2e/   (each its own image; e2e uses the repo root as context)
scripts/             run-test.sh, setup-test-secrets.sh, coverage.ts + coverage-gate.ts (the coverage gate)
spike/               architecture evidence (§13), including ~12 MB of committed video
data/ artifacts/ secrets/   runtime state, gitignored
```

## Findings, in priority order

### 1. `src/` hides three subsystems in one flat bag (recommended: move)

The top level mixes **harness mechanics** (`session`, `recorder`, `cursor`,
`interaction`, `events`, `geometry`, `network`), **run lifecycle** (`main`,
`config`, `secrets`), and **control plane** (`runner`, `server`). A reader cannot
tell from the root listing which files belong to the same subsystem, and the
control-plane/daemon boundary that §16 draws explicitly is invisible.

Proposed mapping (paths in SPEC §14/§16 and compose mounts must be updated in
the same change):

| From | To |
|---|---|
| `src/{main,config,secrets,events,geometry,network}.ts` | `src/harness/` |
| `src/{session,recorder,cursor,interaction}.ts` | `src/harness/browser/` |
| `src/runner/**` | `src/control/runner/**` |
| `src/server/**` | `src/control/server/**` |
| `src/agent/**`, `src/postprocess/**`, `src/report/**` | unchanged |

Risk: mechanical but wide — `Dockerfile`, both compose files, `tests/**`, the
acceptance driver's `node src/...` calls, tsconfig `include` and SPEC paths all
reference these files. The move checklist must also update the coverage
exclusions and expected-source inventory: `bunfig.toml`'s
`coveragePathIgnorePatterns` (currently `src/main.ts`, `src/session.ts`, …) and
`scripts/coverage.ts`'s `SOURCE_DIRS`, or `bun run test:coverage` fails with
"not instrumented / unexpected files" until the lists match again. Do it as one
change with no behaviour edits.

### 2. `spike/` carries 12 MB of committed video (recommended: move media out)

`spike/results/a/video.mkv` (6.5 MB) and `b/webm` (5.3 MB) dominate repository
weight and make every clone slow. The *scripts* and their README are the
evidence that matters; the recordings are re-runnable.

Recommendation: keep `spike/` scripts, move the media to a release asset (or Git
LFS) and link it from the spike README. Do this before inviting outside
contributors.

### 3. `tests/` mirrors the source tree, but the fixture data is scattered

`tests/specs/` and `tests/stub/` are *data*, while `tests/fixtures/` already
exists for data. Recommendation: `tests/fixtures/specs/` and
`tests/fixtures/stub/`, leaving `tests/{unit,acceptance}` as the only executable
suites. Also worth separating the Playwright drivers that run *inside* the e2e
image (`tests/acceptance/tools/*.mjs`) into `tests/e2e/`, so
`tests/acceptance/` is purely the criteria driver.

### 4. Runtime state at the repository root (recommended: leave as is)

`data/`, `artifacts/` and `secrets/` are bind-mounted by both compose files,
referenced throughout SPEC §15/§16 and set as `DATA_DIR`/`ARTIFACTS_DIR`/
`SECRETS_DIR` in the UI image. Moving them to `var/` would gain tidiness and cost
a spec-wide rename. Left alone deliberately; `.dockerignore` now keeps them out
of build contexts, which was the actual cost.

### 5. No `docs/`, no `.dockerignore`, no `SECURITY.md` (partly fixed here)

`.dockerignore` landed with the bun change (build contexts no longer ship
`node_modules`, `artifacts`, `secrets`, `spike`). Still missing: a
`SECURITY.md` (the control plane is localhost-only by design and should say so
alongside the disclosure path), and a `CONTRIBUTING.md` pointer to `AGENTS.md`
and `SPEC.md` once the repo is public.

### 6. Three "ui"s, one console (recommended: document, do not rename)

`ui/` is the workspace package, `docker/ui/` builds it, `src/server/` serves it.
The names are individually right and referenced everywhere. Leave them; this
document and the `AGENTS.md` layout table are the map.

### 7. Docker build contexts are per-image and inconsistent (low priority)

`docker/browser` and `docker/proxy` define an image-local context. The other
three — the orchestrator (`Dockerfile`), the control plane (`docker/ui/`) and the
e2e driver (`docker/e2e/`) — all build from the repository root, which is why the
single root `.dockerignore` governs them. The orchestrator and control-plane
stages copy the workspace manifests they need (`package.json`, `bun.lock`,
`ui/package.json`); the e2e stage writes its own one-line manifest and copies
`tests/acceptance/tools/`. If the Playwright driver moves to
`tests/e2e/`, revisit whether the e2e image can get its own context.

## What this change did, and what is proposed next

Done here: bun workspace + single lock, `bun test` for the unit suite, aggregate
coverage gate, bun-based Docker installs, CI on bun, `.dockerignore`, this
document.

Proposed, in order of value/risk ratio: (1) media out of `spike/`, (2) fixture
data under `tests/fixtures/`, (3) `src/` subsystem regrouping with a
behaviour-free change, (4) `SECURITY.md` + `CONTRIBUTING.md` before the first
external contributor.
