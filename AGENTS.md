# AGENTS.md: Context for Future Sessions

Read this first, then `SPEC.md`, which is the source of truth for architecture, interfaces, behaviour and acceptance criteria. When behaviour changes, update `SPEC.md` in the same change.

## What This Project Is

An AI-agent-driven browser testing platform.

- **Execution:** an LLM/VLM agent drives a real, sandboxed, headful Chrome to execute a test goal.
- **Evidence:** everything is recorded (screen video, event timeline, screenshots, transcript), and the harness, not the agent, decides pass/fail.
- **Output:** a condensed video with idle time compressed, zoom on actions, and chapters marked passed/failed.

## Status (2026-10-30)

| Area | State |
|---|---|
| SPEC §0–§14 (core harness) | **Implemented and committed** (`5c21d33`). All gates green; acceptance suite 21/21. |
| Live smoke, Anthropic (`anthropic/claude-opus-5-5`) | PASSED against the fixture login site. |
| Live smoke, OpenAI (`openai/gpt-6-astra`) | **Blocked by the key, not the code**: OpenAI returns 401 "Missing scopes: api.responses.write". The user must grant that scope or provide another key in `./secrets/OPENAI_API_KEY`. |
| SPEC §15 (natural-language runs: plan → execute → evaluate → report) | **Designed, not implemented.** |
| SPEC §16 (runner daemon, control-plane API, React web UI) | **Designed, not implemented.** |

User decisions behind §15–16:

- The control plane runs in a container and talks to a host **runner daemon** over token-authenticated HTTP. Only the runner touches Docker.
- Plan review is an optional per-run toggle (default off).
- The UI is a React + Vite SPA, localhost only, with no login.

### Next Work: Suggested Phases for §15–16

1. **Orchestrator.**
   - Refactor provider clients to a generic `structured({system, parts, schema})` call, with `next()` built on it.
   - Add `planner.ts`, approval polling (`/control/approval.json`), plan-aware actions (`plan_step`, `criterion`, `step_done`, `upload`, `assert_url`), `status.json`, `evaluator.ts`, the §15.5 verdict and `CANCELLED` (exit 4).
   - Generate `report.json/md/html` with every string HTML-escaped.
   - Fixtures: add a blog app (login, new post with image upload, publish toggle, public page) and a `hero.png` asset.
   - Acceptance criteria 22–26.
2. **Runner daemon** (`src/runner/`) and **control-plane API** (`src/server/`):
   - the ui container plus compose wiring for `/run-input` and `/control`;
   - the security guards (token, Host header, Origin, CSP sandbox on artifacts);
   - criteria 27–28.
3. **React SPA** (`ui/`): runs list, new-run form, run detail (live SSE, plan approval, report, video with chapter seek, screenshots), and Playwright UI end-to-end tests (criterion 29).
4. **Live blog scenario** through the UI with a real model (criterion 30). Then the full gates, a SPEC sync and a commit.

## Repository Layout

```text
SPEC.md                  source of truth (§13 spike evidence, §14 quality gates, §15–16 next features)
AGENTS.md / README.md    session context / human quick start
docker/browser/          Ubuntu 26.04 + Xvfb + Openbox + Chrome kiosk (sandbox ON via seccomp_profile.json)
docker/proxy/            Squid 7 egress proxy; gen-squid-conf builds squid.conf from the TestSpec
Dockerfile               orchestrator image (node:26-trixie-slim + ffmpeg + xdotool)
docker-compose.yml       run pair (browser + orchestrator share netns/IPC/X socket) + proxy; networks sandbox (internal) / egress
src/                     orchestrator (runs inside the container)
  main.ts                run lifecycle (§6.6)
  session.ts             CDP connect, invariant, dialog/navigation guards, popup adoption
  recorder.ts            ffmpeg x11grab
  cursor.ts              visible cursor glide
  interaction.ts         InteractionEngine
  config.ts              TestSpec zod + allowlist validation
  secrets.ts             secret loading, origin/input-type binding, redact()
  egress.ts              Squid access-log parsing
  events.ts              timeline schema
  geometry.ts
  agent/                 actions (zod + wire schema), loop, prompt (lead-authored), verdict, budget, coords, model factory
  agent/providers/       anthropic.ts, openai.ts (raw fetch, retries in http.ts), stub.ts
  postprocess/           timemap, zoom, chapters, duration, render, cli
scripts/run-test.sh      one run: compose up -d, docker wait, always down -v
tests/unit/              node:test unit tests (pure modules)
tests/acceptance/        run.ts (criteria 1–21), compose overlays, tools/ (analysis run in the orchestrator image)
tests/fixtures/sites/    fake internet: app.test, other.test, cdn.app.test, evil.test, llm.test, with a ground-truth request log
tests/specs/, tests/stub/  TestSpecs and stub-model scripts used by acceptance
spike/                   architecture and egress-proxy spikes (evidence for SPEC §13; don't modify)
secrets/                 gitignored, one file per secret (ANTHROPIC_API_KEY, OPENAI_API_KEY, TEST_USER_*)
artifacts/               gitignored run outputs
```

## Commands

| Task | Command |
|---|---|
| All fast gates | `npm run check` (Biome with warnings as errors, `tsc` 7, unit tests with coverage ≥90/80/90, shellcheck, hadolint) |
| Acceptance suite (~21 min, needs Docker) | `npm run test:acceptance` (filter with `-- --only 5,7`). Writes `artifacts/acceptance-<ts>/report.{json,md}`. |
| Fixture test credentials | `sh scripts/setup-test-secrets.sh` (writes `secrets/TEST_USER_EMAIL` and `secrets/TEST_USER_PASSWORD`) |
| One stub run against fixtures | `COMPOSE_OVERLAYS=tests/acceptance/compose.fixtures.yml scripts/run-test.sh specs/login.json stub//tests/stub/login.json` |
| Live smoke | `COMPOSE_OVERLAYS=tests/acceptance/compose.fixtures.yml scripts/run-test.sh specs/login.json anthropic/claude-opus-5-5` |
| Re-run post-processing | `node src/postprocess/cli.ts artifacts/<run_id>` (inside the orchestrator image) |

## Environment Facts (This Machine)

- macOS arm64, Docker Desktop 29.9 / Compose v5.6, host Node 24.20. Native TypeScript stripping works on the host for scripts; containers run Node 26 LTS.
- The proxy container has direct internet egress here, so `UPSTREAM_PROXY` is optional. With it, use `http.docker.internal:3128` plus `UPSTREAM_BYPASS` for the fixture hosts (the fixtures overlay sets this).
- **Never print, cat or log `./secrets/*` contents.** Grep artifacts for key values only to report hit counts.

## Conventions

- **TypeScript:** erasable syntax only (no parameter properties, enums or namespaces), `.ts` import extensions, `import type`. Node runs the sources directly; `tsc --noEmit` only type-checks.
- **Dependencies:** pinned exactly, with the lockfile committed. Prefer versions published at least 7 days ago. Model providers are called with raw `fetch` (no SDKs), so `NODE_USE_ENV_PROXY` routes them through proxy port 3129.
- **Validation:** zod 4 `z.strictObject`. Model output is untrusted: `normalizeEnums`, then zod, with `toWireSchema()` for providers. **Always pass the wire schema to providers**, never the raw zod JSON schema.
- **Style:** Biome style (2 spaces, single quotes, width 140). Compact code, few comments.
- **Tests:** unit tests in `tests/unit/**` cover pure modules. IO modules are covered by the acceptance suite and excluded from coverage in `package.json`.
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

**Acceptance**

- Criterion 5 (sync) measures real frame `pts` the way `spike/analyze.py` does. The rule: every delay ≥ 0, minimum ≤ 50 ms, maximum ≤ 100 ms. An earlier "every click ≤ 50 ms" bound failed under host load.
