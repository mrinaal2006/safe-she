'use strict';
// Vercel build step: copy the web app (shared with the Android app) into ./public.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'safeshe-android', 'assets');
const dst = path.join(root, 'public');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
fs.writeFileSync(path.join(dst, 'config.js'), 'window.SAFESHE_API = "";\n'); // same-origin API
console.log('Web app copied to public/:', fs.readdirSync(dst).join(', '));
