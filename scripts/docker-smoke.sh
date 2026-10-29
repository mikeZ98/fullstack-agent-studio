#!/usr/bin/env bash
# Container smoke test (needs a running Docker daemon): builds the image, starts the fully
# offline compose profile, waits for the HEALTHCHECKs, then verifies the non-root user and
# one streamed chat turn end to end (studio-offline -> mock-agent over HTTP).
#
#   scripts/docker-smoke.sh                     # uses host port 3001
#   SMOKE_PORT=4001 scripts/docker-smoke.sh
#   SMOKE_SKIP_BUILD=1 scripts/docker-smoke.sh  # reuse an already built image (CI)
set -euo pipefail
cd "$(dirname "$0")/.."

port="${SMOKE_PORT:-3001}"
project="studio-smoke-$$"
compose=(docker compose --project-name "$project" --profile offline)
override=""
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  [[ -z "$override" ]] || rm -f "$override"
}
trap cleanup EXIT

fail() {
  echo "✖ $*" >&2
  "${compose[@]}" logs --no-color --tail 50 >&2 || true
  exit 1
}

if [[ "${SMOKE_SKIP_BUILD:-0}" == "1" ]]; then
  docker image inspect fullstack-agent-studio:local >/dev/null || fail "image fullstack-agent-studio:local not found"
else
  echo "▸ Building the image"
  "${compose[@]}" build
fi

echo "▸ Starting the offline profile"
if [[ "$port" != "3001" ]]; then
  override="$(mktemp)"
  printf 'services:\n  studio-offline:\n    ports: !override ["%s:3000"]\n' "$port" >"$override"
  compose+=(--file docker-compose.yml --file "$override")
fi
"${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 120 studio-offline || fail "services did not become healthy"

user="$(docker image inspect --format '{{.Config.User}}' fullstack-agent-studio:local)"
[[ "$user" == "nextjs:nodejs" ]] || fail "image runs as '$user', expected nextjs:nodejs"

for service in mock-agent studio-offline; do
  id="$("${compose[@]}" ps --quiet "$service")"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$id")"
  [[ "$health" == "healthy" ]] || fail "$service is $health"
done

health="$(curl --fail --silent --show-error "http://localhost:${port}/api/health")"
[[ "$health" == *'"status":"ok"'* ]] || fail "unexpected health report: $health"

body='{"id":"smoke","trigger":"submit-message","messages":[{"id":"u1","role":"user","parts":[{"type":"text","text":"Draw a mermaid flow chart"}]}]}'
stream="$(curl --fail --silent --show-error --no-buffer -X POST \
  -H 'content-type: application/json' -d "$body" "http://localhost:${port}/api/chat")"
[[ "$stream" == *'"type":"data-artifact-close"'* ]] || fail "no artifact in the chat stream"
[[ "$stream" == *'data: [DONE]'* ]] || fail "chat stream did not finish"

echo "✔ Container smoke test passed (image user: $user)"
