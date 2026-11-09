#!/usr/bin/env node
/* Hubie chat service — local Kick chat bridge (added 2026-11-07, go-live).
 *
 * Why it exists: the read-only Kick adapter (js/chat.js KickChatAdapter)
 * connects fine from Node (standalone protocol test: resolve chatroom ->
 * per-channel Pusher credentials -> subscribe -> subscription_succeeded),
 * but it can NEVER connect inside the streaming Chrome on this VM.
 * Diagnosed 2026-11-07 with CDP network/console evidence from the scene
 * page exactly as scripts/stream.sh opens it: every external request —
 * the channel-API fetch, the realtime-credentials POST and the Pusher
 * websocket — dies with net::ERR_NO_SUPPORTED_PROXIES. stream.sh passes
 * --proxy-server="$https_proxy", and that proxy URL carries embedded
 * credentials (http://user:pass@host:3128); Chrome does not support
 * credentials in a --proxy-server URL, so ALL proxied traffic from the
 * page fails. Localhost is proxy-exempt, which is why the scene itself
 * and the voice bridge always worked while chat never took over and the
 * simulated feed silently carried every test stream.
 *
 * So the adapter now lives here, in Node, where the same code is proven
 * to connect (Node fetch/websocket honour the proxy via
 * NODE_USE_ENV_PROXY). The scene talks to this service on localhost
 * only:
 *
 *   GET /health  -> { ok, connected, chatroomId, received,
 *                     lastMessageAt, lastError, channel }
 *   GET /events  -> Server-Sent Events. On connect, and on every state
 *                   change:  event: status  data: {"connected":bool,...}
 *                   Per chat message:
 *                                event: message data: {id,user,text,ts,
 *                                                      platform:'kick'}
 *                   (exactly the adapter's message contract, so the
 *                   scene feeds it into the same moderator -> responder
 *                   flow as before). Heartbeat comments every 15s.
 *
 * The scene stands the simulated feed DOWN while status says connected
 * and stands it back UP when the bridge reports disconnected or the
 * event stream itself drops — the show never depends on the socket.
 *
 * Read-only, like the adapter: there is deliberately NO endpoint that
 * accepts anything outbound — POSTs get a 405. Hubie answers on stream
 * (voice + subtitles + chat panel), never by posting in Kick chat.
 *
 * Channel slug comes from config/stream.local.json (kickChat.channelSlug)
 * when present, else the public default. No secrets are read or logged
 * here — the stream key is never touched by this service.
 *
 * Usage:  node scripts/chat-service.js [port]     (default 8381)
 */
'use strict';
/* Node's fetch/websocket only honour the egress proxy when asked; set it
 * before anything in this process makes a request. */
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1';

const http = require('http');
const fs = require('fs');
const path = require('path');
const Chat = require('../js/chat.js');

function defaultChannel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'config', 'stream.local.json'), 'utf8'));
    if (cfg && cfg.kickChat && cfg.kickChat.channelSlug) return cfg.kickChat.channelSlug;
    if (cfg && cfg.channel) return cfg.channel;
  } catch (e) { /* no local config — fall through to the public default */ }
  return 't4tiger';
}

function createChatService(opts) {
  opts = opts || {};
  const channel = opts.channel || defaultChannel();
  const port = (opts.port !== undefined) ? opts.port : 8381;
  const makeAdapter = opts.adapterFactory ||
    (() => new Chat.KickChatAdapter({ channel }));

  const state = {
    connected: false, chatroomId: null, received: 0,
    lastMessageAt: null, lastError: null, channel
  };
  const clients = new Set();
  const recent = []; // small ring, diagnostics only (not replayed to the scene)

  function statusPayload() {
    return {
      connected: state.connected, chatroomId: state.chatroomId,
      received: state.received, lastMessageAt: state.lastMessageAt,
      lastError: state.lastError, channel: state.channel
    };
  }
  function broadcast(event, data) {
    const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of clients) { try { res.write(frame); } catch (e) { /* dropped below */ } }
  }
  function syncFromAdapter() {
    state.connected = !!(adapter && adapter.connected);
    if (adapter && adapter.chatroomId) state.chatroomId = adapter.chatroomId;
    broadcast('status', statusPayload());
  }

  const adapter = makeAdapter();
  adapter.connect({
    onMessage(msg) {
      state.received++;
      state.lastMessageAt = msg.ts || Date.now();
      recent.push(msg);
      if (recent.length > 50) recent.shift();
      broadcast('message', msg);
    },
    onOpen() { syncFromAdapter(); },
    onClose() { syncFromAdapter(); },
    onError(err) {
      state.lastError = String((err && err.message) || err).slice(0, 200);
      syncFromAdapter();
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) { /* dropped on close */ } }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'GET') {
      // Read-only by design: nothing here can post to Kick chat, ever.
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'read-only bridge: GET /health and GET /events only' }));
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(Object.assign({ ok: true }, statusPayload())));
    }
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('event: status\ndata: ' + JSON.stringify(statusPayload()) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404); res.end();
  });

  return {
    server, adapter, state,
    listen(cb) { server.listen(port, '127.0.0.1', cb); },
    close() {
      clearInterval(heartbeat);
      try { adapter.disconnect(); } catch (e) { /* already down */ }
      for (const res of clients) { try { res.end(); } catch (e) { /* ignore */ } }
      clients.clear();
      server.close();
    }
  };
}

if (require.main === module) {
  const port = parseInt(process.argv[2], 10) || 8381;
  const svc = createChatService({ port });
  svc.listen(() => {
    console.log(new Date().toISOString() +
      ' hubie chat bridge on http://127.0.0.1:' + port +
      ' (channel ' + svc.state.channel + ', read-only)');
  });
  setInterval(() => { // connection evidence in the log, once a minute
    console.log(new Date().toISOString() + ' chat: connected=' + svc.state.connected +
      ' chatroom=' + svc.state.chatroomId + ' received=' + svc.state.received +
      (svc.state.lastError ? ' lastError=' + svc.state.lastError : ''));
  }, 60000);
  const stop = () => { svc.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createChatService };
