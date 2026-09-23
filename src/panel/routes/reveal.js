'use strict';

/**
 * POST /reveal/:field — session-gated one-shot unmask (FR-012). Extend
 * REVEALABLE_FIELDS to add later fields (SMTP password, Actual password —
 * tasks.md T019) without rewriting this route.
 */

const { envGet } = require('../config-store');

const REVEALABLE_FIELDS = {
  'telegram-bot-token': 'TELEGRAM_BOT_TOKEN',
};

function register(router, ctx) {
  const { requireSession } = ctx;

  router.post('/reveal/:field', (req, res, params) => {
    requireSession(req, res, (req2, res2) => {
      const envKey = REVEALABLE_FIELDS[params.field];
      if (!envKey) {
        res2.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res2.end('Unknown field');
        return;
      }
      const value = envGet(envKey) || '';
      res2.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res2.end(value);
    });
  });
}

module.exports = { register };
