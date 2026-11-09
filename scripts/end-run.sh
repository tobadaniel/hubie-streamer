#!/usr/bin/env bash
# Hubie end-of-run procedure — the scheduled, graceful stop for a judged run.
#
#   scripts/end-run.sh             perform the end-of-run (see steps below)
#   scripts/end-run.sh --dry-run   validate everything, change nothing:
#                                  discovers the stack, reads the counters,
#                                  checks the sign-off resolves in the clip
#                                  library, and prints the plan. It sends
#                                  NO signals and posts NOTHING.
#
# Why the stop is shaped this way:
#   The run's final spoken line must be the user's sign-off, exactly once,
#   and it must come from the pre-rendered clone clip in the library (not
#   the Piper fallback). The scene's own closing path
#   (window.__hubieClosing in js/scene.js) is unreachable from outside the
#   page in this deployment — stream.sh launches Chrome with no
#   --remote-debugging-port (no CDP, no DevToolsActivePort), and the page
#   exposes no other control channel. So this script speaks the sign-off
#   through the exact channel the speech director itself uses
#   (POST /say {id, text, pace} to the voice service), with two guards
#   that make "final" deterministic rather than racy:
#     1. Chrome's processes are SIGSTOPped first. The page's JS halts, so
#        the director can submit no new intent while the queue drains and
#        the sign-off plays. (The captured frame freezes for these last
#        seconds; the audio stays live and matched to the frozen subtitle.)
#     2. The script waits for the voice-service queue to fully drain
#        before posting, then waits for the sign-off's own speech-ended
#        event in the /sync journal before touching the encoder.
#   The encoder is stopped the operator way: SIGTERM to
#   scripts/encoder-supervisor.js, which kills ffmpeg and schedules NO
#   restart. Everything else is then stopped, Kick is verified offline,
#   and the final state is snapshotted into logs/tonight-run.json.
#
# Idempotent-safe: if logs/tonight-run.json already records a completed
# run, the script reports that and exits 0 without signalling anything.
# Every signal is guarded by a live-PID check, so a partially stopped
# stack is finished off rather than errored on.
#
# The stream key is never read, printed, or logged by this script — it
# does not open config/stream.local.json at all.
set -u
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

VOICE="http://127.0.0.1:8379"
KICK_API="https://kick.com/api/v2/channels/t4tiger"
RUN_FILE="logs/tonight-run.json"
SIGNOFF_ID="SIGNOFF-1"
SIGNOFF_TEXT="gamble responsibly. and if you're looking for where to gamble, hubie on housebets is always ready to host you."
SIGNOFF_PACE="slow"

say() { echo "[end-run] $*"; }
warn() { echo "[end-run] WARN: $*" >&2; }

# PID discovery (bracketed patterns: a pattern can never match this
# script's own helper processes, whose command lines contain the text).
pids() { pgrep -f "$1" 2>/dev/null | tr '\n' ' '; }
SUP_PIDS=$(pids 'scripts/encoder[-]supervisor.js')
STREAM_PIDS=$(pids 'scripts/stream[.]sh')
CHROME_PIDS=$(pids 'chrome[-]linux64/chrome')
XVFB_PIDS=$(pids 'Xvfb')
VOICE_PIDS=$(pids 'scripts/voice[-]service.js')
CHAT_PIDS=$(pids 'scripts/chat[-]service.js')
WATCHDOG_PIDS=$(pids 'scripts/watchdog[.]sh')
SERVE_PIDS=$(pids 'scripts/serve[.]js')
FFMPEG_PIDS=$(pids 'ffmpeg.*x11grab')

health_json() { curl -s -m 3 "$VOICE/health" 2>/dev/null; }
sync_json() { curl -s -m 3 "$VOICE/sync" 2>/dev/null; }
jget() { # jget <json> <js-expression-on-d>
  printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log("")}})' "$2" 2>/dev/null;
}

# ---------------------------------------------------------------- dry run
if [ "$DRY" = "1" ]; then
  say "DRY RUN — validation only; nothing will be signalled or posted."
  say "stack discovered:"
  say "  encoder supervisor : ${SUP_PIDS:-none}"
  say "  stream.sh          : ${STREAM_PIDS:-none} (pgid file: $(cat /tmp/judged.pgid 2>/dev/null || echo absent))"
  say "  chrome             : ${CHROME_PIDS:-none}"
  say "  xvfb               : ${XVFB_PIDS:-none}"
  say "  voice service      : ${VOICE_PIDS:-none}"
  say "  chat service       : ${CHAT_PIDS:-none}"
  say "  watchdog           : ${WATCHDOG_PIDS:-none}"
  say "  scene server       : ${SERVE_PIDS:-none}"
  say "  ffmpeg (x11grab)   : ${FFMPEG_PIDS:-none}"
  H=$(health_json)
  if [ -n "$H" ]; then
    say "voice /health: spoken=$(jget "$H" 'd.spoken') displayed-check via /sync, dropped=$(jget "$H" 'd.dropped'), clipsPlayed=$(jget "$H" 'd.clipsPlayed'), clipFallbacks=$(jget "$H" 'd.clipFallbacks'), queue=$(jget "$H" 'd.queue'), bufferedSec=$(jget "$H" 'd.bufferedSec')"
  else
    warn "voice service /health unreachable"
  fi
  S=$(sync_json)
  if [ -n "$S" ]; then
    say "scene /sync: mode=$(jget "$S" 'd.scene&&d.scene.mode'), displayed=$(jget "$S" 'd.scene&&d.scene.displayed'), serviceDropped=$(jget "$S" 'd.scene&&d.scene.serviceDropped')"
  fi
  K=$(curl -s -4 -m 5 "$KICK_API" 2>/dev/null)
  if [ -n "$K" ]; then
    say "kick: is_live=$(jget "$K" '!!(d.livestream&&d.livestream.is_live)'), livestream_id=$(jget "$K" 'd.livestream&&d.livestream.id')"
  else
    warn "kick API unreachable from here (the real run polls it with retries)"
  fi
  # Sign-off library resolution: replicate the voice service's own
  # tokenize + greedy partition against the real manifest (read-only).
  SIGNOFF_TEXT="$SIGNOFF_TEXT" node <<'NODE'
const fs = require('fs'), path = require('path');
const root = process.cwd();
const words = require(path.join(root, 'js/commentary.js')).words;
function tokenizeLine(text) {
  let t = String(text).toLowerCase().replace(/[’‘]/g, "'");
  t = t.replace(/\d+(?:\.\d+)?/g, (m) => {
    if (m.indexOf('.') >= 0) { const p = m.split('.'); return words(parseInt(p[0], 10)) + ' point ' + words(parseInt(p[1], 10)); }
    return words(parseInt(m, 10));
  });
  return t.replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
}
const libDir = path.join(root, 'voices-local', 'library');
const manifest = JSON.parse(fs.readFileSync(path.join(libDir, 'manifest.json'), 'utf8'));
const byFirst = new Map();
for (const e of manifest.entries || []) {
  if (!e || e.status !== 'ready' || !e.file || !e.key) continue;
  const toks = tokenizeLine(e.key);
  if (!toks.length) continue;
  if (!byFirst.has(toks[0])) byFirst.set(toks[0], []);
  byFirst.get(toks[0]).push({ toks, file: e.file });
}
for (const l of byFirst.values()) l.sort((a, b) => b.toks.length - a.toks.length);
const toks = tokenizeLine(process.env.SIGNOFF_TEXT);
const parts = []; let i = 0, ok = true;
while (i < toks.length) {
  const cands = byFirst.get(toks[i]) || [];
  let hit = null;
  for (const c of cands) {
    if (c.toks.length > toks.length - i) continue;
    let m = true;
    for (let j = 0; j < c.toks.length; j++) if (c.toks[j] !== toks[i + j]) { m = false; break; }
    if (m) { hit = c; break; }
  }
  if (!hit) { ok = false; break; }
  parts.push(hit.file); i += hit.toks.length;
}
if (ok && parts.length === 1) {
  console.log('[end-run] sign-off resolves to the single library clip: ' + parts[0] + ' (clone voice, NOT the Piper fallback)');
} else if (ok) {
  console.log('[end-run] WARN: sign-off partitions into ' + parts.length + ' fragments (' + parts.join(' + ') + '), not one whole-line clip');
  process.exitCode = 3;
} else {
  console.log('[end-run] WARN: sign-off does NOT resolve in the library at token ' + i + ' — the voice service would fall back to Piper');
  process.exitCode = 3;
}
NODE
  RC=$?
  say "plan, in order:"
  say "  1. SIGSTOP chrome (freeze page JS; no new commentary intents)"
  say "  2. wait for the voice queue to drain (queue 0, buffer ~0, spoken stable)"
  say "  3. POST the sign-off to $VOICE/say as id $SIGNOFF_ID (pace $SIGNOFF_PACE) — the director's own channel"
  say "  4. wait for speech-ended($SIGNOFF_ID) in the /sync journal, then a 2s grace"
  say "  5. capture final counters, then SIGTERM the encoder supervisor (operator stop, no restart)"
  say "  6. let stream.sh's trap retire chrome/xvfb; stop watchdog, voice, chat, scene server; verify ports free"
  say "  7. verify the Kick channel offline via the public API (poll up to 120s)"
  say "  8. snapshot the final state into $RUN_FILE and print a summary"
  [ "$RC" = "0" ] || warn "dry run found a problem above (exit $RC)"
  exit "$RC"
fi

# ------------------------------------------------------------- real run
# Idempotency: a completed run is never re-ended.
if [ -f "$RUN_FILE" ] && grep -q '"status": "completed"' "$RUN_FILE"; then
  say "run already recorded as completed in $RUN_FILE — nothing to do."
  exit 0
fi

SIGNOFF_STARTED=""; SIGNOFF_ENDED=""; SIGNOFF_DELIVERED="false"

# 1. Freeze the page: no new commentary intents from here on.
if [ -n "$CHROME_PIDS" ]; then
  say "freezing chrome (SIGSTOP): $CHROME_PIDS"
  kill -STOP $CHROME_PIDS 2>/dev/null || warn "SIGSTOP chrome failed (already gone?)"
else
  warn "no chrome processes found — the page may already be down; continuing with the voice-side stop"
fi

# 2. Drain the voice queue: nothing playing, nothing waiting, counter stable.
say "waiting for the voice queue to drain…"
DRAINED=0; LAST_SPOKEN=-1; STABLE=0
for i in $(seq 1 100); do
  H=$(health_json)
  Q=$(jget "$H" 'd.queue'); B=$(jget "$H" 'd.bufferedSec'); SP=$(jget "$H" 'd.spoken')
  if [ "$Q" = "0" ] && [ -n "$B" ] && awk "BEGIN{exit !($B <= 0.05)}" && [ "$SP" = "$LAST_SPOKEN" ]; then
    STABLE=$((STABLE + 1)); [ "$STABLE" -ge 3 ] && { DRAINED=1; break; }
  else
    STABLE=0
  fi
  LAST_SPOKEN=${SP:-$LAST_SPOKEN}
  sleep 0.25
done
[ "$DRAINED" = "1" ] && say "queue drained" || warn "queue did not fully drain in 25s — proceeding (the service age-gate reaps any straggler unspoken)"

# 3. Post the sign-off through the director's own channel.
PAYLOAD=$(SIGNOFF_ID="$SIGNOFF_ID" SIGNOFF_TEXT="$SIGNOFF_TEXT" SIGNOFF_PACE="$SIGNOFF_PACE" node -e 'console.log(JSON.stringify({id:process.env.SIGNOFF_ID,text:process.env.SIGNOFF_TEXT,pace:process.env.SIGNOFF_PACE}))')
RESP=$(curl -s -m 5 -X POST "$VOICE/say" -H 'Content-Type: application/json' -d "$PAYLOAD" 2>/dev/null)
say "sign-off posted: $RESP"

# 4. Wait for its speech-ended in the journal (+2s grace).
say "waiting for speech-ended($SIGNOFF_ID)…"
for i in $(seq 1 80); do
  S=$(sync_json)
  SIGNOFF_STARTED=$(jget "$S" "(d.events||[]).filter(e=>e.type==='speech-started'&&e.data&&e.data.id==='$SIGNOFF_ID').map(e=>e.data.ts)[0]||''")
  SIGNOFF_ENDED=$(jget "$S" "(d.events||[]).filter(e=>e.type==='speech-ended'&&e.data&&e.data.id==='$SIGNOFF_ID').map(e=>e.data.ts)[0]||''")
  [ -n "$SIGNOFF_ENDED" ] && { SIGNOFF_DELIVERED="true"; break; }
  sleep 0.5
done
if [ "$SIGNOFF_DELIVERED" = "true" ]; then
  say "sign-off spoken (started ts=$SIGNOFF_STARTED, ended ts=$SIGNOFF_ENDED); 2s grace"
else
  warn "sign-off speech-ended not observed within 40s (started ts=${SIGNOFF_STARTED:-none}) — proceeding to teardown on schedule"
fi
sleep 2

# 5. Capture final counters BEFORE anything else stops.
H=$(health_json); S=$(sync_json)
F_SPOKEN=$(jget "$H" 'd.spoken'); F_DROPPED=$(jget "$H" 'd.dropped')
F_DROPPED_STALE=$(jget "$H" 'd.droppedStale'); F_DROPPED_OVER=$(jget "$H" 'd.droppedOverflow')
F_CLIPS=$(jget "$H" 'd.clipsPlayed'); F_FALLBACKS=$(jget "$H" 'd.clipFallbacks')
F_MAXLAG=$(jget "$H" 'd.maxStartLagSec')
F_DISPLAYED=$(jget "$S" 'd.scene&&d.scene.displayed')
F_SVCDROPPED=$(jget "$S" 'd.scene&&d.scene.serviceDropped')
T_LINES=$(wc -l < logs/transport.log 2>/dev/null | tr -d ' ')
T_STARTS=$(grep -c '"event":"ffmpeg_start"' logs/transport.log 2>/dev/null || true)
T_RESTARTS=$(( ${T_STARTS:-0} > 0 ? ${T_STARTS:-0} - 1 : 0 ))
say "final counters: spoken=$F_SPOKEN displayed=$F_DISPLAYED dropped=$F_DROPPED clipsPlayed=$F_CLIPS clipFallbacks=$F_FALLBACKS transportRestarts=$T_RESTARTS"

# 6. Operator stop: SIGTERM the supervisor → ffmpeg dies, no restart;
#    stream.sh then exits and its trap retires Chrome/Xvfb.
if [ -n "$SUP_PIDS" ]; then
  say "SIGTERM encoder supervisor: $SUP_PIDS"
  kill -TERM $SUP_PIDS 2>/dev/null || true
else
  warn "no encoder supervisor found"
fi
for i in $(seq 1 30); do
  [ -z "$(pids 'scripts/stream[.]sh')" ] && break
  sleep 0.5
done
# Chrome was SIGSTOPped: CONT before TERM so pending signals can land.
CHROME_PIDS=$(pids 'chrome[-]linux64/chrome')
if [ -n "$CHROME_PIDS" ]; then
  kill -CONT $CHROME_PIDS 2>/dev/null || true
  kill -TERM $CHROME_PIDS 2>/dev/null || true
fi
XVFB_PIDS=$(pids 'Xvfb'); [ -n "$XVFB_PIDS" ] && kill -TERM $XVFB_PIDS 2>/dev/null || true

# 7. Stop the rest: watchdog (records the run + retires the relay),
#    voice, chat, scene server. Verify processes and ports are gone.
[ -n "$WATCHDOG_PIDS" ] && { say "SIGTERM watchdog: $WATCHDOG_PIDS"; kill -TERM $WATCHDOG_PIDS 2>/dev/null || true; }
[ -n "$VOICE_PIDS" ] && kill -TERM $VOICE_PIDS 2>/dev/null || true
[ -n "$CHAT_PIDS" ] && kill -TERM $CHAT_PIDS 2>/dev/null || true
SERVE_PIDS=$(pids 'scripts/serve[.]js'); [ -n "$SERVE_PIDS" ] && kill -TERM $SERVE_PIDS 2>/dev/null || true
sleep 3
for pat in 'scripts/encoder[-]supervisor.js' 'scripts/stream[.]sh' 'chrome[-]linux64/chrome' 'scripts/voice[-]service.js' 'scripts/chat[-]service.js' 'scripts/watchdog[.]sh' 'scripts/serve[.]js' 'scripts/rtmp[-]relay.js' 'ffmpeg.*x11grab'; do
  LEFT=$(pids "$pat")
  if [ -n "$LEFT" ]; then
    warn "stragglers for $pat: $LEFT — escalating to SIGKILL"
    kill -CONT $LEFT 2>/dev/null || true
    kill -KILL $LEFT 2>/dev/null || true
  fi
done
sleep 1
PORTS_FREE="true"
for p in 8377 8379 8381 1936; do
  curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/" && { PORTS_FREE="false"; warn "port $p still answers"; }
done
say "ports free: $PORTS_FREE"

# 8. Verify Kick offline (ingest reap can lag; poll up to 120s).
KICK_OFFLINE="false"; KICK_LAST=""
for i in $(seq 1 12); do
  K=$(curl -s -4 -m 5 "$KICK_API" 2>/dev/null)
  if [ -n "$K" ]; then
    KICK_LAST="is_live=$(jget "$K" '!!(d.livestream&&d.livestream.is_live)') id=$(jget "$K" 'd.livestream&&d.livestream.id')"
    if [ "$(jget "$K" '!!(d.livestream&&d.livestream.is_live)')" != "true" ]; then KICK_OFFLINE="true"; break; fi
  fi
  sleep 10
done
say "kick offline verified: $KICK_OFFLINE (last API state: ${KICK_LAST:-unreachable})"
[ "$KICK_OFFLINE" = "true" ] || warn "Kick still showed the session live after 120s — the encoder is verifiably dead, so this is ingest reap lag; re-check the channel shortly"

# 9. Snapshot the final state into the run record.
END_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
END_WAT=$(TZ=Africa/Lagos date +%Y-%m-%dT%H:%M:%S+01:00)
export END_UTC END_WAT SIGNOFF_ID SIGNOFF_TEXT SIGNOFF_DELIVERED SIGNOFF_STARTED SIGNOFF_ENDED
export F_SPOKEN F_DISPLAYED F_DROPPED F_DROPPED_STALE F_DROPPED_OVER F_CLIPS F_FALLBACKS F_MAXLAG F_SVCDROPPED
export T_LINES T_RESTARTS KICK_OFFLINE PORTS_FREE
node <<'NODE'
const fs = require('fs');
const f = 'logs/tonight-run.json';
let d = {};
try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* fresh record */ }
const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
d.status = 'completed';
d.ended_at_utc = process.env.END_UTC;
d.ended_at_wat = process.env.END_WAT;
d.end_reason = 'scheduled stop at 6h (user decision 2026-11-08 18:39 WAT), executed by scripts/end-run.sh';
d.signoff = {
  id: process.env.SIGNOFF_ID,
  text: process.env.SIGNOFF_TEXT,
  source: 'library clip (clone voice) via POST /say — the speech director channel',
  delivered: process.env.SIGNOFF_DELIVERED === 'true',
  speech_started_ts: num(process.env.SIGNOFF_STARTED),
  speech_ended_ts: num(process.env.SIGNOFF_ENDED)
};
d.final_counters = {
  spoken: num(process.env.F_SPOKEN),
  displayed: num(process.env.F_DISPLAYED),
  dropped: num(process.env.F_DROPPED),
  dropped_stale: num(process.env.F_DROPPED_STALE),
  dropped_overflow: num(process.env.F_DROPPED_OVER),
  scene_service_dropped: num(process.env.F_SVCDROPPED),
  clips_played: num(process.env.F_CLIPS),
  clip_fallbacks: num(process.env.F_FALLBACKS),
  max_start_lag_sec: num(process.env.F_MAXLAG)
};
d.transport_events = {
  log_lines: num(process.env.T_LINES),
  ffmpeg_starts: num(process.env.T_RESTARTS) == null ? null : num(process.env.T_RESTARTS) + 1,
  encoder_restarts: num(process.env.T_RESTARTS)
};
d.final_balance = null; // scene state lives only inside the page (no external interface) — see end-run notes
d.reload_count = null;  // same: the HUD counters are in-page only
try {
  const lr = fs.readFileSync('logs/longest-run.txt', 'utf8').trim().split('\n');
  const kv = {}; for (const line of lr) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1); }
  d.longest_run_evidence = { file: 'logs/longest-run.txt', seconds: num(kv.seconds), hours: num(kv.hours), updated: kv.updated || null, uptime_log: 'logs/uptime.log' };
} catch (e) { d.longest_run_evidence = null; }
d.kick_offline_verified = process.env.KICK_OFFLINE === 'true';
d.ports_free_after_stop = process.env.PORTS_FREE === 'true';
const tmp = f + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
fs.renameSync(tmp, f);
console.log('[end-run] snapshot written to ' + f);
NODE

say "summary: run completed; sign-off delivered=$SIGNOFF_DELIVERED; spoken=$F_SPOKEN displayed=$F_DISPLAYED dropped=$F_DROPPED; encoder restarts=$T_RESTARTS; kick offline=$KICK_OFFLINE"
