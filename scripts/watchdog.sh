#!/usr/bin/env bash
# Hubie watchdog — keeps the stream scene server alive with NO human help
# and keeps the evidence log for the contest's "longest run with no human".
#
# What it does:
#   - starts scripts/serve.js (the scene server OBS/ffmpeg captures)
#   - if the server process dies, restarts it after 5s and logs the crash
#   - appends start/stop/crash lines to logs/uptime.log (ISO timestamps)
#   - maintains logs/longest-run.txt: the longest single uninterrupted
#     server run, in seconds and in hours — this is the number quoted on
#     the contest form as "longest run with no human" (for the server leg;
#     judges cross-check against the Kick channel's stream history).
#
# What it does NOT do: stream anything, hold any key, or touch Kick.
# Streaming is OBS/ffmpeg configured separately (see README) with the
# channel's stream key entered by Oluwatoba in OBS only — never in this repo.
#
# Usage:  bash scripts/watchdog.sh [port]     (default 8377)
# Stop:   Ctrl-C, or kill the watchdog PID. Stopping ends the current run
#         (that is a human action — only do it before going live, not during).
set -u
cd "$(dirname "$0")/.."
PORT="${1:-8377}"
# Evidence directory: production uses logs/; off-air tests override
# HUBIE_WATCHDOG_DIR so their runs never touch the production evidence.
WDIR="${HUBIE_WATCHDOG_DIR:-logs}"
mkdir -p "$WDIR"
LOG="$WDIR/uptime.log"
LONGEST="$WDIR/longest-run.txt"
RUN_START=0

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }

record_run() {
  local end=$1 start=$2 dur best=0
  dur=$((end - start))
  [ -f "$LONGEST" ] && best=$(sed -n 's/^seconds=//p' "$LONGEST" | head -1)
  [ -z "${best:-}" ] && best=0
  if [ "$dur" -gt "$best" ]; then
    printf 'seconds=%s\nhours=%s\nupdated=%s\n' "$dur" \
      "$(awk -v s="$dur" 'BEGIN{printf "%.2f", s/3600}')" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LONGEST"
    log "new longest no-human run: ${dur}s"
  fi
}

# RTMPS relay leg (added 2026-11-08, v1.6): the local CONNECT relay is
# a single point of failure for the encoder — when its upstream died in
# the judged run, only a human could have brought it back. The watchdog
# now supervises it next to the scene server: if the relay process
# exits, it is restarted in 2s and the encoder supervisor rides out the
# gap (ffmpeg fails fast against a dead relay and retries on its
# backoff ladder). Relay output (structured JSON) goes to
# logs/rtmp-relay.log. Relay env (HUBIE_RELAY_*) passes through from
# the watchdog's own environment; production uses the defaults.
RELAY_PID=0
relay_loop() {
  trap 'kill $RELAY_PID 2>/dev/null; exit 0' TERM INT
  while true; do
    log "rtmp relay starting"
    node scripts/rtmp-relay.js >> "$WDIR/rtmp-relay.log" 2>&1 &
    RELAY_PID=$!
    wait "$RELAY_PID"
    log "rtmp relay exited (code $?) — restarting in 2s, no human involved"
    sleep 2
  done
}
relay_loop &
RELAY_LOOP_PID=$!

trap 'log "watchdog stopped by signal — run ended"; kill $RELAY_LOOP_PID 2>/dev/null; [ "$RUN_START" -gt 0 ] && record_run "$(date +%s)" "$RUN_START"; exit 0' INT TERM

log "watchdog started (port $PORT, pid $$) — setup phase, stream not live yet"
while true; do
  RUN_START=$(date +%s)
  log "scene server starting"
  node scripts/serve.js "$PORT" >> "$WDIR/server.log" 2>&1 &
  SERVER_PID=$!
  wait "$SERVER_PID"
  RC=$?
  NOW=$(date +%s)
  log "scene server exited (code $RC) after $((NOW - RUN_START))s — restarting in 5s, no human involved"
  record_run "$NOW" "$RUN_START"
  sleep 5
done
