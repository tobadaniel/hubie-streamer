# Assets — Hubie's face

## Current: full-body mascot (2026-11-07)

`hubie-fullbody.png` is the scene's presenter: the full-body Hubie (sloth in
a top hat with an H buckle, orange vest, green bow tie, standing pose) from
the image Oluwatoba provided on 2026-11-07, kept untouched as
`hubie-fullbody-source.jpg`. The character was cut out of the plain taupe
background locally — OpenCV grabCut segmentation (border = definite
background, saturated interior = definite foreground), a 1px edge erosion,
a Gaussian feather and colour decontamination against the sampled
background, plus a cleanup pass that removes the painted ground shadow
under the shoes. No external/upload background-removal service was used.
The scene animates him with CSS transforms only (idle bob/sway, talking
pulse, win / big-win / near-miss reactions, loss droop) — see
`css/styles.css` and the `react()` helper in `js/scene.js`.

## Previous: official avatar from Oluwatoba's own recording (v1.1)

`hubie-official.png` is the avatar the stream scene uses now. It is a tight
crop of the **official Hubie** — the cartoon sloth in a black top hat with a
gold buckle and a bow tie — taken from Oluwatoba's own screen recording of
housebets.com (2026-11-06), where Hubie appears as the rewards-chat avatar on
his signed-in account. It is genuinely Housebets' character, captured from the
real product, and its provenance is this repo's own source recording.

Crop details: frame at t=145s of the recording, the full-screen Hubie chat
header avatar, cropped to the circular badge and scaled to 256×256.

## Still preferred: the official art pack

`hubie-art-pack.zip` from the "Hubie, live 24/7" contest page remains the
**preferred** source: when it becomes available it replaces this crop (full
art, likely layered/rigged, plus the official voice notes). The crop is one
flat circular avatar — fine for the scene's face, but the pack is the real
thing. To swap in:

1. Sign in to Housebets (Oluwatoba's account — his step, nobody else's).
2. Download `hubie-art-pack.zip` from Contest Labs. It was not downloadable
   from the public pages on 2026-11-06.
3. Drop the official art files into this folder and point `index.html`'s
   Hubie `<img>` at them, keeping the state classes (`hubie--idle`,
   `hubie--talking`, `hubie--excited`, `hubie--down`, `hubie--blink`) so the
   animation and reactions still work. If the pack ships layered/rigged
   files, map the same five states to its layers.
4. Follow the pack's voice notes for Hubie's voice. Until then the scene
   uses the browser's built-in speech synthesis as a stand-in voice only.

Keep any licence/readme files from the art pack in this folder alongside the art.

## Retired: the placeholder

`hubie.svg` is the **original v1 placeholder** — an original character drawn
for this repo in Housebets colours so the scene could run and be tested. It is
**not** official Housebets art and the scene no longer uses it. It stays in
the folder for reference only — never describe it as official in a stream, a
post, or the contest submission.
