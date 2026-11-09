#!/usr/bin/env node
/* Hubie coupled-sync proof verification (off-air, local evidence only).
 *
 * Correlates the three independent records of the proof run:
 *   1. logs/proof-voice.log  — the voice service's own start log
 *      ("line started id=... text=..."), one entry per audible start.
 *   2. logs/proof-chrome.log — the scene's HUBIE-SYNC display lines
 *      (console, ?synclog=1), one entry per subtitle rendered.
 *   3. logs/proof-sync.json  — the final /sync snapshot (service +
 *      scene counters + the speech-event journal).
 * Pass evidence: the SET of line ids the service started equals the
 * SET the scene displayed, with identical texts — displayed == spoken
 * with names, not just totals. Also reports the pacing counters, the
 * result-line intent->speech lag distribution (from the scene log),
 * frame spot checks (subtitle band is visibly populated while a line
 * speaks and empty in the gaps), and writes logs/proof-samples.json
 * (>= 10 in-recording lines) for the transcription spot check
 * (scripts/verify-transcribe.py).
 * Usage: node scripts/verify-proof.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const meta = JSON.parse(read('logs/proof-meta.json'));
const sync = JSON.parse(read('logs/proof-sync.json'));
const voiceLog = read('logs/proof-voice.log');
const chromeLog = read('logs/proof-chrome.log');

/* ---- 1. voice service starts (its own log) ---- */
const startedById = new Map();
for (const line of voiceLog.split('\n')) {
  const m = line.match(/line started id=(\S+), lag=([\d.]+)s .* text="(.*)"/);
  if (m) startedById.set(m[1], { id: m[1], postLagSec: Number(m[2]), text: m[3] });
}
/* ---- 2. scene displays (Chrome console) ---- */
const displayedById = new Map();
const resultLags = [];
for (const line of chromeLog.split('\n')) {
  const m = line.match(/HUBIE-SYNC display id=(\S+) kind=([a-z]+)(?: lagMs=(\d+))? ts=(\d+) text=\\?"(.*?)\\?"(?:,|")/);
  if (m) {
    displayedById.set(m[1], { id: m[1], kind: m[2], lagMs: m[3] ? Number(m[3]) : null, ts: Number(m[4]), text: m[5] });
    if (m[2] === 'result' && m[3]) resultLags.push(Number(m[3]));
  }
}
/* ---- set + text equality ---- */
const startedIds = [...startedById.keys()];
const displayedIds = [...displayedById.keys()];
const onlyStarted = startedIds.filter((id) => !displayedById.has(id));
const onlyDisplayed = displayedIds.filter((id) => !startedById.has(id));
const textMismatches = startedIds.filter((id) => displayedById.has(id) && displayedById.get(id).text !== startedById.get(id).text);

/* ---- counters ---- */
const svc = sync.service || {};
const scn = sync.scene || {};
const journal = sync.events || [];
const jStarted = journal.filter((e) => e.type === 'speech-started');
const jEnded = new Map(journal.filter((e) => e.type === 'speech-ended').map((e) => [e.data.id, e.data.ts]));
const jDropped = journal.filter((e) => e.type === 'speech-dropped');

/* ---- in-recording samples for transcription + frames ---- */
const inWindow = jStarted
  .map((e) => ({ id: e.data.id, text: e.data.text, startTs: e.data.ts, endTs: jEnded.get(e.data.id) || null }))
  .filter((s) => s.endTs && s.startTs >= meta.ffmpegStartedAt + 1000 && s.endTs <= meta.ffmpegEndedAt - 500)
  .map((s) => ({ id: s.id, text: s.text, startOff: (s.startTs - meta.ffmpegStartedAt) / 1000, endOff: (s.endTs - meta.ffmpegStartedAt) / 1000 }));
const sampleStep = Math.max(1, Math.floor(inWindow.length / 12));
const samples = inWindow.filter((_, i) => i % sampleStep === 0).slice(0, 12);
fs.writeFileSync(path.join(ROOT, 'logs/proof-samples.json'), JSON.stringify(samples, null, 2));

/* ---- frame spot check: subtitle band populated vs cleared ---- */
function brightFraction(sec) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(sec), '-i', path.join(ROOT, 'demo/hubie-coupled-proof.mp4'),
    '-frames:v', '1', '-vf', 'crop=1040:65:200:585,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let bright = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] > 120) bright++;
  return bright / raw.length;
}
let frameCheck = null;
try {
  const speechFr = samples.slice(0, 6).map((s) => brightFraction(s.startOff + (s.endOff - s.startOff) * 0.45));
  const gaps = [];
  for (let i = 0; i + 1 < inWindow.length && gaps.length < 3; i++) {
    if (inWindow[i + 1].startOff - inWindow[i].endOff > 2.5) gaps.push(inWindow[i].endOff + 0.8);
  }
  const gapFr = gaps.map(brightFraction);
  frameCheck = {
    speechMean: speechFr.reduce((a, b) => a + b, 0) / Math.max(1, speechFr.length),
    gapMean: gapFr.length ? gapFr.reduce((a, b) => a + b, 0) / gapFr.length : null,
    speechFrames: speechFr.map((x) => +x.toFixed(4)),
    gapFrames: gapFr.map((x) => +x.toFixed(4))
  };
} catch (e) { frameCheck = { error: String(e).slice(0, 200) }; }

/* ---- result lag distribution ---- */
resultLags.sort((a, b) => a - b);
const lagStats = resultLags.length ? {
  n: resultLags.length,
  medianMs: resultLags[Math.floor(resultLags.length / 2)],
  p90Ms: resultLags[Math.min(resultLags.length - 1, Math.floor(resultLags.length * 0.9))],
  maxMs: resultLags[resultLags.length - 1]
} : null;

const summary = {
  recordingSec: meta.durationSec,
  service: { spoken: svc.spoken, dropped: svc.dropped, droppedStale: svc.droppedStale, droppedOverflow: svc.droppedOverflow, clipsPlayed: svc.clipsPlayed, clipFallbacks: svc.clipFallbacks, maxPostToAudioLagSec: svc.maxStartLagSec, linesReceived: svc.linesReceived },
  scene: { coupled: scn.coupled, intentsSubmitted: scn.intentsSubmitted, linesGenerated: scn.linesGenerated, displayed: scn.displayed, intentsReplaced: scn.intentsReplaced, intentsDropped: scn.intentsDropped, intentsExpired: scn.intentsExpired, serviceDropped: scn.serviceDropped },
  setEquality: {
    startedCount: startedIds.length, displayedCount: displayedIds.length,
    onlyStarted, onlyDisplayed, textMismatches,
    exact: onlyStarted.length === 0 && onlyDisplayed.length === 0 && textMismatches.length === 0
  },
  journal: { started: jStarted.length, ended: jEnded.size, dropped: jDropped.length },
  resultLagIntentToSpeech: lagStats,
  inWindowLines: inWindow.length,
  samplesWritten: samples.length,
  frameCheck
};
fs.writeFileSync(path.join(ROOT, 'logs/proof-verification.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
