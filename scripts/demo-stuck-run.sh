#!/usr/bin/env bash
# Gives the demo instance something for `stuck_executions` to find: a workflow
# with a real median runtime, and one execution of that same workflow hanging
# far past it.
#
#   N8N_URL=http://localhost:5678 N8N_API_KEY=... ./scripts/demo-stuck-run.sh
#
# A run is made to hang by pointing it at a TCP sink container that accepts the
# connection and never answers. An unroutable IP does not work: the connect
# attempt fails after about 75 seconds and the run ends as an error.
set -euo pipefail

URL="${N8N_URL:-http://localhost:${N8N_DEMO_PORT:-5678}}"
KEY="${N8N_API_KEY:?N8N_API_KEY is required, demo-setup.sh prints it}"
NETWORK="${DEMO_NETWORK:-n8n-guard_default}"
SINK="${DEMO_SINK:-demo-sink}"
NAME="${DEMO_WORKFLOW:-Nightly sync}"
H=(-H "X-N8N-API-KEY: $KEY" -H 'content-type: application/json')

body() { # $1 = url the HTTP node calls, $2 = node timeout in ms
  python3 -c '
import json, sys
url, timeout, name = sys.argv[1], int(sys.argv[2]), sys.argv[3]
print(json.dumps({
  "name": name,
  "settings": {"executionOrder": "v1"},
  "nodes": [
    {"id": "s1", "name": "Schedule", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2,
     "position": [0, 0], "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}},
    {"id": "h1", "name": "Fetch", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
     "position": [220, 0], "parameters": {"url": url, "options": {"timeout": timeout}}},
  ],
  "connections": {"Schedule": {"main": [[{"node": "Fetch", "type": "main", "index": 0}]]}},
}))' "$1" "$2" "$NAME"
}

count() { # $1 = execution status
  curl -s "${H[@]}" "$URL/api/v1/executions?workflowId=$id&status=$1&limit=100" \
    | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["data"]))'
}

if ! docker ps --filter "name=^${SINK}$" --format '{{.Names}}' | grep -q .; then
  docker rm -f "$SINK" >/dev/null 2>&1 || true
  docker run -d --name "$SINK" --network "$NETWORK" alpine/socat \
    TCP-LISTEN:5999,fork,reuseaddr SYSTEM:'sleep 3600' >/dev/null
  echo "started the TCP sink container $SINK"
fi

id="$(curl -s "${H[@]}" "$URL/api/v1/workflows" \
  | python3 -c 'import sys,json;m=[w for w in json.load(sys.stdin)["data"] if w["name"]==sys.argv[1]];print(m[0]["id"] if m else "")' "$NAME")"
if [ -z "$id" ]; then
  id="$(curl -s -X POST "${H[@]}" -d "$(body https://example.com 10000)" "$URL/api/v1/workflows" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
fi
echo "workflow $id ($NAME)"

# A baseline first: without finished runs there is no median to judge against.
curl -s -X PUT "${H[@]}" -d "$(body https://example.com 10000)" "$URL/api/v1/workflows/$id" >/dev/null
curl -s -X POST "${H[@]}" "$URL/api/v1/workflows/$id/activate" >/dev/null
echo "collecting baseline runs, one per minute ..."
for _ in $(seq 1 12); do
  n="$(count success)"
  [ "$n" -ge 3 ] && break
  sleep 20
done
curl -s -X POST "${H[@]}" "$URL/api/v1/workflows/$id/deactivate" >/dev/null
echo "baseline: $(count success) finished runs"

# Then one run that never comes back.
curl -s -X PUT "${H[@]}" -d "$(body "http://$SINK:5999/hang" 3600000)" "$URL/api/v1/workflows/$id" >/dev/null
curl -s -X POST "${H[@]}" "$URL/api/v1/workflows/$id/activate" >/dev/null
echo "waiting for the hanging run to start ..."
for _ in $(seq 1 12); do
  [ "$(count running)" -ge 1 ] && break
  sleep 15
done
# Deactivating leaves the already running execution alone: exactly one stays stuck.
curl -s -X POST "${H[@]}" "$URL/api/v1/workflows/$id/deactivate" >/dev/null
echo "stuck: $(count running) running execution(s)"
echo "It counts as stuck about a minute after it started. The sink holds the"
echo "connection for an hour, so rerun this script if the recording is later."
