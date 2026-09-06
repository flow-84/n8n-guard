#!/usr/bin/env bash
# Prepares the docker-compose instance so every n8n-guard check has something
# to look at: an owner account, a Public API key, two workflows, and a folder
# of workflow exports that has deliberately drifted from the instance.
#
#   docker compose up -d
#   ./scripts/demo-setup.sh
#
# Prints the environment block to run the server with. Nothing here touches
# anything outside the compose instance.
set -euo pipefail

N8N_URL="${N8N_URL:-http://localhost:${N8N_DEMO_PORT:-5679}}"
EMAIL="${DEMO_EMAIL:-demo@example.com}"
EXPORT_DIR="${EXPORT_DIR:-$PWD/.n8n-demo-exports}"

# The owner password is generated once and kept out of the repository. A second
# run has to reuse it, because n8n only accepts the owner setup once and every
# later run logs in instead.
CRED_FILE="${DEMO_CRED_FILE:-$PWD/.n8n-demo-credentials}"
if [ -n "${DEMO_PASSWORD:-}" ]; then
  PASSWORD="$DEMO_PASSWORD"
elif [ -f "$CRED_FILE" ]; then
  PASSWORD="$(cat "$CRED_FILE")"
else
  PASSWORD="$(openssl rand -base64 18)"
  (umask 077; printf '%s' "$PASSWORD" > "$CRED_FILE")
fi
COOKIE="$(mktemp)"
trap 'rm -f "$COOKIE"' EXIT

echo "waiting for $N8N_URL ..."
for _ in $(seq 1 60); do
  curl -sf "$N8N_URL/healthz" >/dev/null && break
  sleep 2
done
curl -sf "$N8N_URL/healthz" >/dev/null || { echo "n8n never became healthy; is 'docker compose up -d' running?" >&2; exit 1; }

# n8n answers /healthz before its REST API is ready, so the session is
# established in a retry loop rather than a single shot.
API_KEY=""
for _ in $(seq 1 30); do
  curl -s -c "$COOKIE" -X POST "$N8N_URL/rest/owner/setup" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"firstName\":\"Demo\",\"lastName\":\"User\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1 || true
  curl -s -c "$COOKIE" -X POST "$N8N_URL/rest/login" -H 'content-type: application/json' \
    -d "{\"emailOrLdapLoginId\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1 || true

  SCOPES="$(curl -s -b "$COOKIE" "$N8N_URL/rest/api-keys/scopes" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(d["data"]))' 2>/dev/null || true)"
  if [ -n "$SCOPES" ]; then
    API_KEY="$(curl -s -b "$COOKIE" -X POST "$N8N_URL/rest/api-keys" -H 'content-type: application/json' \
      -d "{\"label\":\"n8n-guard-demo-$(date +%s)\",\"expiresAt\":null,\"scopes\":$SCOPES}" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["rawApiKey"])' 2>/dev/null || true)"
  fi
  [ -n "$API_KEY" ] && break
  sleep 2
done
[ -n "$API_KEY" ] || { echo "could not obtain a Public API key from $N8N_URL" >&2; exit 1; }

# Idempotent: running the script twice must not pile up duplicate workflows.
workflow_exists() {
  curl -s -H "X-N8N-API-KEY: $API_KEY" "$N8N_URL/api/v1/workflows" \
    | python3 -c 'import sys,json;print(any(w["name"]==sys.argv[1] for w in json.load(sys.stdin)["data"]))' "$1"
}

create_workflow() {
  local name="$1" url="$2"
  if [ "$(workflow_exists "$name")" = "True" ]; then
    echo "workflow '$name' already exists, skipping" >&2
    curl -s -H "X-N8N-API-KEY: $API_KEY" "$N8N_URL/api/v1/workflows" \
      | python3 -c 'import sys,json;print(json.dumps(next(w for w in json.load(sys.stdin)["data"] if w["name"]==sys.argv[1])))' "$name"
    return
  fi
  curl -s -X POST "$N8N_URL/api/v1/workflows" -H "X-N8N-API-KEY: $API_KEY" -H 'content-type: application/json' -d "{
    \"name\": \"$name\",
    \"settings\": {},
    \"nodes\": [
      {\"id\":\"a1\",\"name\":\"When clicking Test\",\"type\":\"n8n-nodes-base.manualTrigger\",\"typeVersion\":1,\"position\":[0,0],\"parameters\":{}},
      {\"id\":\"a2\",\"name\":\"Fetch\",\"type\":\"n8n-nodes-base.httpRequest\",\"typeVersion\":4.2,\"position\":[220,0],\"parameters\":{\"url\":\"$url\",\"options\":{}}}
    ],
    \"connections\": {\"When clicking Test\": {\"main\": [[{\"node\":\"Fetch\",\"type\":\"main\",\"index\":0}]]}}
  }"
}

mkdir -p "$EXPORT_DIR"

# 1. A workflow that is exported and matches the instance.
create_workflow "In sync" "https://example.com/in-sync" > "$EXPORT_DIR/in-sync.json"

# 2. A workflow that exists live but was never exported -> missing_in_git.
create_workflow "Never exported" "https://example.com/never-exported" >/dev/null

# 3. A workflow that points at the sink container, which accepts the connection
#    and never answers, so demo-stuck-run.sh can leave a run in `running`.
create_workflow "Nightly sync" "http://demo-sink:5999/hang" >/dev/null

# 4. An export whose workflow no longer exists live -> missing_in_instance.
python3 - "$EXPORT_DIR/deleted-upstream.json" <<'PY'
import json, sys
json.dump({
    "id": "gone-from-instance",
    "name": "Deleted upstream",
    "nodes": [{"name": "Noop", "type": "n8n-nodes-base.noOp", "typeVersion": 1, "position": [0, 0], "parameters": {}}],
    "connections": {},
}, open(sys.argv[1], "w"), indent=2)
PY

# 5. Drift the "In sync" export so its content no longer matches -> content_drift.
python3 - "$EXPORT_DIR/in-sync.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
for node in data.get("nodes", []):
    if node.get("name") == "Fetch":
        node.setdefault("parameters", {})["url"] = "https://example.com/OLD-URL"
data["name"] = "In sync"
json.dump(data, open(path, "w"), indent=2)
PY

cat <<EOF

Demo instance ready. Run n8n-guard against it with:

  export N8N_URL=$N8N_URL
  export N8N_API_KEY=$API_KEY
  export N8N_SQLITE_PATH=$PWD/.n8n-demo/database.sqlite
  export N8N_GIT_REPO_PATH=$EXPORT_DIR
  npm start

n8n owner login: $EMAIL / $PASSWORD  (also stored in $CRED_FILE)
EOF
