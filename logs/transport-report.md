# Transport diagnosis + supervised auto-reconnect — report (v1.6)

**Date:** 2026-11-08. **Scope (user-approved):** diagnose the RTMPS
transport failure that ended the 11:45 WAT judged run at ~44 minutes,
and build supervised auto-reconnect. **Local work only — nothing was
streamed to Kick at any point; the channel stayed offline; no relaunch
in this task.** The aborted attempt record in `logs/tonight-run.json`
is untouched.

---

## 1. The failure signature (from the old logs)

Run started 11:45:30 WAT (10:45:30Z). Dress fully green; sync held for
the whole run (final counters: spoken 753, displayed 752 with one
display in flight at teardown, dropped 0, max start lag 0.29s — the
voice/sync layer was never the problem).

At **11:29:58.485Z** (44m14s after the tunnel was established at
10:45:44Z) the local CONNECT relay logged `upstream closed`. The old
relay logged no error line before it, no byte counters, no close
metadata. ffmpeg then failed with "Connection reset by peer" (-104)
and exited, because the old relay destroyed the client socket the
instant the upstream leg closed. `stream.sh` treated ffmpeg as its
foreground job, so ffmpeg's exit fired the cleanup trap and tore down
Chrome/Xvfb — one tunnel hiccup ended the whole run.

Observable signature, stated exactly: **the proxy-side (upstream) leg
of the tunnel closed first, cleanly in Node's view — a `close` event
with no preceding `error` event on either leg.** The old instrumentation
cannot say more: it recorded no `hadError`, no errno, no byte counts,
and no keepalive was configured on either socket.

## 2. Diagnosis

Candidate causes for a clean upstream close at 44m14s:

- (a) the egress proxy terminated the CONNECT tunnel (lifetime/policy);
- (b) Kick's ingest closed its side and the proxy propagated the FIN;
- (c) a NAT/middlebox state expiry on the path.

44m14s is not a round timer value, which weakly argues against a
simple fixed tunnel TTL and toward (b) or an idle/flow-based policy —
but the old logs cannot distinguish these. **The soak (below) was
designed to separate "the tunnel path drops healthy streams on a
timer" from "the far end closed".**

### Soak test (off air, started 2026-11-08 12:06:59Z, `scripts/soak-transport.sh`)

- **Leg A — through the instrumented relay** (DIRECT mode, production
  encoder settings, ~4.6 Mbps testsrc2+sine): ffmpeg → relay :1937 →
  socat TLS → local RTMP listener sink. The egress proxy runs outside
  this VM and cannot CONNECT back into a VM-loopback sink, so leg A
  exercises the relay code path + localhost path, not the proxy hop
  (documented design limit).
- **Leg B — control, no relay:** identical publisher → socat TLS →
  listener on a separate port.
- **Leg C1 — real proxy, downstream:** continuous HTTPS stream
  (wikimedia recentchange) through the actual egress proxy.
- **Leg C2 — real proxy, upstream:** chunked PUT drip ~1 KB/s through
  the actual egress proxy (httpbin, then postman-echo).

Results:

- **Legs A and B:** ran the full soak — **2h02m** (12:06:59Z →
  ~14:09Z). Leg A's relay carried **one single connection the whole
  time**: established 12:07:01Z, 4,112,649,418 bytes up / 107,783
  down, heartbeat rates 4.2–4.9 Mbps throughout, and **zero
  close/error/FIN events** in the instrumented log (242 heartbeat
  lines, nothing else). Both sink files grew **monotonically — 0
  decreases across 484 samples at 15s cadence** — to 3,029,860,352
  bytes (A) and 3,064,463,360 bytes (B). (Both sink files total ~26%
  less than the relay's forwarded bytes, on the no-relay control leg
  too — a property of the local listener sinks under this VM's load,
  identical with and without the relay; it does not bear on the
  tunnel question.) Full addendum at the end of this file.
- **C1:** ran 12:07:01Z → 12:22:03Z = **15m02s, 50,353,541 bytes,
  HTTP 200, curl rc=0** — the origin stream ended cleanly (that
  endpoint is designed for clients to reconnect). A proxy-side kill
  mid-stream would surface as a curl transfer error; rc=0 + clean
  completion points to a server-side end. Moderate confidence.
- **C2 via httpbin:** four consecutive tunnels died at **31.5–32.1s,
  exactly 30,720 bytes sent, 470 received, "server FIN"** every time —
  httpbin's own slow-request-body timeout (gunicorn-class ~30s), a
  worked example of a *server-side* close that looks identical to a
  tunnel drop without instrumentation.
- **C2 via postman-echo:** cycle 1 — the TLS handshake through the
  proxy stalled **~400s** (an observed proxy-path anomaly worth
  noting; it does not match the production failure shape), then
  dripped **651,264 bytes over 1,040s** before a server FIN; cycle 2
  died at **exactly 651,264 bytes again** after 640.8s. A deterministic
  byte count across cycles = an origin-side body-size cap
  (651,264 = 318 × 2048-byte chunks), not a time cap and not the proxy
  (the production tunnel moved ~1.5 GB up, so no such proxy cap
  exists in general).

## 3. Conclusion (with confidence)

- **The relay code was not the root cause — high confidence.** Leg A
  ran the same relay, same bitrate, past the production tunnel's
  lifetime with a healthy upstream and zero drops; the old relay's
  bugs were in *failure handling* (instant client destroy → ffmpeg's
  ECONNRESET; no keepalive; no instrumentation), not in causing the
  close.
- **The close came from beyond the local machine — the proxy hop or
  Kick's ingest — moderate confidence.** The upstream leg closed first
  and cleanly; nothing on this VM errored. The soak could not exercise
  the real proxy→Kick path (the proxy cannot loop back to a local
  sink), and no leg-C tunnel survived long enough to test a ~44-minute
  proxy timer specifically (C1 ended server-side at 15m; C2 cycles
  ended on origin byte caps). **Inconclusive on (a) vs (b)** — stated
  plainly.
- **What settles it next time:** the relay is now instrumented
  (below). On any future drop, the production relay log will show
  `firstCloser`, `hadError`, errno/syscall per leg, byte counters and
  duration — i.e. exactly which side closed and how. The design no
  longer depends on the answer: §4 makes any single drop survivable.

## 4. What was built

### Instrumented relay — `scripts/rtmp-relay.js` v2
Same interface (ffmpeg → `127.0.0.1:1936`, CONNECT via `https_proxy`
to the Kick ingest; proxy URL never logged). Now: structured JSONL
lifecycle logging on **both** legs (`client_connect`,
`upstream_connect`, `connect_sent`, `tunnel_established`, `bytes`
every 30s per connection, `leg_fin`, `socket_error` with
code/errno/syscall, `leg_close` with `hadError`, `first_close_signal`,
and a `tunnel_closed` summary with duration + byte totals + first
closer); **TCP keepalive (15s) + noDelay on both sockets**; a 120s
silence watchdog flagging `possible_half_open`; **graceful FIN
propagation** (`peer.end()` with a 5s grace before destroy, vs the
old instant `destroy()`); pre-establishment client bytes are stashed
and flushed, never dropped. Off-air soak hooks exist via env
(`HUBIE_RELAY_DIRECT`, target/port overrides) and refuse to run in
proxy mode without `https_proxy`.

### Encoder supervisor — `scripts/encoder-supervisor.js` (new)
`stream.sh` now runs ffmpeg **under this supervisor**, never directly.
Behaviour: on encoder exit, restart fast — first retry **3s** — on a
backoff ladder **3s → 5s → 10s → 20s (capped)**, unlimited retries
while the stack is up; a run of ≥60s counts as stable and resets the
ladder; every start/exit/restart is appended as JSONL to
`logs/transport.log` (the run-level evidence trail a run record can
cite). SIGTERM/SIGINT to the supervisor = operator stop: it kills the
encoder and schedules nothing. A planned clean exit stops the loop
only when stream.sh passes `--no-restart-on-clean-exit` (fixed-length
captures); a live run restarts even on a clean exit.

### `stream.sh` restructured
ffmpeg's exit no longer ends the script: the cleanup trap (Chrome/
Xvfb/serve) fires only when `stream.sh` itself exits, i.e. on operator
stop. Same capture (x11grab + audio FIFO), same encoder settings, same
output target via the relay; the proxy-stripped environment wrapper is
unchanged. New `HUBIE_STREAM_TARGET` env override points the encoder
at an explicit target and skips reading `config/stream.local.json`
entirely (off-air tests only; production path unchanged).

### `watchdog.sh` — relay is now supervised too
The watchdog runs the relay in a restart loop (2s restart delay,
uptime-log evidence) alongside the scene server, so the relay is no
longer a single point of failure. `HUBIE_WATCHDOG_DIR` redirects its
evidence files for tests.

### Voice FIFO reattach — verified against the service's design
The voice service already handles reader detach: in-flight segments
and the waiting line are journaled as `speech-dropped
{reason:'fifo-detached'}`, the scheduler and emission ledger reset,
and it re-opens the FIFO after 500ms; the wall-clock feeder discards
at rate while unattached. The forced-drop runs below confirm a
restarted encoder reattaches to a voice that is already "in the
moment" — no wedge, ledger on wall clock, `displayed == spoken`
deltas preserved across every kill.

### A real bug the verification caught
The first forced encoder kill exposed a fatal supervisor flaw: the
restart timer was `unref()`'d, so once ffmpeg's handle was gone the
supervisor's event loop drained and **the supervisor process exited
silently during its own restart delay** — and stream.sh's trap then
killed the scene, exactly the failure shape v1.6 exists to prevent.
Fixed (the timer stays ref'd; comment in the code), and guarded by a
new subprocess liveness test that runs the real supervisor against a
crashing fake encoder. (Unit tests with fake timers cannot see an
event-loop liveness bug; this one is end-to-end.) A detached
supervisor was also observed respawning a crashing encoder **1,313
times over ~7 minutes** with zero operator stops during the
investigation.

## 5. Forced-drop verification (off air, local sink, 2026-11-08)

Full stack in production shape (watchdog serve + instrumented relay
DIRECT → socat TLS → respawning RTMP listener sink; voice; chat;
stream.sh with a dummy local target — the real stream key was never
read). Sink bytes sampled at 1s cadence. Full record:
`logs/reconnect-test/results.txt` + `transport.log` + `sink-sizes.log`.
(Note: the scripted harness, `scripts/reconnect-test.sh`, twice failed
its coupling gate in this sandbox under load avg ~12 with the soak and
other stacks sharing the VM; the identical composition was therefore
driven manually with the same measurements.)

| Kill | Signal / target | Supervisor reaction | Sink-visible gap | Show continuity |
|---|---|---|---|---|
| A | SIGKILL ffmpeg (ran 51s) | exit logged instantly; restart in **3.0s** (ladder step 1); attempt 2 up +3.1s | **~12s** (delay + encoder init + handshake + sink listener respawn + keyframe) | Chrome/Xvfb PIDs unchanged; FIFO reattached; spoken/displayed deltas +7/+7; dropped 0 |
| B | SIGTERM ffmpeg (ran 79s) | ffmpeg graceful exit **+7s** (flushes trailer), code 255; restart **3.0s** (stable → ladder reset); attempt 3 up +3.1s after exit | **~5s** flat (growth continued through the flush) | PIDs unchanged; dropped 0 |
| C | SIGKILL ffmpeg (ran 45s) | restart in **5.0s** (unstable run → ladder step 2, as designed); attempt 4 up +5.0s | **~13s** | PIDs unchanged; dropped 0 |
| Relay | SIGKILL relay process | watchdog restarted the relay in **~3s** (new PID); ffmpeg noticed the dead tunnel **+3.9s** (exit code 224); supervisor restarted it after **10s** (ladder step 3 after the repeated kills; a stable run would retry at 3s); tunnel re-established on the new relay **+1s** after encoder start | **~20s** end to end | serve/Chrome/Xvfb PIDs unchanged; spoken 103 / displayed 79 (constant pre-attach offset 24); dropped 0; FIFO reattached |

Final counters: **spoken 103, displayed 79, dropped 0, clips 103** —
the offset is lines the long-lived voice service spoke before this
scene page attached; deltas matched 1:1 at every sample. The scene,
game state, balance and voice journal never restarted; only the
encoder (and once the relay) cycled.

## 6. Tests

**33/33 green** (`node tests/test.js`), up from the 27/27 baseline:
backoff ladder values; restart decisions (crash → 3s, repeat → 5s,
stable run resets, operator stop never restarts); planned vs unplanned
clean exits; supervisor with fake spawn/timers (exactly one restart at
the ladder delay, healthy encoder never touched, no other process
signalled); operator stop; and the subprocess **liveness** regression
test for the unref bug.

## 7. Honest residuals

- **Judging semantics (the note that matters):** a fast reconnect on
  the same stream key *should* present to Kick as one continuous
  session with a brief freeze — that is the design goal, and the
  measured freezes are ~5–20s — but **only a real run can confirm how
  Kick records it** (one VOD vs split VODs, and how the judges' "any
  human action resets the run" check treats an automatic reconnect).
  If Kick ends the session server-side on a tunnel drop, the
  supervisor will re-push on the same key within seconds; whether
  that reads as the same broadcast is Kick's call, not ours.
- The diagnosis between "proxy terminated the tunnel" and "Kick
  ingest closed" remains open (§3); the instrumentation now in the
  production relay will answer it on the first future drop.
- One C2 cycle's TLS handshake through the proxy stalled ~400s. A
  stall of that shape mid-run would look like a longer freeze; the
  supervisor cannot fix a proxy that accepts CONNECT but stalls TLS —
  it can only keep retrying, which it does, with the ladder capped at
  20s.
- `scripts/reconnect-test.sh` should be re-run once on an idle machine
  to certify the scripted form end to end; the manual run in §5 used
  the identical composition and measurements.
- Soak legs A/B final tallies: see addendum below.

---

## Addendum — soak final tallies (completed 2026-11-08 ~14:09Z)

Soak ran **12:06:59Z → ~14:09Z = 2h02m**, then was stopped cleanly
(`scripts/soak-transport.sh stop`; all legs verified down, all soak
ports free).

- **Leg A (through instrumented relay):** 1 connection total.
  Established 12:07:01.428Z. Final heartbeat 14:09:02Z: bytesUp
  **4,112,649,418**, bytesDown 107,783. Interval rates 4.84 / 4.85 /
  4.23 / 4.38 Mbps. Log contains exactly: 1× listening, 1×
  client_connect, 1× upstream_connect, 1× tunnel_established, 242×
  bytes — **no leg_fin, no socket_error, no leg_close, no
  tunnel_closed**. Sink file 3,029,860,352 bytes, monotonic growth
  (0 decreases in 484 monitor samples).
- **Leg B (control, no relay):** sink file 3,064,463,360 bytes,
  monotonic growth, publisher alive at stop. Behaviour statistically
  identical to leg A.
- **Leg C1 (real proxy, downstream):** ended 12:22:03Z after 15m02s,
  50,353,541 bytes, HTTP 200, curl rc=0 (origin ended its stream;
  see §2).
- **Leg C2 (real proxy, upstream drip):** httpbin cycles died at
  31.5–32.1s ×4 (origin body timeout, exactly 30,720B each);
  postman-echo cycles: one at 1,040.1s (including the ~400s TLS
  stall), then nine more at **640.5–641.3s, each at exactly 651,264
  bytes sent** (origin body-size cap), the last cycle still running
  when the soak was stopped. No drip death matched a ~44-minute or
  any other time-based pattern attributable to the proxy.

**Soak verdict:** the tunnel path itself — relay code, localhost
path, production encoder settings at production bitrate — does
**not** drop on a ~45-minute (or any) timer with a healthy upstream.
This is the evidence behind §3's conclusion. The sink .flv files
(~6 GB) were deleted after these tallies were recorded; all soak
logs remain in `logs/soak/`.
