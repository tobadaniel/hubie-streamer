#!/usr/bin/env node
/* Local CONNECT relay for the Hubie stream pipeline (added 2026-11-07
 * during the first live test). Why it exists: this network forces egress
 * through an HTTP proxy, and ffmpeg's built-in proxy handling cannot
 * hold an RTMPS publish (connections died after ~30s, three attempts),
 * while a plain HTTP CONNECT tunnel through the same proxy holds far
 * longer. This relay listens on 127.0.0.1:1936; scripts/stream.sh
 * with HUBIE_RTMP_RELAY=127.0.0.1:1936 points ffmpeg at
 * rtmps://127.0.0.1:1936/app/<key> with its proxy env stripped, so
 * ffmpeg runs end-to-end TLS to Kick through the tunnel.
 * Proxy credentials come from the https_proxy env var at runtime;
 * nothing secret is stored in this file and nothing secret is logged
 * (the proxy URL is never printed — only that env-proxy mode is on).
 * Usage: node scripts/rtmp-relay.js
 *
 * v2 (2026-11-08, transport diagnosis): the 2026-11-08 judged run died
 * at ~44 min when this relay logged a bare "upstream closed" — the old
 * code kept no byte counters, no error detail, no keepalive, and could
 * not say which side closed first or why. This version is built to
 * answer that question next time:
 *   - structured JSON-lines logging (stdout): one event per line with
 *     ts / conn id / leg, so logs/rtmp-relay.log is machine-greppable;
 *   - socket lifecycle on BOTH legs: client_connect, upstream_connect,
 *     connect_sent, tunnel_established (with proxy status), leg_fin
 *     (remote FIN), socket_error (errno/code/syscall), leg_close
 *     (hadError), and a tunnel_closed summary naming the FIRST closer
 *     ('client' | 'upstream' | 'local-destroy'), total duration and
 *     byte counts for each direction;
 *   - byte counters per direction with a periodic report every
 *     HUBIE_RELAY_REPORT_MS (default 30s);
 *   - TCP keepalive on both legs (setKeepAlive, initial delay
 *     HUBIE_RELAY_KEEPALIVE_MS, default 15s) + setNoDelay; the OS then
 *     probes a half-open peer and eventually errors the socket, which
 *     the lifecycle logging records. An idle watchdog also flags any
 *     established tunnel with no bytes in either direction for
 *     HUBIE_RELAY_IDLE_WARN_MS (default 120s — an RTMPS publish is
 *     never silent that long) as possible_half_open;
 *   - FIN is propagated gracefully (other.end()) with a 5s grace
 *     before destroy, instead of the old instant destroy() — the old
 *     behaviour turned the proxy's clean close into the ECONNRESET
 *     ffmpeg reported ("Connection reset by peer"). ffmpeg still exits
 *     either way; the supervisor (scripts/encoder-supervisor.js) is
 *     what recovers the run.
 * Interface unchanged: listen 127.0.0.1:1936 (HUBIE_RELAY_LISTEN_PORT),
 * proxy CONNECT to the Kick ingest host:443 by default.
 * Soak-test hooks (never used in production): HUBIE_RELAY_TARGET_HOST /
 * HUBIE_RELAY_TARGET_PORT override the CONNECT target, and
 * HUBIE_RELAY_DIRECT=1 skips the proxy CONNECT entirely (plain TCP to
 * the target) so the relay code path can be soaked against a local
 * sink — the egress proxy cannot call back into this VM, so a local
 * sink can never terminate a through-proxy tunnel.
 */
'use strict';
const net = require('net');
const { URL } = require('url');

const LISTEN_PORT = parseInt(process.env.HUBIE_RELAY_LISTEN_PORT || '1936', 10);
const TARGET_HOST = process.env.HUBIE_RELAY_TARGET_HOST || 'fa723fc1b171.global-contribute.live-video.net';
const TARGET_PORT = parseInt(process.env.HUBIE_RELAY_TARGET_PORT || '443', 10);
const DIRECT = process.env.HUBIE_RELAY_DIRECT === '1';
const KEEPALIVE_MS = parseInt(process.env.HUBIE_RELAY_KEEPALIVE_MS || '15000', 10);
const REPORT_MS = parseInt(process.env.HUBIE_RELAY_REPORT_MS || '30000', 10);
const IDLE_WARN_MS = parseInt(process.env.HUBIE_RELAY_IDLE_WARN_MS || '120000', 10);
const FIN_GRACE_MS = 5000;

let proxy = null;
if (!DIRECT) {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!raw) {
    console.error('rtmp-relay: https_proxy env not set and HUBIE_RELAY_DIRECT is not 1 — refusing to start');
    process.exit(1);
  }
  proxy = new URL(raw);
}

function log(obj) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), src: 'rtmp-relay' }, obj)));
}

let connSeq = 0;

const server = net.createServer((client) => {
  const id = ++connSeq;
  const t0 = Date.now();
  const conn = {
    id: id, established: false, closed: false,
    bytesUp: 0, bytesDown: 0,           // up = client(ffmpeg) -> target, down = target -> client
    lastDataAt: t0, idleWarned: false,
    firstCloser: null,                    // 'client' | 'upstream' | 'local-destroy'
    clientEnded: false, upstreamEnded: false,
    clientClosed: false, upstreamClosed: false,
    graceTimer: null
  };
  log({ event: 'client_connect', conn: id, from: client.remoteAddress + ':' + client.remotePort });
  client.setKeepAlive(true, KEEPALIVE_MS);
  client.setNoDelay(true);

  let up;
  if (DIRECT) {
    up = net.connect(TARGET_PORT, TARGET_HOST);
  } else {
    up = net.connect(Number(proxy.port || 3128), proxy.hostname);
  }
  up.setKeepAlive(true, KEEPALIVE_MS);
  up.setNoDelay(true);

  function noteFirstCloser(leg, why) {
    if (!conn.firstCloser) { conn.firstCloser = leg; log({ event: 'first_close_signal', conn: id, leg: leg, why: why }); }
  }

  // Client -> upstream: ffmpeg may send its TLS ClientHello the moment
  // its TCP connect completes, i.e. before the CONNECT handshake with
  // the proxy finishes. Those bytes are stashed (never dropped) and
  // flushed the instant the tunnel is established.
  const stash = [];
  client.on('data', (d) => {
    conn.bytesUp += d.length; conn.lastDataAt = Date.now(); conn.idleWarned = false;
    if (!conn.established) { stash.push(d); return; }
    if (up.write(d) === false) client.pause();
  });
  up.on('drain', () => client.resume());

  // Upstream -> client: in proxy mode the first bytes are the CONNECT
  // response; everything past the header terminator is tunnel data.
  let buf = Buffer.alloc(0);
  up.on('data', (chunk) => {
    if (conn.established) {
      conn.bytesDown += chunk.length; conn.lastDataAt = Date.now(); conn.idleWarned = false;
      if (client.write(chunk) === false) up.pause();
      return;
    }
    if (DIRECT) return; // unreachable: direct mode establishes on connect
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) {
      if (buf.length > 16384) { log({ event: 'connect_response_overflow', conn: id }); teardown('local-destroy'); }
      return;
    }
    const head = buf.slice(0, idx).toString('latin1');
    const statusLine = head.split('\r\n')[0];
    const m = / ([0-9]{3}) /.exec(statusLine + ' ');
    const status = m ? Number(m[1]) : 0;
    if (status !== 200) {
      log({ event: 'connect_refused', conn: id, statusLine: statusLine });
      teardown('local-destroy');
      return;
    }
    establish(Buffer.from(buf.slice(idx + 4)));
  });
  client.on('drain', () => up.resume());

  function establish(rest) {
    if (conn.established) return;
    conn.established = true;
    log({ event: 'tunnel_established', conn: id, mode: DIRECT ? 'direct' : 'proxy-connect', target: TARGET_HOST + ':' + TARGET_PORT, afterMs: Date.now() - t0, stashedBytes: stash.reduce((a, b) => a + b.length, 0) });
    for (const d of stash) { if (up.write(d) === false) client.pause(); }
    stash.length = 0;
    if (rest && rest.length) {
      conn.bytesDown += rest.length; conn.lastDataAt = Date.now();
      client.write(rest);
    }
  }

  if (DIRECT) {
    up.on('connect', () => { log({ event: 'upstream_connect', conn: id, target: TARGET_HOST + ':' + TARGET_PORT }); establish(null); });
  } else {
    up.on('connect', () => {
      log({ event: 'upstream_connect', conn: id, target: 'egress-proxy' });
      const auth = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
      up.write('CONNECT ' + TARGET_HOST + ':' + TARGET_PORT + ' HTTP/1.1\r\nHost: ' + TARGET_HOST + ':' + TARGET_PORT + '\r\nProxy-Authorization: Basic ' + auth + '\r\nProxy-Connection: keep-alive\r\n\r\n');
      log({ event: 'connect_sent', conn: id, target: TARGET_HOST + ':' + TARGET_PORT });
    });
  }

  // Lifecycle wiring for one leg. leg is 'client' or 'upstream'.
  function wireLeg(sock, leg, peer) {
    sock.on('end', () => {
      log({ event: 'leg_fin', conn: id, leg: leg });
      noteFirstCloser(leg, 'fin');
      if (leg === 'client') conn.clientEnded = true; else conn.upstreamEnded = true;
      // Propagate the FIN gracefully instead of destroying the peer
      // (destroy is what turned a clean upstream close into ffmpeg's
      // ECONNRESET last time). If the peer does not finish within the
      // grace window, destroy it so the tunnel cannot hang half-open.
      try { peer.end(); } catch (e) { /* already gone */ }
      if (!conn.graceTimer) {
        conn.graceTimer = setTimeout(() => {
          if (!conn.closed) { log({ event: 'fin_grace_expired', conn: id, leg: leg }); teardown('local-destroy'); }
        }, FIN_GRACE_MS);
        if (conn.graceTimer.unref) conn.graceTimer.unref();
      }
    });
    sock.on('error', (e) => {
      log({ event: 'socket_error', conn: id, leg: leg, code: e.code || null, errno: e.errno || null, syscall: e.syscall || null, message: e.message });
      noteFirstCloser(leg, 'error:' + (e.code || 'unknown'));
    });
    sock.on('close', (hadError) => {
      log({ event: 'leg_close', conn: id, leg: leg, hadError: !!hadError });
      if (leg === 'client') conn.clientClosed = true; else conn.upstreamClosed = true;
      maybeFinish();
    });
  }
  wireLeg(client, 'client', up);
  wireLeg(up, 'upstream', client);

  function teardown(why) {
    if (!conn.firstCloser) conn.firstCloser = why;
    try { client.destroy(); } catch (e) { /* ignore */ }
    try { up.destroy(); } catch (e) { /* ignore */ }
  }

  function maybeFinish() {
    if (conn.closed || !(conn.clientClosed && conn.upstreamClosed)) return;
    conn.closed = true;
    if (conn.graceTimer) clearTimeout(conn.graceTimer);
    clearInterval(reportTimer);
    log({
      event: 'tunnel_closed', conn: id, established: conn.established,
      durationMs: Date.now() - t0, bytesUp: conn.bytesUp, bytesDown: conn.bytesDown,
      firstCloser: conn.firstCloser || 'unknown'
    });
  }

  // Periodic byte report + idle (possible half-open) watch.
  const reportTimer = setInterval(() => {
    if (conn.closed) return;
    log({ event: 'bytes', conn: id, bytesUp: conn.bytesUp, bytesDown: conn.bytesDown, established: conn.established });
    const idleMs = Date.now() - conn.lastDataAt;
    if (conn.established && idleMs > IDLE_WARN_MS && !conn.idleWarned) {
      conn.idleWarned = true;
      log({ event: 'possible_half_open', conn: id, idleMs: idleMs, bytesUp: conn.bytesUp, bytesDown: conn.bytesDown });
    }
  }, REPORT_MS);
  if (reportTimer.unref) reportTimer.unref();
});

server.on('error', (e) => log({ event: 'server_error', code: e.code || null, message: e.message }));
server.listen(LISTEN_PORT, '127.0.0.1', () => {
  log({ event: 'listening', port: LISTEN_PORT, mode: DIRECT ? 'direct' : 'proxy-connect', target: TARGET_HOST + ':' + TARGET_PORT, keepAliveMs: KEEPALIVE_MS, reportMs: REPORT_MS, idleWarnMs: IDLE_WARN_MS });
});
