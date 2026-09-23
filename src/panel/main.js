'use strict';

/**
 * Panel entrypoint: opens the shared SQLite store and starts the HTTP server.
 */

require('dotenv').config();

const store = require('../store');
const { log } = require('../log');
const { createServer } = require('./server');

const PORT = Number(process.env.PANEL_PORT) || 8080;

const db = store.open(process.env.DATA_DIR);
const server = createServer(db);

server.listen(PORT, () => {
  log('info', 'panel', 'listening', { port: PORT });
});
