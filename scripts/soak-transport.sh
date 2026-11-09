#!/usr/bin/env bash
# Transport soak test — OFF AIR, local sinks only, no Kick, no stream key.
#
# Built 2026-11-08 to diagnose the ~44-minute RTMPS tunnel death that
# ended the judged run (see logs/transport-report.md). Three legs run
# in parallel for as long as they survive:
#
#   A (through the instrumented relay, scripts/rtmp-relay.js in
#     HUBIE_RELAY_DIRECT mode): ffmpeg publisher -> relay :1937 ->
#     socat TLS terminator :19350 -> ffmpeg RTMP listener sink :1935.
#     The relay is protocol-blind (it pipes TCP bytes), so a direct-mode
#     tunnel to a local TLS sink exercises the exact relay code path —
#     socket lifecycle, keepalive, byte piping — against a healthy
#     local upstream. The egress proxy hop CANNOT be soaked this way:
#     the proxy runs outside this VM and cannot CONNECT back into a
#     sink on the VM's loopback.
#   B (control, no relay): the same publisher straight to a second TLS
#     sink (:19351 -> :1939). If A drops and B doesn't, the relay code
#     is implicated; if both drop, look below the relay.
#   C (the real egress proxy, both directions):
#     C1 holds a CONNECT tunnel to a public SSE stream
#        (stream.wikimedia.org) — continuous downstream data;
#     C2 pushes a rate-limited chunked POST through the proxy
#        (httpbin.org/post, ~500 KB/s, production-like upstream rate).
#     C answers: does the proxy itself kill long-lived tunnels on a
#     timer, in either direction?
#
# Publishers use the production encoder settings (1280x720@30 testsrc2
# + sine tone, x264 veryfast, 4500k CBR, AAC 128k) so byte rates match
# the real run (~4.7 Mbps up, near-zero down).
#
# Usage: scripts/soak-transport.sh start|stop|status
# State + evidence: logs/soak/ (pidfile, per-leg logs, monitor log with
# sink byte growth sampled every 15s).
set -uo pipefail
cd "$(dirname "$0")/.."
DIR="logs/soak"
PIDFILE="$DIR/soak.pids"
mkdir -p "$DIR"

pub_args() { # $1 = target URL
  echo "-re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=44100 -c:v libx264 -preset veryfast -b:v 4500k -maxrate 4500k -bufsize 9000k -pix_fmt yuv420p -g 60 -c:a aac -b:a 128k -ar 44100 -f flv $1"
}

start() {
  [ -f "$PIDFILE" ] && { echo "soak already started (pidfile exists) — stop it first" >&2; exit 1; }
  [ -f "$DIR/soak-cert.pem" ] || openssl req -x509 -newkey rsa:2048 \
    -keyout "$DIR/soak-key.pem" -out "$DIR/soak-cert.pem" -days 2 -nodes \
    -subj "/CN=localhost" 2>/dev/null
  : > "$PIDFILE"
  echo "soak start $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$DIR/soak-monitor.log"

  # --- sinks ---
  setsid ffmpeg -hide_banner -loglevel error -listen 1 -i rtmp://127.0.0.1:1935/app/soak \
    -c copy -f flv "$DIR/sink-a.flv" >> "$DIR/sink-a.log" 2>&1 & echo "sinkA=$!" >> "$PIDFILE"
  setsid socat OPENSSL-LISTEN:19350,reuseaddr,cert="$DIR/soak-cert.pem",key="$DIR/soak-key.pem",verify=0 \
    TCP:127.0.0.1:1935 >> "$DIR/socat-a.log" 2>&1 & echo "socatA=$!" >> "$PIDFILE"
  setsid ffmpeg -hide_banner -loglevel error -listen 1 -i rtmp://127.0.0.1:1939/app/soak \
    -c copy -f flv "$DIR/sink-b.flv" >> "$DIR/sink-b.log" 2>&1 & echo "socatB-sink=$!" >> "$PIDFILE"
  setsid socat OPENSSL-LISTEN:19351,reuseaddr,cert="$DIR/soak-cert.pem",key="$DIR/soak-key.pem",verify=0 \
    TCP:127.0.0.1:1939 >> "$DIR/socat-b.log" 2>&1 & echo "socatB=$!" >> "$PIDFILE"
  sleep 1

  # --- relay (instrumented, direct mode -> local TLS sink A) ---
  setsid env HUBIE_RELAY_LISTEN_PORT=1937 HUBIE_RELAY_DIRECT=1 \
    HUBIE_RELAY_TARGET_HOST=127.0.0.1 HUBIE_RELAY_TARGET_PORT=19350 \
    node scripts/rtmp-relay.js >> "$DIR/soak-relay.log" 2>&1 & echo "relay=$!" >> "$PIDFILE"
  sleep 1

  # --- publishers ---
  setsid ffmpeg -hide_banner -loglevel error $(pub_args "rtmps://127.0.0.1:1937/app/soak?tls_verify=0") \
    >> "$DIR/pub-a.log" 2>&1 & echo "pubA=$!" >> "$PIDFILE"
  setsid ffmpeg -hide_banner -loglevel error $(pub_args "rtmps://127.0.0.1:19351/app/soak?tls_verify=0") \
    >> "$DIR/pub-b.log" 2>&1 & echo "pubB=$!" >> "$PIDFILE"

  # --- leg C: the real egress proxy ---
  setsid bash -c '
    echo "C1 start $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> logs/soak/soak-c.log
    out=$(curl -sN -o /dev/null -w "%{size_download} %{http_code}" https://stream.wikimedia.org/v2/stream/recentchange 2>>logs/soak/soak-c.log)
    echo "C1 end $(date -u +%Y-%m-%dT%H:%M:%SZ) rc=$? bytes/code: $out" >> logs/soak/soak-c.log
  ' & echo "legC1=$!" >> "$PIDFILE"
  setsid bash -c '
    while true; do
      node scripts/soak-upload-drip.js >> logs/soak/soak-c.log 2>&1
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) C2drip wrapper: restarting in 5s" >> logs/soak/soak-c.log
      sleep 5
    done
  ' & echo "legC2=$!" >> "$PIDFILE"

  # --- monitor: sink growth is the drop detector ---
  setsid bash -c '
    while true; do
      a=$(stat -c%s logs/soak/sink-a.flv 2>/dev/null || echo 0)
      b=$(stat -c%s logs/soak/sink-b.flv 2>/dev/null || echo 0)
      echo "$(date +%s) sinkA=$a sinkB=$b" >> logs/soak/soak-monitor.log
      sleep 15
    done
  ' & echo "monitor=$!" >> "$PIDFILE"
  echo "soak started; pids in $PIDFILE"
}

stop() {
  [ -f "$PIDFILE" ] || { echo "no pidfile — nothing to stop" >&2; exit 1; }
  while IFS='=' read -r name pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "killed $name ($pid)"
  done < "$PIDFILE"
  sleep 2
  while IFS='=' read -r name pid; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done < "$PIDFILE"
  rm -f "$PIDFILE"
  echo "soak stop $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$DIR/soak-monitor.log"
}

status() {
  [ -f "$PIDFILE" ] || { echo "soak not running (no pidfile)"; exit 0; }
  while IFS='=' read -r name pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "$name ($pid): alive"; else echo "$name ($pid): DEAD"; fi
  done < "$PIDFILE"
  tail -3 "$DIR/soak-monitor.log" 2>/dev/null
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
