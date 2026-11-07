#!/bin/sh
# Runs one test end to end: scripts/run-test.sh <test-file-relative-to-tests/> <agent-model>
# <agent-model> is <provider>/<id>; for the stub provider the id is the script path as the
# orchestrator sees it (e.g. stub/tests/stub/login.json or stub/login.json under /tests).
set -eu

TEST_FILE_ARG=${1:?usage: run-test.sh <test-file> <agent-model>}
AGENT_MODEL=${2:?usage: run-test.sh <test-file> <agent-model>}
PROVIDER=${AGENT_MODEL%%/*}

case "$PROVIDER" in
  anthropic) default_hosts=api.anthropic.com ;;
  openai) default_hosts=api.openai.com ;;
  stub) default_hosts=stub.invalid ;;
  *) echo "run-test.sh: unknown provider '$PROVIDER' (expected anthropic|openai|stub)" >&2; exit 2 ;;
esac
AGENT_EGRESS_HOSTS="${AGENT_EGRESS_HOSTS:-$default_hosts}"

RUN_ID="$(date +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' ')"
export RUN_ID AGENT_MODEL AGENT_EGRESS_HOSTS
export TEST_FILE="/tests/$TEST_FILE_ARG"
export UPSTREAM_PROXY="${UPSTREAM_PROXY:-}"
export UPSTREAM_BYPASS="${UPSTREAM_BYPASS:-}"
export CHROME_WEBGL="${CHROME_WEBGL:-0}"

FILES="-f docker-compose.yml"
if [ -n "${COMPOSE_OVERLAYS:-}" ]; then
  for f in $COMPOSE_OVERLAYS; do FILES="$FILES -f $f"; done
fi
PROJECT="run-$RUN_ID"

# The orchestrator runs as `node` (uid 1000) inside the container and creates
# its own run directory (§9 requires it to be fresh). On a Linux host the bind
# mount is owned by a different uid, so the artifacts root must be writable from
# inside; Docker Desktop's permissive mounts hide this.
mkdir -p artifacts
chmod 0777 artifacts

DOWN_DONE=0
cleanup() {
  [ "$DOWN_DONE" -eq 1 ] && return 0
  DOWN_DONE=1
  # shellcheck disable=SC2086
  docker compose $FILES -p "$PROJECT" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

rc=0
# shellcheck disable=SC2086
docker compose $FILES -p "$PROJECT" up --build -d || rc=$?
# --exit-code-from implies abort-on-any-exit, which would kill the browser before a
# fast-failing orchestrator (or a fast-failing proxy) can report a clean exit code.
# shellcheck disable=SC2086
ORCH_CID="$(docker compose $FILES -p "$PROJECT" ps -q orchestrator 2>/dev/null || true)"
if [ -n "$ORCH_CID" ]; then
  rc="$(docker wait "$ORCH_CID" 2>/dev/null || echo "$rc")"
elif [ "$rc" -eq 0 ]; then
  rc=1
fi

# A failed run is only diagnosable if the containers' stderr survives: `cleanup`
# below removes them (and their logs) with the project.
if [ "$rc" -ne 0 ]; then
  echo "---- orchestrator log (exit $rc) ----"
  # shellcheck disable=SC2086
  docker compose $FILES -p "$PROJECT" logs --no-color --tail 200 orchestrator 2>&1 || true
  echo "---- proxy log ----"
  # shellcheck disable=SC2086
  docker compose $FILES -p "$PROJECT" logs --no-color --tail 40 proxy 2>&1 || true
  echo "---- end container logs ----"
fi

cleanup
echo "artifacts: artifacts/$RUN_ID"
exit "$rc"
