#!/usr/bin/env bash
# Hubie stream pipeline — Xvfb + Chrome (scene) + ffmpeg x11grab -> RTMP.
#
# PRODUCTION:
#   scripts/stream.sh
#   Reads the stream key from config/stream.local.json — an UNTRACKED,
#   gitignored local file that must never be committed or shared. Shape
#   (same nested shape as config/stream.example.json):
#     { "rtmp": { "server": "rtmps://<ingest host Kick shows in the dashboard>/",
#                 "streamKey": "<kick stream key>" },
#       "kickChat": { "enabled": true, "channelSlug": "t4tiger" } }
#   The key is used only inside the ffmpeg target URL in this process;
#   it is never printed (ffmpeg logging is kept at error level).
#
# DRY RUN (no Kick, nothing public):
#   scripts/stream.sh --dry-run [seconds]
#   Pushes to a LOCAL RTMP sink (rtmp://127.0.0.1:1935/live/dryrun) for a
#   bounded time. Start a sink first, e.g.:
#     ffmpeg -listen 1 -i rtmp://127.0.0.1:1935/live/dryrun -c copy /tmp/sink.flv
#
# Encoder settings (Kick-friendly): 720p30, H.264 veryfast, 4500 kbps CBR-ish
# (maxrate = bitrate, bufsize 2x), keyframe every 2s, AAC 128k stereo.
#
# SUPERVISION (2026-11-08): ffmpeg runs under scripts/encoder-supervisor.js
# (fast restart + backoff + logs/transport.log evidence). An encoder exit
# never stops the scene any more — see the trap comment near the bottom.
# HUBIE_STREAM_TARGET=<url> overrides the push target for off-air tests
# and skips the stream-key config entirely.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
DURATION=0
FFMPEG_ENV=()
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; DURATION="${2:-75}"; fi

DISPLAY_NUM=98
export DISPLAY=":${DISPLAY_NUM}"
PORT=8377
W=1280; H=720; FPS=30; VBITRATE=4500k
CHROME="${CHROME:-$HOME/rec-tools/browsers/chrome/linux-157.0.8103.38/chrome-linux64/chrome}"
PROFILE="logs/stream-chrome-profile"
mkdir -p logs

if [ -n "${HUBIE_STREAM_TARGET:-}" ]; then
  # LOCAL TEST OVERRIDE (off-air verification only): push to an explicit
  # target — e.g. a local TLS sink through the relay — and never read
  # the stream-key config at all. Used by the reconnect verification
  # (logs/transport-report.md). Never set this in production.
  TARGET="$HUBIE_STREAM_TARGET"
  DISPLAY_TARGET="$TARGET (local test override)"
  if [ -n "${HUBIE_RTMP_RELAY:-}" ]; then
    FFMPEG_ENV=(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY)
  fi
elif [ "$DRY_RUN" = "1" ]; then
  TARGET="rtmp://127.0.0.1:1935/live/dryrun"
  DISPLAY_TARGET="$TARGET"
else
  CFG="config/stream.local.json"
  [ -f "$CFG" ] || { echo "stream.sh: $CFG missing — create it locally with rtmp.server + rtmp.streamKey (never commit it). See scripts/stream.sh header." >&2; exit 1; }
  read -r RTMP_SERVER STREAM_KEY < <(node -e '
    const c = require("./config/stream.local.json");
    const r = c.rtmp || {};
    const server = r.server || c.rtmpServer;
    const key = r.streamKey || c.streamKey;
    if (!server || !key) { console.error("stream.local.json needs rtmp.server and rtmp.streamKey"); process.exit(1); }
    let s = server.replace(/\/?$/, "/");
    // Kick (IVS) ingest URLs are rtmps://<host>/app/<stream key>; a server
    // value copied without its /app/ path is rejected at connect time.
    try { if (new URL(s).pathname === "/") s += "app/"; } catch (e) {}
    console.log(s + " " + key);')
  TARGET="${RTMP_SERVER}${STREAM_KEY}"
  DISPLAY_TARGET="${RTMP_SERVER}<stream key hidden>"
  # Optional local CONNECT relay (scripts/rtmp-relay.js): ffmpeg's built-in
  # proxy handling cannot hold an RTMPS publish through this network's
  # egress proxy (connections died after ~30s in testing on 2026-11-07),
  # while a plain CONNECT tunnel holds indefinitely. With
  # HUBIE_RTMP_RELAY=127.0.0.1:1936 set, ffmpeg talks TLS end-to-end to
  # Kick through the relay and its own proxy env is stripped.
  FFMPEG_ENV=()
  if [ -n "${HUBIE_RTMP_RELAY:-}" ]; then
    TARGET="rtmps://${HUBIE_RTMP_RELAY}/app/${STREAM_KEY}"
    DISPLAY_TARGET="rtmps://${HUBIE_RTMP_RELAY}/app/<stream key hidden> (via local relay)"
    FFMPEG_ENV=(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY)
  fi
fi

# Scene server (skip if already listening)
if ! curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; then
  node scripts/serve.js "$PORT" >> logs/server.log 2>&1 &
  SRV=$!
  sleep 1
else
  SRV=""
fi

Xvfb ":${DISPLAY_NUM}" -screen 0 "${W}x${H}x24" -nolisten tcp >> logs/xvfb.log 2>&1 &
XVFB=$!
sleep 1

# Chrome gets NO --proxy-server on purpose: this network's proxy URL
# carries embedded credentials, which Chrome rejects wholesale
# (ERR_NO_SUPPORTED_PROXIES on every proxied request — CDP-verified
# 2026-11-07; it silently killed the in-browser Kick chat adapter).
# The page only talks to localhost services (scene, voice bridge, chat
# bridge), which are proxy-exempt anyway, so the browser needs no proxy.
# --disable-infobars suppresses the "Chrome for Testing is only for
# automated testing" bar at the top of the capture (frame-verified
# 2026-11-07: with the flag, the top of the 1280x720 frame is scene).
"$CHROME" --no-sandbox --no-first-run --disable-fre --disable-dev-shm-usage \
  --disable-infobars \
  --user-data-dir="$PROFILE" \
  --window-size="${W},${H}" --window-position=0,0 --kiosk \
  --autoplay-policy=no-user-gesture-required \
  "http://127.0.0.1:${PORT}/" >> logs/chrome-stream.log 2>&1 &
CHR=$!
sleep 6  # let the scene paint and the first round start

DUR_ARGS=()
if [ "$DURATION" != "0" ]; then DUR_ARGS=(-t "$DURATION"); fi
# Audio source: silent bed by default (dry runs). Two live options:
#  - HUBIE_AUDIO_FIFO=/tmp/hubie-audio.fifo : the voice service's continuous
#    PCM feed (s16le 22050 Hz mono — Piper TTS + silence clock). This is the
#    route verified live on 2026-11-07; Hubie's voice IS the stream audio.
#  - HUBIE_AUDIO_PULSE=<source> : a PulseAudio source (kept for completeness;
#    this VM has no PulseAudio server, the FIFO route is the working one).
AUDIO_ARGS=(-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100)
if [ -n "${HUBIE_AUDIO_FIFO:-}" ]; then
  AUDIO_ARGS=(-f s16le -ar 22050 -ac 1 -i "$HUBIE_AUDIO_FIFO")
elif [ -n "${HUBIE_AUDIO_PULSE:-}" ]; then
  [ -n "${HUBIE_PULSE_RUNTIME:-}" ] && export XDG_RUNTIME_DIR="$HUBIE_PULSE_RUNTIME"
  AUDIO_ARGS=(-f pulse -i "$HUBIE_AUDIO_PULSE")
fi
# Stack cleanup runs ONLY when stream.sh itself exits (the operator
# stop). ffmpeg is no longer stream.sh's foreground child: it belongs
# to the encoder supervisor (scripts/encoder-supervisor.js), which
# restarts it in seconds after any exit while Chrome, Xvfb and the
# scene server keep running untouched. The old shape — ffmpeg in the
# foreground, this trap on its exit — is what turned the 2026-11-08
# tunnel drop into a dead run: the encoder exited and the trap killed
# the show. Now the trap fires only when the operator stops stream.sh.
cleanup() { kill $CHR $XVFB ${SRV:+$SRV} 2>/dev/null || true; }
trap cleanup EXIT
echo "stream.sh: pushing ${W}x${H}@${FPS} H.264 ${VBITRATE} -> ${DISPLAY_TARGET} (supervised encoder; restarts do not stop the show)"
SUP_ARGS=(--transport-log "${HUBIE_TRANSPORT_LOG:-logs/transport.log}")
# A bounded push (dry run / local test -t) ends cleanly on purpose:
# tell the supervisor not to restart after that planned clean exit.
if [ "$DURATION" != "0" ]; then SUP_ARGS+=(--no-restart-on-clean-exit); fi
"${FFMPEG_ENV[@]}" node scripts/encoder-supervisor.js "${SUP_ARGS[@]}" -- ffmpeg -y -loglevel error -stats_period 10 \
  -f x11grab -video_size "${W}x${H}" -framerate "$FPS" -i ":${DISPLAY_NUM}" \
  "${AUDIO_ARGS[@]}" \
  -c:v libx264 -preset veryfast -b:v "$VBITRATE" -maxrate "$VBITRATE" -bufsize 9000k \
  -pix_fmt yuv420p -g $((FPS * 2)) \
  -c:a aac -b:a 128k -ar 44100 \
  "${DUR_ARGS[@]}" -f flv "$TARGET"
