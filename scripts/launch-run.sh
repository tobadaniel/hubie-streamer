#!/usr/bin/env bash
# Hubie PRODUCTION stack launcher — the single canonical way a judged run
# is started (first used for run 5, 2026-11-14; built from the run-4 stack
# shape and the 2026-11-13 soak-test launcher, whose relay port check bug
# is fixed here: port 1936 is a CONNECT relay and is probed over raw TCP,
# never HTTP).
#
# Starts, all setsid-detached so they survive the launching session:
#   watchdog.sh        (scene server :8377 + RTMP relay :1936, supervised)
#   voice-service.js   :8379 (clip library on, coupled sync, FIFO audio)
#   chat-service.js    :8381 (Kick chat bridge, read-only)
#   stream.sh          Xvfb + Chrome kiosk + supervised ffmpeg, pushing
#                      via the relay with the voice FIFO as audio input
#
# It deliberately does NOT write logs/tonight-run.json — the caller owns
# the run record (the launch job writes it; the guard appends segments).
# It never reads or prints the stream key; stream.sh handles the key
# internally from config/stream.local.json.
#
# Refuses to start if any stack port is already taken (no double-launch).
set -u
cd "$(dirname "$0")/.."
mkdir -p logs

for p in 8377 8379 8381; do
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/"; then
    echo "launch-run: port $p already answers — a stack is already up, refusing to double-launch" >&2
    exit 1
  fi
done
if (exec 3<>/dev/tcp/127.0.0.1/1936) 2>/dev/null; then
  echo "launch-run: relay port 1936 already accepts TCP — a stack is already up, refusing to double-launch" >&2
  exit 1
fi

echo "launch-run: starting watchdog (scene server + relay)"
setsid bash scripts/watchdog.sh >> logs/watchdog.out 2>&1 < /dev/null &
echo "launch-run: starting voice service :8379"
setsid node scripts/voice-service.js 8379 >> logs/voice.log 2>&1 < /dev/null &
echo "launch-run: starting chat service :8381"
setsid node scripts/chat-service.js 8381 >> logs/chat.log 2>&1 < /dev/null &

for p in 8377 8379 8381; do
  ok=0
  for i in $(seq 1 30); do
    if curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/"; then ok=1; break; fi
    sleep 1
  done
  [ "$ok" = "1" ] || { echo "launch-run: port $p never came up" >&2; exit 1; }
  echo "launch-run: port $p up"
done
ok=0
for i in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/1936) 2>/dev/null; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || { echo "launch-run: relay port 1936 never accepted TCP" >&2; exit 1; }
echo "launch-run: relay port 1936 up (TCP)"

echo "launch-run: starting stream.sh (live to Kick via relay)"
setsid bash -c 'echo $$ > /tmp/judged.pgid; HUBIE_AUDIO_FIFO=/tmp/hubie-audio.fifo HUBIE_RTMP_RELAY=127.0.0.1:1936 exec bash scripts/stream.sh >> logs/stream.out 2>&1' < /dev/null > /dev/null 2>&1 &
echo "launch-run: stream.sh launched (pgid recorded in /tmp/judged.pgid)"
echo "launch-run: done"
