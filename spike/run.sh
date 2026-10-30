#!/usr/bin/env bash
# Rebuilds and reruns both spike arms end to end. Keeps images, removes containers/volumes.
set -euo pipefail
cd "$(dirname "$0")"

# Docker Desktop's internal forwarder; needed for apt/npm inside builds and runtime containers.
if [ -z "${http_proxy:-}" ]; then
  export http_proxy=http://http.docker.internal:3128
  export https_proxy=http://http.docker.internal:3128
  export HTTP_PROXY=$http_proxy HTTPS_PROXY=$https_proxy
  export NO_PROXY=localhost,127.0.0.1,browser,pages,pages-alt
  export no_proxy=$NO_PROXY
fi

wait_healthy() {
  # $1 = compose file, $2 = project, $3 = service, $4 = timeout seconds
  local cid status
  cid=$(docker compose -p "$2" -f "$1" ps -q "$3")
  for _ in $(seq 1 "$4"); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "missing")
    [ "$status" = "healthy" ] && return 0
    sleep 1
  done
  echo "service $3 not healthy after ${4}s (last status: $status)" >&2
  return 1
}

sample_stats() {
  # $1 = results dir, $2 = project name prefix for containers
  local dir=$1 proj=$2
  echo "epoch_s,container,cpu_perc,mem_usage" > "$dir/stats.csv"
  # wait for the recording marker
  for _ in $(seq 1 90); do [ -f "$dir/.recording" ] && break; sleep 1; done
  while [ -f "$dir/.recording" ]; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' \
      | grep "^${proj}-" \
      | sed "s/^/$(node -e 'console.log((Date.now()/1000).toFixed(3))'),/" >> "$dir/stats.csv" || true
    sleep 1
  done
}

merge_json() {
  # $1 = file, $2 = key, $3 = json value
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    j[process.argv[2]] = JSON.parse(process.argv[3]);
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  ' "$1" "$2" "$3"
}

run_arm() {
  local arm=$1
  local proj="spike-$arm"
  local compose_file="arm-$arm/docker-compose.yml"
  local res="results/$arm"
  mkdir -p "$res/logs"
  chmod 777 "$res" "$res/logs" 2>/dev/null || true
  rm -f "$res"/{.recording,events.jsonl,frames.jsonl,stats.csv,timings.json,checks.json,error.txt,swiftshader.json,video.mkv,video.webm,quality.png,decor_on.png,decor_off.png,aria_before.txt,aria_after.txt}
  rm -rf "$res/frames"
  mkdir -p "$res/frames"
  chmod 777 "$res/frames" 2>/dev/null || true

  echo "=== arm $arm: build + up browser ==="
  local t0
  t0=$(node -e 'console.log(Date.now()/1000)')
  docker compose -p "$proj" -f "$compose_file" up -d --build browser
  local sandbox_mode=seccomp+caps-dropped
  if ! wait_healthy "$compose_file" "$proj" browser 90; then
    if [ "$arm" = "a" ]; then
      echo "sandboxed Chrome failed; retrying with --no-sandbox" >&2
      sandbox_mode=no-sandbox
      CHROME_NO_SANDBOX=1 docker compose -p "$proj" -f "$compose_file" up -d --force-recreate browser
      wait_healthy "$compose_file" "$proj" browser 90
    else
      echo "arm-b browser unhealthy; retrying with chromiumSandbox off" >&2
      sandbox_mode=no-sandbox
    fi
  fi
  local up_s
  up_s=$(node -e "console.log((Date.now()/1000 - $t0).toFixed(3))")

  echo "=== arm $arm: orchestrator run (sandbox mode: $sandbox_mode) ==="
  local sb_on=0
  [ "$arm" = "b" ] && [ "$sandbox_mode" != "no-sandbox" ] && sb_on=1
  sample_stats "$res" "$proj" &
  local sampler_pid=$!
  set +e
  MODE=full CHROME_SANDBOX="$sandbox_mode" CHROMIUM_SANDBOX_ON=$sb_on \
    docker compose -p "$proj" -f "$compose_file" up --build --exit-code-from orchestrator orchestrator
  local rc=$?
  set -e
  wait "$sampler_pid" 2>/dev/null || true
  if [ "$arm" = "b" ] && [ "$rc" != 0 ] && [ "$sb_on" = 1 ]; then
    echo "sandboxed Chromium failed; retrying with sandbox off" >&2
    sandbox_mode=no-sandbox
    sample_stats "$res" "$proj" &
    sampler_pid=$!
    set +e
    MODE=full CHROME_SANDBOX=no-sandbox CHROMIUM_SANDBOX_OFF=1 CHROMIUM_SANDBOX_ON=0 \
      docker compose -p "$proj" -f "$compose_file" up --build --exit-code-from orchestrator orchestrator
    rc=$?
    set -e
    wait "$sampler_pid" 2>/dev/null || true
  fi

  if [ -f "$res/timings.json" ]; then
    merge_json "$res/timings.json" compose_up_to_ready_s "$up_s"
  else
    echo "{\"compose_up_to_ready_s\": $up_s, \"connect_ms\": null, \"record_start_to_first_frame_ms\": null}" > "$res/timings.json"
  fi

  echo "=== arm $arm: swiftshader pass (rc so far: $rc) ==="
  if [ "$arm" = "a" ]; then
    local extra="--enable-unsafe-swiftshader --disable-gpu-sandbox --ignore-gpu-blocklist --use-angle=swiftshader"
    CHROME_EXTRA_ARGS="$extra" CHROME_NO_SANDBOX=$([ "$sandbox_mode" = "no-sandbox" ] && echo 1 || echo 0) \
      CHROME_DISABLE_GPU=0 \
      docker compose -p "$proj" -f "$compose_file" up -d --force-recreate browser
    wait_healthy "$compose_file" "$proj" browser 90
  fi
  set +e
  # NOTE: depends_on recreation resets the browser env, so the extra Chrome
  # args must be re-supplied here or depends_on will recreate it without them.
  MODE=swiftshader CHROME_SANDBOX="$sandbox_mode" CHROMIUM_SANDBOX_ON=$sb_on \
    CHROME_EXTRA_ARGS="${extra:-}" CHROME_DISABLE_GPU=$([ "$arm" = "a" ] && echo 0 || echo 1) \
    CHROME_NO_SANDBOX=$([ "$sandbox_mode" = "no-sandbox" ] && echo 1 || echo 0) \
    docker compose -p "$proj" -f "$compose_file" up --force-recreate --exit-code-from orchestrator orchestrator
  set -e
  if [ -f "$res/swiftshader.json" ]; then
    local val
    val=$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).webgl_swiftshader))' "$res/swiftshader.json")
    merge_json "$res/checks.json" webgl_swiftshader "$val"
  fi

  docker compose -p "$proj" -f "$compose_file" logs > "$res/logs/containers.log" 2>&1 || true
  docker compose -p "$proj" -f "$compose_file" down -v
  echo "=== arm $arm done (orchestrator rc=$rc) ==="
  return 0
}

run_arm a
run_arm b
echo "All arms complete."
