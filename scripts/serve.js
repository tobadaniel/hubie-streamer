#!/usr/bin/env node
/* Zero-dependency static server for the Hubie stream scene.
 * Serves only this repo folder, on 127.0.0.1 by default (OBS Browser Source
 * and ffmpeg point at the local URL — the scene itself is never public
 * unless Oluwatoba chooses to publish the repo/recording later).
 * Usage: node scripts/serve.js [port]     (default 8377)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8377;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(new Date().toISOString() + ' hubie scene server listening on http://127.0.0.1:' + PORT + '/');
});
