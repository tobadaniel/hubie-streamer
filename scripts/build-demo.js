#!/usr/bin/env node
/* Rebuild demo/hubie-demo.html — the single-file demo bundle — from the
 * repo sources, the same way the original bundle was made:
 * index.html with the stylesheet and the four scripts inlined and the
 * full-body Hubie mascot embedded as a data URI. No external references.
 * Usage: node scripts/build-demo.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let html = read('index.html');
const css = read('css/styles.css');
const avatarB64 = fs.readFileSync(path.join(ROOT, 'assets/hubie-fullbody.png')).toString('base64');

html = html.replace('<link rel="stylesheet" href="css/styles.css">',
  '<style>\n' + css + '\n</style>');
html = html.replace('src="assets/hubie-fullbody.png"',
  'src="data:image/png;base64,' + avatarB64 + '"');
for (const js of ['js/games.js', 'js/commentary.js', 'js/chat.js', 'js/speech-director.js', 'js/scene.js']) {
  html = html.replace('<script src="' + js + '"></script>',
    '<script>\n' + read(js) + '\n</script>');
}
// Strip the repo-scene HTML comment and add the bundle banner instead.
html = html.replace(/<!--\n  HUBIE STREAM SCENE[\s\S]*?-->/,
  '<!-- HUBIE DEMO: single-file bundle of hubie-streamer (rebuilt by scripts/build-demo.js). Auto-plays demo rounds on load; the Enable voice button is optional (browser speech needs one click). The full-body Hubie mascot (from the image Oluwatoba provided, cut out locally) is inlined, with the mascot animation system, the safety marquee, the Mines layout fix, the live Kick chat adapter (disabled by default — no config in the bundle, simulated chat runs), the Slots casino-break segment, and the coupled speech director (in the bundle it runs in local mode: no voice bridge, subtitles at generation time). No network, no real money. -->');

const leftover = html.match(/(href|src)="(css|js|assets)\//g);
if (leftover) { console.error('build-demo: external references remain:', leftover); process.exit(1); }
const out = path.join(ROOT, 'demo/hubie-demo.html');
fs.writeFileSync(out, html);
console.log('build-demo: wrote', out, '(' + html.length + ' bytes, zero external references)');
