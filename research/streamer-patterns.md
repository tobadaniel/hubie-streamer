# Kick Slots Streamer Patterns — Research for Hubie Commentary v2

Researched 2026-11-07. Purpose: rebuild the commentary of Hubie (AI demo streamer)
so he talks the way real Kick casino/slots streamers talk, instead of narrating
in long sentences.

## Method and sources

- Channels checked read-only via Kick's public API (`/api/v2/channels/<slug>` and
  `/videos`). No login, no posting.
- One recent casino/slots VOD sampled per streamer (the most recent full one):
  - **jkolby** — "DEGEN TIME 👑 $1,250 START 👑 $25K LEADERBOARD 👑 GIVEAWAYS",
    2026-11-07, ~4h14m.
  - **jerzynft** — "$15,000 GIVEAWAY !GAMBA 🌟 SLOTS & CHARTS 🌟 $50,000+ MONTHLY",
    2026-11-06, ~3h38m.
  - **syken** — "POV: 10K OR NOTHING 🍀 $6,000 RACE IS LIVE", 2026-11-06, ~1h04m.
- Per streamer, 6 audio samples of 90 seconds were extracted from the VOD's HLS
  stream (audio only, 16 kHz mono): one near the opening, two mid-stream, one
  late, and two at loudness peaks found by an RMS scan (5-second windows) over a
  30-minute mid-stream pull. Samples are in `research/samples/`.
- Transcription: local, faster-whisper (base model, CPU, int8), word counts and
  burst statistics computed from the transcripts in `research/transcripts/`.
  Kick's own auto-caption track for each full VOD was also pulled
  (`research/captions-*.srt`) and used only as corroboration (phrase counts over
  the whole stream). Quotes below are from the whisper transcripts; whisper is
  imperfect on slang and crosstalk, so quotes are kept short and are evidence of
  shape, not court-grade wording.

---

## Per-streamer notes

### jerzynft — the high-energy solo slots grinder

The closest of the three to the classic Kick slots streamer. Talk is dense
(speech present ~80-88% of sampled time) but almost never in long sentences:
median burst 6-12 words, and the *reaction* bursts are 2-6 words.

- **Sizing is said out loud, in round numbers, before the action.** Sample opens
  mid-negotiation: "what is it, 500 bucks? … 400". Over the full VOD the caption
  track repeats "five hundred bucks" dozens of times, plus "two hundred".
  Bet figures are read off flatly when a challenge is set: "challenge is locked
  in, 50 bucks, 222x, 40, 32 dollars".
- **Hype = verbatim repetition, not adjectives.** Opening a loud segment:
  "Let's fucking ride, Chad. Let's fucking ride, Chad." Asking chat for games:
  "Guys, give me some slot calls. Give me some slot calls." A comeback win:
  "Oh my god, we're fucking back. We're fucking back. Oh my god." — the same
  3-4 word unit two or three times, then straight back to spinning ("run it").
- **Anticipation is a command to the game or himself:** "flip it, flip it to
  max, bro", "gotta go one more, bro."
- **Losses are stated flatly, with the number.** Arguing with a chatter who
  wants a cut: "I'm not giving you 10%. I'm down a thousand right now." Broke
  talk is self-deprecating: "damn, I'm broke as fuck anyways".
- **Silence is allowed.** One mid sample has a ~40-second near-silent stretch
  while a game plays out — he does not fill every second.
- **Chat is half the show.** Arrivals greeted by name ("Yo, Dumo, what's good
  dog, how you doing bro?"), follows thanked by name ("Thank you Carlos,
  appreciate the love"), chat asked for slot calls, trolls told to be banned.
  Between rounds the talk is social/admin, not game narration.

### jkolby — the hangout host; games are the backdrop

Streams with friends on mic, runs giveaways and a leaderboard; gameplay talk is
the *sparsest* of the three and the flattest. Median burst 12-17 words because
much of the talk is conversation and admin, but his actual game reactions are
3-6 words.

- **Opening has no intro monologue.** The sampled VOD opens with ~70 seconds of
  a motivational audio clip, then rapid-fire name greetings: "What's up Karan?
  What's up pads? What's up solar bands?…" — chat is greeted person by person.
- **Results are read flat and immediately replaced by "what's next".**
  "Okay, 60 cents. Okay, what's next?" A small win: "Not a super, but we take
  it." A good hit: "Bang, there we go, nice." / "Oh we're in, okay, good shit."
- **Budgets are counted in spins, not money:** "I'm gonna give this 25 more"
  (25 more spins), "what if we start doing point one spins and then I'll rinse
  it to zero".
- **Cold vocabulary:** a dead slot has him "cooked" — "we have cooked on the
  slot… it's always dead for me"; the session-level version: "we've kind of
  gotten cooked" (about the last few nights). Losing the balance back is
  "rinse": "let's withdraw this before I fucking rinse it all".
- **Switching is announced as a hop and put to chat.** Between segments he
  recaps ("we went from two soul to four soul… went back to two"), announces
  "we're going to hop over to gamba", and asks: "What do we do tonight, bro? Do
  we do a bonus hunt? Or do we just freestyle?"
- **Dry-spell talk is short pleading at the game:** "No, no, come on. You got
  to do something." One loudness-peak sample was 82% music/silence — long
  stretches where the game just runs.

### syken — rapid-fire duo banter, micro-reactions

Streams with a friend; the two trade one-liners. Highest talk density (speech
~90-100% of mid-stream samples) but the *shortest* bursts: median 3-6 words.
His stream is a near-constant drip of micro-reactions rather than commentary.

- **Greeting is a chant:** "Yo, yo, yo, what's good? what's good? what's good?"
  — the same phrase three times.
- **Reactions are verdicts of 1-3 words:** "Nice." "Jesus." "Oh no, bro."
  "That's crazy." "Brother, huh?" Disbelief gets repeated as a question:
  "10K buys?" … "10K buys?" / "a hundred dollar bonus buys?" said twice.
- **Anticipation is "imagine" + pleading.** "I may have a double back to back
  5 scatter. Imagine, bro." / "Imagine a 5-scat on this. Oh my god." During a
  spin: "Come on, Barra, please." … "Please."
- **The game is spoken to like a lazy person:** "You have done absolutely
  nothing. You need to wake your ass up." Frustration with a feature: "So
  tiring, bro. It's so tiring."
- **Bet sizes are plain and extreme in both directions:** "Let me do $2 for
  the other one." "I'm doing the last 50 on first." "$200 bonus buys" and
  "10K buys" discussed in the same breath. The number is stated, never
  explained.
- **Switching is casual and loyalty-based:** "I'll never stop playing Hacksaw."
  / "Maybe we'll go back to Rugs." — floated mid-conversation, decided on feel.

---

## Combined pattern synthesis

### The headline difference from narration
A narrator *describes finished events in sentences* ("The dice rolled a 74 and
we won 9,800 coins, bringing the balance to…"). These streamers **react in
real time in fragments**: a size before the spin, a plea during it, a 2-5 word
verdict at the reveal, and the number read flat. Everything else is chat.

### Session openings
No formal intro. A chant or greeting burst, arrivals greeted **by name** in
rapid succession, a one-line recap of last session ("we got cooked the past
couple nights"), and a loose plan posed as a question ("bonus hunt or
freestyle?"). Energy is front-loaded; details are not.

### Sizing callouts (before the bet/spin)
- The amount is announced **before** the action, as a plain round number,
  sometimes negotiated down out loud ("500 bucks? … 400").
- Budgets also come in spins ("give this 25 more").
- The stake is repeated when it's big — saying the number twice *is* the hype.

### Anticipation (during the round)
- Imperatives and pleading aimed at the game: "come on", "please", "do
  something", "flip it", "one more". (Hubie's own bank drops every
  "come"-based plea — user rule 2026-11-08: the doubled "let this
  one ___" plea sounds wrong to him — and runs on "pls pls pls", "just this time", "land it",
  "one time", "please. just land." instead. The pattern transfers; the
  wording is his.)
- "Imagine [the top outcome]" is the standard tease.
- The game is addressed as a person who can be scolded ("you have done
  absolutely nothing, wake up").

### Win reactions, graded
- **Small win (stake back to ~2x):** flat acceptance, 3-5 words, instantly on
  to the next spin: "not a super, but we take it", "okay, 60 cents, what's
  next?" No celebration.
- **Solid win:** a short chant — one phrase repeated twice ("we're back,
  we're back"), the amount read out, then "run it" (spin again immediately).
- **Massive win / huge multiplier:** disbelief loops — "oh my god" three-plus
  times, the multiplier or the buy size repeated as a question ("10K buys?…
  10K buys?"), references to the session story ("we're back" = the win undoes
  the session's losses). Even here the units are 2-5 words; the *volume and
  repetition* carry it, not vocabulary.

### Loss reactions
- Single loss: often nothing, or a 1-3 word verdict ("unlucky", "dead").
- The loss is sometimes read as a session figure, plainly: "I'm down a
  thousand right now."
- Nobody explains a loss. It is absorbed and the next spin starts.

### Cold-streak talk ("rinsed" / "cooked")
- The core vocabulary is **cooked** (beaten by the game), **rinsed** (balance
  drained), **dead** (the game is paying nothing).
- Framing is session-level and a bit fatalistic: "we've kind of gotten
  cooked", "it's always dead for me".
- The response is never analysis — it's endurance ("give this 25 more"),
  self-deprecating broke humour, or a switch.

### Game switches
- Trigger: the game is "dead", boring, or tiring — an emotional verdict, not
  a stat.
- Phrasing is a **hop**: "hop over to [game]", "go back to [game]", "what's
  next?" The choice is often put to chat or floated as a question first.

### Reload talk
- Busts are expected and planned for out loud: "rinse it to zero" is said
  *before* it happens; withdrawing winnings before they get rinsed back is a
  recurring decision point ("let's withdraw this before I rinse it all").
- Session endings in the samples are flat and honest: down, done, back Monday.

### Chat interaction between rounds
Roughly half of all talk. Name greetings on arrival, thanks for follows by
name, crowdsourcing game choices ("give me some slot calls"), answering
questions in the same fragments, giveaway/admin business interleaved, trolls
handled in one line. The streamer talks *with* chat far more than he narrates
the game.

### Filler habits
"bro" as punctuation; "you guys" / "chat" as address; "to be honest", "I
mean", "right now"; rhetorical questions repeated twice; reading screen text
aloud flatly (figures, names, options).

### Rhythm metrics (from the 18 transcribed samples)
- **Reaction burst length:** 1-6 words. Overall burst medians run 3-14 words,
  but the long tail is chat/admin; in-game reactions sit at the short end.
- **Speech coverage:** ~20% to ~100% of any 90-second window. Silence is a
  tool — dry spells and big reveals both get quiet. Nobody narrates
  continuously.
- **Hype repetition:** the key device. A phrase is said **2-3 times verbatim**
  (greetings x3, win chants x2, disbelief questions x2). Repetition replaces
  adjectives.
- **Numbers:** always plain and round, said **before** the action; results
  read once, flat, then gone.
- **Sentence ratio:** full grammatical sentences appear mainly in admin and
  conversation; during actual gameplay they are the exception.

---

## Hubie line bank v2 — as implemented in `js/commentary.js`

This section mirrors the engine banks exactly (the engine is the source of
truth; the library builder and tests enumerate from it). Short bursts,
repetition as hype, flat number reads, the game addressed directly.
Adapted to Hubie's world: **100,000 start, stakes as plain numbers**,
**no swearing, no copied signature catchphrases, no win promises, no
telling viewers to deposit**, and the **demo wording rule**: the word is
spoken only in the opening line, one sparse mid-stream reminder, and the
closing sign-off — the scrolling banner carries it on screen throughout.

**Variant policy (user rule, 2026-11-08):** every slang/hype category
carries 3-5+ interchangeable variants, so a 3-hour stream never loops.
"Bang bang bang" interchanges with the Ws-in-the-chat chant — spoken
"double yous" (plural) with "chat" drawn out: **"double yous in the
chaaaaat"**. Anticipation never uses the banned
doubled plea or any "come"-based phrasing. `{stake}` = the bet in words,
`{back}` = the payout in words, `{x}` = the multiplier in words,
`{game}` / `{from}` = game names, `{amount}` = a reload amount,
`{name}` = a chat username.

### Sizing (before the round)
- "what are we putting on this one. {stake}. {stake} riding."
- "in with {stake}. let this be it."
- "{stake} on {game}. here we go."
- "size check. {stake}. send it."
- "going in. {stake}. watch this."
- "size up. {stake}."

### Send-it sizing (~5% of the roll)
- "big one. {stake} riding. feel it."
- "sending it. {stake}. all of it matters now."
- "this is the big send. {stake}."

### Anticipation (during the round — no "come" phrasing, ever)
- "pls pls pls."
- "just this time. just this time."
- "land it. land it."
- "one time. one time."
- "please. just land."
- "do something. wake up."
- "imagine the big one here."
- "hold. hold."
- "hopefully it cooks this time." *(his own real take, sliced into the library)*

### Win shouts (solid win lead-in — bang interchanges with double yous)
- "bang bang bang. yes sir. yes sir. we did it."
- "double yous in the chaaaaat. yes sir. we did it."
- "yes. YES. there it is."
- "boom. got it. got it."
- "there we go. there we go."

### Affirmations (rotated with the shouts)
- "yes sir. yes sir."
- "that is how we do it. that is how we do it."
- "told you. told you."
- "we move. we move."

### Win figures (appended to a shout or affirmation)
- "{back} back. off {stake}. that is a {x}. massive."
- "{back} back. {x}. we take those."
- "paid. {back}. off {stake}. lovely."
- Short forms when the numbers run long: "{back} back. {x}." / "paid {back}. {x}."

### Small win (flat, stake back to ~2x — no hype by design)
- "{back} back. next."
- "{back} back. what is next."
- "small one. {back} back. run it."
- "we take it. {back} back."
- "paid. keep going."

### Massive win (10x+)
- "holy cow. {x}. {x-figure}. look at that."
- "MASSIVE. {back} back. that is a {x}."
- "oh my days. {x}. clip that. clip that."
- "{x}. {x}. look at that."
- "double yous in the chaaaaat. {x}. look at that."
- "session saved. session saved."
- "that is the one. THAT is the one."

### Near miss
- "one away. ONE away. so close."
- "so close. one away. one away."
- "ONE tile from it. one."
- "it teased us. it actually teased us."
- "that was right there."

### Single loss
- "damn. cooked."
- "nah. that is rough."
- "cooked. move on."
- "no good. next."
- "gone. we go again."
- "dead."
- "nothing. next."

### Cold streak (cooked / rinsed / dead set)
- "we are getting rinsed on {game} right now."
- "{game} is ice cold. ice cold."
- "nothing is landing. nothing."
- "{game} is dead right now. dead."
- "cooked. properly cooked."

### Game switch (cold hop)
- "{from} is cold. {game}. let us see {game}."
- "let us go check out {game}."
- "switching. {game} now. fresh board, fresh luck."
- "{from} is dead. we hop. {game} now."
- "enough of this one. what is next."

### Neutral rotation
- "{game} now. let us see {game}."
- "over to {game}. new game."
- "rotating. {game} time."

### Slots break / push
- "casino break. five spins on the slots."
- "break time. slots, five spins. then back."
- "quick slots break. five spins only."
- "pair. stake back. no harm."
- "pair on the reels. money back."
- "stake back. the slot shrugs."

### Bust
- "rinsed. we are cooked."
- "and that is the roll gone. cooked."
- "busted. the roll is empty."
- "rinsed. rinsed to zero."

### Reload (spoken as one burst right after the bust line)
- "reload. {amount} more. we go again."
- "fresh {amount} in. back in. we go again."
- "reload again. another {amount}. back in."
- "bought back in. {amount}. let us run it."

### House lines (the only spoken demo mentions)
- Opening: "hey hey. hubie here. demo play, no real money. let us play."
- Reminder: "reminder, chat. demo play. no real money here." /
  "quick one. this is demo play. no real money, ever."
- Closing: "that is the show, chat. hubie out. demo play, no real money,
  always. gamble responsibly."
- Safe reply: "no. no promises, no deposits. back to the game."

### Welcome / chat hooks
- "hey hey, {name}. welcome in."
- "yo {name}. good timing."
- "hey {name}. pull up a seat."
- "we see you, {name}. we see you."
- Idle/chat: "hydrate check, chat." / "night crew, we still rolling." /
  "we move. always moving." / "eyes up. next round loading." /
  "give me a game, chat. give me a call."

### Rewards one-liners (verified figures only: 22.5% = 10% + 12.5%)
- "rakeback here is ten percent. every bet earns."
- "vip rewards, twelve point five. it adds up."
- "total rewards, twenty two point five percent. rakeback plus vip."
- "bronze one at two hundred xp. levels climb, rewards climb."
- "keys on every bet. that is the housebets way."
- "quick one. rakeback is ten percent here. ten."
- "that is twenty two point five total. the house pays back."

---

*Files: samples in `research/samples/`, transcripts in `research/transcripts/`,
full-VOD caption tracks in `research/captions-*.srt`, VOD metadata in
`research/videos-*.json`, playlist sources in `research/sources.json`,
loudness peaks: jkolby ~6,970s and ~7,745s; jerzynft ~6,085s and ~6,865s;
syken ~2,795s and ~2,985s (absolute VOD seconds). Transcription: faster-whisper
base/CPU; its venv (`research/venv-fw`) can be deleted and recreated with
`pip install faster-whisper`.*
