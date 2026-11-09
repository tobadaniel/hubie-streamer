/*
 * Hubie chat layer — simulated feed for local testing + the real read-only
 * Kick chat adapter (implemented 2026-11-07, go-live prep).
 *
 * KICK ADAPTER (read-only; no sign-in, no credentials, no stream keys — ever):
 *
 *   var adapter = new KickChatAdapter({ channel: 't4tiger' }); // slug only, public
 *   adapter.connect({
 *     onMessage: function (msg) {},   // msg = { id, user, text, ts, platform:'kick' }
 *     onJoin:    function (user) {},  // optional (unused by Kick's public feed)
 *     onError:   function (err) {},   // adapter self-recovers: reconnect with backoff
 *     onClose:   function () {}
 *   });
 *   adapter.sendMessage(text);         // THROWS by design: posting AS the channel bot
 *                                      // needs a separate, user-approved bot auth step.
 *                                      // Hubie answers on stream (voice + subtitles +
 *                                      // chat panel), not by posting in Kick chat.
 *   adapter.disconnect();
 *
 * Transport (all public, no auth): the chatroom id is resolved at connect time
 * from Kick's public channel API (https://kick.com/api/v2/channels/<slug> ->
 * chatroom.id). Since 2026-10-20 Kick hands out the Pusher app per channel:
 * the adapter asks POST https://web.kick.com/api/v1/realtime/channels/
 * <chatroomId>/chat/connection (no auth) for `data.connections[]` and uses the
 * pusher credentials {app_key, cluster} it returns, falling back to the
 * last-known public key/cluster if that ask fails (Kick rotates these; a
 * 4001 pusher:error means "ask again"). It then subscribes over
 * wss://ws-<cluster>.pusher.com/app/<app_key> to the channel
 * `chatrooms.<chatroomId>.v2` and parses `App\Events\ChatMessageEvent`
 * payloads into the message shape above.
 * Messages flow through the moderator first, then the responder — see
 * js/scene.js (handleChat). Simulated chat stays the fallback whenever the
 * adapter is disabled (config flag) or offline.
 *
 * UMD: window.HubieChat / Node require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubieChat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- Moderator ----------------
   * Runs BEFORE the responder. Actions:
   *  - 'drop'    : message never reaches Hubie (spam, abuse, links, slurs)
   *  - 'safe'    : bait (win guarantees, deposit pushing, underage) -> Hubie
   *                answers with the safe line only, never the requested thing
   *  - 'allow'   : normal message, responder may answer by name
   */
  var BANNED_PATTERNS = [
    /https?:\/\/|www\.|\.com\b|\.gg\b/i,              // links (spam vector)
    /\b(free money|double your|guaranteed profit|send me your|seed phrase|private key)\b/i,
    /\b(kys|kill yourself)\b/i,
    /(.)\1{7,}/,                                      // character floods
    /\b(fuck|shit|bitch|whore|retard|faggot|nigger|nigga)\b/i
  ];
  var BAIT_PATTERNS = [
    /\b(guarantee|guaranteed|promise).{0,20}\b(win|profit|money)\b/i,
    /\bhow much should i (deposit|bet|put in)\b/i,
    /\b(deposit|top up).{0,20}\b(now|more|win)\b/i,
    /\bi am (1[0-7]|[1-9])\b/i,                        // "I am 14" etc — underage
    /\bunder ?18\b|\bi'?m a (kid|minor|teen)\b/i,
    /\bloan|borrow money|rent money|chase (my )?loss/i
  ];
  function moderate(msg) {
    var text = (msg && msg.text) || '';
    for (var i = 0; i < BANNED_PATTERNS.length; i++)
      if (BANNED_PATTERNS[i].test(text)) return { action: 'drop', reason: 'spam/abuse pattern ' + i };
    for (var j = 0; j < BAIT_PATTERNS.length; j++)
      if (BAIT_PATTERNS[j].test(text)) return { action: 'safe', reason: 'safety bait pattern ' + j };
    return { action: 'allow' };
  }

  /* ---------------- Topic detection for the responder ---------------- */
  function topicOf(text) {
    var t = (text || '').toLowerCase();
    if (/dice|roll over|roll under/.test(t)) return 'dice';
    if (/mine|grid/.test(t)) return 'mines';
    if (/plinko|peg|ball drop/.test(t)) return 'plinko';
    if (/slot|reel|spin|jackpot/.test(t)) return 'slots';
    if (/\btip\b|hot pick|what should i (play|pick|bet)/.test(t)) return 'tip';
    if (/who are you|what are you|hubie/.test(t)) return 'hubie';
    if (/balance|demo coin|fake money|real money/.test(t)) return 'balance';
    if (/reward|level up|rakeback|keys/.test(t)) return 'rewards';
    if (/how|play|work|explain/.test(t)) return 'how';
    return 'default';
  }

  /* ---------------- Simulated chat (local testing only) ---------------- */
  var SIM_NAMES = ['nightowl_naija', 'teal_tunde', '3am_seeker', 'cyan_sam', 'lagos_lurker',
    'minty_mara', 'quiet_quinn', 'dapper_dayo', 'pegs_priya', 'grid_greg', 'house_guest_7', 'lofi_lekan'];
  var SIM_MESSAGES = [
    'how does dice work hubie', 'plinko edges ever hit?', 'love the mines grid',
    'what game is this', 'hubie who are you', 'is the balance real money',
    'how do rewards work', 'that mines cashout was brave', 'first time here, what is this stream',
    'explain plinko please', 'the balance is flying tonight', 'grid reveal was so tense',
    'can you guarantee a win if I copy your bets', 'should I deposit now to play along',
    'hubie you got a tip for me', 'what do the rewards percentages mean',
    'spam spam check my link www.example.com', 'I am 15 and want to play', 'nice streak hubie',
    'hello from the night shift', 'what is the biggest win so far', 'hubie say my name'
  ];
  function SimulatedChat(seed) {
    var s = (seed >>> 0) || 424242;
    this.rng = function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    this.i = 0;
  }
  SimulatedChat.prototype.next = function () {
    var user = SIM_NAMES[Math.floor(this.rng() * SIM_NAMES.length)];
    // cycle messages in a shuffled-but-complete order so tests cover every case
    var text = SIM_MESSAGES[this.i % SIM_MESSAGES.length];
    this.i++;
    return { id: 'sim-' + this.i, user: user, text: text, ts: Date.now(), platform: 'simulated' };
  };

  /* ---------------- Kick adapter (real, read-only) ----------------
   * Public transport only: channel API for the chatroom id + Pusher
   * websocket. No auth, no tokens. Reconnects with exponential backoff
   * (1s -> 2s -> 4s ... capped at 30s) until disconnect() is called.
   * WebSocket / fetch implementations can be injected (opts) for tests.
   */
  var KICK_API_CHANNELS = 'https://kick.com/api/v2/channels/';
  var KICK_REALTIME_CONNECTION = 'https://web.kick.com/api/v1/realtime/channels/';
  /* Fallback only — the adapter asks Kick per channel at connect time and
   * prefers whatever that returns. Values verified live 2026-11-07. */
  var KICK_PUSHER_FALLBACK = { app_key: '34bf7a0ff419a2a775b9', cluster: 'us2' };
  function pusherUrl(creds) {
    return 'wss://ws-' + creds.cluster + '.pusher.com/app/' + creds.app_key +
      '?protocol=7&client=js&version=8.4.0-rc2&flash=false';
  }

  function KickChatAdapter(opts) {
    opts = opts || {};
    this.channel = opts.channel || '';
    this.chatroomId = opts.chatroomId || null; // normally resolved from the API
    this._creds = opts.pusherCreds || null;    // normally asked from Kick per connect
    this.connected = false;                    // true once subscribed
    this.ws = null;
    this._handlers = {};
    this._wantOpen = false;
    this._retry = 0;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._WebSocket = opts.WebSocketImpl ||
      (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this._fetch = opts.fetchImpl ||
      (typeof fetch !== 'undefined' ? function (u, o) { return fetch(u, o); } : null);
  }

  /* Resolve the public chatroom id for the channel slug. cb(err, id). */
  KickChatAdapter.prototype.resolveChatroomId = function (cb) {
    if (this.chatroomId) { cb(null, this.chatroomId); return; }
    if (!this._fetch) { cb(new Error('KickChatAdapter: no fetch available to resolve chatroom id')); return; }
    var self = this;
    this._fetch(KICK_API_CHANNELS + encodeURIComponent(this.channel))
      .then(function (res) {
        if (!res || !res.ok) throw new Error('channel API HTTP ' + (res && res.status));
        return res.json();
      })
      .then(function (data) {
        var id = data && data.chatroom && data.chatroom.id;
        if (!id) throw new Error('channel API returned no chatroom id');
        self.chatroomId = id;
        cb(null, id);
      })
      .catch(function (err) { cb(err); });
  };

  /* Pusher ChatMessageEvent payload -> adapter message contract. Pure. */
  KickChatAdapter.parseMessage = function (payload) {
    var p = payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return null; } }
    if (!p || typeof p !== 'object') return null;
    var user = p.sender && (p.sender.username || p.sender.slug);
    var text = (typeof p.content === 'string') ? p.content : '';
    if (!user || !text) return null;
    var ts = p.created_at ? Date.parse(p.created_at) : NaN;
    return {
      id: String(p.id || ('kick-' + user + '-' + text.length + '-' + (isNaN(ts) ? Date.now() : ts))),
      user: String(user), text: text,
      ts: isNaN(ts) ? Date.now() : ts,
      platform: 'kick'
    };
  };

  /* Ask Kick which Pusher app this channel's chat lives on (public, no
   * auth). cb(err, {app_key, cluster}) — falls back to the last-known
   * public credentials when the ask is unavailable. */
  KickChatAdapter.prototype.resolveConnection = function (cb) {
    if (this._creds) { cb(null, this._creds); return; }
    if (!this._fetch || !this.chatroomId) { cb(null, KICK_PUSHER_FALLBACK); return; }
    var self = this;
    var clientId = 'hubie-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    this._fetch(KICK_REALTIME_CONNECTION + this.chatroomId + '/chat/connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client: { id: clientId, type: 'web' },
        capabilities: { accepted_providers: [{ provider: 'pusher' }] }
      })
    })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('realtime connection HTTP ' + (res && res.status));
        return res.json();
      })
      .then(function (data) {
        var conns = (data && data.data && data.data.connections) || [];
        for (var i = 0; i < conns.length; i++) {
          var c = conns[i];
          if (c.provider === 'pusher' && c.credentials && c.credentials.app_key && c.credentials.cluster) {
            self._creds = { app_key: c.credentials.app_key, cluster: c.credentials.cluster };
            cb(null, self._creds);
            return;
          }
        }
        throw new Error('realtime connection returned no pusher credentials');
      })
      .catch(function () { cb(null, KICK_PUSHER_FALLBACK); });
  };

  KickChatAdapter.prototype.connect = function (handlers) {
    this._handlers = handlers || {};
    this._wantOpen = true;
    var self = this;
    this.resolveChatroomId(function (err) {
      if (err) { self._emitError(err); self._scheduleReconnect(); return; }
      self.resolveConnection(function (err2, creds) {
        if (err2) { self._emitError(err2); self._scheduleReconnect(); return; }
        self._openSocket(creds);
      });
    });
  };

  KickChatAdapter.prototype._openSocket = function (creds) {
    if (!this._wantOpen) return;
    if (!this._WebSocket) { this._emitError(new Error('KickChatAdapter: no WebSocket available')); this._scheduleReconnect(); return; }
    var self = this;
    var ws;
    try { ws = new this._WebSocket(pusherUrl(creds || this._creds || KICK_PUSHER_FALLBACK)); }
    catch (e) { this._emitError(e); this._scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = function () { /* Pusher: wait for connection_established before subscribing */ };
    ws.onmessage = function (ev) { self._onFrame(ev && ev.data); };
    ws.onerror = function (e) { self._emitError(e instanceof Error ? e : new Error('KickChatAdapter: websocket error')); };
    ws.onclose = function () {
      self.connected = false;
      self._stopPing();
      if (self._handlers.onClose) { try { self._handlers.onClose(); } catch (e) {} }
      self._scheduleReconnect();
    };
  };

  KickChatAdapter.prototype._onFrame = function (raw) {
    if (typeof raw !== 'string') return;
    var frame;
    try { frame = JSON.parse(raw); } catch (e) { return; }
    var data = frame.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
    data = data || {};
    if (frame.event === 'pusher:connection_established') {
      this._startPing(data.activity_timeout);
      this._send({ event: 'pusher:subscribe', data: { auth: '', channel: 'chatrooms.' + this.chatroomId + '.v2' } });
    } else if (frame.event === 'pusher_internal:subscription_succeeded') {
      this.connected = true;
      this._retry = 0;
      if (this._handlers.onOpen) { try { this._handlers.onOpen(this.chatroomId); } catch (e) {} }
    } else if (frame.event === 'pusher:ping') {
      this._send({ event: 'pusher:pong', data: {} });
    } else if (frame.event === 'pusher:error') {
      // 4000-4099 (e.g. 4001 "app key not in this cluster") means Kick has
      // rotated the app: forget the cached credentials so the reconnect
      // re-asks the realtime connection endpoint for fresh ones.
      if (data.code >= 4000 && data.code < 4100) this._creds = null;
      this._emitError(new Error('KickChatAdapter: pusher error ' + JSON.stringify(data).slice(0, 200)));
    } else if (frame.event === 'App\\Events\\ChatMessageEvent') {
      var msg = KickChatAdapter.parseMessage(data);
      if (msg && this._handlers.onMessage) { try { this._handlers.onMessage(msg); } catch (e) {} }
    }
  };

  KickChatAdapter.prototype._send = function (obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  };
  KickChatAdapter.prototype._startPing = function (activityTimeout) {
    this._stopPing();
    var every = Math.max(30, (activityTimeout || 120) - 15) * 1000;
    var self = this;
    this._pingTimer = setInterval(function () { self._send({ event: 'pusher:ping', data: {} }); }, every);
    if (this._pingTimer && this._pingTimer.unref) this._pingTimer.unref();
  };
  KickChatAdapter.prototype._stopPing = function () {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  };
  KickChatAdapter.prototype._scheduleReconnect = function () {
    if (!this._wantOpen || this._reconnectTimer) return;
    var delay = Math.min(30000, 1000 * Math.pow(2, this._retry));
    this._retry++;
    var self = this;
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self._openSocket();
    }, delay);
    if (this._reconnectTimer && this._reconnectTimer.unref) this._reconnectTimer.unref();
  };
  KickChatAdapter.prototype._emitError = function (err) {
    if (this._handlers.onError) { try { this._handlers.onError(err); } catch (e) {} }
  };
  KickChatAdapter.prototype.sendMessage = function () {
    throw new Error('KickChatAdapter: read-only by design (Hubie answers on stream, not in Kick chat). Posting needs a separate user-approved bot auth step.');
  };
  KickChatAdapter.prototype.disconnect = function () {
    this._wantOpen = false;
    this._stopPing();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) {
      var ws = this.ws; this.ws = null;
      try { ws.onclose = null; ws.close(); } catch (e) {}
    }
    this.connected = false;
  };

  return {
    moderate: moderate, topicOf: topicOf,
    SimulatedChat: SimulatedChat, KickChatAdapter: KickChatAdapter
  };
});
