#!/usr/bin/env bash
# Starts one execution that stays in `running`, so `stuck_executions` has
# something real to find during the demo recording.
#
#   ./scripts/demo-stuck-run.sh
#
# The workflow it starts points at a TCP sink that accepts the connection and
# never answers, so the run hangs until the node's own timeout expires (about
# an hour). Run this again if the recording is more than an hour after setup.
#
# The Public API cannot start an execution, so this uses the same internal REST
# session that demo-setup.sh already uses to create the owner and the API key.
set -euo pipefail

N8N_URL="${N8N_URL:-http://localhost:${N8N_DEMO_PORT:-5679}}"
EMAIL="${DEMO_EMAIL:-demo@example.com}"
WORKFLOW_NAME="${DEMO_STUCK_WORKFLOW:-Nightly sync}"
CRED_FILE="${DEMO_CRED_FILE:-$PWD/.n8n-demo-credentials}"

[ -f "$CRED_FILE" ] || { echo "no $CRED_FILE; run ./scripts/demo-setup.sh first" >&2; exit 1; }
PASSWORD="$(cat "$CRED_FILE")"

COOKIE="$(mktemp)"
trap 'rm -f "$COOKIE"' EXIT

curl -sf -c "$COOKIE" -X POST "$N8N_URL/rest/login" -H 'content-type: application/json' \
  -d "{\"emailOrLdapLoginId\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null \
  || { echo "login to $N8N_URL failed; is the demo instance up?" >&2; exit 1; }

WORKFLOW_ID="$(curl -s -b "$COOKIE" "$N8N_URL/rest/workflows?includeScopes=false" \
  | python3 -c 'import sys,json;print(next((w["id"] for w in json.load(sys.stdin)["data"] if w["name"]==sys.argv[1]),""))' "$WORKFLOW_NAME")"
[ -n "$WORKFLOW_ID" ] || { echo "workflow '$WORKFLOW_NAME' not found; run ./scripts/demo-setup.sh first" >&2; exit 1; }

# n8n refuses a manual run without a starting point, and the payload it wants is
# the full workflow plus the trigger node to start from.
PAYLOAD="$(curl -s -b "$COOKIE" "$N8N_URL/rest/workflows/$WORKFLOW_ID" | python3 -c '
import sys, json
data = json.load(sys.stdin)["data"]
trigger = next(n["name"] for n in data["nodes"] if n["type"].endswith("Trigger"))
print(json.dumps({"workflowData": data, "startNodes": [], "runData": {},
                  "triggerToStartFrom": {"name": trigger}}))')"

EXECUTION_ID="$(curl -s -b "$COOKIE" -X POST "$N8N_URL/rest/workflows/$WORKFLOW_ID/run" \
  -H 'content-type: application/json' -d "$PAYLOAD" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("executionId",""))')"
[ -n "$EXECUTION_ID" ] || { echo "the instance did not start an execution" >&2; exit 1; }

echo "execution $EXECUTION_ID of '$WORKFLOW_NAME' is running and will not finish"
echo "wait about a minute, then stuck_executions with threshold_minutes: 1 reports it"
