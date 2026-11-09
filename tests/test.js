#!/usr/bin/env node
/* Hubie logic tests — run: node tests/test.js
 * Covers: game engines, session rotation, the streamer balance story
 * (percentage staking, bust + narrated reload), moderator, chat topics,
 * the chat bridge, the voice service's sync discipline, and commentary.
 * Commentary v2 note: v1 demanded zero verbatim repeats over a simulated
 * hour; v2 lines are SHORT streamer bursts where hype repetition is the
 * design ("bang bang bang"), so the commentary test now checks the
 * new contract instead — every line short enough to speak in ~3s, no
 * back-to-back identical lines, figure-bearing lines effectively unique
 * (their numbers move), paces routed by event, and no safety violations. */
'use strict';
const assert = require('assert');
const Games = require('../js/games.js');
const Commentary = require('../js/commentary.js');
const Chat = require('../js/chat.js');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  PASS ' + name); }

console.log('games:');
ok('dice result shape and payout math', () => {
  const rng = Games.makeRng(42);
  for (let i = 0; i < 200; i++) {
    const r = Games.playDice(rng, 10000, { bet: 100 });
    assert(r.roll >= 0 && r.roll <= 99.99);
    assert.strictEqual(r.win, r.mode === 'over' ? r.roll > r.target : r.roll < r.target);
    if (r.win) assert(Math.abs(r.payout - Math.round(100 * r.multiplier * 100) / 100) < 0.02);
    else assert.strictEqual(r.payout, 0);
  }
});
ok('mines: mines count, steps valid, cashout math', () => {
  const rng = Games.makeRng(7);
  for (let i = 0; i < 200; i++) {
    const r = Games.playMines(rng, 10000, { bet: 50 });
    assert.strictEqual(r.mines.length, r.mineCount);
    assert.strictEqual(new Set(r.mines).size, r.mineCount);
    r.steps.forEach(s => assert(!r.mines.includes(s.tile) === !s.mine));
    if (r.hitMine) { assert.strictEqual(r.payout, 0); assert.strictEqual(r.steps[r.steps.length - 1].mine, true); }
    else assert(r.payout > 50);
  }
});
ok('plinko: path length, slot range, payout', () => {
  const rng = Games.makeRng(99);
  for (let i = 0; i < 200; i++) {
    const r = Games.playPlinko(rng, 10000, { bet: 50 });
    assert.strictEqual(r.path.length, 8);
    assert(r.slot >= 0 && r.slot <= 8);
    assert.strictEqual(r.multiplier, Games.PLINKO_SLOTS[r.slot]);
  }
});
ok('session: rotates games, balance stays sane, stats add up', () => {
  const s = new Games.Session(1234, 100000);
  const seen = new Set();
  const counts = {};
  for (let i = 0; i < 500; i++) { const r = s.playRound(); seen.add(r.game); counts[r.game] = (counts[r.game] || 0) + 1; assert(s.balance >= 0); assert.strictEqual(r.balanceAfter, s.balance); }
  // Originals are the main show; Slots appears only as the break segment.
  assert.deepStrictEqual([...seen].sort(), ['Dice', 'Mines', 'Plinko', 'Slots']);
  assert.strictEqual(counts.Slots, 85, 'blockSize 4: 24 original rounds + 5 spins per cycle');
  assert(counts.Dice + counts.Mines + counts.Plinko === 415, 'originals dominate the session');
  assert.strictEqual(s.wins + s.losses, 500);
  assert.strictEqual(s.round, 500);
});
ok('slots: paytable math, pair is a push, result shape', () => {
  const rng = Games.makeRng(2026);
  let three = 0, pairs = 0;
  for (let i = 0; i < 2000; i++) {
    const r = Games.playSlots(rng, 100000, { bet: 1000 });
    assert.strictEqual(r.game, 'Slots');
    assert.strictEqual(r.reels.length, 3);
    r.reels.forEach(s => assert(Games.SLOT_SYMBOLS.includes(s)));
    const isThree = r.reels[0] === r.reels[1] && r.reels[1] === r.reels[2];
    const isPair = !isThree && (r.reels[0] === r.reels[1] || r.reels[1] === r.reels[2] || r.reels[0] === r.reels[2]);
    if (isThree) { three++; assert.strictEqual(r.payout, 1000 * Games.SLOT_PAYTABLE[r.reels[0]]); assert.strictEqual(r.win, true); assert.strictEqual(r.multiplier, Games.SLOT_PAYTABLE[r.reels[0]]); }
    else if (isPair) { pairs++; assert.strictEqual(r.payout, 1000, 'pair returns the stake'); assert.strictEqual(r.profit, 0); assert.strictEqual(r.win, false); }
    else assert.strictEqual(r.payout, 0);
    if (r.bigWin) assert(r.multiplier >= 10);
    if (r.nearMiss) assert(!isThree && r.reels[0] === r.reels[1] && (r.reels[0] === 'Seven' || r.reels[0] === 'Hubie'), 'near miss = high pair on first reels, third missed');
  }
  assert(three > 20 && pairs > 400, 'both outcomes occur at sane rates: three=' + three + ' pairs=' + pairs);
});
ok('session: slot break lands after 2 full original rotations, then originals resume', () => {
  const s = new Games.Session(99, 100000);
  s.gameBlockSize = 5; // scene setting
  const order = [];
  for (let i = 0; i < 40; i++) order.push(s.playRound().game);
  const firstThirty = order.slice(0, 30);
  assert(firstThirty.every(g => g !== 'Slots'), 'no slots during the first 2 rotations');
  assert.deepStrictEqual([...new Set(firstThirty)].sort(), ['Dice', 'Mines', 'Plinko'], 'all three originals played');
  assert.deepStrictEqual(order.slice(30, 35), ['Slots', 'Slots', 'Slots', 'Slots', 'Slots'], 'exactly a 5-spin break');
  assert(order.slice(35).every(g => g !== 'Slots'), 'originals resume after the break');
});

ok('session: streamer balance story — % staking, bust and reload, no quiet refill', () => {
  const s = new Games.Session(4242); // default roll
  assert.strictEqual(s.balance, 100000, 'starts on a 100,000 demo roll');
  assert.strictEqual(s.totalBoughtIn, 100000);
  assert.strictEqual(s.reloads, 0);
  // Percentage bounds + accounting over 400 rounds: the balance may only
  // ever move by the round's profit, plus a tracked reload event.
  let prev = s.balance;
  for (let i = 0; i < 400; i++) {
    const r = s.playRound();
    const rollBefore = prev + (r.reload ? r.reload.amount : 0);
    assert(r.bet >= 500, 'bet floor ~500, got ' + r.bet);
    assert(r.bet <= rollBefore, 'never bets more than the roll');
    assert(r.bet <= Math.max(500, rollBefore * 0.11), 'top tier is the ~5% send (x2 press cap), got bet ' + r.bet + ' on ' + rollBefore);
    assert(Math.abs((r.balanceAfter - rollBefore) - r.profit) < 0.02, 'balance moves only by profit + tracked reloads');
    if (r.reload) {
      assert(r.reload.amount === 50000 || r.reload.amount === 100000, 'reload is 50k or 100k');
      assert.strictEqual(r.reload.count, s.reloads);
      assert.strictEqual(r.reload.totalIn, s.totalBoughtIn);
    }
    prev = s.balance;
  }
  // Forced bust: below 5,000 the next round opens with a narrated reload.
  const s2 = new Games.Session(11, 100000);
  s2.balance = 3000;
  const rb = s2.playRound();
  assert(rb.reload, 'bust triggers a reload event on the next round');
  assert.strictEqual(s2.reloads, 1);
  assert.strictEqual(s2.totalBoughtIn, 100000 + rb.reload.amount);
  assert(s2.balance > 5000, 'reload lands before the bet is placed');
});

console.log('chat / moderation:');
ok('moderator drops spam/abuse/links, safes the bait, allows the rest', () => {
  assert.strictEqual(Chat.moderate({ text: 'check www.example.com free money' }).action, 'drop');
  assert.strictEqual(Chat.moderate({ text: 'you are a bitch' }).action, 'drop');
  assert.strictEqual(Chat.moderate({ text: 'can you guarantee I will win?' }).action, 'safe');
  assert.strictEqual(Chat.moderate({ text: 'how much should I deposit to copy you' }).action, 'safe');
  assert.strictEqual(Chat.moderate({ text: 'I am 15, can I play' }).action, 'safe');
  assert.strictEqual(Chat.moderate({ text: 'how does dice work hubie' }).action, 'allow');
  assert.strictEqual(Chat.moderate({ text: 'nice streak tonight' }).action, 'allow');
});
ok('topic detection routes questions', () => {
  assert.strictEqual(Chat.topicOf('how does dice work'), 'dice');
  assert.strictEqual(Chat.topicOf('the mines grid is tense'), 'mines');
  assert.strictEqual(Chat.topicOf('plinko ball drop please'), 'plinko');
  assert.strictEqual(Chat.topicOf('is the balance real money'), 'balance');
  assert.strictEqual(Chat.topicOf('hello there'), 'default');
});
ok('simulated chat produces named messages incl. bait cases', () => {
  const sim = new Chat.SimulatedChat(5);
  const actions = new Set();
  for (let i = 0; i < 40; i++) { const m = sim.next(); assert(m.user && m.text); actions.add(Chat.moderate(m).action); }
  assert(actions.has('drop') && actions.has('safe') && actions.has('allow'));
});
ok('kick adapter: resolves chatroom, subscribes, parses messages, stays read-only', () => {
  // Fake Pusher socket: records frames, driven synchronously by the test.
  function FakeWS(url) { this.url = url; this.readyState = 1; this.sent = []; FakeWS.last = this; }
  FakeWS.prototype.send = function (s) { this.sent.push(JSON.parse(s)); };
  FakeWS.prototype.close = function () { this.readyState = 3; };
  const got = [];
  const adapter = new Chat.KickChatAdapter({
    channel: 't4tiger', chatroomId: 424242, WebSocketImpl: FakeWS,
    pusherCreds: { app_key: 'testkey', cluster: 'us2' },
    fetchImpl: () => Promise.reject(new Error('fetch must not be called when id+creds are preset'))
  });
  adapter.connect({ onMessage: m => got.push(m) });
  const ws = FakeWS.last;
  assert(ws.url.includes('ws-us2.pusher.com/app/'), 'pusher endpoint');
  ws.onmessage({ data: JSON.stringify({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.1', activity_timeout: 120 }) }) });
  const sub = ws.sent.find(f => f.event === 'pusher:subscribe');
  assert(sub && sub.data.channel === 'chatrooms.424242.v2', 'subscribes to the channel chatroom');
  ws.onmessage({ data: JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel: 'chatrooms.424242.v2', data: '{}' }) });
  assert.strictEqual(adapter.connected, true);
  ws.onmessage({ data: JSON.stringify({ event: 'App\\Events\\ChatMessageEvent', channel: 'chatrooms.424242.v2', data: JSON.stringify({ id: 987, content: 'hubie say my name', sender: { username: 'teal_tunde' }, created_at: '2026-11-07T19:00:00.000Z' }) }) });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].user, 'teal_tunde');
  assert.strictEqual(got[0].text, 'hubie say my name');
  assert.strictEqual(got[0].platform, 'kick');
  assert.strictEqual(Chat.moderate(got[0]).action, 'allow', 'parsed message flows through the moderator');
  assert.throws(() => adapter.sendMessage('hi'), /read-only/);
  adapter.disconnect();
  assert.strictEqual(adapter.connected, false);
});

console.log('commentary v2 — short bursts over a simulated hour:');
ok('600+ lines: all short, no back-to-back repeats, figures stay fresh, paces routed', () => {
  const s = new Games.Session(777);
  const eng = new Commentary.Engine(31337);
  const lines = [];       // every spoken text, in order
  const winLines = [];    // figure-bearing win callouts
  const names = ['teal_tunde', '3am_seeker', 'cyan_sam', 'minty_mara'];
  let lastGame = s.currentGame;
  const push = (spoken, isWin) => { lines.push(spoken.text); if (isWin) winLines.push(spoken.text); };
  for (let round = 0; round < 300; round++) {           // ~12s a round => ~1 hour
    const r = s.playRound();
    if (r.game !== lastGame) { push(eng.segmentChange(r.game, { from: lastGame, cold: r.streak <= -3 })); lastGame = r.game; }
    if (r.reload) push(eng.bustReload(r.reload.amount));
    push(eng.roundStart(r));
    if (round % 3 === 0) push(eng.anticipation());
    push(eng.roundResult(r), r.win);
    if (round % 31 === 0) push(eng.rewards());
    if (round % 17 === 0) push(eng.idle());
    if (round % 13 === 0) push(eng.welcome(names[round % names.length] + '_' + round));
    if (round % 11 === 0) push(eng.chatAnswer('viewer_' + round, Chat.topicOf('how does dice work')));
  }
  assert(lines.length >= 600, 'expected 600+ lines, got ' + lines.length);
  lines.forEach((t) => {
    assert(t.length <= 140, 'line too long to speak in ~3s (' + t.length + ' chars): ' + t);
    assert(!/\bguarantee|\bwill win\b|\bfuck\b|\bshit\b/i.test(t), 'safety violation in line: ' + t);
    assert(!/\bdemo\b/i.test(t), 'the demo word leaked into a regular line (it belongs only in opening/reminder/closing + the banner): ' + t);
  });
  // The sanctioned spoken demo moments (opening + sparse reminder), the
  // sparse cadence, and the closing: since 2026-11-08 the run's final
  // spoken line is the user's own sign-off, verbatim (it carries "gamble
  // responsibly" + the Housebets host line instead of a demo mention).
  assert(eng.opening().text.includes('demo play, no real money'), 'opening carries the start-of-run demo mention');
  assert(/\bdemo\b/i.test(eng.reminder().text), 'mid-stream reminder carries the sparse demo mention');
  assert.strictEqual(eng.closing().text, 'gamble responsibly. and if you\'re looking for where to gamble, hubie on housebets is always ready to host you.', 'closing is the user-directed sign-off (2026-11-08), verbatim');
  const eng2 = new Commentary.Engine(5);
  assert.strictEqual(eng2.reminderDue(eng2.startedAt + 60 * 1000), false, 'reminder is not due minutes into a run');
  assert.strictEqual(eng2.reminderDue(eng2.startedAt + 2.6 * 3600 * 1000), true, 'reminder is due around the run midpoint');
  eng2.markReminder(eng2.startedAt + 2.6 * 3600 * 1000);
  assert.strictEqual(eng2.reminderDue(eng2.startedAt + 3.6 * 3600 * 1000), false, 'reminder is not due again an hour later');
  assert.strictEqual(eng2.reminderDue(eng2.startedAt + 4.7 * 3600 * 1000), true, 'reminder is due again ~2h after the last one');
  for (let i = 1; i < lines.length; i++)
    assert(lines[i] !== lines[i - 1], 'same line twice in a row at ' + i + ': ' + lines[i]);
  const winUnique = new Set(winLines).size / Math.max(1, winLines.length);
  console.log('    lines: ' + lines.length + ', win callouts: ' + winLines.length + ' (' + Math.round(winUnique * 100) + '% unique)');
  assert(winUnique >= 0.75, 'figure-bearing win lines should stay effectively unique, got ' + winUnique);
  // Pace routing by event type.
  const win = eng.roundResult({ game: 'Dice', win: true, bigWin: false, bet: 2500, payout: 10000, multiplier: 4, profit: 7500, streak: 1 });
  assert.strictEqual(win.pace, 'fast');
  assert(win.text.includes('ten thousand'), 'win callout carries the payout in words: ' + win.text);
  // Stake wording lives in 2 of the 3 figure templates by design (the
  // third is the terse "{payW} back. {multW}."), so check the contract
  // across a spread of win lines rather than one template draw — the old
  // single-draw assertion only passed for particular RNG streams.
  let stakeLines = 0;
  for (let i = 0; i < 12; i++) {
    const w = eng.roundResult({ game: 'Dice', win: true, bigWin: false, bet: 2500, payout: 10000, multiplier: 4, profit: 7500, streak: 1 });
    assert(w.text.includes('ten thousand'), 'every win callout carries the payout in words: ' + w.text);
    if (w.text.includes('two thousand five hundred')) stakeLines++;
  }
  assert(stakeLines >= 4, 'win callouts regularly carry the stake in words (' + stakeLines + '/12)');
  const loss = eng.roundResult({ game: 'Dice', win: false, bet: 2500, payout: 0, multiplier: 0, profit: -2500, streak: -1 });
  assert.strictEqual(loss.pace, 'slow');
  // Win grading (research merge): a small win (<2x) is FLAT acceptance —
  // no shout, normal pace, figure read plainly; only 10x+ is "massive".
  const small = eng.roundResult({ game: 'Plinko', win: true, bigWin: false, bet: 2500, payout: 2750, multiplier: 1.1, profit: 250, streak: 1 });
  assert.strictEqual(small.pace, 'normal', 'small win stays flat (normal pace), got: ' + small.text);
  assert(!/bang|holy cow|MASSIVE/i.test(small.text), 'small win gets no hype shout: ' + small.text);
  // Massive bank: 4 of 6 templates shout the multiplier, the other two are
  // pure disbelief loops ("session saved. session saved.") — the research
  // pattern — so check the contract across a spread of draws, not one.
  let multLines = 0;
  for (let i = 0; i < 12; i++) {
    const monster = eng.roundResult({ game: 'Dice', win: true, bigWin: true, bet: 1000, payout: 12000, multiplier: 12, profit: 11000, streak: 1 });
    assert.strictEqual(monster.pace, 'fast');
    if (monster.text.includes('twelve x')) multLines++;
  }
  assert(multLines >= 5, 'massive-win lines regularly shout the multiplier (' + multLines + '/12)');
  // Same spread treatment as the monster check above: the merged massive
  // bank keeps disbelief-only lines alongside the figure callouts (4 of 6
  // templates carry the multiplier), so a single draw can legitimately
  // land on "that is the one." — check the contract across 12 draws.
  let bigMult = 0;
  for (let i = 0; i < 12; i++) {
    const big = eng.roundResult({ game: 'Slots', win: true, bigWin: true, bet: 5000, payout: 250000, multiplier: 50, profit: 245000, streak: 1 });
    if (big.text.includes('fifty x')) bigMult++;
  }
  assert(bigMult >= 5, 'big-win lines regularly shout the multiplier (' + bigMult + '/12)');
  const br = eng.bustReload(50000);
  assert(br.text.includes('reload') && br.text.includes('fifty thousand'), 'bust+reload narrated with the amount: ' + br.text);
  assert(/ten percent|twelve point five|twenty two point five|two hundred xp/.test(eng.rewards().text), 'rewards one-liner carries a verified figure');
});

console.log('commentary banks — language rules (2026-11-08):');
ok('banned phrase is gone: no "let this one come", no come-based anticipation', () => {
  const B = Commentary.BANKS;
  for (const name of Object.keys(B)) {
    for (const line of B[name]) {
      assert(!/let this one come/i.test(line), 'banned phrase in ' + name + ': ' + line);
    }
  }
  for (const line of B.ANTICIPATION_LINES) {
    assert(!/\bcome\b/i.test(line), 'come-based anticipation line survived: ' + line);
    assert(!/\bcome\b/i.test(Commentary.SAFE_REPLY), 'safe reply must stay clean');
  }
  // the replacements the user asked for are the anticipation bank now
  const bank = B.ANTICIPATION_LINES.join(' | ');
  for (const want of ['pls pls pls', 'just this time', 'land it', 'one time', 'please. just land', 'do something'])
    assert(bank.includes(want), 'anticipation replacement missing: ' + want);
});
ok('variant policy: every slang/hype category carries 3+ interchangeable variants', () => {
  const B = Commentary.BANKS;
  const cats = {
    'sizing': B.START_LINES, 'send-it sizing': B.START_SEND_LINES,
    'anticipation': B.ANTICIPATION_LINES, 'win shouts': B.WIN_SHOUTS,
    'affirmations': B.AFFIRMATION_LINES, 'big win': B.BIGWIN_LINES,
    'small win (flat)': B.SMALL_WIN_LINES, 'near miss': B.NEARMISS_LINES,
    'loss': B.LOSS_LINES, 'cooked/rinsed/cold': B.COLD_LINES,
    'switch/hop': B.SWITCH_LINES, 'bust': B.BUST_LINES, 'reload': B.RELOAD_LINES,
    'welcome': B.WELCOME_LINES, 'chat hooks/idle': B.IDLE_LINES
  };
  for (const name of Object.keys(cats)) {
    const distinct = new Set(cats[name]).size;
    assert(distinct >= 3, name + ' has only ' + distinct + ' variants (3+ required so a 3h stream never loops)');
  }
  // bang bang bang interchanges with the Ws-in-the-chat chant
  const shouts = B.WIN_SHOUTS.join(' | ');
  assert(shouts.includes('bang bang bang'), 'bang bang bang missing from win shouts');
  assert(shouts.includes('double yous in the chaaaaat'), 'Ws-in-the-chat chant missing from win shouts (spoken form: "double yous in the chaaaaat")');
  assert(B.BIGWIN_LINES.join(' | ').includes('double yous in the chaaaaat'), 'double yous missing from the massive bank');
});

console.log('voice clip library:');
ok('manifest integrity: files exist, decode as 22050Hz WAV, are non-silent, no banned text', () => {
  const fs = require('fs');
  const path = require('path');
  const libDir = path.join(__dirname, '..', 'voices-local', 'library');
  const manifestPath = path.join(libDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.log('    (skipped: library not built in this checkout)'); return; }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest.entries.length >= 150, 'library should hold 150+ phrases, got ' + manifest.entries.length);
  const sources = new Set(manifest.entries.map(e => e.source));
  assert(!sources.has('real'), 'single voice rule: no manifest entry may be sourced from a real take (his real voice stays off the public stream)');
  assert(manifest.entries.every(e => e.source === 'clone'), 'every library entry is a clone render (one assumed voice throughout)');
  assert(manifest.entries.some(e => e.key.includes('double yous in the chaaaaat')), 'Ws-in-the-chat clip is in the library');
  for (const e of manifest.entries) {
    assert(!/let this one come/i.test(e.key), 'banned phrase in manifest: ' + e.key);
    if (e.moment === 'anticipation') assert(!/\bcome\b/i.test(e.key), 'come-based anticipation clip in manifest: ' + e.key);
    const file = path.join(libDir, e.file);
    assert(fs.existsSync(file), 'manifest references a missing file: ' + e.file);
    const buf = fs.readFileSync(file);
    assert(buf.toString('ascii', 0, 4) === 'RIFF', 'not a WAV: ' + e.file);
    let rate = 0, dataOff = -1, dataLen = 0;
    for (let off = 12; off + 8 <= buf.length;) {
      const id = buf.toString('ascii', off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
      if (id === 'data') { dataOff = off + 8; dataLen = len; break; }
      off += 8 + len + (len % 2);
    }
    assert.strictEqual(rate, 22050, 'clip must be 22050 Hz for the FIFO: ' + e.file);
    assert(dataOff > 0 && dataLen > 2000, 'clip suspiciously short: ' + e.file);
    let sumSq = 0, n = 0;
    for (let i = dataOff; i + 1 < dataOff + dataLen; i += 2) { const v = buf.readInt16LE(i); sumSq += v * v; n++; }
    assert(Math.sqrt(sumSq / n) > 100, 'clip is silent: ' + e.file);
  }
  console.log('    library: ' + manifest.entries.length + ' entries, all clone (single assumed voice)');
});

console.log('speech director — coupled sync (v1.4):');
const Speech = require('../js/speech-director.js');
function manualVoice() {
  // A by-hand voice service: post() only records; the test fires the
  // speech events explicitly, so display timing is deterministic.
  const v = {
    posted: [], current: null, director: null,
    post(line) { v.posted.push(line); },
    start(line) { v.current = line; v.director.handleEvent({ type: 'speech-started', id: line.id, text: line.text, ts: Date.now() }); },
    end() { const l = v.current; v.current = null; v.director.handleEvent({ type: 'speech-ended', id: l.id, ts: Date.now() }); }
  };
  return v;
}
function coupledDirector(v, displays, clears, extra) {
  const d = new Speech.Director(Object.assign({
    post: (line) => v.post(line),
    onDisplay: (e) => displays.push(e),
    onClear: (e) => clears.push(e),
    sweep: false
  }, extra || {}));
  v.director = d;
  d.setMode('coupled');
  return d;
}
ok('subtitle renders ONLY on speech-started, clears on speech-ended, replay never double-displays', () => {
  const v = manualVoice(); const displays = [], clears = [];
  const d = coupledDirector(v, displays, clears);
  const res = d.submit({ kind: 'sizing', make: () => ({ text: 'five thousand riding.', pace: 'normal' }) });
  assert.strictEqual(res, 'sent');
  assert.strictEqual(v.posted.length, 1, 'line posted to the voice service');
  assert.strictEqual(displays.length, 0, 'NOT displayed at send time — the old scene did exactly this and diverged');
  v.start(v.posted[0]);
  assert.strictEqual(displays.length, 1, 'displayed when speech started');
  assert.strictEqual(displays[0].text, 'five thousand riding.', 'the displayed text is the spoken line, verbatim');
  assert.strictEqual(d.stats().displayed, 1);
  // a reconnect replay of the same event must not display twice
  d.handleEvent({ type: 'speech-started', id: v.posted[0].id, text: v.posted[0].text, ts: Date.now() });
  assert.strictEqual(displays.length, 1, 'replayed speech-started is deduped by line id');
  assert.strictEqual(clears.length, 0, 'not cleared before speech ends');
  v.end();
  assert.strictEqual(clears.length, 1, 'cleared exactly on speech-ended');
  assert.strictEqual(clears[0].id, v.posted[0].id);
  d.destroy();
});
ok('pacing gate: at most one pending intent; a line is generated only when a speech slot opens', () => {
  const v = manualVoice(); const displays = [], clears = [];
  const d = coupledDirector(v, displays, clears);
  let generatedB = 0;
  assert.strictEqual(d.submit({ kind: 'sizing', make: () => ({ text: 'line A.', pace: 'normal' }) }), 'sent');
  v.start(v.posted[0]);
  assert.strictEqual(d.submit({ kind: 'sizing', make: () => { generatedB++; return { text: 'line B.', pace: 'normal' }; } }), 'pending');
  assert.strictEqual(generatedB, 0, 'pending intent is NOT generated while the voice is busy');
  assert.strictEqual(d.stats().linesGenerated, 1);
  assert.strictEqual(d.submit({ kind: 'rewards', make: () => ({ text: 'filler.', pace: 'normal' }) }), 'dropped',
    'a lower-priority newcomer is turned away while the slot is taken');
  assert.strictEqual(d.stats().intentsDropped, 1);
  v.end(); // A finishes -> the slot opens -> B is generated and sent
  assert.strictEqual(generatedB, 1, 'pending intent generated exactly at the slot opening');
  assert.strictEqual(v.posted.length, 2);
  assert.strictEqual(v.posted[1].text, 'line B.');
  v.start(v.posted[1]); v.end();
  d.destroy();
});
ok('priority: a result intent replaces a pending sizing intent, which is then never generated', () => {
  const v = manualVoice(); const displays = [], clears = [];
  const d = coupledDirector(v, displays, clears);
  let sizingGenerated = 0;
  d.submit({ kind: 'sizing', make: () => ({ text: ' opener.', pace: 'normal' }) });
  v.start(v.posted[0]);
  assert.strictEqual(d.submit({ kind: 'sizing', make: () => { sizingGenerated++; return { text: 'stale sizing.', pace: 'normal' }; } }), 'pending');
  assert.strictEqual(d.submit({ kind: 'result', mood: 'talking', make: () => ({ text: 'bang bang bang. paid.', pace: 'fast' }) }), 'replaced');
  assert.strictEqual(d.stats().intentsReplaced, 1, 'the displaced pending intent is counted honestly');
  v.end();
  assert.strictEqual(sizingGenerated, 0, 'the replaced sizing line was never generated');
  assert.strictEqual(v.posted.length, 2);
  assert.strictEqual(v.posted[1].text, 'bang bang bang. paid.', 'the result line took the slot');
  v.start(v.posted[1]);
  assert.strictEqual(displays[displays.length - 1].text, 'bang bang bang. paid.');
  assert.strictEqual(displays[displays.length - 1].mood, 'talking', 'the intent mood rides the display event');
  v.end();
  d.destroy();
});
ok('expiry: an anticipation intent whose moment passes while the voice is busy dies unspoken', () => {
  const v = manualVoice(); const displays = [], clears = [];
  let fakeNow = 1000000;
  const d = coupledDirector(v, displays, clears, { now: () => fakeNow });
  d.submit({ kind: 'sizing', make: () => ({ text: 'long sizing line.', pace: 'normal' }) });
  v.start(v.posted[0]);
  assert.strictEqual(d.submit({ kind: 'anticipation', ttlMs: 1600, make: () => ({ text: 'pls pls pls.', pace: 'fast' }) }), 'pending');
  fakeNow += 2000; // the reveal finished while the sizing line was still speaking
  d.expireCheck();
  assert.strictEqual(d.stats().intentsExpired, 1);
  assert.strictEqual(d.stats().pending, null);
  v.end();
  assert.strictEqual(v.posted.length, 1, 'the expired anticipation was never generated or posted');
  d.destroy();
});

console.log('chat bridge service:');
function fakeAdapterFactory(handlersRef) {
  return function () {
    const a = {
      connected: false, chatroomId: null,
      connect(h) { handlersRef.h = h; },
      disconnect() { a.connected = false; }
    };
    handlersRef.adapter = a;
    return a;
  };
}
function httpJson(port, pathName, method) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: method || 'GET' },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject); req.end();
  });
}
async function bridgeTests() {
  const { createChatService } = require('../scripts/chat-service.js');
  const http = require('http');
  const ref = {};
  const svc = createChatService({ port: 0, channel: 'testchan', adapterFactory: fakeAdapterFactory(ref) });
  await new Promise((r) => { svc.server.listen(0, '127.0.0.1', r); });
  const port = svc.server.address().port;
  try {
    // health reports disconnected before the adapter subscribes
    let h = JSON.parse((await httpJson(port, '/health')).body);
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.connected, false);
    assert.strictEqual(h.channel, 'testchan');
    // SSE client: gets a status event immediately, then live transitions
    const sse = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => resolve(res));
      req.on('error', reject);
    });
    let sseBuf = '';
    sse.on('data', (c) => { sseBuf += c; });
    const waitFor = async (needle) => {
      for (let i = 0; i < 50 && !sseBuf.includes(needle); i++) await new Promise((r) => setTimeout(r, 40));
      assert(sseBuf.includes(needle), 'SSE should contain ' + JSON.stringify(needle) + ', got: ' + sseBuf.slice(0, 300));
    };
    await waitFor('"connected":false'); // initial status on connect
    // adapter subscribes -> bridge flips to connected and broadcasts it
    ref.adapter.connected = true; ref.adapter.chatroomId = 72832211;
    ref.h.onOpen(72832211);
    await waitFor('"connected":true');
    h = JSON.parse((await httpJson(port, '/health')).body);
    assert.strictEqual(h.connected, true);
    assert.strictEqual(h.chatroomId, 72832211);
    // a chat message is forwarded in the adapter contract, moderator-ready
    ref.h.onMessage({ id: 'kick-1', user: 'teal_tunde', text: 'hubie say my name', ts: 123, platform: 'kick' });
    await waitFor('"text":"hubie say my name"');
    h = JSON.parse((await httpJson(port, '/health')).body);
    assert.strictEqual(h.received, 1);
    assert.strictEqual(Chat.moderate({ text: 'hubie say my name' }).action, 'allow');
    // read-only by design: POSTs are refused, there is no send path
    const post = await httpJson(port, '/events', 'POST');
    assert.strictEqual(post.status, 405);
    // adapter drops -> status flips back to disconnected (scene restands sim)
    ref.adapter.connected = false;
    ref.h.onClose();
    await waitFor('"connected":false');
    sse.destroy();
    passed++; console.log('  PASS chat bridge: health, SSE status transitions, message forwarding, read-only');
  } finally {
    svc.close();
  }
}

async function voiceTests() {
  const { createVoiceService } = require('../scripts/voice-service.js');
  const { EventEmitter } = require('events');
  function fakeSpawn() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stdout.pause = () => {}; proc.stdout.resume = () => {};
    proc.stdin = { writable: true, on: () => {}, write: () => {
      // fake synth: 300ms later the line's 1.2s of "audio" lands at once
      setTimeout(() => { proc.stdout.emit('data', Buffer.alloc(Math.floor(22050 * 2 * 1.2))); }, 300);
    } };
    proc.kill = () => {};
    return proc;
  }
  const svc = createVoiceService({ port: 0, fifo: '/tmp/hubie-test-voice.fifo', spawnImpl: fakeSpawn, log: () => {} });
  // Attach a dummy FIFO reader, like ffmpeg does in production: with no
  // reader the service's FIFO write-stream open pends forever and keeps
  // this test process alive after the suite has passed (observed as hung
  // test processes). The reader is destroyed in the finally below.
  const fifoReader = require('fs').createReadStream('/tmp/hubie-test-voice.fifo');
  fifoReader.on('data', () => {});
  fifoReader.on('error', () => {});
  try {
    // A realistic dense burst: 10 short lines, one every 700ms, while each
    // line takes ~1.5s to say. The discipline must resolve EVERY line —
    // spoken fresh or dropped and counted — never queued into staleness.
    for (let i = 0; i < 10; i++) {
      svc.enqueue('burst line number ' + i + ' on the dice', i % 2 ? 'fast' : 'normal');
      await new Promise(r => setTimeout(r, 700));
    }
    await new Promise(r => setTimeout(r, 8000));
    const h = svc.health();
    assert.strictEqual(h.spoken + h.dropped, 10, 'every line resolved: spoken ' + h.spoken + ' + dropped ' + h.dropped + ' != 10');
    assert(h.spoken >= 3 && h.dropped >= 2, 'burst should mix spoken and dropped, got spoken ' + h.spoken + ' dropped ' + h.dropped);
    assert.strictEqual(h.dropped, h.droppedStale + h.droppedOverflow, 'drop accounting adds up');
    assert(h.maxStartLagSec <= 4.5, 'no spoken line started stale, max lag ' + h.maxStartLagSec + 's');
    passed++; console.log('  PASS voice service: burst discipline — spoken ' + h.spoken + ', dropped ' + h.dropped + ' (stale ' + h.droppedStale + ', replaced ' + h.droppedOverflow + '), max start lag ' + h.maxStartLagSec + 's');
  } finally { svc.close(); fifoReader.destroy(); }
}

async function clipTests() {
  const { createVoiceService, loadLibrary, lookupClip } = require('../scripts/voice-service.js');
  const { EventEmitter } = require('events');
  const fs = require('fs');
  const path = require('path');
  // Fixture library: two tiny 22050 Hz clips + manifest, built in /tmp.
  const dir = '/tmp/hubie-test-library';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
  function fixtureWav(file, freq, seconds) {
    const rate = 22050, n = Math.floor(rate * seconds);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.floor(Math.sin(2 * Math.PI * freq * i / rate) * 12000), i * 2);
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
    hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([hdr, data]));
  }
  fixtureWav(path.join(dir, 'clips', 'bang.wav'), 220, 0.4);
  fixtureWav(path.join(dir, 'clips', 'five.wav'), 330, 0.4);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    version: 1, sampleRate: 22050,
    entries: [
      { key: 'bang bang bang.', file: 'clips/bang.wav', source: 'clone', moment: 'win-shout', variant: 't1', status: 'ready' },
      { key: 'five thousand.', file: 'clips/five.wav', source: 'clone', moment: 'amount', variant: 't2', status: 'ready' }
    ]
  }));
  // Direct lookup: partition assembles fragments; a name line misses.
  const lib = loadLibrary(dir, 22050, () => {});
  assert.strictEqual(lib.enabled, true);
  assert(Buffer.isBuffer(lookupClip(lib, 'bang bang bang. five thousand.')), 'partition of two clips should hit');
  assert.strictEqual(lookupClip(lib, 'hey hey, teal_tunde. welcome in.'), null, 'name-bearing line must miss (Piper fallback)');
  assert.strictEqual(lookupClip(lib, 'something entirely unmapped'), null, 'unmapped line must miss');
  passed++; console.log('  PASS clip lookup: partition hit, name/unmapped miss');

  function fakeSpawn() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stdout.pause = () => {}; proc.stdout.resume = () => {};
    proc.stdin = { writable: true, on: () => {}, write: () => {
      setTimeout(() => { proc.stdout.emit('data', Buffer.alloc(Math.floor(22050 * 2 * 1.2))); }, 300);
    } };
    proc.kill = () => {};
    return proc;
  }
  const fifo = '/tmp/hubie-test-clip.fifo';
  const svc = createVoiceService({ port: 0, fifo, spawnImpl: fakeSpawn, log: () => {}, libraryDir: dir });
  const reader = fs.createReadStream(fifo); reader.on('data', () => {}); reader.on('error', () => {});
  const waitHealth = async (pred, what) => {
    for (let i = 0; i < 60; i++) { const h = svc.health(); if (pred(h)) return h; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('timed out waiting for ' + what + ': ' + JSON.stringify(svc.health()));
  };
  try {
    let h = await waitHealth(x => x.libraryEnabled && x.libraryEntries === 2, 'library to load');
    svc.enqueue('bang bang bang. five thousand.', 'fast');
    h = await waitHealth(x => x.clipsPlayed === 1, 'clip line to be dispatched');
    h = await waitHealth(x => x.spoken >= 1, 'clip line to be heard');
    assert.strictEqual(h.clipFallbacks, 0, 'mapped line must not fall back');
    svc.enqueue('a completely unmapped sentence here', 'normal');
    h = await waitHealth(x => x.clipFallbacks === 1, 'unmapped line to fall back to Piper');
    h = await waitHealth(x => x.spoken >= 2, 'fallback line to be spoken by Piper');
    assert.strictEqual(h.clipsPlayed, 1, 'fallback must not count as a clip play');
    passed++; console.log('  PASS voice service: clip hit plays from library, miss falls back to Piper (health counts both)');
  } finally { svc.close(); reader.destroy(); }
  // Piper-only mode: the flag disables the library entirely.
  const fifo2 = '/tmp/hubie-test-clip2.fifo';
  const svc2 = createVoiceService({ port: 0, fifo: fifo2, spawnImpl: fakeSpawn, log: () => {}, libraryDir: dir, library: false });
  const reader2 = fs.createReadStream(fifo2); reader2.on('data', () => {}); reader2.on('error', () => {});
  try {
    assert.strictEqual(svc2.health().libraryEnabled, false);
    svc2.enqueue('bang bang bang.', 'fast');
    await new Promise(r => setTimeout(r, 600));
    const h = svc2.health();
    assert.strictEqual(h.clipsPlayed, 0, 'no clips in Piper-only mode');
    assert.strictEqual(h.clipFallbacks, 0, 'no fallback counting in Piper-only mode');
    passed++; console.log('  PASS voice service: library flag off = Piper-only mode');
  } finally { svc2.close(); reader2.destroy(); }
}

async function directorSessionTests() {
  console.log('speech director — simulated session:');
  // A timed fake voice (starts 5ms after post, speaks 25-65ms per line)
  // fed by the REAL engine + games session at streamer cadence compressed:
  // intents arrive every ~12ms, far faster than speech — the pacing must
  // absorb the excess and every line the voice starts must be displayed
  // exactly once, in order. displayed == spoken is the pass bar.
  const startedOrder = [], displayedOrder = [];
  let d;
  const post = (line) => {
    const dur = 25 + (line.text.length % 5) * 10;
    setTimeout(() => { startedOrder.push(line.text); d.handleEvent({ type: 'speech-started', id: line.id, text: line.text, ts: Date.now() }); }, 5);
    setTimeout(() => { d.handleEvent({ type: 'speech-ended', id: line.id, ts: Date.now() }); }, 5 + dur);
  };
  d = new Speech.Director({ post, onDisplay: (e) => displayedOrder.push(e.text), sweep: false });
  d.setMode('coupled');
  const eng = new Commentary.Engine(777);
  const sess = new Games.Session(4242);
  let lastGame = sess.currentGame;
  for (let round = 0; round < 150; round++) {
    const r = sess.playRound();
    if (r.reload) d.submit({ kind: 'result', mood: 'down', make: () => eng.bustReload(r.reload.amount) });
    if (r.game !== lastGame) {
      const g = r.game, f = lastGame, c = r.streak <= -3;
      d.submit({ kind: 'segment', make: () => eng.segmentChange(g, { from: f, cold: c }) });
      lastGame = r.game;
    }
    d.submit({ kind: 'sizing', ttlMs: 9000, make: () => eng.roundStart(r) });
    if (round % 3 === 0) d.submit({ kind: 'anticipation', ttlMs: 1600, make: () => eng.anticipation() });
    d.submit({ kind: 'result', make: () => eng.roundResult(r) });
    if (round % 17 === 0) d.submit({ kind: 'rewards', ttlMs: 30000, make: () => eng.rewards() });
    await new Promise((res) => setTimeout(res, 12));
  }
  for (let i = 0; i < 200 && (d.stats().outstanding || d.stats().pending); i++)
    await new Promise((res) => setTimeout(res, 25));
  const st = d.stats();
  assert.strictEqual(st.outstanding, null, 'session drains fully');
  assert.deepStrictEqual(displayedOrder, startedOrder, 'every started line displayed exactly once, in order');
  assert.strictEqual(st.displayed, startedOrder.length, 'displayed counter == spoken count');
  assert.strictEqual(st.linesGenerated, startedOrder.length, 'everything generated was spoken (this fake voice never drops)');
  assert(st.intentsSubmitted > st.linesGenerated, 'pacing absorbed excess intents: submitted ' + st.intentsSubmitted + ' vs generated ' + st.linesGenerated);
  assert(st.intentsReplaced + st.intentsDropped + st.intentsExpired > 0, 'the excess is accounted: replaced ' + st.intentsReplaced + ', turned away ' + st.intentsDropped + ', expired ' + st.intentsExpired);
  assert(st.resultLagCount > 0 && st.maxResultLagMs < 1600, 'result lines start promptly: max intent->speech lag ' + st.maxResultLagMs + 'ms over ' + st.resultLagCount + ' results');
  passed++; console.log('  PASS simulated session: displayed == spoken (' + startedOrder.length + ' lines), submitted ' + st.intentsSubmitted + ', generated ' + st.linesGenerated + ', replaced ' + st.intentsReplaced + ', dropped ' + st.intentsDropped + ', expired ' + st.intentsExpired);
  d.destroy();
}

async function voiceEventTests() {
  console.log('voice service — speech events / sync:');
  const { createVoiceService } = require('../scripts/voice-service.js');
  const { EventEmitter } = require('events');
  const http = require('http');
  const fs = require('fs');
  function fakeSpawn() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stdout.pause = () => {}; proc.stdout.resume = () => {};
    proc.stdin = { writable: true, on: () => {}, write: () => {
      setTimeout(() => { proc.stdout.emit('data', Buffer.alloc(Math.floor(22050 * 2 * 1.2))); }, 300);
    } };
    proc.kill = () => {};
    return proc;
  }
  function postJson(port, pathName, obj) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      req.on('error', reject); req.end(JSON.stringify(obj));
    });
  }
  function sseConnect(port, lastEventId) {
    return new Promise((resolve, reject) => {
      const headers = lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {};
      const req = http.get({ host: '127.0.0.1', port, path: '/events', headers }, (res) => {
        const conn = { res, buf: '', frames: [] };
        res.on('data', (c) => {
          conn.buf += c;
          let idx;
          while ((idx = conn.buf.indexOf('\n\n')) >= 0) {
            const raw = conn.buf.slice(0, idx); conn.buf = conn.buf.slice(idx + 2);
            if (!raw || raw.startsWith(':')) continue;
            const frame = {};
            for (const line of raw.split('\n')) {
              const p = line.indexOf(':');
              if (p > 0) frame[line.slice(0, p)] = line.slice(p + 1).trim();
            }
            if (frame.event) { try { frame.data = JSON.parse(frame.data); } catch (e) { /* keep raw */ } conn.frames.push(frame); }
          }
        });
        resolve(conn);
      });
      req.on('error', reject);
    });
  }
  async function waitFrames(conn, pred, what) {
    for (let i = 0; i < 100; i++) { if (conn.frames.some(pred)) return; await new Promise((r) => setTimeout(r, 60)); }
    throw new Error('timed out waiting for ' + what + ': ' + JSON.stringify(conn.frames).slice(0, 400));
  }
  const fifo = '/tmp/hubie-test-events.fifo';
  const svc = createVoiceService({ port: 0, fifo, spawnImpl: fakeSpawn, log: () => {}, library: false });
  const reader = fs.createReadStream(fifo); reader.on('data', () => {}); reader.on('error', () => {});
  await new Promise((r) => { svc.server.listen(0, '127.0.0.1', r); });
  const port = svc.server.address().port;
  try {
    const conn = await sseConnect(port);
    await waitFrames(conn, (f) => f.event === 'sync', 'initial sync snapshot');
    const sync0 = conn.frames.find((f) => f.event === 'sync');
    assert.strictEqual(sync0.data.speakingId, null, 'nothing speaking at connect');
    // POST /say with a scene-style id: the id is echoed and rides the events.
    const sayRes = await postJson(port, '/say', { id: 'L-test-1', text: 'a line for the events test', pace: 'normal' });
    assert.strictEqual(sayRes.status, 200);
    assert.strictEqual(JSON.parse(sayRes.body).id, 'L-test-1', '/say echoes the line id');
    await waitFrames(conn, (f) => f.event === 'speech-started' && f.data.id === 'L-test-1', 'speech-started for L-test-1');
    const started = conn.frames.find((f) => f.event === 'speech-started');
    assert.strictEqual(started.data.text, 'a line for the events test', 'speech-started carries the exact line text');
    assert(started.id && Number(started.id) > 0, 'events are sequence-numbered for replay');
    await waitFrames(conn, (f) => f.event === 'speech-ended' && f.data.id === 'L-test-1', 'speech-ended for L-test-1');
    // Telemetry round-trip: the scene's counters land in /sync next to the service's.
    await postJson(port, '/telemetry', { mode: 'coupled', coupled: true, linesGenerated: 7, displayed: 6, intentsExpired: 1, intentsReplaced: 2, intentsDropped: 3 });
    const syncBody = JSON.parse((await httpJson(port, '/sync')).body);
    assert.strictEqual(syncBody.scene.displayed, 6);
    assert.strictEqual(syncBody.scene.linesGenerated, 7);
    assert(syncBody.service.spoken >= 1, 'service counters ride /sync');
    assert(syncBody.events.some((e) => e.type === 'speech-started' && e.data.id === 'L-test-1'), 'journal keeps the started event');
    const firstSeq = Number(started.id);
    conn.res.destroy();
    // Second line while nobody listens, then reconnect with Last-Event-ID:
    // the missed events replay, then a fresh sync snapshot lands.
    svc.enqueue('second line for replay', 'normal', 'L-test-2');
    for (let i = 0; i < 60 && svc.health().spoken < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert(svc.health().spoken >= 2, 'second line spoken while disconnected');
    const conn2 = await sseConnect(port, firstSeq);
    await waitFrames(conn2, (f) => f.event === 'speech-started' && f.data.id === 'L-test-2', 'replayed speech-started for L-test-2');
    await waitFrames(conn2, (f) => f.event === 'sync', 'sync snapshot after replay');
    assert(!conn2.frames.some((f) => f.event === 'speech-started' && f.data.id === 'L-test-1'), 'no replay of events at or before Last-Event-ID');
    conn2.res.destroy();
    passed++; console.log('  PASS voice events: /say id echo, speech-started/ended over SSE, /sync telemetry merge, Last-Event-ID replay');
  } finally { svc.close(); reader.destroy(); }
}

async function feederTests() {
  console.log('voice service — wall-clock feeder (v3.2):');
  // The pre-fix feeder emitted exactly 100ms of audio per 100ms tick, so
  // whenever ticks slipped under load the FIFO received audio slower
  // than real time and the recorded audio timeline compressed (~5% in
  // the coupled proof). This test drives the feeder with a FAKE clock
  // and deliberately slipped/irregular ticks and asserts the emitted
  // audio duration tracks SIMULATED WALL TIME, not tick count.
  // Tolerances asserted: total emitted duration within +/-50ms of wall
  // time at the end (the ledger math is exact to <1 sample at tick
  // boundaries; the slack only absorbs pipe-flush residue at the
  // reader), a single post-slip tick emits >=85% of the slipped
  // interval as catch-up (the ledger emits 100%), and speech-started
  // fires at the tick that clocks the line's first byte out.
  const { createVoiceService } = require('../scripts/voice-service.js');
  const { EventEmitter } = require('events');
  const fs = require('fs');
  const path = require('path');
  const BPS = 22050 * 2; // s16le mono at the model rate
  // Fixture library: one 3.0s tone clip (dispatch is instant, and the
  // speech bytes are identifiable against the silence in the stream).
  const dir = '/tmp/hubie-test-feeder-library';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
  (function fixtureWav(file, freq, seconds) {
    const rate = 22050, n = Math.floor(rate * seconds);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.floor(Math.sin(2 * Math.PI * freq * i / rate) * 12000), i * 2);
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
    hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([hdr, data]));
  })(path.join(dir, 'clips', 'wall.wav'), 220, 3.0);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    version: 1, sampleRate: 22050,
    entries: [{ key: 'wall clock test line.', file: 'clips/wall.wav', source: 'clone', moment: 'test', variant: 't1', status: 'ready' }]
  }));
  function fakeSpawn() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stdout.pause = () => {}; proc.stdout.resume = () => {};
    proc.stdin = { writable: true, on: () => {}, write: () => {} };
    proc.kill = () => {};
    return proc;
  }
  let fakeNow = 1762000000000;
  const timers = [];
  const logs = [];
  const fifo = '/tmp/hubie-test-feeder.fifo';
  const svc = createVoiceService({
    port: 0, fifo, spawnImpl: fakeSpawn, libraryDir: dir,
    log: (s) => logs.push(String(s)),
    now: () => fakeNow,
    setInterval: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearInterval: (h) => { if (h) h.cleared = true; }
  });
  let totalBytes = 0, firstSpeechOffset = -1;
  const reader = fs.createReadStream(fifo);
  reader.on('data', (chunk) => {
    if (firstSpeechOffset < 0) {
      for (let i = 0; i + 1 < chunk.length; i += 2) {
        if (Math.abs(chunk.readInt16LE(i)) > 500) { firstSpeechOffset = totalBytes + i; break; }
      }
    }
    totalBytes += chunk.length;
  });
  reader.on('error', () => {});
  const settle = async () => { // wait until the reader's byte count is stable
    let last = -1;
    for (let i = 0; i < 40 && totalBytes !== last; i++) { last = totalBytes; await new Promise(r => setTimeout(r, 25)); }
  };
  const tick = async (advanceMs) => { fakeNow += advanceMs; svc.feederTick(); await settle(); };
  try {
    for (let i = 0; i < 60 && !svc.health().fifoReady; i++) await new Promise(r => setTimeout(r, 50));
    assert(svc.health().fifoReady, 'FIFO reader attached');
    // 360ms of pure silence in three slipped ticks (100+170+90).
    await tick(100); await tick(170); await tick(90);
    assert(Math.abs(totalBytes - Math.round(0.36 * BPS)) <= BPS * 0.05,
      'silence emission tracks wall time: got ' + totalBytes + ' bytes for 0.36s');
    // Post the clip line at wall 360ms; it dispatches on the next tick.
    svc.enqueue('wall clock test line.', 'normal', 'L-feed-1');
    await tick(420); await tick(130); // wall 910ms
    // Speech must begin at its wall-clock position (~360ms of silence
    // precede it), not at a tick-count position.
    assert(firstSpeechOffset > 0, 'speech bytes observed in the emitted stream');
    assert(Math.abs(firstSpeechOffset - Math.round(0.36 * BPS)) <= BPS * 0.1,
      'speech starts at its wall-clock offset: byte ' + firstSpeechOffset + ' vs expected ~' + Math.round(0.36 * BPS));
    // The slip: one tick arrives 800ms after the previous one. That ONE
    // tick must emit the whole slipped interval as catch-up (the old
    // feeder would emit exactly 100ms here and fall 700ms behind).
    const beforeSlip = totalBytes;
    await tick(800); // wall 1710ms
    const slipEmission = totalBytes - beforeSlip;
    assert(slipEmission >= 0.85 * 0.8 * BPS,
      'post-slip tick emits the slipped interval as catch-up: got ' + slipEmission + ' bytes for an 800ms slip');
    await tick(250); await tick(640); await tick(400); await tick(1000); // wall 4000ms exactly
    // 10 ticks fired for 4.0s of wall time: the old feeder would have
    // emitted 10 x 100ms = 1.0s of audio. Asserted tolerance +/-50ms.
    assert(Math.abs(totalBytes - 4.0 * BPS) <= BPS * 0.05,
      'total emitted duration tracks wall time: ' + (totalBytes / BPS).toFixed(3) + 's emitted for 4.000s simulated (10 ticks)');
    const h = svc.health();
    assert(Math.abs(h.emittedSec - 4.0) <= 0.01 && Math.abs(h.feedWallSec - 4.0) <= 0.01,
      'health ledger agrees: emittedSec ' + h.emittedSec + ' vs feedWallSec ' + h.feedWallSec);
    assert.strictEqual(h.spoken, 1, 'the clip line was spoken');
    assert.strictEqual(h.clipsPlayed, 1);
    assert.strictEqual(h.dropped, 0, 'nothing dropped under slipped ticks');
    const started = logs.find(l => l.includes('line started id=L-feed-1'));
    assert(started, 'speech-started log line present for the clip');
    const lag = Number((started.match(/lag=([\d.]+)s/) || [])[1]);
    assert(lag >= 0.4 && lag <= 0.5,
      'speech-started is consistent with emission: posted at wall 360ms, started at the 780ms tick -> lag ' + lag + 's');
    passed++; console.log('  PASS feeder: emitted 4.000s of audio for 4.000s of slipped-tick wall time (10 ticks; pre-fix feeder would emit 1.0s), catch-up tick emitted ' + Math.round(slipEmission / BPS * 1000) + 'ms, speech onset at byte ' + firstSpeechOffset + ', start lag ' + lag + 's');
  } finally { svc.close(); reader.destroy(); }
}

function supervisorTests() {
  console.log('encoder supervisor:');
  const Sup = require('../scripts/encoder-supervisor.js');
  const { EventEmitter } = require('events');

  ok('backoff ladder: 3s, 5s, 10s, 20s, then capped at 20s', () => {
    assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map((f) => Sup.backoffDelayMs(f)), [3000, 5000, 10000, 20000, 20000, 20000]);
  });

  ok('restart decision: crash restarts fast, stable run resets the ladder, operator stop never restarts', () => {
    const crash = { clean: false, ranMs: 4000 };
    let d = Sup.decideRestart({ stopRequested: false, consecutiveFailures: 0 }, crash, {});
    assert(d.restart && d.delayMs === 3000 && d.failures === 1);
    d = Sup.decideRestart({ stopRequested: false, consecutiveFailures: 1 }, crash, {});
    assert(d.restart && d.delayMs === 5000 && d.failures === 2);
    d = Sup.decideRestart({ stopRequested: false, consecutiveFailures: 3 }, { clean: false, ranMs: 44 * 60000 }, {});
    assert(d.restart && d.stable && d.delayMs === 3000 && d.failures === 1, 'a 44-minute run earns the fast retry again');
    d = Sup.decideRestart({ stopRequested: true, consecutiveFailures: 0 }, crash, {});
    assert(!d.restart && d.reason === 'operator-stop');
  });

  ok('restart decision: planned clean exit stops only with the flag; an unplanned clean exit still restarts', () => {
    const cleanExit = { clean: true, ranMs: 75000 };
    let d = Sup.decideRestart({ stopRequested: false, consecutiveFailures: 0 }, cleanExit, { noRestartOnCleanExit: true });
    assert(!d.restart && d.reason === 'planned-clean-exit');
    d = Sup.decideRestart({ stopRequested: false, consecutiveFailures: 0 }, cleanExit, {});
    assert(d.restart && d.reason === 'unexpected-clean-exit');
  });

  function rig() {
    const children = [], timers = [];
    let fakeNow = 1700000000000;
    const sup = new Sup.EncoderSupervisor({
      command: 'ffmpeg', args: ['-test'],
      spawnImpl: () => { const c = new EventEmitter(); c.pid = 1000 + children.length; c.killed = []; c.kill = (s) => { c.killed.push(s); return true; }; children.push(c); return c; },
      setTimeoutImpl: (cb, ms) => { const t = { cb: cb, ms: ms, cleared: false }; timers.push(t); return t; },
      clearTimeoutImpl: (t) => { t.cleared = true; },
      now: () => fakeNow,
      transportLogPath: null,
      stderr: { write: () => {} }
    });
    return { sup: sup, children: children, timers: timers, advance: (ms) => { fakeNow += ms; } };
  }

  ok('supervisor: encoder exit schedules exactly one restart at the ladder delay; the show stack is never signalled', () => {
    const r = rig();
    r.sup.start();
    assert.strictEqual(r.children.length, 1);
    r.advance(5000);
    r.children[0].emit('exit', 1, null);            // tunnel-drop style crash
    assert.strictEqual(r.children.length, 1, 'no instant respawn — the delay applies');
    assert.strictEqual(r.timers.length, 1);
    assert.strictEqual(r.timers[0].ms, 3000, 'first retry within ~5s');
    r.timers[0].cb();
    assert.strictEqual(r.children.length, 2, 'exactly one new encoder');
    r.children[1].emit('exit', null, 'SIGKILL');    // fast second failure deepens the ladder
    assert.strictEqual(r.timers[1].ms, 5000);
    r.timers[1].cb();
    assert.strictEqual(r.children.length, 3);
    r.advance(70000);                                // third run is stable, then dies
    r.children[2].emit('exit', 1, null);
    assert.strictEqual(r.timers[2].ms, 3000, 'stable run reset the ladder');
    assert(r.children.every((c) => c.killed.length === 0), 'the supervisor never kills a healthy encoder, and owns no other process');
  });

  ok('supervisor: operator stop kills the current encoder and schedules nothing', () => {
    const r = rig();
    r.sup.start();
    r.sup.stop();
    assert.deepStrictEqual(r.children[0].killed, ['SIGTERM']);
    r.children[0].emit('exit', null, 'SIGTERM');
    assert.strictEqual(r.timers.length, 0, 'no restart after an operator stop');
    assert.strictEqual(r.children.length, 1);
  });

  return Promise.resolve();
}

/* Liveness regression (2026-11-08): the first forced-drop verification
 * found the supervisor exiting silently during its own restart delay —
 * the restart timer was unref'd, so once ffmpeg's handle was gone the
 * event loop drained and the process died before the retry fired (and
 * stream.sh's trap then killed the scene). Unit tests with fake timers
 * cannot see an event-loop liveness bug, so this test runs the real
 * supervisor as a subprocess against a fake ffmpeg that always crashes
 * and counts spawns in the transport log. */
function supervisorLivenessTest() {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const fakeFfmpeg = '/tmp/hubie-fake-ffmpeg.sh';
  const tlog = '/tmp/hubie-supervisor-liveness.log';
  fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\nsleep 0.1\nexit 1\n', { mode: 0o755 });
  try { fs.unlinkSync(tlog); } catch (e) { /* fresh */ }
  // Detached with ignored stdio: the supervisor must live in its own
  // session (as it does under stream.sh's setsid launch). A non-detached
  // child shares the test process's group and can be signalled by the
  // surrounding shell/session lifecycle, which is not the supervisor's
  // behaviour and flaked this test in the agent sandbox.
  const proc = spawn('node', ['scripts/encoder-supervisor.js',
    '--transport-log', tlog, '--delays', '150,150,150', '--stable-ms', '60000',
    '--', fakeFfmpeg], { cwd: require('path').join(__dirname, '..'), detached: true, stdio: 'ignore' });
  const stopIt = () => {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch (e) { try { proc.kill('SIGTERM'); } catch (e2) { /* gone */ } }
  };
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 6000;
    const poll = () => {
      let starts = 0, exits = 0;
      try {
        const lines = fs.readFileSync(tlog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        starts = lines.filter((l) => l.event === 'ffmpeg_start').length;
        exits = lines.filter((l) => l.event === 'ffmpeg_exit').length;
      } catch (e) { /* log not written yet */ }
      if (starts >= 3 && exits >= 2) {
        stopIt();
        passed++; console.log('  PASS supervisor liveness: real subprocess respawned a crashing encoder ' + starts + ' times across restart delays (unref regression guard)');
        return resolve();
      }
      if (Date.now() > deadline) {
        stopIt();
        return reject(new Error('supervisor liveness: only ' + starts + ' starts / ' + exits + ' exits in 6s — the supervisor is not surviving its own restart delay'));
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

bridgeTests()
  .then(() => { console.log('voice service:'); return voiceTests(); })
  .then(() => { console.log('voice service clip library:'); return clipTests(); })
  .then(() => directorSessionTests())
  .then(() => voiceEventTests())
  .then(() => feederTests())
  .then(() => supervisorTests())
  .then(() => supervisorLivenessTest())
  .then(() => { console.log('\nAll ' + passed + ' tests passed.'); })
  .catch((e) => { console.error('  FAIL:', e); process.exit(1); });
