'use strict';
// Vercel build step: copy the web app (shared with the Android app) into ./public.
const fs = require('node:fs');
const path = require('node:path');
const src = path.join(__dirname, '..', '..', 'safeshe-android', 'assets');
const dst = path.join(__dirname, '..', 'public');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
// Same-origin API when the app is served by this deployment.
fs.writeFileSync(path.join(dst, 'config.js'), 'window.SAFESHE_API = "";\n');
console.log('Copied web app to', dst, '→', fs.readdirSync(dst).join(', '));
