'use strict';

/**
 * Optional cheap guard for the pure layout helpers (quickstart "Optional"
 * section). Run from the host:  node src/dev/check-layout.js
 * The module has no external dependencies.
 */

const { renderPage, renderAuthPage } = require('../panel/layout');

const page = renderPage({ title: 'x', active: 'recipients', body: '<h1>hi</h1>' });
if (!page.includes('href="/static/panel.css"')) throw new Error('missing css link');
if (!page.includes('aria-current="page"')) throw new Error('missing active marker');
if (page.split('aria-current="page"').length - 1 !== 1) throw new Error('active not exactly once');
if (!page.includes('/recipients')) throw new Error('nav missing recipients');

const auth = renderAuthPage({ title: 'login', body: '<h1>Log in</h1>' });
if (auth.includes('<nav')) throw new Error('auth page must not carry nav');
if (!auth.includes('href="/static/panel.css"')) throw new Error('auth page missing css link');

console.log('layout OK');
