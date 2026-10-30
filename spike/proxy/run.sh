#!/usr/bin/env bash
# Rebuilds and reruns the egress-proxy spike end to end. Keeps images, removes containers/volumes.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${http_proxy:-}" ]; then
  export http_proxy=http://http.docker.internal:3128
  export https_proxy=http://http.docker.internal:3128
  export HTTP_PROXY=$http_proxy HTTPS_PROXY=$https_proxy
  export NO_PROXY=localhost,127.0.0.1
  export no_proxy=$NO_PROXY
fi

PROJ=spike-proxy
CF=docker-compose.yml
RES=../results/proxy
dc() { docker compose -p "$PROJ" -f "$CF" "$@"; }

mkdir -p "$RES"/{squid,internet,logs}
chmod -R 777 "$RES" 2>/dev/null || true
rm -f "$RES"/{checks.json,real.json,direct.json,error.txt,squid.conf,squid-upstream.conf}
rm -f "$RES"/squid/{access.log,cache.log} "$RES"/internet/internet.jsonl

json_field() { # $1=file $2=key $3=raw string value
  node -e '
    const fs=require("fs");
    const f=process.argv[1];
    const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};
    j[process.argv[2]]=process.argv[3];
    fs.writeFileSync(f,JSON.stringify(j,null,2));
  ' "$1" "$2" "$3"
}

echo "=== build + up infra ==="
dc up -d --build internet proxy browser
dc restart internet >/dev/null   # reopen internet.jsonl in case it was truncated under a running server

for i in $(seq 1 90); do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$PROJ-browser-1" 2>/dev/null || echo missing)
  [ "$s" = healthy ] && break; sleep 1
done
echo "browser health: $s"
sleep 3  # let squid finish parsing its generated config

INET_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$PROJ-internet-1" | awk '{print $1}')
echo "internet egress IP: $INET_IP"
json_field "$RES/direct.json" internet_egress_ip "$INET_IP"

echo "=== check 1: direct egress probes ==="
echo '{}' > "$RES/direct.json.tmp"
run_probe() { # $1=json-key-prefix, rest=command run via dc
  local key=$1; shift
  local out rc
  set +e
  out=$("$@" 2>&1); rc=$?
  set -e
  printf '%s\n' "$out" >> "$RES/logs/check1.log"
  node -e '
    const fs=require("fs");
    const f=process.argv[1];
    const j=JSON.parse(fs.readFileSync(f,"utf8"));
    j[process.argv[2]]={rc:Number(process.argv[3]),output:process.argv[4]};
    fs.writeFileSync(f,JSON.stringify(j,null,2));
  ' "$RES/direct.json.tmp" "$key" "$rc" "$out"
}
: > "$RES/logs/check1.log"

run_probe browser_getent_evil      dc exec -T browser getent hosts evil.test
run_probe browser_getent_example   dc exec -T browser getent hosts example.com
run_probe browser_getent_proxy     dc exec -T browser getent hosts proxy
run_probe browser_tcp_internet     dc exec -T browser bash -c "timeout 3 bash -c '</dev/tcp/$INET_IP/8080' && echo CONNECTED || echo FAILED:\$?"
run_probe orch_getent_evil         dc run --rm --no-deps -T --entrypoint node orchestrator -e "require('dns').lookup('evil.test',(e,a)=>{console.log(e?String(e):a);process.exit(e?1:0)})"
run_probe orch_getent_example      dc run --rm --no-deps -T --entrypoint node orchestrator -e "require('dns').lookup('example.com',(e,a)=>{console.log(e?String(e):a);process.exit(e?1:0)})"
run_probe orch_getent_proxy        dc run --rm --no-deps -T --entrypoint node orchestrator -e "require('dns').lookup('proxy',(e,a)=>{console.log(e?String(e):a);process.exit(e?1:0)})"
run_probe orch_tcp_internet        dc run --rm --no-deps -T --entrypoint node orchestrator -e "
  const s=require('net').connect(8080,'$INET_IP',()=>{console.log('CONNECTED');process.exit(0)});
  s.setTimeout(3000,()=>{console.log('TIMEOUT');process.exit(1)});
  s.on('error',e=>{console.log('ERR '+e.code);process.exit(1)})"

node -e '
  const fs=require("fs");
  const d=JSON.parse(fs.readFileSync("'$RES'/direct.json.tmp","utf8"));
  const j=fs.existsSync("'$RES'/direct.json")?JSON.parse(fs.readFileSync("'$RES'/direct.json","utf8")):{};
  j.direct_egress_browser={getent_evil:d.browser_getent_evil,getent_example:d.browser_getent_example,getent_proxy:d.browser_getent_proxy,tcp_internet:d.browser_tcp_internet};
  j.direct_egress_orchestrator={getent_evil:d.orch_getent_evil,getent_example:d.orch_getent_example,getent_proxy:d.orch_getent_proxy,tcp_internet:d.orch_tcp_internet};
  fs.writeFileSync("'$RES'/direct.json",JSON.stringify(j,null,2));
'
rm -f "$RES/direct.json.tmp"

echo "=== check: main harness run ==="
set +e
MODE=full dc up --build --exit-code-from orchestrator orchestrator
rc=$?
set -e
echo "orchestrator rc=$rc"

dc exec -T proxy cat /etc/squid/squid.conf > "$RES/squid.conf" 2>/dev/null || true

echo "=== check 9: real-internet pass (UPSTREAM_PROXY) ==="
set +e
TEST_FILE=/spec/test2.json UPSTREAM_PROXY=http.docker.internal:3128 \
  dc up -d --force-recreate proxy
sleep 3
dc exec -T proxy cat /etc/squid/squid.conf > "$RES/squid-upstream.conf" 2>/dev/null || true
# re-supply the spec/upstream env: depends_on would recreate the proxy with defaults otherwise
TEST_FILE=/spec/test2.json UPSTREAM_PROXY=http.docker.internal:3128 \
  MODE=real dc up --force-recreate --exit-code-from orchestrator orchestrator
realrc=$?
set -e
echo "real pass rc=$realrc"

node post.mjs

dc logs > "$RES/logs/containers.log" 2>&1 || true
cp "$RES"/squid/access.log "$RES"/logs/squid-access.log 2>/dev/null || true
cp "$RES"/squid/cache.log "$RES"/logs/squid-cache.log 2>/dev/null || true

dc down -v
echo "=== proxy spike done ==="
