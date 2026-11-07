# AGENTS.md: Context for Future Sessions

Read this first, then `SPEC.md`, which is the source of truth for architecture, interfaces, behaviour and acceptance criteria. When behaviour changes, update `SPEC.md` in the same change.

## What This Project Is

An AI-agent-driven browser testing platform; the console brands it **Flight Recorder** and package, compose and image names follow that.

- **Execution:** an LLM/VLM agent drives a real, sandboxed, headful Chrome to execute a test goal.
- **Evidence:** everything is recorded (screen video, event timeline, screenshots, transcript), and the harness, not the agent, decides pass/fail.
- **Output:** a condensed video with idle time compressed, zoom on actions, and chapters marked passed/failed.

## Status (2026-10-30)

| Area | State |
|---|---|
| SPEC §0–§14 (core harness) | Implemented. Acceptance suite criteria 1–21 green. |
| SPEC §15 (NL runs: plan → execute → evaluate → report) | Implemented: `structured()` model calls, planner + approval gate, plan-aware actions (`plan_step`, `criterion`, `step_done`, `upload`, `assert_url`), finish nudge, evaluator, §15.5 verdict + `CANCELLED` (exit 4), `status.json`, `report.{json,md,html}`. Criteria 22–26 green. |
| SPEC §16 (runner daemon, control-plane API, React UI) | Implemented: `bun run runner` (host, token auth, queue, docker execFile), `src/server/` control plane (`docker-compose.ui.yml`, 127.0.0.1:7070), `ui/` React+Vite SPA, live progress via a derived `progress` snapshot (detail API field + SSE `progress` event). Criteria 27–29 and 32 green. |
| Toolchain | **bun 1.4.1** installs, runs `bun test`, the UI's vitest and CI; **Node 26** stays the runtime (containers, orchestrator, runner, server, acceptance driver). One workspace lock (`bun.lock`). Structure notes: `docs/ARCHITECTURE.md`. |
| Live smoke, Anthropic (`anthropic/claude-opus-5-5`) | PASSED login spec and the full NL blog scenario through the UI (run `20261031-002333-6657`: 25 steps, all criteria MET, finish nudge fired once). |
| Live smoke, OpenAI (`openai/gpt-6-astra`) | **Blocked by the key, not the code**: OpenAI returns 401 "Missing scopes: api.responses.write". The user must grant that scope or replace `./secrets/OPENAI_API_KEY`. |

To use the platform: `sh scripts/setup-test-secrets.sh`, start the runner (`bun run runner`), `docker compose -f docker-compose.ui.yml up`, open http://127.0.0.1:7070.

### Model calls through the control plane

The runner reads `./secrets/RUNNER_TOKEN` (auto-generated on first start) and drives `docker compose` via `execFile` only — no shell. Request dirs live in `./data/requests/<run_id>/` (`request.json`, `spec.json`, `assets/`, `control/`, `stub/`). The UI writes them; the runner mounts them at `/run-input` and `/control` via a generated `compose.run.yml` overlay.

## Repository Layout

```text
SPEC.md                  source of truth (§13 spike evidence, §14 quality gates, §15–16 next features)
AGENTS.md / README.md    session context / human quick start
.github/workflows/       CI: ci.yml (fast gates) + acceptance.yml (Docker suite, live smoke)
package.json + bun.lock  workspace root (ui is the one workspace member); bun is the toolchain
bunfig.toml              bun test config: coverage excludes (the aggregate gate is in scripts/)
scripts/coverage.ts      lcov parsing + expected-source inventory (unit-tested)
scripts/coverage-gate.ts SPEC §14 CLI: aggregate floors + complete-report check
docs/ARCHITECTURE.md     structure reassessment: what lives where, what should move next
docker/browser/          Ubuntu 26.04 + Xvfb + Openbox + Chrome kiosk (sandbox ON via seccomp_profile.json)
docker/proxy/            Squid 7 egress proxy; gen-squid-conf builds squid.conf from the TestSpec
Dockerfile               orchestrator image (node:26-trixie-slim + ffmpeg + xdotool)
docker-compose.yml       run pair (browser + orchestrator share netns/IPC/X socket) + proxy; networks sandbox (internal) / egress
src/                     orchestrator (runs inside the container)
  main.ts                run lifecycle (§6.6, §15: planner → approval → agent → evaluator → report)
  session.ts             CDP connect, invariant, dialog/navigation guards, popup adoption
  recorder.ts            ffmpeg x11grab
  cursor.ts              visible cursor glide
  interaction.ts         InteractionEngine
  config.ts              TestSpec zod + allowlist validation
  secrets.ts             secret loading, origin/input-type binding, redact()
  egress.ts              Squid access-log parsing
  events.ts              timeline schema
  geometry.ts
  agent/                 actions (zod + wire schema + agentWireSchema), loop (incl. finish nudge),
                         prompt.ts + plan-prompts.ts (LEAD-AUTHORED — do not reword without review),
                         planner, evaluator, verdict, budget, coords, model factory, plan.ts
  agent/providers/       anthropic.ts, openai.ts (raw fetch, retries in http.ts), stub.ts
  postprocess/           timemap, zoom, chapters, duration, render, cli
  report/                report.json/md/html (escapeHtml everywhere)
  runner/                host daemon: token, request validation, manager (queue, execFile compose), http
  server/                control-plane API: guards (Host/Origin/CT), form, multipart, api
ui/                      React + Vite SPA (workspace member, vitest tests)
docker/ui/               ui image (multi-stage: vite build → node runtime)
docker/e2e/              Playwright driver image for criterion 29
docker-compose.ui.yml    separate always-on ui project (127.0.0.1:7070)
data/                    gitignored: request dirs (requests/<run_id>/{request.json,spec.json,assets/,control/,stub/})
scripts/run-test.sh      one run: compose up -d, docker wait, always down -v
tests/unit/              bun:test unit tests (pure modules)
tests/acceptance/        run.ts (criteria 1–29, 31–32; 29/32 = Playwright e2e of the real UI), overlays, tools/
tests/fixtures/sites/    fake internet: app.test, other.test, cdn.app.test, evil.test, llm.test, with a ground-truth request log
tests/specs/, tests/stub/  TestSpecs and stub-model scripts used by acceptance
spike/                   architecture and egress-proxy spikes (evidence for SPEC §13; don't modify)
secrets/                 gitignored, one file per secret (ANTHROPIC_API_KEY, OPENAI_API_KEY, TEST_USER_*)
artifacts/               gitignored run outputs
```

## Commands

| Task | Command |
|---|---|
| All fast gates | `bun run check` (Biome with warnings as errors, `tsc` 7, `bun test` + aggregate coverage gate ≥90/90, shellcheck, hadolint) |
| Acceptance suite (~21 min, needs Docker) | `bun run test:acceptance` (filter with `-- --only 5,7` or `-- --skip 29,32`; unknown ids exit 1). Writes `artifacts/acceptance-<ts>/report.{json,md}`. |
| Fixture test credentials | `sh scripts/setup-test-secrets.sh` (writes `secrets/TEST_USER_EMAIL` and `secrets/TEST_USER_PASSWORD`) |
| One stub run against fixtures | `COMPOSE_OVERLAYS=tests/acceptance/compose.fixtures.yml scripts/run-test.sh specs/login.json stub//tests/stub/login.json` |
| Live smoke | `COMPOSE_OVERLAYS=tests/acceptance/compose.fixtures.yml scripts/run-test.sh specs/login.json anthropic/claude-opus-5-5` |
| CI workflows (GitHub Actions) | `.github/workflows/ci.yml` (fast gates on every PR and on pushes to `main`) and `.github/workflows/acceptance.yml` (nightly, `workflow_dispatch`, or PR label `run-acceptance`). Same commands as above; see SPEC §14.1. |
| Re-run post-processing | `node src/postprocess/cli.ts artifacts/<run_id>` (inside the orchestrator image) |

## Environment Facts (This Machine)

- macOS arm64, Docker Desktop 29.9 / Compose v5.6, host Node 24.20. Native TypeScript stripping works on the host for scripts; containers run Node 26 LTS.
- The proxy container has direct internet egress here, so `UPSTREAM_PROXY` is optional. With it, use `http.docker.internal:3128` plus `UPSTREAM_BYPASS` for the fixture hosts (the fixtures overlay sets this).
- **Never print, cat or log `./secrets/*` contents.** Grep artifacts for key values only to report hit counts.

## Conventions

- **TypeScript:** erasable syntax only (no parameter properties, enums or namespaces), `.ts` import extensions, `import type`. Node runs the sources directly; `tsc --noEmit` only type-checks.
- **Dependencies:** pinned exactly, with the single workspace lock (`bun.lock`) committed. Install with `bun install --frozen-lockfile`; never add a second lock. Prefer versions published at least 7 days ago. Model providers are called with raw `fetch` (no SDKs), so `NODE_USE_ENV_PROXY` routes them through proxy port 3129.
- **Validation:** zod 4 `z.strictObject`. Model output is untrusted: `normalizeEnums`, then zod, with `toWireSchema()` for providers. **Always pass the wire schema to providers**, never the raw zod JSON schema.
- **Style:** Biome style (2 spaces, single quotes, width 140). Compact code, few comments.
- **Tests:** unit tests in `tests/unit/**` are `bun:test` (assertions stay `node:assert/strict`) and cover pure modules. IO modules are covered by the acceptance suite and excluded via `bunfig.toml` `coveragePathIgnorePatterns`. SPEC §14's coverage floors are aggregate and enforced by `scripts/coverage-gate.ts` (bun's own threshold is per-file and has no branch metric); a slow test that waits on real backoff passes its own timeout as the third `it()` argument.
- **Prompt text:** `src/agent/prompt.ts` (and, later, planner/evaluator prompts and any eval rubric) is lead-authored. Don't change the wording casually; changes need review.
- **Spec sync:** the `gen-squid-conf` script in SPEC §2.4 must stay **byte-identical** to `docker/proxy/gen-squid-conf`.
- **hadolint:** ignores are inline (`# hadolint ignore=DL3008[,DL4006]`) with the reason in SPEC §14. There is no `.hadolint.yaml`.
- **Commits:** conventional style (`feat:`, `docs:`, `chore:`) with the Devin trailer. Never commit `secrets/*` (except `.gitkeep`) or `artifacts/`.

## Hard-Won Gotchas (Don't Rediscover These)

**Chrome**

- Headful Chrome binds CDP to loopback only. That is why the orchestrator shares the browser's network namespace.
- `cap_drop: ALL` and `no-new-privileges` on the browser container break Chrome's sandboxed zygote (`sys_chroot` fails). Use Playwright's seccomp profile instead; the sandbox is on.
- WebGL is `null` under `--disable-gpu`. `CHROME_WEBGL=1` needs `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --disable-gpu-sandbox`.

**Squid**

- Squid's default `umask 027` makes `access.log` unreadable to the orchestrator; `umask 022` is in the config.
- Squid logs CONNECT tunnels when they close, so `main.ts` polls for the `:3129` line (up to 20 s) before summarizing egress.
- `UPSTREAM_PROXY` must not add `always_direct` for every allowed host; only `UPSTREAM_BYPASS` hosts go direct.
- `lookupHostIP: Given Non-IP` lines in `cache.log` are a numeric check, not DNS. Denied hosts are never resolved.

**Recording and post-processing**

- ffmpeg needs `-flush_packets 1`, or a SIGKILLed recorder leaves a 0-byte `raw.mkv`.
- `freezedetect` was rejected: typing falls below the noise floor, so whole runs looked frozen. Long actions are compressed by event duration instead (`ACTIVE_MAX`/`ACTIVE_KEEP`, §7.2).
- Chrome loads `<track kind="chapters">` only when the file is served as `Content-Type: text/vtt`.

**Docker and Compose**

- `docker compose up --exit-code-from` implies `--abort-on-container-exit`, which hung runs when the proxy exited early. `run-test.sh` uses `up -d` + `docker wait`, with a trap to always run `down -v`.
- `docker compose ps --format json` lists exposed ports too; check `PublishedPort > 0`.

**Model providers**

- Anthropic: the API rejects `oversized_image`. `resizedSize` uses round-half-up in the probe and round-half-even for the returned edge, which matches all documented cases. Claude 4.7+ is the high-resolution tier (1920×1080 is sent unchanged).
- Anthropic doesn't guarantee enum casing, hence `normalizeEnums`.
- OpenAI strict mode needs every key `required`, so optional fields are nullable.

**Control plane**

- `POST /api/runs` requires an `Origin` header matching the UI host AND a JSON/multipart content type (CSRF guard); scripts must send `Origin: http://127.0.0.1:7070`.
- `docker compose ... build/down` interpolates env for every service — pass dummy RUN_ID/TEST_FILE/AGENT_MODEL/AGENT_EGRESS_HOSTS for teardown or service builds.
- The run pair's compose is invoked by the runner; UI POSTs create request dirs the runner validates and launches. Never let the UI container have the Docker socket.

**Live-model behaviour**

- Anthropic's `json_schema` grammar limits: ≤16 union-typed params, `minItems` only 0/1, no maxItems, compiled-grammar size cap. `agentWireSchema()` hoists `label`/`plan_step` into the turn object and enums plan ids — required, verified live.
- Squid logs CONNECT tunnels when they CLOSE; undici keeps the model tunnel open across steps, so egress summary polls for the `:3129` line.
- The finish nudge fires on `done: PASSED` with unproven criteria (max 2), feeding the gap back as a history entry; a rejected `done` turn has no ACTION_END.

**Acceptance**

- Criterion 5 (sync) measures real frame `pts` the way `spike/analyze.py` does. The rule: every delay ≥ 0, minimum ≤ 50 ms, maximum ≤ 100 ms. An earlier "every click ≤ 50 ms" bound failed under host load.
