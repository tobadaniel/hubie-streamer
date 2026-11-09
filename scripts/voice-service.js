#!/usr/bin/env node
/* Hubie voice service v2 — local TTS bridge (v1 2026-11-07, v2 same night).
 *
 * Why it exists: this VM's Chrome has ZERO speechSynthesis voices
 * (verified: speechSynthesis.getVoices() returns [] in the scene page),
 * so the scene's built-in browser TTS can never produce sound here, and
 * x11grab captures no audio anyway. This service speaks the scene's
 * commentary lines with Piper (local neural TTS, model in voices-local/,
 * gitignored) and feeds them as a CONTINUOUS raw-PCM stream into a FIFO;
 * scripts/stream.sh reads the FIFO as the stream's audio input
 * (HUBIE_AUDIO_FIFO), so the voice is mixed at real-time rate with
 * silence between lines — the stream clock never stalls.
 *
 * VOICE (v2): en_US-ryan-medium — a livelier male voice than the flat
 * lessac-medium v1 shipped with (user: "too robotic"). (Ryan-HIGH was
 * tried first and rejected on measurement: RTF 1.7-5.1 on this VM, it
 * synthesizes slower than real time. Same voice, medium model: 0.4-0.9.)
 * Delivery varies
 * by line type via three persistent Piper processes, one per pace lane:
 *   fast   length_scale 0.88  (wins, anticipation, near misses)
 *   normal length_scale 0.95  (default)
 *   slow   length_scale 1.08  (losses, busts — flatter, heavier)
 * The scene tags every line with a pace (see js/commentary.js).
 *
 * SYNC DISCIPLINE (v2, the actual fix for the voice/picture desync):
 * Piper synthesizes a line in ~0.4x real time but emits the audio in one
 * batch at the END of synthesis, and lines serialize invisibly inside a
 * free-running Piper stdin queue — v1 let a 4-deep text queue feed that
 * hidden backlog, so in bursts the audible line trailed the on-screen
 * action by 10+ seconds. v2's rule: THE VOICE NEVER SPEAKS STALE LINES.
 *   - at most ONE line waiting behind the line in the pipeline;
 *     a fresher post replaces the waiting line (counted as dropped);
 *   - a line is only sent to Piper when its projected audible start is
 *     within ~3s of posting (age + synthesized-audio backlog + synth
 *     estimate); a line that ages past 3s unsent is dropped (counted);
 *   - synthesis is serialized (one line in Piper at a time), and every
 *     line's ACTUAL audible start lag is measured from byte offsets in
 *     the PCM stream and logged + exposed on /health.
 * Subtitles are unaffected: they always show every line. Only the voice
 * skips what it can no longer say in time.
 *
 * Audio format: s16le mono at the model's sample rate (ryan-high:
 * 22050 Hz); ffmpeg resamples to 44100 stereo on encode.
 *
 * CLIP LIBRARY (v3, 2026-11-08): one assumed (clone) voice throughout,
 * pre-rendered offline into voices-local/library/ (clone renders only —
 * the user's real takes were retired from the live library on his
 * instruction, so his real voice never airs; see the library builder
 * in voices-local/work/). An incoming line is tokenized and
 * matched against the library manifest: whole-line first, then a
 * greedy partition into phrases/fragments/number chunks (the same way
 * js/commentary.js composes figure lines). On a hit the clip audio is
 * streamed into the FIFO under the SAME queue discipline (at most one
 * line waiting, stale lines dropped and counted) — playback is instant,
 * so sync is exact. On a miss (unmapped lines, e.g. chat answers with
 * viewer names) the line falls back to live Piper as before. Replacing
 * any clip with a same-named file (e.g. a future real take) swaps the
 * audio with no code change; the loader caches by path+mtime.
 * Disable with HUBIE_VOICE_LIBRARY=off (Piper-only mode).
 *
 * COUPLED SYNC (v3.1, 2026-11-08, with js/speech-director.js): the run
 * of 2026-11-08 was ended because subtitles showed every generated line
 * while the voice spoke ~43% of them — screen and voice diverged. This
 * service is now the single source of truth for what is being said:
 *   - every line carries an id (the scene assigns L1, L2, ...; /say
 *     accepts {id} and echoes it; unided posts get svc-<n>);
 *   - GET /events is an SSE stream (same shape as the chat bridge):
 *     speech-started {id, text, ts, lagSec} fires at the exact feeder
 *     tick a line's first audio byte is clocked into the FIFO, and
 *     speech-ended {id, ts} when its last byte is clocked out; a line
 *     killed by the queue discipline emits speech-dropped {id, reason}.
 *     Events are journaled (seq-numbered, ring of 400) and replayed to
 *     a reconnecting client from its Last-Event-ID; every connect also
 *     gets a sync snapshot {speakingId, speakingText, waitingId,
 *     spoken} so the scene can reconcile. The scene displays a subtitle
 *     ONLY on speech-started — displayed == spoken by construction.
 *   - POST /telemetry accepts the scene director's counters; GET /sync
 *     returns /health + the latest scene telemetry + the event journal
 *     tail, so one call verifies the whole coupling.
 * The generation pacing itself lives scene-side (the director holds at
 * most one pending intent and only generates when a speech slot opens);
 * this service's queue discipline stays as the safety net, and its
 * drops are now EVENTS, not silent losses.
 *
 * FEEDER CLOCK (v3.2, 2026-11-08): the feeder used to emit exactly
 * 100ms of audio per 100ms setInterval tick regardless of when the tick
 * actually fired. Under CPU load the ticks slip, the FIFO then receives
 * audio slower than real time, and ffmpeg — which timestamps raw PCM by
 * sample count — lays that audio on a compressed timeline (measured in
 * the coupled proof recording: audio ~8s ahead of wall/video at 100s
 * in, ~14s at 215s). The feeder now runs an emission ledger clocked by
 * elapsed WALL time: bytes owed = elapsed x rate, and each tick emits
 * exactly the shortfall (speech first, silence after; discarded at the
 * same rate while no reader is attached), so a slipped tick is followed
 * by an equal catch-up emission and total emitted audio duration tracks
 * wall time to the sample. /health exposes emittedSec vs feedWallSec so
 * the ledger can be verified from outside.
 *
 * Usage:  node scripts/voice-service.js [port]     (default 8379)
 * Env:    HUBIE_TTS_MODEL  (default: first present of
 *                           voices-local/en_US-ryan-medium.onnx,
 *                           en_US-lessac-medium.onnx, en_US-ryan-high.onnx
 *                           — see defaultModel() for the measured reasons)
 *         HUBIE_AUDIO_FIFO (default /tmp/hubie-audio.fifo)
 *         HUBIE_VOICE_LIBRARY (off = Piper-only; default: on when the
 *                           library manifest exists)
 *         HUBIE_LIBRARY_DIR (default voices-local/library)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PACES = { fast: 0.88, normal: 0.95, slow: 1.08 };
const MAX_START_LAG_MS = 3000;      // a line must be able to START within ~3s of posting
const SYNTH_SEC_PER_CHAR = 1 / 45;  // measured: ~100 chars -> ~2.2s synth (incl. margin)

function defaultModel() {
  // Preference order is measured, not aesthetic: en_US-ryan-high sounds
  // great but synthesizes at RTF 1.7-5.1 on this VM (2-5x SLOWER than
  // real time — it can never keep up live), while ryan-medium is the same
  // voice at RTF 0.4-0.9. Lessac-medium (RTF ~0.4) is the fallback.
  const dir = path.join(__dirname, '..', 'voices-local');
  const medium = path.join(dir, 'en_US-ryan-medium.onnx');
  if (fs.existsSync(medium)) return medium;
  const lessac = path.join(dir, 'en_US-lessac-medium.onnx');
  if (fs.existsSync(lessac)) return lessac;
  return path.join(dir, 'en_US-ryan-high.onnx');
}
function modelRate(model) {
  try {
    const cfg = JSON.parse(fs.readFileSync(model + '.json', 'utf8'));
    return (cfg.audio && cfg.audio.sample_rate) || 22050;
  } catch (e) { return 22050; }
}

/* ---------------- clip library ----------------
 * Tokenization mirrors the commentary engine's composition: lowercase,
 * digits become spoken words (via js/commentary.js words(), so "50"
 * matches the "fifty" chunk), punctuation is a separator. A line is
 * covered when its token stream partitions into manifest phrases. */
const CommentaryWords = (() => {
  try { return require('../js/commentary.js').words; } catch (e) { return null; }
})();
function tokenizeLine(text) {
  let t = String(text).toLowerCase().replace(/[’‘]/g, "'");
  if (CommentaryWords) {
    t = t.replace(/\d+(?:\.\d+)?/g, (m) => {
      if (m.indexOf('.') >= 0) {
        const p = m.split('.');
        return CommentaryWords(parseInt(p[0], 10)) + ' point ' + CommentaryWords(parseInt(p[1], 10));
      }
      return CommentaryWords(parseInt(m, 10));
    });
  }
  return t.replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
}
function readWavPcm(file, expectRate) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let rate = 0, dataOff = -1, dataLen = 0;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    if (id === 'data') { dataOff = off + 8; dataLen = len; break; }
    off += 8 + len + (len % 2);
  }
  if (!dataOff || rate !== expectRate) return null;
  return buf.slice(dataOff, dataOff + dataLen);
}
function loadLibrary(dir, rate, log) {
  const lib = { enabled: false, entries: 0, byFirst: new Map(), cache: new Map(), dir: dir };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (e) { return lib; }
  for (const e of manifest.entries || []) {
    if (!e || e.status !== 'ready' || !e.file || !e.key) continue;
    const toks = tokenizeLine(e.key);
    if (!toks.length) continue;
    if (!lib.byFirst.has(toks[0])) lib.byFirst.set(toks[0], []);
    lib.byFirst.get(toks[0]).push({ toks: toks, file: path.join(dir, e.file) });
    lib.entries++;
  }
  for (const list of lib.byFirst.values()) list.sort((a, b) => b.toks.length - a.toks.length);
  lib.rate = rate;
  lib.enabled = lib.entries > 0;
  if (lib.enabled) log(new Date().toISOString() + ' voice: clip library loaded, ' + lib.entries + ' phrases from ' + dir);
  return lib;
}
function libraryClipPcm(lib, file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  const cached = lib.cache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.pcm;
  const pcm = readWavPcm(file, lib.rate);
  if (pcm) lib.cache.set(file, { mtimeMs: st.mtimeMs, pcm: pcm });
  return pcm;
}
/* Partition a line's tokens into manifest phrases; returns joined PCM
 * (45ms silence between fragments) or null when any token is uncovered. */
function lookupClip(lib, text) {
  if (!lib.enabled) return null;
  const toks = tokenizeLine(text);
  if (!toks.length) return null;
  const parts = [];
  let i = 0;
  while (i < toks.length) {
    const cands = lib.byFirst.get(toks[i]) || [];
    let hit = null;
    for (const c of cands) {
      if (c.toks.length > toks.length - i) continue;
      let match = true;
      for (let j = 0; j < c.toks.length; j++) if (c.toks[j] !== toks[i + j]) { match = false; break; }
      if (match) { hit = c; break; }
    }
    if (!hit) return null;
    const pcm = libraryClipPcm(lib, hit.file);
    if (!pcm) return null;
    parts.push(pcm);
    i += hit.toks.length;
  }
  if (parts.length === 1) return parts[0];
  const gap = Buffer.alloc(Math.floor(lib.rate * 0.045) * 2);
  const joined = [];
  parts.forEach((p, idx) => { if (idx) joined.push(gap); joined.push(p); });
  return Buffer.concat(joined);
}

function createVoiceService(opts) {
  opts = opts || {};
  const PORT = opts.port != null ? opts.port : 8379;
  const MODEL = opts.model || process.env.HUBIE_TTS_MODEL || defaultModel();
  const FIFO = opts.fifo || process.env.HUBIE_AUDIO_FIFO || '/tmp/hubie-audio.fifo';
  const RATE = modelRate(MODEL), BYTES_PER_SEC = RATE * 2; // s16le mono
  const LIBRARY_DIR = opts.libraryDir || process.env.HUBIE_LIBRARY_DIR ||
    path.join(__dirname, '..', 'voices-local', 'library');
  const LIBRARY_ON = opts.library != null ? !!opts.library :
    process.env.HUBIE_VOICE_LIBRARY !== 'off';
  const TICK_MS = 100;
  const spawnImpl = opts.spawnImpl || spawn;
  // Injectable clock + interval timers: the feeder tests drive a fake
  // clock with deliberately slipped ticks to prove wall-clock emission.
  const now = opts.now || Date.now;
  const setInt = opts.setInterval || setInterval;
  const clearInt = opts.clearInterval || clearInterval;
  const log = opts.log || function () { console.log.apply(console, arguments); };
  const library = LIBRARY_ON ? loadLibrary(LIBRARY_DIR, RATE, log) : { enabled: false, entries: 0 };
  let clipsPlayed = 0, clipFallbacks = 0;
  let linesReceived = 0;

  /* ---------------- speech events (coupled sync) ----------------
   * Journaled SSE: every event gets a sequence number; a reconnecting
   * scene sends Last-Event-ID and is replayed what it missed, then a
   * sync snapshot reconciles whatever the journal no longer holds. */
  const eventClients = new Set();
  const journal = [];              // { seq, type, data } ring, newest last
  let eventSeq = 0;
  function emitEvent(type, data) {
    const evt = { seq: ++eventSeq, type: type, data: data };
    journal.push(evt);
    if (journal.length > 400) journal.shift();
    const frame = 'id: ' + evt.seq + '\nevent: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of eventClients) { try { res.write(frame); } catch (e) { /* dropped on close */ } }
  }
  const eventHeartbeat = setInt(() => {
    for (const res of eventClients) { try { res.write(': ping\n\n'); } catch (e) { /* dropped on close */ } }
  }, 15000);
  if (eventHeartbeat.unref) eventHeartbeat.unref();
  function syncSnapshot() {
    const speaking = segments.find((s) => s.started) || null;
    return {
      speakingId: speaking ? speaking.id : null,
      speakingText: speaking ? speaking.text : null,
      waitingId: waiting ? waiting.id : null,
      spoken: spoken, dropped: dropped
    };
  }

  /* ---------------- FIFO + real-time feeder ---------------- */
  try { execSync('mkfifo ' + JSON.stringify(FIFO)); } catch (e) { /* exists */ }
  let fifoOut = null, fifoReady = false, closed = false;
  let pending = Buffer.alloc(0);       // synthesized speech waiting to be clocked out
  let totalGenerated = 0;              // speech bytes produced by Piper
  let totalPlayed = 0;                 // speech bytes clocked into the FIFO
  let feedEpoch = now();               // wall-clock start of the emission ledger
  let emittedBytes = 0;                // ALL bytes (speech + silence) clocked out this epoch

  function openFifo() {
    if (closed) return;
    fifoOut = fs.createWriteStream(FIFO);
    fifoOut.on('open', () => { fifoReady = true; log(new Date().toISOString() + ' voice: stream attached to FIFO'); });
    fifoOut.on('error', () => { fifoReady = false; if (!closed) { const t = setTimeout(openFifo, 1000); if (t.unref) t.unref(); } });
    fifoOut.on('close', () => {
      const wasAttached = fifoReady;
      fifoReady = false;
      if (closed) return;
      // A stream that was really attached detached: audio in flight is
      // lost — count every lost line as dropped (segments AND the waiting
      // line) and reset the offset accounting for the next attach. A
      // stream that never attached (open failed, e.g. no reader yet) has
      // nothing to reset — leave the pipeline untouched.
      if (wasAttached) {
        if (segments.length) dropped += segments.length;
        if (waiting) { dropped++; droppedStale++; }
        // Coupled sync: lines lost with the stream are EVENTS, so the
        // scene frees its speech slot (and clears any subtitle whose
        // audio just vanished) instead of waiting on an end that will
        // never come.
        for (const s of segments) emitEvent('speech-dropped', { id: s.id, reason: 'fifo-detached', ts: now() });
        if (waiting) emitEvent('speech-dropped', { id: waiting.id, reason: 'fifo-detached', ts: now() });
        segments = []; synthSeg = null; waiting = null; pending = Buffer.alloc(0);
        totalGenerated = 0; totalPlayed = 0;
        feedEpoch = now(); emittedBytes = 0; // the emission ledger restarts with the new attach
      }
      { const t = setTimeout(openFifo, 500); if (t.unref) t.unref(); }
    });
  }
  openFifo();

  /* ---------------- Piper processes (one per pace) ---------------- */
  const pipers = {};
  function startPiper(pace) {
    const proc = spawnImpl('python3', ['-m', 'piper', '--model', MODEL,
      '--output-raw', '--length-scale', String(PACES[pace])],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    proc.stdout.on('data', (d) => {
      pending = Buffer.concat([pending, d]);
      totalGenerated += d.length;
      if (synthSeg) { synthSeg.lastDataAt = now(); synthSeg.gotData = true; }
    });
    proc.on('exit', (code) => {
      if (closed) return;
      console.error(new Date().toISOString() + ' voice: piper[' + pace + '] exited (' + code + '), restarting in 2s');
      if (pipers[pace] === proc) pipers[pace] = null;
      setTimeout(() => startPiper(pace), 2000);
    });
    if (proc.stdin && proc.stdin.on) proc.stdin.on('error', () => { /* handled by exit */ });
    pipers[pace] = proc;
  }
  Object.keys(PACES).forEach(startPiper);

  /* ---------------- Scheduler: strict queue discipline ---------------- */
  let waiting = null;        // at most ONE line: { text, pace, postedAt }
  let segments = [];         // lines sent to Piper, in order: { postedAt, pace, chars, genStart, genEnd, started, lastDataAt }
  let synthSeg = null;       // the segment currently synthesizing (subset of segments)
  let spoken = 0, dropped = 0, droppedStale = 0, droppedOverflow = 0;
  let lastStartLagSec = null, maxStartLagSec = 0;

  let autoId = 0;
  function sanitizeId(id) {
    return (typeof id === 'string' && /^[\w-]{1,64}$/.test(id)) ? id : null;
  }
  function enqueue(text, pace, id) {
    if (!PACES[pace]) pace = 'normal';
    linesReceived++;
    const lineId = sanitizeId(id) || ('svc-' + (++autoId));
    if (waiting) { // fresher line replaces the waiting one
      dropped++; droppedOverflow++;
      emitEvent('speech-dropped', { id: waiting.id, reason: 'replaced', ts: now() });
    }
    let clipPcm = null;
    if (library.enabled) {
      clipPcm = lookupClip(library, text);
      if (!clipPcm) clipFallbacks++; // unmapped line: live Piper speaks it
    }
    waiting = { id: lineId, text: text, pace: pace, postedAt: now(), clipPcm: clipPcm };
    return lineId;
  }

  function schedulerTick() {
    const tNow = now();
    // Detect end of synthesis: data flowed, then stopped for 250ms.
    if (synthSeg && synthSeg.gotData && tNow - synthSeg.lastDataAt > 250) {
      synthSeg.genEnd = totalGenerated;
      synthSeg = null;
    }
    // Age gate: a waiting line that can no longer start in time dies here.
    if (waiting && tNow - waiting.postedAt > MAX_START_LAG_MS) {
      dropped++; droppedStale++;
      emitEvent('speech-dropped', { id: waiting.id, reason: 'stale', ts: tNow });
      waiting = null;
    }
    if (!waiting || synthSeg) return;
    if (waiting.clipPcm) {
      // Clip dispatch is instant (no synthesis), but the line still has
      // to be able to START within the lag window behind whatever audio
      // is already buffered — same discipline as a synthesized line.
      const pendingSecC = pending.length / BYTES_PER_SEC;
      if ((tNow - waiting.postedAt) / 1000 + pendingSecC > MAX_START_LAG_MS / 1000) return;
      const segC = {
        id: waiting.id, text: waiting.text,
        postedAt: waiting.postedAt, pace: waiting.pace, chars: waiting.text.length,
        genStart: totalGenerated, genEnd: totalGenerated + waiting.clipPcm.length,
        started: false, lastDataAt: tNow
      };
      segments.push(segC);
      pending = Buffer.concat([pending, waiting.clipPcm]);
      totalGenerated += waiting.clipPcm.length;
      clipsPlayed++;
      waiting = null;
      return;
    }
    const piper = pipers[waiting.pace];
    if (!piper || !piper.stdin || !piper.stdin.writable) return;
    const pendingSec = pending.length / BYTES_PER_SEC;
    const estSynth = waiting.text.length * SYNTH_SEC_PER_CHAR;
    const projectedLag = (tNow - waiting.postedAt) / 1000 + Math.max(pendingSec, estSynth);
    if (projectedLag * 1000 > MAX_START_LAG_MS) return; // backlog too deep; age gate will reap it
    const seg = {
      id: waiting.id, text: waiting.text,
      postedAt: waiting.postedAt, pace: waiting.pace, chars: waiting.text.length,
      genStart: totalGenerated, genEnd: null, started: false, lastDataAt: tNow
    };
    segments.push(seg);
    synthSeg = seg;
    piper.stdin.write(waiting.text + '\n');
    waiting = null;
  }

  /* ---------------- Feeder + start-lag measurement ----------------
   * WALL-CLOCK EMISSION (v3.2): the ledger (feedEpoch + emittedBytes)
   * decides how much audio each tick clocks out — exactly the amount
   * owed for the wall time elapsed since the epoch began, speech from
   * pending first and silence for the rest. With no stream attached the
   * same amount is discarded instead of written, so the voice is already
   * "in the moment" whenever a stream attaches and the byte-offset lag
   * accounting stays exact. See the header for why fixed 100ms-per-tick
   * emission compressed the audio timeline under load. */
  function feederTick() {
    schedulerTick();
    const owed = Math.floor((now() - feedEpoch) * BYTES_PER_SEC / 1000 / 2) * 2;
    const toEmit = owed - emittedBytes;
    if (toEmit > 0) {
      const speechNow = Math.min(pending.length, toEmit);
      if (fifoReady && fifoOut) {
        const head = pending.slice(0, speechNow);
        const chunk = speechNow === toEmit ? head
          : Buffer.concat([head, Buffer.alloc(toEmit - speechNow)]); // silence keeps the stream clock alive
        try { fifoOut.write(chunk); } catch (e) { /* close handler resets */ }
      }
      if (speechNow > 0) pending = pending.slice(speechNow);
      totalPlayed += speechNow;
      emittedBytes += toEmit;
    }
    // A segment's audible start = the tick its first byte is clocked out.
    function markStarted(seg) {
      seg.started = true;
      spoken++;
      const lag = (now() - seg.postedAt) / 1000;
      lastStartLagSec = +lag.toFixed(2);
      if (lag > maxStartLagSec) maxStartLagSec = lastStartLagSec;
      log(new Date().toISOString() + ' voice: line started id=' + seg.id + ', lag=' + lag.toFixed(2) + 's pace=' + seg.pace + ' chars=' + seg.chars + ' text="' + seg.text + '"');
      emitEvent('speech-started', { id: seg.id, text: seg.text, ts: now(), lagSec: lastStartLagSec });
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg.started && totalPlayed >= seg.genStart && totalGenerated > seg.genStart) markStarted(seg);
    }
    // Retire fully-played segments — a retirement IS the speech-ended
    // moment (the line's last byte has been clocked out).
    while (segments.length && segments[0].genEnd != null && totalPlayed >= segments[0].genEnd) {
      const doneSeg = segments.shift();
      if (!doneSeg.started) markStarted(doneSeg); // defensive: start can never be skipped
      emitEvent('speech-ended', { id: doneSeg.id, ts: now() });
    }
    // Flow control: never let synthesized audio pile up far ahead.
    Object.keys(pipers).forEach((p) => {
      const pr = pipers[p];
      if (pr && pr.stdout && pr.stdout.pause && pr.stdout.resume) {
        if (pending.length > BYTES_PER_SEC * 4) pr.stdout.pause(); else pr.stdout.resume();
      }
    });
  }
  const feeder = setInt(feederTick, TICK_MS);

  function health() {
    return {
      ok: true, fifoReady: fifoReady,
      voice: path.basename(MODEL),
      pacesUp: Object.keys(PACES).filter((p) => !!pipers[p]),
      queue: waiting ? 1 : 0,
      bufferedSec: +(pending.length / BYTES_PER_SEC).toFixed(2),
      emittedSec: +(emittedBytes / BYTES_PER_SEC).toFixed(2),
      feedWallSec: +((now() - feedEpoch) / 1000).toFixed(2),
      spoken: spoken, dropped: dropped,
      droppedStale: droppedStale, droppedOverflow: droppedOverflow,
      lastStartLagSec: lastStartLagSec, maxStartLagSec: maxStartLagSec,
      libraryEnabled: library.enabled, libraryEntries: library.entries,
      clipsPlayed: clipsPlayed, clipFallbacks: clipFallbacks,
      linesReceived: linesReceived, eventClients: eventClients.size
    };
  }

  /* Scene telemetry (POST /telemetry): the director's counters, merged
   * into /sync so a single read verifies the coupling end to end. */
  let sceneTelemetry = null, sceneTelemetryAt = 0;
  function sync() {
    return {
      service: health(),
      scene: sceneTelemetry,
      sceneTelemetryAt: sceneTelemetryAt || null,
      events: journal.slice()
    };
  }

  /* ---------------- HTTP intake ---------------- */
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(health()));
    }
    if (req.method === 'GET' && req.url === '/sync') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(sync()));
    }
    if (req.method === 'GET' && req.url === '/events') {
      // SSE, same contract shape as the chat bridge: replay what the
      // reconnecting scene missed (Last-Event-ID), then a sync snapshot.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const lastSeq = parseInt(req.headers['last-event-id'], 10) || 0;
      if (lastSeq > 0) {
        for (const evt of journal) {
          if (evt.seq > lastSeq) {
            try { res.write('id: ' + evt.seq + '\nevent: ' + evt.type + '\ndata: ' + JSON.stringify(evt.data) + '\n\n'); } catch (e) { /* gone */ }
          }
        }
      }
      res.write('event: sync\ndata: ' + JSON.stringify(syncSnapshot()) + '\n\n');
      eventClients.add(res);
      req.on('close', () => eventClients.delete(res));
      return;
    }
    if (req.method === 'POST' && req.url === '/say') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let text = '', pace = 'normal', id = null, lineId = null;
        try { const j = JSON.parse(body); text = String(j.text || ''); pace = String(j.pace || 'normal'); id = j.id; } catch (e) { /* ignore */ }
        text = text.replace(/\s+/g, ' ').trim().slice(0, 300);
        if (text) lineId = enqueue(text, pace, id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: lineId }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/telemetry') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          const clean = {};
          for (const k of ['mode', 'coupled', 'intentsSubmitted', 'linesGenerated', 'intentsReplaced',
                           'intentsDropped', 'intentsExpired', 'displayed', 'serviceDropped',
                           'resultLagCount', 'lastResultLagMs', 'maxResultLagMs', 'pending', 'outstanding']) {
            if (j[k] !== undefined) clean[k] = j[k];
          }
          sceneTelemetry = clean;
          sceneTelemetryAt = now();
        } catch (e) { /* malformed telemetry is ignored, never fatal */ }
        res.writeHead(204); res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  function close() {
    closed = true;
    clearInt(feeder);
    clearInt(eventHeartbeat);
    for (const res of eventClients) { try { res.end(); } catch (e) { /* ignore */ } }
    eventClients.clear();
    try { server.close(); } catch (e) {}
    Object.keys(pipers).forEach((p) => { if (pipers[p]) { try { pipers[p].kill(); } catch (e) {} } });
    if (fifoOut) { try { fifoOut.destroy(); } catch (e) {} }
  }

  return { server: server, health: health, sync: sync, enqueue: enqueue, close: close, PORT: PORT, feederTick: feederTick };
}

if (require.main === module) {
  const svc = createVoiceService({ port: parseInt(process.argv[2], 10) || 8379 });
  svc.server.listen(svc.PORT, '127.0.0.1', () => {
    console.log(new Date().toISOString() + ' hubie voice service v2 on http://127.0.0.1:' + svc.PORT);
  });
}

module.exports = { createVoiceService: createVoiceService, PACES: PACES, MAX_START_LAG_MS: MAX_START_LAG_MS, tokenizeLine: tokenizeLine, loadLibrary: loadLibrary, lookupClip: lookupClip };
