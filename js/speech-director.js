/*
 * Hubie speech director — the COUPLED sync layer (v1.4, 2026-11-08).
 *
 * Why it exists: in the judged run of 2026-11-08 the commentary engine
 * produced ~439 lines in 13 minutes; the voice service spoke 190 and
 * silently dropped 249 (114 stale + 135 overflow). The scene displayed
 * EVERY generated line as a subtitle the instant it was generated, so
 * the screen and the voice routinely said different things and the user
 * ended the run: "what's on screen different from what's playing".
 *
 * The fix makes the voice service the single source of truth for what
 * is being said, and this director is the scene-side half:
 *
 *   1. PACING (backpressure). Commentary is submitted as INTENTS, not
 *      lines. An intent is a lazy generator (make() -> {text, pace})
 *      plus a kind, a priority and an optional TTL. The director holds
 *      at most ONE pending intent behind the line currently in the
 *      voice. A pending intent is only GENERATED (its line produced and
 *      posted to the voice service) at the moment a speech slot opens,
 *      so lines are never produced faster than they can be spoken.
 *      A fresher intent whose priority is >= the pending intent's
 *      replaces it (counted: intentsReplaced); a lower-priority
 *      newcomer is turned away (counted: intentsDropped); a pending
 *      intent whose moment passes (TTL) expires (counted:
 *      intentsExpired). Results outrank everything but the closing
 *      sign-off; anticipation outranks sizing; rewards are filler and
 *      are expected to lose most contests for the slot — that is the
 *      point of filler under pacing.
 *
 *   2. SUBTITLE COUPLING. In coupled mode the director NEVER displays a
 *      line at submit or send time. The scene renders a subtitle only
 *      when handleEvent() receives the voice service's speech-started
 *      event for that line id (the service emits it at the exact tick
 *      the line's first audio byte is clocked into the stream), and
 *      clears it on speech-ended. By construction, displayed == spoken:
 *      nothing is on screen that is not being spoken at that moment.
 *      Events carry ids, so reconnect replay can never double-display.
 *
 *   3. RECONCILIATION. If the event stream drops and reconnects, the
 *      service sends a sync snapshot {speakingId, speakingText,
 *      waitingId}; reconcile() repairs the director's view (a line that
 *      finished while we were away frees the slot; a line speaking now
 *      that we somehow never displayed gets displayed from the snapshot).
 *
 * Modes: 'local' (no voice bridge — demo bundle, file://, or the bridge
 * configured but its event stream never connected: lines display
 * immediately at generation, exactly the pre-v1.4 behaviour, so the
 * show always carries on) and 'coupled' (bridge events connected).
 * The mode is reported in stats() so verification knows which regime a
 * session ran under; displayed==spoken is only claimed for coupled.
 *
 * Pure logic, UMD like js/commentary.js: window.HubieSpeech in the
 * browser, module.exports in Node (the test suite drives it directly).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubieSpeech = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Priority ladder (higher wins the single pending slot). Results are
   * the point of the stream; the closing sign-off outranks even them so
   * a graceful stop can never lose its last line to a late result. */
  var PRIORITY = {
    closing: 110,
    result: 100,
    anticipation: 80,
    chat: 70,
    segment: 65,
    sizing: 60,
    reminder: 45,
    opening: 40,
    rewards: 10,
    idle: 10
  };

  function Director(opts) {
    opts = opts || {};
    this.post = opts.post || function () {};             // (line {id,text,pace}) -> voice service
    this.onDisplay = opts.onDisplay || function () {};   // (evt {id,text,mood,kind}) on speech-started
    this.onClear = opts.onClear || function () {};       // (evt {id}) on speech-ended of the displayed line
    this.now = opts.now || function () { return Date.now(); };
    this.mode = 'local';
    this.seq = 0;
    this.outstanding = null;   // { id, intent, sentAt, startedAt } — sent, not yet ended/dropped
    this.pending = null;       // one intent or null (only while outstanding exists)
    this.displayedId = null;
    this.displayedIds = {};    // every id ever displayed (dedupe across local/coupled/replay)
    // Telemetry (mirrored to the voice service /sync endpoint).
    this.intentsSubmitted = 0;
    this.linesGenerated = 0;   // lines actually produced + posted (the paced successor of "produced")
    this.intentsReplaced = 0;
    this.intentsDropped = 0;
    this.intentsExpired = 0;
    this.displayed = 0;
    this.serviceDropped = 0;   // lines the service's safety net dropped after we sent them
    this.resultLagCount = 0;
    this.lastResultLagMs = null;
    this.maxResultLagMs = 0;
    var self = this;
    if (opts.sweep !== false && typeof setInterval === 'function') {
      this._sweep = setInterval(function () { self.expireCheck(); }, 200);
      if (this._sweep && this._sweep.unref) this._sweep.unref();
    }
  }

  Director.prototype.setMode = function (mode) { this.mode = mode; };

  Director.prototype._normalize = function (spec) {
    var intent = {
      kind: spec.kind || 'idle',
      priority: spec.priority != null ? spec.priority : (PRIORITY[spec.kind] || 0),
      mood: spec.mood,
      ttlMs: spec.ttlMs != null ? spec.ttlMs : null,
      make: spec.make,
      createdAt: this.now()
    };
    return intent;
  };

  /* Produce the intent's line and post it to the voice service.
   * Returns false when the generator produced nothing usable. */
  Director.prototype._release = function (intent) {
    var line = intent.make ? intent.make() : null;
    if (!line || !line.text) { this.intentsDropped++; return false; }
    var id = 'L' + (++this.seq);
    this.linesGenerated++;
    this.outstanding = { id: id, intent: intent, sentAt: this.now(), startedAt: null };
    this.post({ id: id, text: line.text, pace: line.pace || 'normal' });
    return true;
  };

  Director.prototype.expireCheck = function () {
    if (this.pending && this.pending.ttlMs != null &&
        this.now() - this.pending.createdAt > this.pending.ttlMs) {
      this.pending = null;
      this.intentsExpired++;
    }
  };

  /* After the outstanding line ends/drops: release the pending intent. */
  Director.prototype._pump = function () {
    if (this.outstanding || !this.pending) return;
    this.expireCheck();
    if (!this.pending) return;
    var intent = this.pending;
    this.pending = null;
    this._release(intent);
  };

  /* Submit a commentary intent. Returns how it was resolved:
   * 'sent' | 'pending' | 'replaced' | 'dropped'. */
  Director.prototype.submit = function (spec) {
    var intent = this._normalize(spec || {});
    this.intentsSubmitted++;
    if (this.mode === 'local') {
      // Uncoupled regime: generate + display now (pre-v1.4 behaviour),
      // still post to the bridge when one is configured.
      var line = intent.make ? intent.make() : null;
      if (!line || !line.text) { this.intentsDropped++; return 'dropped'; }
      var id = 'L' + (++this.seq);
      this.linesGenerated++;
      this.displayedIds[id] = true;
      this.displayedId = id;
      this.displayed++;
      this.onDisplay({ id: id, text: line.text, mood: intent.mood, kind: intent.kind });
      this.post({ id: id, text: line.text, pace: line.pace || 'normal' });
      return 'sent';
    }
    this.expireCheck();
    if (!this.outstanding && !this.pending) {
      return this._release(intent) ? 'sent' : 'dropped';
    }
    if (!this.pending) { this.pending = intent; return 'pending'; }
    if (intent.priority >= this.pending.priority) {
      this.intentsReplaced++;
      this.pending = intent;
      return 'replaced';
    }
    this.intentsDropped++;
    return 'dropped';
  };

  /* Voice-service speech events (SSE). The service is the truth: a
   * line is displayed exactly when its speech-started arrives and
   * cleared exactly when its speech-ended arrives. */
  Director.prototype.handleEvent = function (evt) {
    if (!evt || !evt.id) return;
    if (evt.type === 'speech-started') {
      if (this.displayedIds[evt.id]) return; // replay/local overlap: shown already
      this.displayedIds[evt.id] = true;
      this.displayed++;
      this.displayedId = evt.id;
      var intent = (this.outstanding && this.outstanding.id === evt.id) ? this.outstanding.intent : null;
      if (this.outstanding && this.outstanding.id === evt.id) {
        this.outstanding.startedAt = evt.ts || this.now();
      }
      var lagMs = null;
      if (intent && intent.kind === 'result') {
        lagMs = (evt.ts || this.now()) - intent.createdAt;
        this.resultLagCount++;
        this.lastResultLagMs = lagMs;
        if (lagMs > this.maxResultLagMs) this.maxResultLagMs = lagMs;
      }
      this.onDisplay({
        id: evt.id, text: evt.text,
        mood: intent ? intent.mood : undefined,
        kind: intent ? intent.kind : undefined,
        lagMs: lagMs
      });
      return;
    }
    if (evt.type === 'speech-ended' || evt.type === 'speech-dropped') {
      if (evt.type === 'speech-dropped') this.serviceDropped++;
      if (this.displayedId === evt.id) {
        this.displayedId = null;
        this.onClear({ id: evt.id });
      }
      if (this.outstanding && this.outstanding.id === evt.id) {
        this.outstanding = null;
        this._pump();
      }
    }
  };

  /* Repair state from the service's sync snapshot after a reconnect:
   * a line that finished while the event stream was down frees the
   * slot; the line speaking right now is displayed if we missed its
   * start (journal replay normally covers this — belt and braces). */
  Director.prototype.reconcile = function (sync) {
    if (!sync) return;
    if (this.outstanding &&
        this.outstanding.id !== sync.speakingId &&
        this.outstanding.id !== sync.waitingId) {
      if (this.displayedId === this.outstanding.id) {
        this.displayedId = null;
        this.onClear({ id: this.outstanding.id });
      }
      this.outstanding = null;
      this._pump();
    }
    if (sync.speakingId && this.outstanding &&
        this.outstanding.id === sync.speakingId &&
        !this.displayedIds[sync.speakingId] && sync.speakingText) {
      this.handleEvent({ type: 'speech-started', id: sync.speakingId, text: sync.speakingText, ts: this.now() });
    }
  };

  Director.prototype.stats = function () {
    return {
      mode: this.mode,
      coupled: this.mode === 'coupled',
      intentsSubmitted: this.intentsSubmitted,
      linesGenerated: this.linesGenerated,
      intentsReplaced: this.intentsReplaced,
      intentsDropped: this.intentsDropped,
      intentsExpired: this.intentsExpired,
      displayed: this.displayed,
      serviceDropped: this.serviceDropped,
      resultLagCount: this.resultLagCount,
      lastResultLagMs: this.lastResultLagMs,
      maxResultLagMs: this.maxResultLagMs,
      pending: this.pending ? this.pending.kind : null,
      outstanding: this.outstanding ? this.outstanding.id : null
    };
  };

  Director.prototype.destroy = function () {
    if (this._sweep) { clearInterval(this._sweep); this._sweep = null; }
  };

  return { Director: Director, PRIORITY: PRIORITY };
});
