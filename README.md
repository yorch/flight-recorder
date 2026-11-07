# Flight Recorder

An AI agent drives a real, sandboxed Chrome to execute a browser test, and the harness records and judges the run:

- screen video;
- event timeline;
- screenshots;
- model transcript.

The harness verifies the outcome itself. It produces a condensed video with idle time compressed, zoom on each action, and chapters marked passed/failed. All network egress goes through an allowlisting proxy.

- **Design and acceptance criteria:** [SPEC.md](SPEC.md)
- **Working notes, status and conventions for contributors and agents:** [AGENTS.md](AGENTS.md)

## Requirements

- Docker Desktop or Docker Engine with Compose v2+ (linux/amd64 or arm64)
- Bun ≥ 1.4 as the package manager, test runner and script runner (`bun.lock` is the only lock)
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
