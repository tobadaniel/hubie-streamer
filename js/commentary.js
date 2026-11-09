/*
 * Hubie commentary engine v2 — SHORT BURSTS ONLY (2026-11-07 overhaul).
 *
 * Why v2 exists: v1 wrote long, detailed lines (5-8 seconds of speech).
 * Long lines cannot stay in sync with fast game action — the voice queue
 * backed up and Hubie was still describing round 9 during round 12. The
 * user (a Kick viewer) called it exactly: Hubie must talk like a slots
 * streamer actually talks. So now EVERY spoken line is a few words to one
 * short sentence — 1 to 3 seconds of speech — and it only ever carries:
 * the stake, what he is doing right now, and the result. Doubled hype
 * phrases ("five thousand. five thousand riding.") are a feature.
 *
 * Every method returns { text, pace } — pace is the voice-service delivery
 * lane ('fast' for wins/anticipation, 'normal' default, 'slow' for losses)
 * so scripts/voice-service.js can vary length_scale by line type.
 *
 * The banks below were merged with the evidence-based line bank in
 * research/streamer-patterns.md (patterns sampled from jkolby, jerzynft
 * and syken VODs): reactions of 1-6 words, verbatim repetition as the
 * hype device, wins GRADED by multiplier (flat for small, shout for
 * solid, disbelief for 10x+), the game addressed directly in
 * anticipation, "hop" switches, and crowdsourced game calls in chat.
 *
 * Repetition policy (changed from v1, deliberately): v1 guaranteed no
 * verbatim repeat for a simulated hour. Short hype lines are MEANT to
 * repeat — streamers chant the same burst all night. The engine now
 * only avoids saying the exact same line twice in a row; figure-bearing
 * lines (results with real numbers) stay effectively unique because the
 * numbers move every round.
 *
 * Variant policy (user rule, 2026-11-08): EVERY slang/hype category
 * carries 3-5 interchangeable variants so a 3-hour stream never sounds
 * like a loop — win shouts rotate "bang bang bang" with "double yous in
 * the chaaaaat" (the Ws-in-the-chat chant, spelled as it is pronounced),
 * affirmations rotate too, and anticipation NEVER uses "let this one
 * come" or any "come"-based phrasing (user: it sounds wrong) — the
 * anticipation bank runs on "pls pls pls", "just this time", "land it",
 * "one time", "please. just land." instead.
 *
 * Safety rules are unchanged and hard: no win promises (hope is fine,
 * guarantees are not), no deposit talk, no swearing anywhere, rewards
 * figures only the verified ones (Rookie: rakeback 10%, VIP rewards
 * 12.5%, total 22.5%, Bronze 1 at 200 XP).
 * Pure logic (no DOM), UMD: window.HubieCommentary / Node require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubieCommentary = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function makeRng(seed) {
    var s = (seed >>> 0) || 987654321;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function pick(rng, a) { return a[Math.floor(rng() * a.length)]; }

  /* ---- spoken numbers: streamers say the words, so the TTS gets words -- */
  var ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function under1000(n) {
    var out = '';
    var h = Math.floor(n / 100), rest = n % 100;
    if (h) out += ONES[h] + ' hundred' + (rest ? ' ' : '');
    if (rest >= 20) out += TENS[Math.floor(rest / 10)] + (rest % 10 ? ' ' + ONES[rest % 10] : '');
    else if (rest > 0) out += ONES[rest];
    return out;
  }
  function words(n) {
    n = Math.round(n);
    if (n < 0) return 'minus ' + words(-n);
    if (n === 0) return 'zero';
    var out = '';
    var m = Math.floor(n / 1000000), th = Math.floor((n % 1000000) / 1000), rest = n % 1000;
    if (m) out += under1000(m) + ' million' + (th || rest ? ' ' : '');
    if (th) out += under1000(th) + ' thousand' + (rest ? ' ' : '');
    if (rest) out += under1000(rest);
    return out.trim();
  }
  // "four x" for whole multipliers, "four point three x" for decimals.
  function multWords(m) {
    if (m == null || m === '') return '';
    var v = Math.round(Number(m) * 10) / 10;
    if (v === Math.floor(v)) return words(v) + ' x';
    return words(Math.floor(v)) + ' point ' + words(Math.round((v % 1) * 10)) + ' x';
  }

  /* ------------------------- line banks (SHORT) ------------------------- */
  var START_LINES = [
    'what are we putting on this one. {betW}. {betW} riding.',
    'in with {betW}. let this be it.',
    '{betW} on {gameL}. here we go.',
    'size check. {betW}. send it.',
    'going in. {betW}. watch this.',
    'size up. {betW}.'
  ];
  var START_SEND_LINES = [ // send-it bets (~5% of the roll)
    'big one. {betW} riding. feel it.',
    'sending it. {betW}. all of it matters now.',
    'this is the big send. {betW}.'
  ];
  var ANTICIPATION_LINES = [ // NO "come"-based phrasing (user rule) — pleas and land-it calls only
    'pls pls pls.',
    'just this time. just this time.',
    'land it. land it.',
    'one time. one time.',
    'please. just land.',
    'do something. wake up.',
    'imagine the big one here.',
    'hold. hold.',
    'hopefully it cooks this time.'
  ];
  var WIN_SHOUTS = [ // "bang bang bang" INTERCHANGES with the Ws-in-the-chat chant (user rule)
    'bang bang bang. yes sir. yes sir. we did it.',
    'double yous in the chaaaaat. yes sir. we did it.',
    'yes. YES. there it is.',
    'boom. got it. got it.',
    'there we go. there we go.'
  ];
  var AFFIRMATION_LINES = [ // rotated with the shouts on solid wins — same energy, different words
    'yes sir. yes sir.',
    'that is how we do it. that is how we do it.',
    'told you. told you.',
    'we move. we move.'
  ];
  var WIN_FIGURES = [
    '{payW} back. off {betW}. that is a {multW}. massive.',
    '{payW} back. {multW}. we take those.',
    'paid. {payW}. off {betW}. lovely.'
  ];
  var WIN_FIGURES_SHORT = [ // when word-numbers run long, figures shrink
    '{payW} back. {multW}.',
    'paid {payW}. {multW}.'
  ];
  /* Small win (stake back to ~2x): the research pattern is FLAT
   * acceptance — a few words, the figure read plainly, straight on to
   * the next round ("we take it", "okay, what's next"). No shout, no
   * hype: saving the energy for real hits is what makes them land. */
  var SMALL_WIN_LINES = [
    '{payW} back. next.',
    '{payW} back. what is next.',
    'small one. {payW} back. run it.',
    'we take it. {payW} back.',
    'paid. keep going.'
  ];
  var BIGWIN_LINES = [
    'holy cow. {multW}. {multCaps}. look at that.',
    'MASSIVE. {payW} back. that is a {multW}.',
    'oh my days. {multW}. clip that. clip that.',
    '{multW}. {multW}. look at that.',
    'double yous in the chaaaaat. {multW}. look at that.',
    'session saved. session saved.',
    'that is the one. THAT is the one.'
  ];
  var LOSS_LINES = [
    'damn. cooked.',
    'nah. that is rough.',
    'cooked. move on.',
    'no good. next.',
    'gone. we go again.',
    'dead.',
    'nothing. next.'
  ];
  var COLD_LINES = [ // losing streak on one game
    'we are getting rinsed on {gameL} right now.',
    '{gameL} is ice cold. ice cold.',
    'nothing is landing. nothing.',
    '{gameL} is dead right now. dead.',
    'cooked. properly cooked.'
  ];
  var SWITCH_LINES = [ // streamer narrates choosing to move games
    '{fromL} is cold. {gameL}. let us see {gameL}.',
    'let us go check out {gameL}.',
    'switching. {gameL} now. fresh board, fresh luck.',
    '{fromL} is dead. we hop. {gameL} now.',
    'enough of this one. what is next.'
  ];
  var SEGMENT_LINES = [
    '{gameL} now. let us see {gameL}.',
    'over to {gameL}. new game.',
    'rotating. {gameL} time.'
  ];
  var SLOT_INTRO_LINES = [
    'casino break. five spins on the slots.',
    'break time. slots, five spins. then back.',
    'quick slots break. five spins only.'
  ];
  var NEARMISS_LINES = [
    'one away. ONE away. so close.',
    'so close. one away. one away.',
    'ONE tile from it. one.',
    'it teased us. it actually teased us.',
    'that was right there.'
  ];
  var PUSH_LINES = [
    'pair. stake back. no harm.',
    'pair on the reels. money back.',
    'stake back. the slot shrugs.'
  ];
  var REWARDS_LINES = [ // verified figures only, punchy one-liners
    'rakeback here is ten percent. every bet earns.',
    'vip rewards, twelve point five. it adds up.',
    'total rewards, twenty two point five percent. rakeback plus vip.',
    'bronze one at two hundred xp. levels climb, rewards climb.',
    'keys on every bet. that is the housebets way.',
    'quick one. rakeback is ten percent here. ten.',
    'that is twenty two point five total. the house pays back.'
  ];
  /* The spoken demo mentions in a run (user rule, 2026-11-07; closing
   * amended by user direction 2026-11-08): the scrolling banner carries
   * the disclaimer on screen at all times, so the voice says the demo
   * mention once at the open and once sparsely mid stream — and the
   * run's final spoken line is the user's own sign-off (CLOSING_LINE
   * below), which carries "gamble responsibly" and the Housebets host
   * line in place of a third demo mention. Nowhere else — regular
   * commentary talks like a normal streamer with plain amounts. */
  var OPENING_LINE = 'hey hey. hubie here. demo play, no real money. let us play.';
  var REMINDER_LINES = [
    'reminder, chat. demo play. no real money here.',
    'quick one. this is demo play. no real money, ever.'
  ];
  var CLOSING_LINE = 'gamble responsibly. and if you\'re looking for where to gamble, hubie on housebets is always ready to host you.';
  var WELCOME_LINES = [
    'hey hey, {name}. welcome in.',
    'yo {name}. good timing.',
    'hey {name}. pull up a seat.',
    'we see you, {name}. we see you.'
  ];
  var IDLE_LINES = [
    'hydrate check, chat.',
    'night crew, we still rolling.',
    'we move. always moving.',
    'eyes up. next round loading.',
    'give me a game, chat. give me a call.'
  ];
  var BUST_LINES = [
    'rinsed. we are cooked.',
    'and that is the roll gone. cooked.',
    'busted. the roll is empty.',
    'rinsed. rinsed to zero.'
  ];
  var RELOAD_LINES = [
    'reload. {amtW} more. we go again.',
    'fresh {amtW} in. back in. we go again.',
    'reload again. another {amtW}. back in.',
    'bought back in. {amtW}. let us run it.'
  ];
  var CHAT_ANSWERS = {
    how: 'pick a game, place the bet, watch the roll. simple.',
    dice: 'dice is roll over or under a number. that is it.',
    mines: 'mines is a grid. reveal gems, dodge mines, cash out.',
    plinko: 'plinko drops a ball. edges pay big, middle pays small.',
    slots: 'slots on the break. five spins, then back.',
    hubie: 'i am hubie. rewards host. i run this whole show.',
    balance: 'play money only. nothing on this floor is real.',
    rewards: 'rakeback ten percent. vip twelve point five. adds up.',
    tip: 'no tips from me. a tip is never a promise.',
    default: 'i hear you. back to the game though.'
  };
  var SAFE_REPLY = 'no. no promises, no deposits. back to the game.';

  function fill(tpl, ctx) {
    return tpl.replace(/\{(\w+)\}/g, function (m, k) { return ctx[k] != null ? ctx[k] : m; });
  }

  function Engine(seed) {
    this.rng = makeRng(seed || (Date.now() % 2147483647));
    this.lineCount = 0;
    this.safetyCount = 0;
    this.segmentCount = 0;
    this.lastText = '';
    this.startedAt = Date.now();
    this.lastReminderAt = 0;
    /* Sparse demo reminder cadence: first one due about 2.5 hours in
     * (roughly the midpoint of a planned run), then no more often than
     * about every 2 hours on open-ended running. */
    this.firstReminderMs = 2.5 * 60 * 60 * 1000;
    this.reminderEveryMs = 2 * 60 * 60 * 1000;
  }
  // Pick a template line, avoiding an immediate verbatim repeat of the
  // previous line (hype repetition across a stream is intended; back-to-
  // back identical lines just sound like a glitch).
  Engine.prototype.say = function (bank, ctx, pace) {
    var text = '', tries = 0;
    do { text = fill(pick(this.rng, bank), ctx || {}); tries++; }
    while (text === this.lastText && tries < 4);
    this.lastText = text;
    this.lineCount++;
    return { text: text, pace: pace || 'normal' };
  };
  Engine.prototype.ctx = function (r) {
    var payRounded = Math.round((r.payout || 0) / 10) * 10;
    return {
      game: r.game || '', gameL: (r.game || '').toLowerCase(),
      betW: words(r.bet || 0), payW: words(payRounded),
      multW: multWords(r.multiplier), multCaps: r.multiplier != null ? String(Math.round(Number(r.multiplier))) : '',
      amtW: ''
    };
  };
  Engine.prototype.roundStart = function (r) {
    var bank = r.sendIt ? START_SEND_LINES : START_LINES;
    return this.say(bank, this.ctx(r), 'normal');
  };
  Engine.prototype.anticipation = function () {
    return this.say(ANTICIPATION_LINES, {}, 'fast');
  };
  Engine.prototype.slotIntro = function () {
    return this.say(SLOT_INTRO_LINES, {}, 'normal');
  };
  Engine.prototype.roundResult = function (r) {
    var c = this.ctx(r);
    if (r.game === 'Slots' && !r.win && r.nearMiss) return this.say(NEARMISS_LINES, c, 'fast');
    if (r.game === 'Slots' && !r.win && r.pair) return this.say(PUSH_LINES, c, 'normal');
    if (r.win) {
      /* Wins are GRADED by multiplier, per the streamer research
       * (research/streamer-patterns.md): a small win (stake back to
       * ~2x) gets flat acceptance, a solid win gets the shout + the
       * figures, and only a genuine monster (10x+) gets the massive
       * bank. Grading by the multiplier (not the games' bigWin flags,
       * which trip as low as 2.1x on Plinko) keeps the energy honest. */
      var mult = Number(r.multiplier) || 0;
      if (mult >= 10) return this.say(BIGWIN_LINES, c, 'fast');
      if (mult < 2) return this.say(SMALL_WIN_LINES, c, 'normal');
    }
    if (r.win) {
      // shout + figures in one short burst (~3s); if the spoken numbers
      // run long, the line sheds the shout, then the stake clause, so a
      // win line never balloons past the burst budget. The lead-in
      // rotates between the shout bank and the affirmation bank so the
      // same celebration never lands twice the same way.
      var shout = pick(this.rng, this.rng() < 0.5 ? WIN_SHOUTS : AFFIRMATION_LINES);
      var fig = fill(pick(this.rng, WIN_FIGURES), c);
      var text = shout + ' ' + fig;
      if (text.length > 130) text = fig;
      if (text.length > 130) text = fill(pick(this.rng, WIN_FIGURES_SHORT), c);
      if (text === this.lastText) text = fig;
      this.lastText = text; this.lineCount++;
      return { text: text, pace: 'fast' };
    }
    if (r.nearMiss) return this.say(NEARMISS_LINES, c, 'fast');
    if (r.streak <= -3 && this.rng() < 0.6) return this.say(COLD_LINES, c, 'slow');
    return this.say(LOSS_LINES, c, 'slow');
  };
  Engine.prototype.segmentChange = function (game, opts) {
    this.segmentCount++;
    var c = { game: game, gameL: String(game).toLowerCase(), fromL: opts && opts.from ? String(opts.from).toLowerCase() : '' };
    if (opts && opts.cold && opts.from) return this.say(SWITCH_LINES, c, 'normal');
    return this.say(SEGMENT_LINES, c, 'normal');
  };
  Engine.prototype.welcome = function (name) {
    return this.say(WELCOME_LINES, { name: name }, 'normal');
  };
  /* The three spoken demo moments, and nothing else. opening() fires
   * once at run start, reminder() fires only when reminderDue() says the
   * sparse schedule is met, closing() fires on a graceful stop. Regular
   * commentary, chat replies and rewards lines never use the word. */
  Engine.prototype.opening = function () {
    return { text: OPENING_LINE, pace: 'normal' };
  };
  Engine.prototype.reminder = function () {
    this.safetyCount++;
    return this.say(REMINDER_LINES, {}, 'slow');
  };
  Engine.prototype.closing = function () {
    return { text: CLOSING_LINE, pace: 'slow' };
  };
  Engine.prototype.reminderDue = function (nowMs) {
    var now = nowMs || Date.now();
    if (!this.lastReminderAt) return now - this.startedAt >= this.firstReminderMs;
    return now - this.lastReminderAt >= this.reminderEveryMs;
  };
  Engine.prototype.markReminder = function (nowMs) {
    this.lastReminderAt = nowMs || Date.now();
  };
  Engine.prototype.rewards = function () {
    return this.say(REWARDS_LINES, {}, 'normal');
  };
  Engine.prototype.idle = function () {
    return this.say(IDLE_LINES, {}, 'normal');
  };
  Engine.prototype.bust = function () {
    return this.say(BUST_LINES, {}, 'slow');
  };
  // Bust + reload as ONE burst: the scene fires this the moment a reload
  // lands, and a single line can never be queue-collapsed by the next one.
  Engine.prototype.bustReload = function (amount) {
    var c = this.ctx({}); c.amtW = words(amount || 0);
    var bust = fill(pick(this.rng, BUST_LINES), c);
    var rel = fill(pick(this.rng, RELOAD_LINES), c);
    var text = bust + ' ' + rel;
    this.lastText = text; this.lineCount++;
    return { text: text, pace: 'slow' };
  };
  Engine.prototype.reload = function (amount) {
    var c = this.ctx({}); c.amtW = words(amount || 0);
    return this.say(RELOAD_LINES, c, 'normal');
  };
  Engine.prototype.chatAnswer = function (name, topic) {
    var answer = CHAT_ANSWERS[topic] || CHAT_ANSWERS.default;
    var text = name + '. ' + answer;
    this.lastText = text; this.lineCount++;
    return { text: text, pace: 'normal' };
  };
  Engine.prototype.safeReply = function () { return { text: SAFE_REPLY, pace: 'normal' }; };

  /* The banks are exported for the test suite (variant counts, banned
   * phrase sweep) and for the voice-library builder, which enumerates
   * every emittable line from these lists rather than duplicating them. */
  var BANKS = {
    START_LINES: START_LINES, START_SEND_LINES: START_SEND_LINES,
    ANTICIPATION_LINES: ANTICIPATION_LINES, WIN_SHOUTS: WIN_SHOUTS,
    AFFIRMATION_LINES: AFFIRMATION_LINES, WIN_FIGURES: WIN_FIGURES,
    WIN_FIGURES_SHORT: WIN_FIGURES_SHORT, SMALL_WIN_LINES: SMALL_WIN_LINES,
    BIGWIN_LINES: BIGWIN_LINES, LOSS_LINES: LOSS_LINES, COLD_LINES: COLD_LINES,
    SWITCH_LINES: SWITCH_LINES, SEGMENT_LINES: SEGMENT_LINES,
    SLOT_INTRO_LINES: SLOT_INTRO_LINES, NEARMISS_LINES: NEARMISS_LINES,
    PUSH_LINES: PUSH_LINES, REWARDS_LINES: REWARDS_LINES,
    OPENING_LINE: [OPENING_LINE], REMINDER_LINES: REMINDER_LINES,
    CLOSING_LINE: [CLOSING_LINE], WELCOME_LINES: WELCOME_LINES,
    IDLE_LINES: IDLE_LINES, BUST_LINES: BUST_LINES, RELOAD_LINES: RELOAD_LINES
  };

  return { Engine: Engine, SAFE_REPLY: SAFE_REPLY, ANSWERS: CHAT_ANSWERS, words: words, multWords: multWords, BANKS: BANKS };
});
