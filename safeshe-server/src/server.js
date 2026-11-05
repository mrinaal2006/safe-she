'use strict';
// Standalone server (local, Docker, Render, VPS). On Vercel, api/index.js is used instead.
const path = require('node:path');
const { createApp, loadConfig } = require('./app');

const cfg = loadConfig({ APP_DIR: path.join(__dirname, '..', '..', 'safeshe-android', 'assets'), ...process.env });
const { app, init } = createApp(cfg);
const port = +process.env.PORT || 8080;
init()
  .then(() => app.listen(port, () => console.log(`SafeShe server on :${port} (app files: ${cfg.appDir})`)))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
