# Autonomous AI Browser Testing

An AI agent drives a real, sandboxed Chrome to execute a browser test, and the platform records the run:

- screen video;
- event timeline;
- screenshots;
- model transcript.

The harness verifies the outcome itself. It produces a condensed video with idle time compressed, zoom on each action, and chapters marked passed/failed. All network egress goes through an allowlisting proxy.

- **Design and acceptance criteria:** [SPEC.md](SPEC.md)
- **Working notes, status and conventions for contributors and agents:** [AGENTS.md](AGENTS.md)

## Requirements

- Docker Desktop or Docker Engine with Compose v2+ (linux/amd64 or arm64)
- Node.js ≥ 24.12 on the host (to run scripts and the gates; containers use Node 26)
- Model API keys as files: `secrets/ANTHROPIC_API_KEY` and/or `secrets/OPENAI_API_KEY`

## Quick Start

```bash
npm ci
npm run check                      # lint, typecheck, unit tests + coverage, shellcheck, hadolint

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

Exit codes: `0` passed, `1` failed, `2` harness error, `3` unverified. Planned for §15: `4` cancelled.

## Acceptance Suite

```bash
npm run test:acceptance            # all SPEC §11 criteria (about 20 minutes)
npm run test:acceptance -- --only 5,17
```

## Roadmap

SPEC §15–16 describe the next features:

- natural-language runs that plan, execute, evaluate and produce a report;
- a host runner daemon;
- a control-plane API with a React web UI for creating, approving and reviewing runs.

These are designed but not implemented yet; see `AGENTS.md` for the phase plan.
