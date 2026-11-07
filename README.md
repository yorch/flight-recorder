# Flight Recorder

An AI agent drives a real, sandboxed Chrome to execute a browser test, and the harness records and judges the run:

- screen video;
- event timeline;
- screenshots;
- model transcript.

The harness verifies the outcome itself. It produces a condensed video with idle time compressed, zoom on each action, and chapters marked passed/failed. All network egress goes through an allowlisting proxy.

- **Documentation site:** <https://yorch.github.io/flight-recorder/>
- **Design and acceptance criteria:** [SPEC.md](SPEC.md)
- **Working notes, status and conventions for contributors and agents:** [AGENTS.md](AGENTS.md)

## Requirements

- Docker Desktop or Docker Engine with Compose v2+ (linux/amd64 or arm64)
- Bun ≥ 1.4 as the package manager, test runner and script runner (`bun.lock` is the only lock)
- `just` for the task recipes (optional — every recipe wraps a command you can run directly)
- Node.js ≥ 24.12 on the host (the runtime for the orchestrator, runner, server and scripts; containers use Node 26)
- Model API keys as files: `secrets/ANTHROPIC_API_KEY` and/or `secrets/OPENAI_API_KEY`

## Quick Start

```bash
bun install
bun run check                      # lint, typecheck, unit tests + coverage, shellcheck, hadolint

sh scripts/setup-test-secrets.sh   # test credentials matching the fixture login site

# Run the login spec against the bundled fixture site with a real model
COMPOSE_OVERLAYS=tests/acceptance/compose.fixtures.yml \
  scripts/run-test.sh specs/login.json anthropic/claude-opus-5-5
```

## Tasks

`just` wraps the commands you actually type; `just --list` shows all of them.

| Recipe | Does |
|---|---|
| `just install` | `bun install --frozen-lockfile` |
| `just check` | every fast gate from SPEC §14 (lint, typecheck, unit + coverage, UI, shellcheck, hadolint) |
| `just test` / `just cover` | unit tests / unit tests with the coverage gate |
| `just doctor` | toolchain versions, Docker status, which secrets exist (never their values) |
| `just up` / `just down` / `just logs` | console + control-plane on <http://127.0.0.1:7070> |
| `just runner` / `just dev` | runner daemon alone / runner + console in one terminal |
| `just run [spec] [model]` | one run against the fixture site (defaults: login spec, recorded stub) |
| `FIXTURES=1 just dev` | runner + console wired to the bundled fixture internet (`app.test`, …) |
| `just acceptance` | acceptance suite (`ONLY=5,7` or `SKIP=29,32` to narrow) |
| `just last` | newest run's report and artifact path |
| `just site` / `just site-dev` | build / live-edit the documentation site in `site/` |

## Running the platform end to end

```bash
# 1. dependencies + fixture credentials
bun install
sh scripts/setup-test-secrets.sh          # TEST_USER_EMAIL / TEST_USER_PASSWORD for the fixture login

# 2. model key(s) — written as files, never echoed (the console lists a model only if its key exists)
install -m 600 /dev/stdin secrets/ANTHROPIC_API_KEY <<< "$ANTHROPIC_API_KEY"

# 3. check the toolchain, Docker and which secrets are wired
just doctor

# 4. runner + console in one terminal, pointed at the fixture sites
FIXTURES=1 just dev                       # or: FIXTURES=1 just runner  +  just up
```

Open <http://127.0.0.1:7070> and create a run: goal, start URL (`http://app.test/` for the fixture app),
model, optional plan review, assets. If plan review is on, the run sits in `awaiting_approval` until you
approve or edit the plan in the console; without it the agent starts immediately.

The first run builds the browser, proxy and orchestrator images (a few minutes); later runs reuse them.
While a run is live the console streams progress (phase, steps, tokens, screenshots); when it finishes you get
the verdict plus the condensed video with chapters, the event timeline, the network panel and the report.

Two things that bite on Linux: the console container reaches the runner through
`host.docker.internal`, so bind the daemon to the bridge gateway (`RUNNER_BIND=172.17.0.1:7071`), and without
`FIXTURES=1` the `*.test` hosts do not resolve.

Results land in `artifacts/<run_id>/`:

| File | Contents |
|---|---|
| `run.json` | verdict and summary |
| `final.mp4` | condensed video |
| `chapters.json` / `chapters.vtt` | chapters |
| `screenshots/` | screenshots |
| `events.jsonl` | event timeline |
| `agent/transcript.jsonl` | model transcript |
| `logs/proxy-access.log` | egress log |

Exit codes: `0` passed, `1` failed, `2` harness error, `3` unverified, `4` cancelled.

## Continuous Integration

Two workflows mirror the gates in SPEC §14.1:

| Workflow | Trigger | Runs |
|---|---|---|
| `ci.yml` | push to `main`, every PR | lint, typecheck (root + ui), unit tests with coverage, shellcheck, hadolint |
| `acceptance.yml` | nightly, manual, or a PR labelled `run-acceptance` (re-runs on later pushes) | the Docker acceptance suite; the manual `live_model` input also runs a real-model smoke |

The `CI` aggregate check is the required status for branch protection. Actions are pinned to commit SHAs and updated by dependabot.

## Acceptance Suite

```bash
bun run test:acceptance            # all SPEC §11 criteria (about 20 minutes)
bun run test:acceptance -- --only 5,17
```

## Roadmap

SPEC §15–16 describe the next features:

- natural-language runs that plan, execute, evaluate and produce a report;
- a host runner daemon;
- a control-plane API with a React web UI for creating, approving and reviewing runs.

These are designed and implemented; see `AGENTS.md` for the current status and `SPEC.md` for the contract.

## License

[MIT](LICENSE) © 2026 Jorge Barnaby
