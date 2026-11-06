'use strict';
// Vercel serverless entry (repository-root deployment): every /api/* request is routed here.
const { createApp, loadConfig } = require('../safeshe-server/src/app');

const { app } = createApp(loadConfig(process.env));
module.exports = app;
