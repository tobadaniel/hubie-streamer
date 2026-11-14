#!/usr/bin/env bash
# Hubie soak TEST launch — Fri 2026-11-13, ahead of run 5 (Sat 01:00).
# Mirrors run 4's production stack exactly (watchdog + voice + chat +
# stream.sh via relay/FIFO), but ALL evidence goes to test locations:
# watchdog dir logs/test-2026-11-13/, transport log logs/transport.test-2026-11-13.log.
# Production evidence (logs/longest-run.txt, logs/transport.log, run 4's
# record in logs/tonight-run.attempt4.json) is never touched.
# Planned stop: 2026-11-14 00:00 WAT via scripts/end-run.sh (separate job).
set -u
cd "$(dirname "$0")/../.."
TDIR="logs/test-2026-11-13"
mkdir -p "$TDIR"

# Ports must be free (no other stack).
for p in 8377 8379 8381 1936; do
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/"; then
    echo "launch-test: port $p already answers — aborting, another stack is up" >&2
    exit 1
  fi
done

# Test run record (end-run.sh needs a non-completed record to act on).
node -e '
const fs = require("fs");
const now = new Date();
const rec = {
  status: "running",
  attempt: "test-2026-11-13",
  kind: "soak test ahead of run 5 (NOT a judged run)",
  channel: "t4tiger",
  channel_url: "https://kick.com/t4tiger",
  stream_title: "Hubie Live - House Originals Demo, Your Favourite AI Rewards Host 🐻",
  started_at: now.toISOString(),
  planned_stop: "2026-11-14T00:00:00+01:00",
  planned_stop_reason: "hard stop one hour before run 5 launch (01:00 WAT), user direction 2026-11-13 16:15 WAT",
  stack: "watchdog (scene :8377 + relay :1936, HUBIE_WATCHDOG_DIR=logs/test-2026-11-13) + voice-service (:8379, library on, coupled) + chat-service (:8381, Kick bridge) + stream.sh (Xvfb :98 + Chrome kiosk + supervised ffmpeg x11grab/FIFO -> RTMPS via relay, transport log logs/transport.test-2026-11-13.log), all setsid-detached",
  note: "Run 4 record preserved at logs/tonight-run.attempt4.json. Run 5 launch overwrites this file with the attempt-5 record."
};
fs.writeFileSync("logs/tonight-run.json", JSON.stringify(rec, null, 2) + "\n");
console.log("launch-test: test run record written");
'

echo "launch-test: starting watchdog (serve + relay, test evidence dir)"
HUBIE_WATCHDOG_DIR="$TDIR" setsid bash scripts/watchdog.sh >> "$TDIR/watchdog.out" 2>&1 < /dev/null &
echo "launch-test: starting voice service :8379"
setsid node scripts/voice-service.js 8379 >> "$TDIR/voice.log" 2>&1 < /dev/null &
echo "launch-test: starting chat service :8381"
setsid node scripts/chat-service.js 8381 >> "$TDIR/chat.log" 2>&1 < /dev/null &

# Wait for the legs to answer. 8377/8379/8381 are HTTP services; 1936 is
# the RTMP CONNECT relay — it accepts TCP but never answers an HTTP GET,
# so it must be checked with a raw TCP connect. (The first version of
# this script HTTP-checked 1936, declared it down, and exited before
# starting stream.sh; the relay was fine. Fixed 2026-11-13.)
for p in 8377 8379 8381; do
  ok=0
  for i in $(seq 1 30); do
    if curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/"; then ok=1; break; fi
    sleep 1
  done
  [ "$ok" = "1" ] || { echo "launch-test: port $p never came up" >&2; exit 1; }
  echo "launch-test: port $p up"
done
ok=0
for i in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/1936) 2>/dev/null; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || { echo "launch-test: relay port 1936 never accepted TCP" >&2; exit 1; }
echo "launch-test: relay port 1936 up (TCP)"

echo "launch-test: starting stream.sh (live to Kick via relay)"
HUBIE_AUDIO_FIFO=/tmp/hubie-audio.fifo \
HUBIE_RTMP_RELAY=127.0.0.1:1936 \
HUBIE_TRANSPORT_LOG=logs/transport.test-2026-11-13.log \
setsid bash scripts/stream.sh >> "$TDIR/stream.out" 2>&1 < /dev/null &
SPID=$!
echo "$SPID" > /tmp/judged.pgid
echo "launch-test: stream.sh launched, pid/pgid $SPID recorded in /tmp/judged.pgid"
echo "launch-test: done"
