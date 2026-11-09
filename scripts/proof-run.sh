#!/usr/bin/env bash
# Hubie COUPLED-SYNC proof run — OFF AIR, local recording only.
#
# Runs the full local stack exactly as production does (scene server,
# voice service with the real clip library, chat bridge, Xvfb + Chrome
# kiosk, voice FIFO) and records ~5 minutes with ffmpeg x11grab + the
# FIFO audio — to a LOCAL FILE (demo/hubie-coupled-proof.mp4).
#
# THERE IS NO RTMP TARGET ANYWHERE IN THIS SCRIPT. It never reads
# config/stream.local.json (the scene page fetches its own config for
# the voice/chat bridge URLs, exactly as in production; the stream key
# in that file is never touched by this harness), never calls
# scripts/stream.sh, and pushes nothing anywhere. Verify with:
#   grep -i rtmp scripts/proof-run.sh   (only this comment matches)
#
# Usage: scripts/proof-run.sh [record-seconds]     (default 330)
# Evidence written to logs/proof-*.{log,json}:
#   proof-voice.log   voice service log (every line start, id + text)
#   proof-chrome.log  Chrome log (HUBIE-SYNC display/clear lines)
#   proof-sync.json   final /sync snapshot (service + scene counters
#                     + the full speech-event journal)
#   proof-health.json final /health snapshot
#   proof-meta.json   ffmpeg start/end epochs for correlation
set -uo pipefail
cd "$(dirname "$0")/.."

DUR="${1:-330}"
FIFO=/tmp/hubie-audio.fifo
PORT=8377; VPORT=8379; CPORT=8381; DISPLAY_NUM=98
W=1280; H=720; FPS=30
CHROME="${CHROME:-$HOME/rec-tools/browsers/chrome/linux-157.0.8103.38/chrome-linux64/chrome}"
PROFILE="logs/proof-chrome-profile"
mkdir -p logs demo

# Refuse to step on a running stack: the proof owns these ports/display.
for p in $PORT $VPORT $CPORT; do
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/"; then
    echo "proof-run: port $p already in use — stop the other stack first" >&2; exit 1
  fi
done

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  sleep 2
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

rm -f "$FIFO"
rm -rf "$PROFILE"

echo "proof-run: starting local stack (serve :$PORT, voice :$VPORT, chat :$CPORT)"
setsid node scripts/serve.js "$PORT" >> logs/proof-server.log 2>&1 & PIDS+=($!)
setsid node scripts/voice-service.js "$VPORT" >> logs/proof-voice.log 2>&1 & PIDS+=($!)
setsid node scripts/chat-service.js "$CPORT" >> logs/proof-chat.log 2>&1 & PIDS+=($!)
for p in $PORT $VPORT $CPORT; do
  ok=0
  for i in $(seq 1 30); do curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/" && { ok=1; break; } || sleep 1; done
  [ "$ok" = "1" ] || { echo "proof-run: service on :$p never came up" >&2; exit 1; }
done

Xvfb ":${DISPLAY_NUM}" -screen 0 "${W}x${H}x24" -nolisten tcp >> logs/proof-xvfb.log 2>&1 & PIDS+=($!)
sleep 1
export DISPLAY=":${DISPLAY_NUM}"
setsid "$CHROME" --no-sandbox --no-first-run --disable-fre --disable-dev-shm-usage \
  --disable-infobars --enable-logging=stderr --v=0 \
  --user-data-dir="$PROFILE" \
  --window-size="${W},${H}" --window-position=0,0 --kiosk \
  --autoplay-policy=no-user-gesture-required \
  "http://127.0.0.1:${PORT}/?synclog=1" >> logs/proof-chrome.log 2>&1 & PIDS+=($!)

echo "proof-run: gate — waiting for the coupling (scene coupled, displayed == spoken, >= 2 lines)"
gate_ok=0
for i in $(seq 1 45); do
  sleep 2
  if node -e '
    const http = require("http");
    http.get("http://127.0.0.1:8379/sync", (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => {
        try {
          const s = JSON.parse(b);
          const sc = s.scene || {};
          if (sc.coupled === true && sc.displayed >= 2 && s.service.spoken >= 2 && sc.displayed === s.service.spoken) process.exit(0);
        } catch (e) {}
        process.exit(1);
      });
    }).on("error", () => process.exit(1));
  '; then gate_ok=1; break; fi
done
[ "$gate_ok" = "1" ] || { echo "proof-run: GATE FAILED — coupling never verified, not recording" >&2; curl -s http://127.0.0.1:$VPORT/sync > logs/proof-sync-gatefail.json || true; exit 1; }
echo "proof-run: gate green — recording ${DUR}s locally (NO RTMP, file only)"

FF_START=$(date +%s%3N)
ffmpeg -y -loglevel error \
  -f x11grab -video_size "${W}x${H}" -framerate "$FPS" -i ":${DISPLAY_NUM}" \
  -f s16le -ar 22050 -ac 1 -i "$FIFO" \
  -c:v libx264 -preset veryfast -b:v 4500k -maxrate 4500k -bufsize 9000k \
  -pix_fmt yuv420p -g $((FPS * 2)) \
  -c:a aac -b:a 128k -ar 44100 \
  -t "$DUR" demo/hubie-coupled-proof.mp4
FF_END=$(date +%s%3N)
node -e 'require("fs").writeFileSync("logs/proof-meta.json", JSON.stringify({ ffmpegStartedAt: Number(process.argv[1]), ffmpegEndedAt: Number(process.argv[2]), durationSec: Number(process.argv[3]) }, null, 2))' "$FF_START" "$FF_END" "$DUR"

echo "proof-run: settling 4s, then snapshotting /sync + /health"
sleep 4
curl -s -m 5 http://127.0.0.1:$VPORT/sync > logs/proof-sync.json || true
curl -s -m 5 http://127.0.0.1:$VPORT/health > logs/proof-health.json || true
echo "proof-run: done — tearing the stack down"
