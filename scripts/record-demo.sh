#!/usr/bin/env bash
# Records the submission demo video end to end. One command, no clicking:
#
#   ./scripts/record-demo.sh
#
# It builds, starts the throwaway compose instance, seeds it, starts the run
# that hangs, waits until that run is really visible as `running`, records a
# dedicated Terminal window while scripts/demo-play.mjs drives the MCP server
# over stdio, then tears the instance down and prints the path to the file.
#
# Nothing outside the compose instance is touched. The Public API key stays in
# .n8n-demo-env (mode 600, gitignored) and is never printed into the recorded
# window.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT_DIR="${DEMO_OUT_DIR:-$ROOT/.n8n-demo-recording}"
OUT="${DEMO_OUT:-$OUT_DIR/n8n-guard-demo-$(date +%Y%m%d-%H%M%S).mp4}"
ENV_FILE="$ROOT/.n8n-demo-env"
MARKER="$OUT_DIR/.play-done"
# 5679, not 5678: the demo must never reach a production n8n on the default port.
N8N_DEMO_PORT="${N8N_DEMO_PORT:-5679}"
export N8N_DEMO_PORT
N8N_URL="${N8N_URL:-http://localhost:$N8N_DEMO_PORT}"
export N8N_URL
# The demo needs the run to be older than the threshold it is queried with.
STUCK_AGE_SECONDS="${DEMO_STUCK_AGE_SECONDS:-75}"
COLUMNS_ON_CAMERA="${DEMO_COLUMNS:-96}"
ROWS_ON_CAMERA="${DEMO_ROWS:-30}"

mkdir -p "$OUT_DIR"
rm -f "$MARKER"

WINDOW_ID=""
# Whatever happens - a failed recording, a Ctrl-C - the demo instance and the
# file holding the API key do not survive this script.
cleanup() {
  [ -n "$WINDOW_ID" ] && osascript -e "tell application \"Terminal\" to close (every window whose id is $WINDOW_ID)" >/dev/null 2>&1
  docker compose down >/dev/null 2>&1
  rm -f "$ENV_FILE"
  return 0
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$1"; }

say "build"
[ -d node_modules ] || npm install
npm run build >/dev/null

say "demo instance"
docker compose up -d --remove-orphans >/dev/null
SETUP_OUT="$(./scripts/demo-setup.sh)"
API_KEY="$(printf '%s\n' "$SETUP_OUT" | sed -n 's/^ *export N8N_API_KEY=//p' | tail -1)"
[ -n "$API_KEY" ] || { echo "demo-setup.sh did not print an API key" >&2; exit 1; }

umask 077
cat > "$ENV_FILE" <<EOF
N8N_URL=$N8N_URL
N8N_API_KEY=$API_KEY
N8N_SQLITE_PATH=$ROOT/.n8n-demo/database.sqlite
N8N_GIT_REPO_PATH=$ROOT/.n8n-demo-exports
N8N_GUARD_STUCK_MINUTES=1
N8N_GUARD_TIMEOUT_MS=4000
EOF
umask 022

say "hanging execution"
./scripts/demo-stuck-run.sh >/dev/null

# Wait for the run to be reported as `running` AND old enough to cross the
# 1 minute threshold the demo queries with: the completion signal, not the
# first sign of life.
started_seconds_ago() {
  curl -s -H "X-N8N-API-KEY: $API_KEY" "$N8N_URL/api/v1/executions?status=running&limit=50" | python3 -c '
import sys, json, datetime
try:
    runs = json.load(sys.stdin).get("data", [])
except Exception:
    print(-1); raise SystemExit
if not runs:
    print(-1); raise SystemExit
now = datetime.datetime.now(datetime.timezone.utc)
ages = [(now - datetime.datetime.fromisoformat(r["startedAt"].replace("Z", "+00:00"))).total_seconds() for r in runs if r.get("startedAt")]
print(int(max(ages)) if ages else -1)'
}

for _ in $(seq 1 60); do
  AGE="$(started_seconds_ago || echo -1)"
  [ "${AGE:--1}" -ge "$STUCK_AGE_SECONDS" ] && break
  printf '\r   running execution age: %ss / %ss' "${AGE:--1}" "$STUCK_AGE_SECONDS"
  sleep 5
done
printf '\n'
[ "${AGE:--1}" -ge "$STUCK_AGE_SECONDS" ] || { echo "no execution stayed in 'running'; is the demo-sink container up?" >&2; exit 1; }

say "recording"
# A window of its own, sized in characters, so the recording holds the demo and
# nothing else that happens to be on the desktop.
BOUNDS="$(osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "cd $ROOT && clear && DEMO_DONE_MARKER=$MARKER ./scripts/demo-play.mjs"
  set demoWindow to front window
  set number of columns of demoWindow to $COLUMNS_ON_CAMERA
  set number of rows of demoWindow to $ROWS_ON_CAMERA
  set position of demoWindow to {40, 40}
  delay 1
  set b to bounds of demoWindow
  set demoId to id of demoWindow
  return ((item 1 of b) as text) & "," & ((item 2 of b) as text) & "," & ((item 3 of b) as text) & "," & ((item 4 of b) as text) & "," & (demoId as text)
end tell
APPLESCRIPT
)"
X1="${BOUNDS%%,*}"; REST="${BOUNDS#*,}"
Y1="${REST%%,*}"; REST="${REST#*,}"
X2="${REST%%,*}"; REST="${REST#*,}"
Y2="${REST%%,*}"; WINDOW_ID="${REST#*,}"
RECT="$X1,$Y1,$((X2 - X1)),$((Y2 - Y1))"

# screencapture -v is denied on this machine even when still screenshots are
# allowed, and it fails silently. ffmpeg's avfoundation capture works, so the
# full screen is recorded and cropped to the demo window afterwards.
SCREEN_IDX="$(ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | sed -n 's/^.*\[\([0-9]*\)\] Capture screen 0$/\1/p' | head -1)"
[ -n "$SCREEN_IDX" ] || { echo "no 'Capture screen' device found in avfoundation" >&2; exit 1; }
RAW="$OUT_DIR/.raw-$(date +%s).mkv"
ffmpeg -y -loglevel error -f avfoundation -framerate 15 -i "$SCREEN_IDX" "$RAW" </dev/null &
REC_PID=$!
# A denied recording does not fail loudly: the process keeps running and never
# writes anything. The output file growing is the signal that it really records.
for _ in $(seq 1 20); do
  [ -s "$RAW" ] && break
  sleep 0.5
done
if [ ! -s "$RAW" ]; then
  kill -9 "$REC_PID" 2>/dev/null || true
  echo "ffmpeg wrote nothing: macOS denies screen recording to the app this script runs in. Grant it in System Settings > Privacy & Security > Screen & System Audio Recording, then run this script again." >&2
  exit 1
fi

for _ in $(seq 1 340); do
  [ -f "$MARKER" ] && break
  sleep 0.5
done
sleep 1
kill -INT "$REC_PID" 2>/dev/null || true
for _ in $(seq 1 30); do
  kill -0 "$REC_PID" 2>/dev/null || break
  sleep 1
done
kill -9 "$REC_PID" 2>/dev/null || true
wait "$REC_PID" 2>/dev/null || true

[ -s "$RAW" ] || { echo "no video was written to $RAW; check Screen Recording permission." >&2; exit 1; }
# avfoundation records in device pixels, the window bounds are in points.
PX_W="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$RAW")"
PT_W="$(osascript -e 'tell application "Finder" to get item 3 of (bounds of window of desktop)')"
CROP="$(python3 - "$PX_W" "$PT_W" "$X1" "$Y1" "$X2" "$Y2" <<'PYEOF'
import sys
px_w, pt_w, x1, y1, x2, y2 = (int(float(v)) for v in sys.argv[1:7])
s = px_w / pt_w
even = lambda v: int(v) - (int(v) % 2)
print(f"crop={even((x2-x1)*s)}:{even((y2-y1)*s)}:{even(x1*s)}:{even(y1*s)}")
PYEOF
)"
ffmpeg -y -loglevel error -i "$RAW" -vf "$CROP" -pix_fmt yuv420p "$OUT"
rm -f "$RAW"

[ -s "$OUT" ] || { echo "cropping produced no file at $OUT" >&2; exit 1; }
DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null || echo "?")"
printf '\nvideo: %s\nlength: %s seconds (limit 120)\n' "$OUT" "$DURATION"
