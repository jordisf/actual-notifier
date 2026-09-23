'use strict';

/**
 * GET / (dashboard shell) — session-guarded, links to each configuration
 * section (most of which don't exist yet; wired progressively by later
 * stories, per tasks.md T009/T015/T020/T024).
 */

const fs = require('fs');
const path = require('path');

const { kvGet } = require('../config-store');

const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'dashboard.html');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(username) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template.replace('{{username}}', escapeHtml(username || '(unknown)'));
}

function register(router, ctx) {
  const { db, requireSession, sendHtml } = ctx;

  router.get('/', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      const username = kvGet(db, 'panel_username');
      sendHtml(res2, 200, render(username));
    });
  });
}

module.exports = { register };
