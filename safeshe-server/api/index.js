'use strict';
// Vercel serverless entry: every /api/* request is routed here (see vercel.json).
// The web app (index.html, track.html, …) is served as static files from /public.
const { createApp, loadConfig } = require('../src/app');

const { app } = createApp(loadConfig(process.env));
module.exports = app;
