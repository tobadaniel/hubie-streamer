/*
 * Hubie demo game engines — DEMO ONLY.
 * Fake demo balance, fake outcomes, no real money, no network calls,
 * no connection to housebets.com or any real betting system.
 * Pure logic (no DOM) so it can be unit-tested in Node and reused by the scene.
 *
 * UMD: works as window.HubieGames in the browser and require() in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubieGames = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Seedable RNG so tests are deterministic and streams are reproducible.
  function makeRng(seed) {
    var s = (seed >>> 0) || 123456789;
    return function () {
      // xorshift32
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function randInt(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }
  function round2(n) { return Math.round(n * 100) / 100; }

  /* ---------------- DICE ----------------
   * Classic roll-over / roll-under. House-originals style.
   * result: { game, bet, target, mode, roll, win, payout, multiplier, bigWin }
   */
  function playDice(rng, balance, opts) {
    opts = opts || {};
    var mode = opts.mode || (rng() < 0.5 ? 'over' : 'under');
    var target = opts.target != null ? opts.target : randInt(rng, 30, 70);
    var bet = Math.min(opts.bet || 5000, balance);
    var roll = round2(rng() * 99.99);
    var winChance = mode === 'over' ? 100 - target : target;
    if (winChance <= 0) winChance = 1;
    var multiplier = round2(98 / winChance); // ~2% demo edge, clearly a demo model
    var win = mode === 'over' ? roll > target : roll < target;
    var payout = win ? round2(bet * multiplier) : 0;
    return {
      game: 'Dice', bet: bet, target: target, mode: mode, roll: roll,
      winChance: winChance, multiplier: multiplier,
      win: win, payout: payout, profit: round2(payout - bet),
      bigWin: win && multiplier >= 3, nearMiss: !win && Math.abs(roll - target) <= 2,
      summary: 'Rolled ' + roll.toFixed(2) + ' (' + mode + ' ' + target + ')'
    };
  }

  /* ---------------- MINES ----------------
   * 5x5 grid, N mines. Hubie reveals tiles one at a time and cashes out
   * (or hits a mine). Returns the full reveal sequence for animation.
   */
  function playMines(rng, balance, opts) {
    opts = opts || {};
    var size = 25, mineCount = opts.mines || pick(rng, [3, 3, 4, 5]);
    var bet = Math.min(opts.bet || 5000, balance);
    var mines = {};
    while (Object.keys(mines).length < mineCount) mines[randInt(rng, 0, size - 1)] = true;
    // multiplier ladder per safe reveal (demo model)
    function multFor(revealed) {
      var safe = size - mineCount;
      var m = 1, remaining = size;
      for (var i = 0; i < revealed; i++) { m *= remaining / (remaining - mineCount); remaining--; }
      return round2(m * 0.98);
    }
    var order = [];
    var pool = [];
    for (var i = 0; i < size; i++) pool.push(i);
    // shuffle reveal order
    for (var j = pool.length - 1; j > 0; j--) { var k = Math.floor(rng() * (j + 1)); var t = pool[j]; pool[j] = pool[k]; pool[k] = t; }
    var cashOutAfter = randInt(rng, 2, 8); // Hubie's "nerve" for this round
    var revealed = 0, hitMine = false, steps = [];
    for (var p = 0; p < pool.length; p++) {
      var tile = pool[p];
      if (mines[tile]) { hitMine = true; steps.push({ tile: tile, mine: true }); break; }
      revealed++;
      steps.push({ tile: tile, mine: false, multiplier: multFor(revealed) });
      if (revealed >= cashOutAfter) break;
    }
    var multiplier = hitMine ? 0 : multFor(revealed);
    var payout = hitMine ? 0 : round2(bet * multiplier);
    return {
      game: 'Mines', bet: bet, mineCount: mineCount, mines: Object.keys(mines).map(Number),
      steps: steps, revealed: revealed, hitMine: hitMine,
      multiplier: multiplier, win: !hitMine, payout: payout, profit: round2(payout - bet),
      bigWin: !hitMine && multiplier >= 3,
      summary: hitMine ? 'Hit a mine after ' + revealed + ' safe tiles' : 'Cashed out after ' + revealed + ' tiles at ' + multiplier + 'x'
    };
  }

  /* ---------------- PLINKO ----------------
   * Ball drops through 8 rows of pegs, lands in a multiplier slot.
   */
  var PLINKO_SLOTS = [8.9, 2.1, 1.1, 0.6, 0.3, 0.6, 1.1, 2.1, 8.9]; // 8 rows -> 9 slots (demo)
  function playPlinko(rng, balance, opts) {
    opts = opts || {};
    var bet = Math.min(opts.bet || 5000, balance);
    var rows = 8, path = [], rights = 0;
    for (var i = 0; i < rows; i++) { var right = rng() < 0.5; path.push(right ? 'R' : 'L'); if (right) rights++; }
    var multiplier = PLINKO_SLOTS[rights];
    var payout = round2(bet * multiplier);
    return {
      game: 'Plinko', bet: bet, path: path, slot: rights, multiplier: multiplier,
      win: multiplier >= 1, payout: payout, profit: round2(payout - bet),
      bigWin: multiplier >= 2, summary: 'Ball landed in the ' + multiplier + 'x slot'
    };
  }

  /* ---------------- SLOTS (casino-break segment) ----------------
   * OUR OWN in-scene demo slot, played only as a short BREAK between the
   * House originals — it is not a fourth rotation game (see Session).
   * 3 reels, weighted symbol stops, paytable-driven wins, a pair returns
   * the stake (push), and two high-value symbols on the first reels with
   * the third missing is the classic near-miss tease. Demo model only.
   */
  var SLOT_SYMBOLS = ['Cherry', 'Coin', 'Dice', 'Star', 'Gem', 'Seven', 'Hubie'];
  var SLOT_WEIGHTS = { Cherry: 24, Coin: 21, Dice: 18, Star: 15, Gem: 11, Seven: 7, Hubie: 4 }; // per 100 stops
  var SLOT_PAYTABLE = { Hubie: 50, Seven: 25, Gem: 12, Star: 8, Dice: 5, Coin: 3, Cherry: 2 };    // 3-of-a-kind multipliers
  function spinReel(rng) {
    var roll = rng() * 100, acc = 0;
    for (var i = 0; i < SLOT_SYMBOLS.length; i++) {
      acc += SLOT_WEIGHTS[SLOT_SYMBOLS[i]];
      if (roll < acc) return SLOT_SYMBOLS[i];
    }
    return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
  }
  function playSlots(rng, balance, opts) {
    opts = opts || {};
    var bet = Math.min(opts.bet || 5000, balance);
    var reels = [spinReel(rng), spinReel(rng), spinReel(rng)];
    var three = reels[0] === reels[1] && reels[1] === reels[2];
    var pair = !three && (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]);
    var pairSymbol = reels[0] === reels[1] ? reels[0] : (reels[1] === reels[2] ? reels[1] : reels[0]);
    var multiplier = three ? SLOT_PAYTABLE[reels[0]] : (pair ? 1 : 0); // pair = stake back (push)
    var payout = round2(bet * multiplier);
    // Near-miss tease: a Seven/Hubie pair lands on the first two reels and
    // the third reel misses — the "so close" moment every slot player knows.
    var nearMiss = !three && reels[0] === reels[1] && (reels[0] === 'Seven' || reels[0] === 'Hubie');
    return {
      game: 'Slots', bet: bet, reels: reels, three: three, pair: pair && !three,
      multiplier: multiplier, win: three, payout: payout, profit: round2(payout - bet),
      bigWin: three && multiplier >= 10, nearMiss: nearMiss,
      summary: three ? 'Three ' + reels[0] + ' on the reels' :
        (pair ? 'A pair of ' + pairSymbol + ' — stake back' : 'Reels came up ' + reels.join(', '))
    };
  }

  var PLAYERS = { Dice: playDice, Mines: playMines, Plinko: playPlinko };
  var GAME_NAMES = Object.keys(PLAYERS);

  /*
   * Session: holds the demo balance and plays rounds forever.
   * Rotates games in blocks so segments vary; never touches real money.
   */
  function Session(seed, startBalance) {
    this.rng = makeRng(seed || (Date.now() % 2147483647));
    this.balance = startBalance || 100000; // DEMO coins, worth nothing
    this.startBalance = this.balance;
    // Streamer-style balance story (2026-11-07 redesign): Hubie starts on a
    // 100,000 demo roll, stakes a percentage of the CURRENT balance like a
    // real streamer, and when the roll can no longer cover sensible play
    // (< 5,000) he BUSTS and a narrated demo RELOAD lands (50k or 100k).
    // There is no quiet auto-refill any more — busts and reloads are events,
    // tracked here (reloads count + total bought in, initial roll included).
    this.reloads = 0;
    this.totalBoughtIn = this.balance;
    this.pendingReload = null;
    this.lastWasWin = false;
    this.round = 0;
    this.wins = 0; this.losses = 0; this.streak = 0; this.bestStreak = 0;
    this.bigWins = 0; this.totalWagered = 0;
    this.currentGame = GAME_NAMES[0];
    this.roundsInGame = 0;
    this.gameBlockSize = 4; // rounds per game before rotating (scene may override)
    // Casino-break bookkeeping: the originals are the main show. After every
    // 2 FULL rotations of the originals (a rotation = one block of each),
    // Hubie takes a short Slots break, then the originals resume.
    this.blocksCompleted = 0;   // original blocks finished since the last break
    this.inBreak = false;
    this.breakSpinsLeft = 0;
    this.breakEveryRotations = 2;
    this.breakLength = 5;       // spins per slot break
  }
  Session.prototype.nextBet = function (opts) {
    // Percentage staking off the current roll, like a real streamer:
    // base bets run 1-2.5% of balance (floor ~500, rounded to clean 250s);
    // a "send-it" bet runs ~5% (slot-break spins and post-win presses draw
    // it more often — the caller decides via opts.sendIt). When the roll
    // runs hot the tiers press up with it (>=250k: x1.5, >=500k: x2), so a
    // long stream can genuinely climb toward 500k / 1M. Outcomes stay fair;
    // only the sizing moves.
    opts = opts || {};
    var tier = this.balance >= 500000 ? 2 : this.balance >= 250000 ? 1.5 : 1;
    var pct = opts.sendIt ? 0.05 : pick(this.rng, [0.01, 0.015, 0.02, 0.025]);
    var raw = this.balance * pct * tier;
    var bet = Math.round(raw / 250) * 250;
    bet = Math.max(500, bet);
    bet = Math.min(bet, Math.floor(this.balance)); // never more than the roll
    return bet;
  };
  Session.prototype._maybeReload = function () {
    // Bust check: below ~5,000 the roll cannot cover sensible play.
    if (this.balance >= 5000 || this.pendingReload) return;
    var amount = pick(this.rng, [50000, 100000]);
    this.balance += amount;
    this.reloads++;
    this.totalBoughtIn += amount;
    this.pendingReload = {
      amount: amount, count: this.reloads, totalIn: this.totalBoughtIn
    };
  };
  Session.prototype.rotateGame = function () {
    var others = GAME_NAMES.filter(function (g) { return g !== this.currentGame; }.bind(this));
    this.currentGame = pick(this.rng, others.length ? others : GAME_NAMES);
    this.roundsInGame = 0;
    return this.currentGame;
  };
  Session.prototype.playRound = function () {
    this._maybeReload(); // a bust lands its reload BEFORE the next bet
    if (this.inBreak) {
      // Slot break in progress — spins come from the slot engine only.
      // Break spins send it more often (30%): the break is the showpiece.
      var spinSend = this.rng() < 0.30;
      var spinBet = this.nextBet({ sendIt: spinSend });
      var spin = playSlots(this.rng, this.balance, { bet: spinBet });
      spin.sendIt = spinSend;
      return this._settle(spin, true);
    }
    if (this.roundsInGame >= this.gameBlockSize) {
      this.blocksCompleted++;
      var blocksPerRotation = GAME_NAMES.length;
      if (this.blocksCompleted >= this.breakEveryRotations * blocksPerRotation) {
        // Two full original rotations done — casino break, then resume.
        this.blocksCompleted = 0;
        this.inBreak = true;
        this.breakSpinsLeft = this.breakLength;
        this.currentGame = 'Slots';
        this.roundsInGame = 0;
        return this.playRound();
      }
      this.rotateGame();
    }
    // Send-it: ~12% of ordinary rounds, ~25% right after a win (pressing).
    var sendIt = this.rng() < (this.lastWasWin ? 0.25 : 0.12);
    var bet = this.nextBet({ sendIt: sendIt });
    var result = PLAYERS[this.currentGame](this.rng, this.balance, { bet: bet });
    result.sendIt = sendIt;
    return this._settle(result, false);
  };
  Session.prototype._settle = function (result, isBreakSpin) {
    if (isBreakSpin) {
      this.breakSpinsLeft--;
      if (this.breakSpinsLeft <= 0) {
        this.inBreak = false;
        this.currentGame = GAME_NAMES[0];
        this.roundsInGame = 0;
      }
    }
    this.balance = round2(this.balance - result.bet + result.payout);
    this.round++; if (!isBreakSpin) this.roundsInGame++;
    this.totalWagered += result.bet;
    if (result.win) { this.wins++; this.streak = this.streak > 0 ? this.streak + 1 : 1; }
    else { this.losses++; this.streak = this.streak < 0 ? this.streak - 1 : -1; }
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;
    if (result.bigWin) this.bigWins++;
    this.lastWasWin = !!result.win;
    if (this.pendingReload) { // surface the bust/reload on this round's result
      result.reload = this.pendingReload;
      this.pendingReload = null;
    }
    result.balanceAfter = this.balance;
    result.streak = this.streak;
    result.round = this.round;
    return result;
  };

  return {
    makeRng: makeRng, playDice: playDice, playMines: playMines, playPlinko: playPlinko,
    playSlots: playSlots, SLOT_SYMBOLS: SLOT_SYMBOLS, SLOT_PAYTABLE: SLOT_PAYTABLE,
    PLINKO_SLOTS: PLINKO_SLOTS, GAME_NAMES: GAME_NAMES, Session: Session
  };
});
