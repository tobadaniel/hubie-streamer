#!/usr/bin/env node
/* Soak leg C2 — upload-direction tunnel-lifetime probe through the real
 * egress proxy. Opens a CONNECT tunnel to httpbin.org:443 (same proxy,
 * same mechanics as the production relay), upgrades to TLS, then drips
 * a chunked PUT body at ~1 KB/s. The slow rate is deliberate: httpbin
 * aborts request bodies at a single-digit-MB cap (it killed the first
 * C2 attempt with 413 after ~6 MB / 12 s at 500 KB/s), so at 1 KB/s a
 * size cap would take 100+ minutes to reach — while a proxy tunnel
 * lifetime timer in the ~45-minute class would kill the connection at
 * ~2.7 MB sent. Time of death vs bytes sent disambiguates the two.
 * Logs one line per event to stdout; the wrapper restarts it after
 * every death so repeated lifetimes can be compared. Proxy credentials
 * come from the env and are never logged. */
'use strict';
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

const proxy = new URL(process.env.https_proxy || process.env.HTTPS_PROXY);
const TARGET_HOST = process.env.HUBIE_SOAK_DRIP_HOST || 'httpbin.org';
const TARGET_PORT = 443;
const CHUNK = 2048, EVERY_MS = 2000;

const t0 = Date.now();
let sent = 0, received = 0, done = false;
function log(msg) {
  console.log(new Date().toISOString() + ' C2drip ' + msg + ' (elapsed ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, sent ' + sent + 'B, received ' + received + 'B)');
}
function finish(why) {
  if (done) return;
  done = true;
  log('TUNNEL DIED: ' + why);
  process.exit(0);
}

const up = net.connect(Number(proxy.port || 3128), proxy.hostname, () => {
  const auth = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
  up.write('CONNECT ' + TARGET_HOST + ':' + TARGET_PORT + ' HTTP/1.1\r\nHost: ' + TARGET_HOST + ':' + TARGET_PORT + '\r\nProxy-Authorization: Basic ' + auth + '\r\nProxy-Connection: keep-alive\r\n\r\n');
});
let buf = Buffer.alloc(0), established = false;
up.on('data', (chunk) => {
  if (established) { received += chunk.length; return; }
  buf = Buffer.concat([buf, chunk]);
  const idx = buf.indexOf('\r\n\r\n');
  if (idx === -1) return;
  const head = buf.slice(0, idx).toString('latin1');
  if (!/ 200 /.test(head)) { log('CONNECT refused: ' + head.split('\r\n')[0]); finish('connect-refused'); return; }
  established = true;
  log('tunnel established, starting TLS');
  const sock = tls.connect({ socket: up, servername: TARGET_HOST }, () => {
    log('TLS up, starting chunked PUT drip at ~' + (CHUNK / (EVERY_MS / 1000)) + ' B/s');
    sock.write('PUT /put HTTP/1.1\r\nHost: ' + TARGET_HOST + '\r\nTransfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\n\r\n');
    const iv = setInterval(() => {
      const body = Buffer.alloc(CHUNK, 0x61);
      const frame = CHUNK.toString(16) + '\r\n' + body.toString('latin1') + '\r\n';
      try { sock.write(frame, 'latin1'); sent += CHUNK; } catch (e) { clearInterval(iv); finish('write failed: ' + e.message); }
    }, EVERY_MS);
    if (iv.unref) iv.unref();
  });
  sock.on('data', (d) => { received += d.length; });
  sock.on('error', (e) => finish('tls error ' + (e.code || '') + ' ' + e.message));
  sock.on('close', () => finish('tls socket close'));
  sock.on('end', () => finish('tls socket end (server FIN)'));
});
up.on('error', (e) => finish('proxy socket error ' + (e.code || '') + ' ' + e.message));
up.on('close', () => { if (!established) finish('proxy socket closed before CONNECT completed'); });
setTimeout(() => finish('local 3h safety timeout'), 3 * 3600 * 1000).unref();
