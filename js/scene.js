/*
 * Hubie stream scene orchestration (browser only).
 * Auto-plays rounds forever with no human input, rotates games via the
 * Session engine, speaks + subtitles every commentary line, runs the chat
 * loop, and fires the sparse mid-stream reminder on the engine's cadence.
 *
 * Chat source (config flag pattern, see config/stream.example.json):
 * simulated chat runs by default and as the always-on fallback. If a config
 * enables Kick chat (kickChat.enabled: true — the tracked example file keeps
 * it false; the untracked config/stream.local.json created at go-live turns
 * it on), the read-only Kick adapter connects to the channel's public
 * chatroom and its messages take over the same handleChat flow the moment
 * the subscription succeeds. If the adapter errors or drops, simulated chat
 * simply carries on — the show never depends on the socket.
 *
 * Voice: browser speech synthesis behind an explicit setup click (browsers
 * block audio before a user gesture). That click is a SETUP step, done before
 * going live — once live, nobody touches anything.
 *
 * Voice bridge (2026-11-07): headless Chrome on this VM has ZERO
 * speechSynthesis voices, so browser TTS can never make sound here. When the
 * local config sets voice.bridgeUrl, commentary lines are POSTed to the
 * local voice service (scripts/voice-service.js), which speaks them with a
 * local TTS engine into the audio sink the stream captures.
 *
 * COUPLED SYNC (v1.4, 2026-11-08): posting lines was not enough — the
 * engine generated ~439 lines in 13 minutes of the judged run, the voice
 * spoke 190 and dropped 249, and because this scene used to set the
 * subtitle the instant a line was generated, screen and voice said
 * different things until the user ended the run. Now ALL commentary goes
 * through the speech director (js/speech-director.js):
 *   - lines are submitted as lazy intents; the director holds at most
 *     one pending intent behind the speaking line and only generates a
 *     line when a speech slot opens (backpressure — generation is paced
 *     to speech; results outrank anticipation outranks sizing outranks
 *     filler);
 *   - the scene subscribes to the voice service's /events stream and
 *     renders a subtitle ONLY when speech-started arrives for that line
 *     id, clearing it on speech-ended — the voice service is the single
 *     source of truth for what is on screen, so displayed == spoken;
 *   - if the bridge or its event stream is unavailable (demo bundle,
 *     file://, service down) the director runs in local mode: subtitles
 *     show at generation time as before, so the show always carries on.
 * The show itself starts only after the config has settled and (in bridge
 * mode) the event stream is up — or a fallback timeout passes — so the
 * very first line already runs under the coupling.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var session = new HubieGames.Session((Date.now() % 100000) + 7, 100000); // streamer roll: starts at 100k
  session.gameBlockSize = 5; // rounds per game before rotating segments
  var voice = new HubieCommentary.Engine((Date.now() % 90000) + 11);
  var simChat = new HubieChat.SimulatedChat(20261106);
  var startedAt = Date.now();
  var voiceOn = false;
  var voiceBridgeUrl = '';
  var seenUsers = {};
  var lastGame = session.currentGame;

  /* ---------- Hubie face states ---------- */
  var hubie = $('hubieSvg');
  function setHubie(state) {
    hubie.setAttribute('class', 'hubie hubie--' + state);
  }
  setInterval(function () { // blink
    var prev = hubie.getAttribute('class');
    hubie.setAttribute('class', prev + ' hubie--blink');
    setTimeout(function () { hubie.setAttribute('class', prev); }, 160);
  }, 3400);

  /* Mascot reactions (2026-11-07): one-shot figure animations fired from
   * round results — win bounce, big-win celebration, near-miss lean-in.
   * Losses use the spoken line's 'down' mood (body droop). The class is removed
   * on a timer so the figure settles back to the idle loop; a fresh
   * reaction restarts cleanly (reflow re-trigger). */
  var reactTimer = null;
  function react(kind) {
    var fig = $('hubieFigure');
    if (!fig || !kind) return;
    var cls = 'react-' + kind;
    var ms = kind === 'bigwin' ? 2600 : kind === 'win' ? 1750 : 1400;
    fig.classList.remove('react-win', 'react-bigwin', 'react-nearmiss');
    void fig.offsetWidth; // restart the animation
    fig.classList.add(cls);
    if (reactTimer) clearTimeout(reactTimer);
    reactTimer = setTimeout(function () { fig.classList.remove(cls); }, ms);
  }

  /* ---------- Speaking (coupled, v1.4) ----------
   * All commentary goes through the speech director (js/speech-director.js).
   * The director owns pacing (at most one pending intent behind the
   * speaking line; an intent's line is generated only when a speech slot
   * opens) and, in coupled mode, the subtitle itself: rendered on the
   * voice service's speech-started event for that line id, cleared on
   * speech-ended. Before the config resolves — and in local mode
   * generally (demo bundle, service down) — the director displays at
   * generation time instead, as this scene always did.
   * ?synclog=1 in the page URL turns on HUBIE-SYNC console lines (the
   * off-air proof harness reads them from the Chrome log to prove the
   * scene displayed exactly the lines the service started). */
  var syncLog = /[?&]synclog=1/.test(location.search || '');
  function directorPost(line) {
    if (!voiceBridgeUrl || typeof fetch !== 'function') return;
    try {
      fetch(voiceBridgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: line.id, text: line.text, pace: line.pace }),
        keepalive: true
      }).catch(function () { /* voice service down: subtitles carry it */ });
    } catch (e) { /* same */ }
  }
  var director = new HubieSpeech.Director({
    post: directorPost,
    onDisplay: function (evt) {
      $('subtitle').textContent = evt.text;
      setHubie(evt.mood || 'talking');
      if (syncLog) console.log('HUBIE-SYNC display id=' + evt.id + ' kind=' + (evt.kind || '') + (evt.lagMs != null ? ' lagMs=' + evt.lagMs : '') + ' ts=' + Date.now() + ' text=' + JSON.stringify(evt.text));
      postTelemetry();
    },
    onClear: function (evt) {
      $('subtitle').textContent = '';
      setHubie('idle');
      if (syncLog) console.log('HUBIE-SYNC clear id=' + evt.id + ' ts=' + Date.now());
    }
  });
  window.__hubieDirector = director;
  window.__hubieSyncStats = function () { return director.stats(); };

  /* Submit a commentary intent: { kind, mood, make, ttlMs }. make() runs
   * only when the line is actually generated — engine draws happen at
   * speech time, so figure lines carry their moment's freshest state. */
  function speak(kind, mood, make, opts) {
    opts = opts || {};
    director.submit({ kind: kind, mood: mood, ttlMs: opts.ttlMs, make: make });
  }

  /* The setup button is a pre-show human action, not commentary: it
   * keeps the old direct behaviour (subtitle now, browser TTS when the
   * operator enabled it, fire-and-forget bridge post). */
  function saySetup(text) {
    $('subtitle').textContent = text;
    setHubie('talking');
    if (voiceBridgeUrl && typeof fetch === 'function') {
      try {
        fetch(voiceBridgeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text, pace: 'normal' }),
          keepalive: true
        }).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }
    if (voiceOn && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(text);
        u.rate = 1.04;
        u.pitch = 1.05;
        u.onend = function () { setHubie('idle'); };
        window.speechSynthesis.speak(u);
      } catch (e) { /* subtitles carry the show if TTS fails */ }
    }
  }
  $('voiceBtn').addEventListener('click', function () {
    voiceOn = true;
    this.textContent = 'Voice on';
    saySetup('voice on. hubie live. let us play.');
  });

  /* ---------- Chat panel ---------- */
  function chatLine(user, text, cls) {
    var feed = $('chatFeed');
    var div = document.createElement('div');
    if (cls) div.className = cls;
    var u = document.createElement('span'); u.className = 'u'; u.textContent = user + ': ';
    div.appendChild(u);
    div.appendChild(document.createTextNode(text));
    feed.appendChild(div);
    while (feed.children.length > 9) feed.removeChild(feed.firstChild);
  }
  function handleChat(msg) {
    var verdict = HubieChat.moderate(msg);
    if (verdict.action === 'drop') {
      chatLine('HubieMod', 'a message was removed (' + verdict.reason.split(' ')[0] + ') — keep chat friendly.', 'modded');
      return;
    }
    chatLine(msg.user, msg.text);
    if (verdict.action === 'safe') {
      speak('chat', 'idle', function () { return voice.safeReply(); }, { ttlMs: 25000 });
      return;
    }
    if (!seenUsers[msg.user]) {
      seenUsers[msg.user] = true;
      speak('chat', undefined, function () { return voice.welcome(msg.user); }, { ttlMs: 25000 });
      return;
    }
    // Answer roughly half of ordinary messages, by name — Hubie is mid-game too.
    if (Math.random() < 0.55) {
      var answerName = msg.user, answerTopic = HubieChat.topicOf(msg.text);
      speak('chat', undefined, function () { return voice.chatAnswer(answerName, answerTopic); }, { ttlMs: 25000 });
    }
  }
  /* Chat source: simulated by default/fallback; live Kick when the config
   * flag enables it. Config = tracked defaults (config/stream.example.json)
   * merged with the untracked local override (config/stream.local.json).
   *
   * Preferred live route (2026-11-07): the local chat BRIDGE
   * (scripts/chat-service.js, kickChat.bridgeUrl in the local config).
   * The in-browser adapter can never connect on this VM — Chrome gets
   * --proxy-server with embedded credentials in the URL and rejects ALL
   * proxied requests with ERR_NO_SUPPORTED_PROXIES (CDP-verified) — so
   * the adapter runs in Node inside the bridge and the scene consumes
   * its Server-Sent Events on localhost. The scene stands the simulated
   * feed down while the bridge reports connected, and back up when it
   * reports disconnected or the event stream drops. If no bridgeUrl is
   * configured, the legacy in-browser adapter path is used instead. */
  var simTimer = null;
  var liveChatUp = false;
  function startSimulatedChat() {
    if (!simTimer) simTimer = setInterval(function () { handleChat(simChat.next()); }, 11000);
  }
  function stopSimulatedChat() { if (simTimer) { clearInterval(simTimer); simTimer = null; } }
  function setLiveChat(up) {
    liveChatUp = up;
    window.__hubieChatMode = up ? 'live' : 'simulated';
    var title = $('chatTitle');
    if (title) title.textContent = up
      ? 'CHAT — LIVE from Kick · Hubie answers by name'
      : 'CHAT — Hubie reads and answers by name';
    if (up) stopSimulatedChat(); else startSimulatedChat();
  }
  startSimulatedChat(); // fallback feed runs until a live source takes over
  window.__hubieChatMode = 'simulated';
  function loadJson(url) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  /* ---------- Voice events + show start (coupled sync) ----------
   * The director couples to the voice service over its /events SSE
   * stream (speech-started / speech-ended / speech-dropped / sync).
   * The show starts once the config has settled AND the coupling is up;
   * if the event stream never connects (service down, demo bundle), a
   * fallback timer starts the show in local mode instead — subtitles at
   * generation time, the show carries on. */
  var voiceBridgeBase = '';
  var configSettledFlag = false;
  var voiceEventsUp = false;
  var startForced = false;
  var showStarted = false;
  function postTelemetry() {
    if (!voiceBridgeBase || typeof fetch !== 'function') return;
    try {
      fetch(voiceBridgeBase + '/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(director.stats()),
        keepalive: true
      }).catch(function () { /* service down: nothing to report to */ });
    } catch (e) { /* same */ }
  }
  setInterval(postTelemetry, 5000);
  function connectVoiceEvents() {
    if (typeof EventSource === 'undefined') return;
    var es = new EventSource(voiceBridgeBase + '/events');
    ['speech-started', 'speech-ended', 'speech-dropped'].forEach(function (type) {
      es.addEventListener(type, function (ev) {
        var d = null;
        try { d = JSON.parse(ev.data); } catch (e) { /* ignore */ }
        if (d && d.id) director.handleEvent({ type: type, id: d.id, text: d.text, ts: d.ts });
      });
    });
    es.addEventListener('sync', function (ev) {
      var d = null;
      try { d = JSON.parse(ev.data); } catch (e) { /* ignore */ }
      if (d) director.reconcile(d);
      if (!voiceEventsUp) {
        voiceEventsUp = true;
        director.setMode('coupled');
        maybeStartShow();
      }
    });
    es.onerror = function () { /* EventSource retries on its own; sync reconciles on return */ };
  }
  function configSettled() {
    if (configSettledFlag) return;
    configSettledFlag = true;
    // Fallback: with no coupling inside ~5s, start in local mode anyway.
    setTimeout(function () { startForced = true; maybeStartShow(); }, 5000);
    maybeStartShow();
  }
  function maybeStartShow() {
    if (showStarted || !configSettledFlag) return;
    if (voiceBridgeBase && !voiceEventsUp && !startForced) return; // bridge configured: wait for the coupling
    showStarted = true;
    startShow();
  }
  setTimeout(configSettled, 6000); // config fetch hung: start anyway (local mode)

  Promise.all([loadJson('config/stream.example.json'), loadJson('config/stream.local.json')])
    .then(function (cfgs) {
      var cfg = cfgs[0] || {}, local = cfgs[1] || {};
      var kick = local.kickChat || cfg.kickChat || {};
      var voiceCfg = local.voice || cfg.voice || {};
      if (voiceCfg.bridgeUrl) {
        voiceBridgeUrl = voiceCfg.bridgeUrl;
        voiceBridgeBase = voiceBridgeUrl.replace(/\/say\/?$/, '');
        connectVoiceEvents();
      }
      if (local.channel) cfg.channel = local.channel;
      configSettled();
      if (!kick.enabled) return; // simulated chat only (default)
      if (kick.bridgeUrl && typeof EventSource !== 'undefined') {
        var es = new EventSource(kick.bridgeUrl);
        var dropTimer = null;
        es.addEventListener('status', function (ev) {
          var d = null;
          try { d = JSON.parse(ev.data); } catch (e) { /* ignore */ }
          if (!d) return;
          if (d.connected) {
            if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
            setLiveChat(true);
          } else {
            setLiveChat(false);
          }
        });
        es.addEventListener('message', function (ev) {
          var msg = null;
          try { msg = JSON.parse(ev.data); } catch (e) { /* ignore */ }
          if (msg && msg.user && msg.text) handleChat(msg); // moderator -> responder
        });
        es.onerror = function () {
          // EventSource retries on its own; if no connected status lands
          // within the grace window, the simulated feed takes back over.
          if (dropTimer) clearTimeout(dropTimer);
          dropTimer = setTimeout(function () { setLiveChat(false); }, 15000);
        };
        return; // bridge route only — never instantiate the in-browser adapter
      }
      var slug = kick.channelSlug || cfg.channel || 't4tiger';
      var adapter = new HubieChat.KickChatAdapter({ channel: slug });
      adapter.connect({
        onMessage: handleChat, // moderator -> responder, same as simulated
        onOpen: function () { setLiveChat(true); }, // live feed is flowing: sim stands down
        onError: function () { /* simulated chat keeps the show warm */ },
        onClose: function () { setLiveChat(false); } // adapter reconnects with backoff on its own
      });
    })
    .catch(function () { configSettled(); /* no config reachable (e.g. file://) — simulated chat, local voice mode */ });

  /* ---------- Game stage rendering ---------- */
  var stage = $('stageBody'), banner = $('resultBanner');
  function renderDice(r, done) {
    stage.innerHTML = '';
    var d = document.createElement('div'); d.className = 'dice-face rolling'; d.textContent = '· ·';
    stage.appendChild(d);
    var ticks = 0;
    var iv = setInterval(function () {
      d.textContent = (Math.random() * 99.99).toFixed(2);
      if (++ticks > 7) { clearInterval(iv); d.classList.remove('rolling'); d.textContent = r.roll.toFixed(2); done(); }
    }, 130);
  }
  function renderMines(r, done) {
    stage.innerHTML = '';
    var grid = document.createElement('div'); grid.className = 'mines-grid';
    var cells = [];
    for (var i = 0; i < 25; i++) { var c = document.createElement('div'); c.className = 'mine-cell'; c.textContent = '·'; grid.appendChild(c); cells.push(c); }
    stage.appendChild(grid);
    var idx = 0;
    var iv = setInterval(function () {
      if (idx >= r.steps.length) { clearInterval(iv); done(); return; }
      var step = r.steps[idx++];
      cells[step.tile].textContent = step.mine ? '💣' : '◆';
      cells[step.tile].className = 'mine-cell ' + (step.mine ? 'boom' : 'safe');
    }, 480);
  }
  function renderPlinko(r, done) {
    stage.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'plinko';
    var ball = document.createElement('div'); ball.className = 'plinko-ball';
    var slots = document.createElement('div'); slots.className = 'plinko-slots';
    HubieGames.PLINKO_SLOTS.forEach(function (m) {
      var s = document.createElement('div'); s.className = 'plinko-slot'; s.textContent = m + 'x'; slots.appendChild(s);
    });
    wrap.appendChild(ball); wrap.appendChild(slots); stage.appendChild(wrap);
    var pos = 0, row = 0;
    var iv = setInterval(function () {
      if (r.path[row] === 'R') pos++; row++;
      ball.style.transform = 'translate(' + ((pos - row / 2) * 44) + 'px,' + (row * 16) + 'px)';
      if (row >= r.path.length) {
        clearInterval(iv);
        slots.children[r.slot].classList.add('hot');
        done();
      }
    }, 220);
  }
  var SLOT_FACE = { Hubie: '🦥', Seven: '7️⃣', Gem: '💎', Star: '⭐', Dice: '🎲', Coin: '🪙', Cherry: '🍒' };
  function renderSlots(r, done) {
    stage.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'slots-row';
    var reels = [];
    for (var i = 0; i < 3; i++) {
      var box = document.createElement('div'); box.className = 'slot-reel spinning';
      var sym = document.createElement('div'); sym.className = 'sym'; sym.textContent = '·';
      var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = 'REEL ' + (i + 1);
      box.appendChild(sym); box.appendChild(nm); wrap.appendChild(box);
      reels.push({ box: box, sym: sym, nm: nm });
    }
    stage.appendChild(wrap);
    var names = HubieGames.SLOT_SYMBOLS;
    var iv = setInterval(function () {
      reels.forEach(function (rl, idx) {
        if (!rl.box.classList.contains('stopped')) {
          var s = names[Math.floor(Math.random() * names.length)];
          rl.sym.textContent = SLOT_FACE[s]; rl.nm.textContent = s.toUpperCase();
        }
      });
    }, 90);
    // staggered stops: reel 1, then 2, then 3 lands the final symbols
    [420, 700, 980].forEach(function (at, idx) {
      setTimeout(function () {
        var rl = reels[idx];
        rl.box.classList.remove('spinning'); rl.box.classList.add('stopped');
        rl.sym.textContent = SLOT_FACE[r.reels[idx]]; rl.nm.textContent = r.reels[idx].toUpperCase();
        if (idx === 2) { clearInterval(iv); setTimeout(done, 350); }
      }, at);
    });
  }
  var RENDER = { Dice: renderDice, Mines: renderMines, Plinko: renderPlinko, Slots: renderSlots };

  /* ---------- Round loop (runs forever, no human input) ---------- */
  function playNext() {
    var prevGame = lastGame;
    var r = session.playRound();
    if (r.reload) {
      // Bust + reload event (balance story): narrate it before anything
      // else this round, and surface the running totals in the HUD.
      // Result-class intent: it outranks everything but the sign-off.
      var reloadAmt = r.reload.amount;
      speak('result', 'down', function () { return voice.bustReload(reloadAmt); });
      var rl = $('reloads'); if (rl) rl.textContent = r.reload.count;
      var bi = $('boughtIn'); if (bi) bi.textContent = Math.round(r.reload.totalIn).toLocaleString('en-US');
    }
    if (r.game !== lastGame) {
      // The slot break gets its own intro; originals use the segment lines,
      // with the cold-streak switch narration when Hubie bails on a game.
      var segGame = r.game, segFrom = prevGame, segCold = r.streak <= -3;
      if (r.game === 'Slots') speak('segment', undefined, function () { return voice.slotIntro(); });
      else speak('segment', undefined, function () { return voice.segmentChange(segGame, { from: segFrom, cold: segCold }); });
      lastGame = r.game;
    }
    $('gameTitle').innerHTML = r.game === 'Slots'
      ? 'Casino Break — <span>Slots</span>'
      : 'House Originals — <span>' + r.game + '</span>';
    $('roundNo').textContent = r.round;
    banner.className = 'result-banner';
    banner.textContent = (r.reload ? 'RELOAD +' + Math.round(r.reload.amount).toLocaleString('en-US') + ' — ' : '') + 'Round ' + r.round + ' — ' + r.summary + '…';
    // Sizing intent: valid only while this round is still being played —
    // if the speech slot never opens in time it expires, and the round's
    // result intent (higher priority) replaces it in the pending slot.
    speak('sizing', undefined, function () { return voice.roundStart(r); }, { ttlMs: 9000 });
    var renderDone = false;
    // Anticipation beat: if the reveal is still running ~0.85s in, Hubie
    // calls for it like a streamer ("come on. come on.") — short line,
    // lands mid-action instead of after it. Only on ~2 of 3 rounds: the
    // streamer research is explicit that silence is a tool — dry rounds
    // breathe instead of being filled with talk.
    var anticTimer = setTimeout(function () {
      // Anticipation intent: it must land mid-reveal, so its TTL is the
      // reveal window — if the voice is still busy when the moment has
      // passed, the intent expires instead of narrating a finished spin.
      if (!renderDone && Math.random() < 0.65) speak('anticipation', 'excited', function () { return voice.anticipation(); }, { ttlMs: 1600 });
    }, 850);
    RENDER[r.game](r, function () {
      renderDone = true;
      clearTimeout(anticTimer);
      $('balance').textContent = Math.round(r.balanceAfter).toLocaleString('en-US');
      banner.textContent = r.win ? (r.bigWin ? 'BIG WIN — ' : 'WIN — ') + r.summary + ' · ' + (r.profit >= 0 ? '+' : '') + Math.round(r.profit).toLocaleString('en-US')
                                  : 'No win — ' + r.summary + ' · ' + Math.round(r.profit).toLocaleString('en-US');
      banner.className = 'result-banner ' + (r.bigWin ? 'big' : r.win ? 'win' : 'loss');
      speak('result', r.bigWin ? 'excited' : r.win ? 'talking' : r.nearMiss ? 'idle' : 'down', function () { return voice.roundResult(r); });
      react(r.bigWin ? 'bigwin' : r.win ? 'win' : r.nearMiss ? 'nearmiss' : null);
      setTimeout(playNext, 3400);
    });
  }

  /* ---------- Timers: uptime, safety, idle filler ---------- */
  setInterval(function () {
    var s = Math.floor((Date.now() - startedAt) / 1000);
    var hh = String(Math.floor(s / 3600)).padStart(2, '0'), mm = String(Math.floor(s / 60) % 60).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
    $('uptime').textContent = hh + ':' + mm + ':' + ss;
  }, 1000);
  /* Demo wording (user rule): the scrolling banner carries the disclaimer
   * on screen at all times, so the voice says it exactly three times —
   * the opening line below, ONE sparse mid-stream reminder (engine owns
   * the cadence: first due ~2.5h in, then no more often than ~2h), and
   * the closing sign-off. No periodic safety rotation any more. */

  /* Show start — called exactly once by maybeStartShow() when the
   * config has settled and (in bridge mode) the voice coupling is up,
   * or the local-mode fallback has fired. Starting here rather than at
   * script eval is what guarantees the opening line already runs under
   * the coupling: generated by the director, displayed on its
   * speech-started event. */
  function startShow() {
    // In coupled mode the static HTML greeting is a subtitle nobody is
    // speaking — clear it so the screen only ever shows spoken lines.
    if (director.mode === 'coupled') $('subtitle').textContent = '';
    speak('opening', undefined, function () { return voice.opening(); }); // spoken demo mention #1 of the run
    setTimeout(playNext, 2500);
    setInterval(function () {
      // markReminder runs inside the generator: the sparse cadence is
      // only consumed when the reminder is actually generated for a
      // speech slot — a reminder intent that loses the pending slot to
      // a result does not burn the run's one mention.
      if (voice.reminderDue()) {
        speak('reminder', undefined, function () { voice.markReminder(); return voice.reminder(); });
      }
    }, 60 * 1000);
    setInterval(function () { speak('rewards', undefined, function () { return voice.rewards(); }, { ttlMs: 30000 }); }, 8 * 60 * 1000);  // rewards one-liners (real 22.5% stack)
    setTimeout(function () { speak('rewards', undefined, function () { return voice.rewards(); }, { ttlMs: 30000 }); }, 150000);          // first one a few minutes in
  }

  /* Graceful stop hook: the stop procedure (or an operator) calls
   * window.__hubieClosing() or dispatches a 'hubie:closing' event, waits
   * a few seconds for the sign-off to be spoken, THEN tears the stack
   * down. The closing line is the run's third and final demo mention.
   * Its intent outranks even results, so the sign-off cannot lose the
   * pending slot to a late round. */
  var closingSaid = false;
  function gracefulClosing() {
    if (closingSaid) return; closingSaid = true;
    speak('closing', 'idle', function () { return voice.closing(); });
  }
  window.__hubieClosing = gracefulClosing;
  window.addEventListener('hubie:closing', gracefulClosing);
})();
