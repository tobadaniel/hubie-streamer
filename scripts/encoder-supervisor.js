#!/usr/bin/env node
/* Encoder supervisor — owns ffmpeg so ffmpeg can no longer own the run.
 *
 * Why it exists (2026-11-08): in the judged run, scripts/stream.sh ran
 * ffmpeg in the foreground with a cleanup trap — when the RTMPS tunnel
 * dropped at ~44 min, ffmpeg exited and the trap tore down Chrome/Xvfb,
 * ending the show for a transport blip. Now ffmpeg is a supervised
 * CHILD: its exit changes nothing else. The scene server, Chrome,
 * Xvfb, the voice service and the chat service keep their own lifecycle
 * and run straight through encoder restarts — game state, balance,
 * the commentary journal and the voice feeder never reset.
 *
 * Behaviour:
 *   - spawn ffmpeg; on exit, log it and restart fast: first retry after
 *     ~3s, then 5s, 10s, 20s, capped at 20s, forever. A run that lasted
 *     >= 60s counts as stable and resets the backoff to the fast start.
 *   - every spawn / exit / scheduled restart is appended as one JSON
 *     line to the transport log (default logs/transport.log) — the
 *     evidence trail a run record can cite for each drop and resume.
 *   - --no-restart-on-clean-exit: a planned, clean ffmpeg exit (the
 *     --dry-run / local-test -t bound) ends the supervisor with code 0
 *     instead of restarting. An UNPLANNED clean exit (code 0 with no
 *     bound) is still restarted in production mode — a silent encoder
 *     is never the desired end state of a judged run.
 *   - SIGTERM/SIGINT to the supervisor is the operator stop: it kills
 *     the current ffmpeg, starts no new one, and exits 0. stream.sh's
 *     own cleanup trap (Chrome/Xvfb/server) still only runs when
 *     stream.sh itself exits.
 *
 * The voice FIFO side needs no help: the voice service detects the
 * reader detaching, counts any in-flight lines as dropped with
 * speech-dropped events, restarts its emission ledger, and re-attaches
 * when the new ffmpeg opens the FIFO — verified end-to-end by the
 * forced-drop test in logs/transport-report.md.
 *
 * Usage: node scripts/encoder-supervisor.js [options] -- ffmpeg args...
 *   --transport-log PATH   (default logs/transport.log)
 *   --delays MS,MS,...     restart delay ladder (default 3000,5000,10000,20000)
 *   --stable-ms MS         run length that resets the ladder (default 60000)
 *   --strip-proxy-env      remove http(s)_proxy from the child's env
 *   --no-restart-on-clean-exit
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_DELAYS = [3000, 5000, 10000, 20000];
const DEFAULT_STABLE_MS = 60000;

/* Delay before the next restart. consecutiveFailures is 0 for the
 * first retry (it counts the failures already seen in the current
 * unstable streak), so the ladder is: 3s, 5s, 10s, 20s, 20s, ... */
function backoffDelayMs(consecutiveFailures, delays) {
  const d = (delays && delays.length) ? delays : DEFAULT_DELAYS;
  const idx = Math.min(Math.max(0, consecutiveFailures | 0), d.length - 1);
  return d[idx];
}

/* Pure restart decision, kept separate so tests can drive it without
 * spawning anything. Returns { restart: bool, delayMs, failures }. */
function decideRestart(state, exit, opts) {
  opts = opts || {};
  const stableMs = opts.stableMs != null ? opts.stableMs : DEFAULT_STABLE_MS;
  if (state.stopRequested) return { restart: false, reason: 'operator-stop' };
  if (exit.clean && opts.noRestartOnCleanExit) return { restart: false, reason: 'planned-clean-exit' };
  const stable = exit.ranMs >= stableMs;
  const failures = stable ? 0 : (state.consecutiveFailures || 0);
  return {
    restart: true,
    reason: exit.clean ? 'unexpected-clean-exit' : 'encoder-exit',
    stable: stable,
    delayMs: backoffDelayMs(failures, opts.delays),
    failures: failures + 1
  };
}

class EncoderSupervisor {
  constructor(opts) {
    opts = opts || {};
    this.command = opts.command;
    this.args = opts.args || [];
    this.env = opts.env || process.env;
    this.transportLogPath = opts.transportLogPath || null;
    this.delays = opts.delays || DEFAULT_DELAYS;
    this.stableMs = opts.stableMs != null ? opts.stableMs : DEFAULT_STABLE_MS;
    this.noRestartOnCleanExit = !!opts.noRestartOnCleanExit;
    this.spawnImpl = opts.spawnImpl || spawn;
    this.setTimeoutImpl = opts.setTimeoutImpl || setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl || clearTimeout;
    this.now = opts.now || Date.now;
    this.stderr = opts.stderr || process.stderr;
    this.child = null;
    this.attempt = 0;
    this.consecutiveFailures = 0;
    this.stopRequested = false;
    this.restartTimer = null;
    this.startedAt = null;
  }

  tlog(obj) {
    const line = JSON.stringify(Object.assign({ ts: new Date(this.now()).toISOString(), src: 'encoder-supervisor' }, obj));
    this.stderr.write(line + '\n');
    if (this.transportLogPath) {
      try { fs.appendFileSync(this.transportLogPath, line + '\n'); } catch (e) { /* evidence must never kill the run */ }
    }
  }

  start() {
    this.tlog({ event: 'supervisor_start', delays: this.delays, stableMs: this.stableMs, noRestartOnCleanExit: this.noRestartOnCleanExit });
    this.spawnEncoder();
  }

  spawnEncoder() {
    this.attempt++;
    const attempt = this.attempt;
    this.startedAt = this.now();
    let child;
    try {
      child = this.spawnImpl(this.command, this.args, { stdio: 'inherit', env: this.env });
    } catch (e) {
      this.tlog({ event: 'ffmpeg_spawn_error', attempt: attempt, message: e.message });
      this.handleExit(attempt, { code: null, signal: null, ranMs: 0, spawnError: true });
      return;
    }
    this.child = child;
    this.tlog({ event: 'ffmpeg_start', attempt: attempt, pid: child.pid || null });
    let exited = false;
    child.on('error', (e) => {
      if (exited) return;
      exited = true;
      this.tlog({ event: 'ffmpeg_spawn_error', attempt: attempt, message: e.message });
      this.handleExit(attempt, { code: null, signal: null, ranMs: this.now() - this.startedAt, spawnError: true });
    });
    child.on('exit', (code, signal) => {
      if (exited) return;
      exited = true;
      this.handleExit(attempt, { code: code, signal: signal, ranMs: this.now() - this.startedAt });
    });
  }

  handleExit(attempt, exit) {
    const clean = exit.code === 0 && !exit.signal && !exit.spawnError;
    this.tlog({
      event: 'ffmpeg_exit', attempt: attempt, code: exit.code, signal: exit.signal,
      ranMs: exit.ranMs, clean: clean, spawnError: !!exit.spawnError
    });
    if (this.child) this.child = null;
    const decision = decideRestart(
      { stopRequested: this.stopRequested, consecutiveFailures: this.consecutiveFailures },
      { clean: clean, ranMs: exit.ranMs },
      { delays: this.delays, stableMs: this.stableMs, noRestartOnCleanExit: this.noRestartOnCleanExit }
    );
    if (!decision.restart) {
      this.tlog({ event: 'supervisor_stop', reason: decision.reason, attempt: attempt });
      this.onStop && this.onStop(decision.reason);
      return;
    }
    this.consecutiveFailures = decision.failures;
    this.tlog({ event: 'restart_scheduled', attempt: attempt + 1, delayMs: decision.delayMs, reason: decision.reason, stable: !!decision.stable });
    // NOTE: this timer must stay REF'D. During the restart delay it is
    // the only handle keeping the supervisor's event loop alive — an
    // unref'd timer lets Node exit silently mid-delay (found by the
    // 2026-11-08 forced-drop test: the supervisor vanished 0ms after
    // logging restart_scheduled, and stream.sh's trap then killed the
    // scene). The subprocess liveness test in tests/test.js guards it.
    this.restartTimer = this.setTimeoutImpl(() => { this.restartTimer = null; if (!this.stopRequested) this.spawnEncoder(); }, decision.delayMs);
  }

  stop() {
    this.stopRequested = true;
    if (this.restartTimer) { this.clearTimeoutImpl(this.restartTimer); this.restartTimer = null; }
    if (this.child) {
      const child = this.child;
      this.tlog({ event: 'supervisor_stop', reason: 'operator-stop' });
      try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
      this.child = null;
    }
  }
}

function parseCli(argv) {
  const out = { transportLogPath: path.join(__dirname, '..', 'logs', 'transport.log'), delays: DEFAULT_DELAYS.slice(), stableMs: DEFAULT_STABLE_MS, stripProxyEnv: false, noRestartOnCleanExit: false };
  const sep = argv.indexOf('--');
  const mine = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] === '--transport-log') out.transportLogPath = mine[++i];
    else if (mine[i] === '--delays') out.delays = mine[++i].split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
    else if (mine[i] === '--stable-ms') out.stableMs = parseInt(mine[++i], 10);
    else if (mine[i] === '--strip-proxy-env') out.stripProxyEnv = true;
    else if (mine[i] === '--no-restart-on-clean-exit') out.noRestartOnCleanExit = true;
  }
  out.command = rest[0];
  out.args = rest.slice(1);
  return out;
}

if (require.main === module) {
  const cfg = parseCli(process.argv.slice(2));
  if (!cfg.command) {
    console.error('encoder-supervisor: no command after -- (expected the ffmpeg invocation)');
    process.exit(2);
  }
  const env = Object.assign({}, process.env);
  if (cfg.stripProxyEnv) {
    delete env.http_proxy; delete env.https_proxy; delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
  }
  const sup = new EncoderSupervisor({
    command: cfg.command, args: cfg.args, env: env,
    transportLogPath: cfg.transportLogPath, delays: cfg.delays,
    stableMs: cfg.stableMs, noRestartOnCleanExit: cfg.noRestartOnCleanExit
  });
  sup.onStop = () => process.exit(0);
  process.on('SIGTERM', () => sup.stop());
  process.on('SIGINT', () => sup.stop());
  sup.start();
}

module.exports = { EncoderSupervisor: EncoderSupervisor, backoffDelayMs: backoffDelayMs, decideRestart: decideRestart, DEFAULT_DELAYS: DEFAULT_DELAYS, DEFAULT_STABLE_MS: DEFAULT_STABLE_MS };
