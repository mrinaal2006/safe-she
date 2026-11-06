'use strict';
// Build step when Vercel's Root Directory is "safeshe-server": copy the web app into ./public.
// Recommended instead: deploy from the repository root (Root Directory "./"), which uses /vercel.json.
const fs = require('node:fs');
const path = require('node:path');
const src = path.join(__dirname, '..', '..', 'safeshe-android', 'assets');
const dst = path.join(__dirname, '..', 'public');
if (!fs.existsSync(src)) {
  console.error('\nSafeShe build error: the app files (safeshe-android/assets) are not available to this build.\n' +
    'Fix: Vercel → Project → Settings → General → Root Directory → clear it (use the repository root "./"), then redeploy.\n');
  process.exit(1);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
fs.writeFileSync(path.join(dst, 'config.js'), 'window.SAFESHE_API = "";\n'); // same-origin API
console.log('Copied web app to', dst, '→', fs.readdirSync(dst).join(', '));
