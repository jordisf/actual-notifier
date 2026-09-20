'use strict';

/**
 * Single-line JSON structured logger to stdout.
 *
 * design §10: every store mutation, Telegram call and Actual write-back
 * emits one line: {"ts","level","service","msg",...fields}
 *
 * service: 'cron' | 'listener'
 */

function log(level, service, msg, fields) {
  const entry = { ts: new Date().toISOString(), level, service, msg };
  if (fields && typeof fields === 'object') Object.assign(entry, fields);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

module.exports = { log };
