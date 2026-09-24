const assert = require('assert');

async function main() {
  const base = 'http://localhost:8099';

  // 1. Bootstrap login page
  let r = await fetch(`${base}/login`);
  let body = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(body.includes('No password has been set'), 'bootstrap notice missing');
  assert.ok(!body.includes('name="password"'), 'password field should not be present in bootstrap');
  console.log('OK: GET /login bootstrap notice');

  // 2. Bootstrap POST /login -> issues session, redirects to /set-password
  r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/set-password');
  const setCookieHeader = r.headers.get('set-cookie');
  assert.ok(setCookieHeader && setCookieHeader.startsWith('panel_session='), 'session cookie missing');
  const cookie = setCookieHeader.split(';')[0];
  console.log('OK: POST /login bootstrap issues session + redirects to /set-password');

  // 3. GET / with bootstrap session should redirect to /set-password (forced)
  r = await fetch(`${base}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/set-password');
  console.log('OK: GET / redirects to /set-password while in bootstrap session');

  // 4. GET /set-password with bootstrap session should render form (200)
  r = await fetch(`${base}/set-password`, { headers: { Cookie: cookie } });
  body = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(body.includes('name="username"') && body.includes('name="password"'));
  console.log('OK: GET /set-password renders form');

  // 5. POST /set-password sets credentials and issues a normal session
  r = await fetch(`${base}/set-password`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=s3cret123&confirm=s3cret123',
    redirect: 'manual',
  });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/');
  const newCookie = r.headers.get('set-cookie').split(';')[0];
  assert.ok(!newCookie.includes('boot_'), 'sanity: cookie value itself should not leak plaintext prefix info trivially (best-effort check)');
  console.log('OK: POST /set-password persists credentials + issues normal session');

  // 6. GET / with the new normal session should now succeed (200), no more forced redirect
  r = await fetch(`${base}/`, { headers: { Cookie: newCookie } });
  body = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(body.includes('Logged in as admin'));
  console.log('OK: GET / reachable after password set, shows username');

  // 7. Second login: GET /login should now show the normal form (no bootstrap notice)
  r = await fetch(`${base}/login`);
  body = await r.text();
  assert.ok(!body.includes('No password has been set'));
  assert.ok(body.includes('name="password"'));
  console.log('OK: GET /login shows normal form after credentials set');

  // 8. POST /login with wrong password -> 401, failure recorded
  r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=wrongpass',
  });
  assert.strictEqual(r.status, 401);
  console.log('OK: POST /login wrong password rejected with 401');

  // 9. POST /login with correct password -> 302 to /
  r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=s3cret123',
    redirect: 'manual',
  });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/');
  const loginCookie = r.headers.get('set-cookie').split(';')[0];
  console.log('OK: POST /login correct password succeeds');

  // 10. Lockout: 5 consecutive failures should lock out even correct password
  for (let i = 0; i < 5; i++) {
    r = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=admin&password=wrongpass',
    });
  }
  assert.strictEqual(r.status, 423, `expected 423 on 5th failure, got ${r.status}`);
  console.log('OK: lockout triggers after 5 consecutive failures (423)');

  r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=s3cret123',
  });
  assert.strictEqual(r.status, 423, 'correct password should still be rejected during lockout');
  console.log('OK: correct password rejected while locked out');

  // 11. Logout clears session, subsequent GET / redirects to /login
  r = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: loginCookie }, redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/login');
  const clearedCookie = r.headers.get('set-cookie');
  console.log('OK: POST /logout redirects to /login, cookie:', clearedCookie);

  // 12. Unauthenticated GET / redirects to /login
  r = await fetch(`${base}/`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/login');
  console.log('OK: GET / without session redirects to /login');

  // 13. login-css-session-gate regression: stylesheet must be public (no session),
  //     because /login and /set-password link it while pre-session.
  r = await fetch(`${base}/static/panel.css`, { redirect: 'manual' });
  assert.strictEqual(r.status, 200, `panel.css should be public, got ${r.status}`);
  assert.ok((r.headers.get('content-type') || '').includes('text/css'), 'panel.css content-type');
  assert.strictEqual(r.headers.get('cache-control'), 'no-store', 'panel.css cache-control');
  console.log('OK: GET /static/panel.css without session -> 200 text/css (public)');

  // 14. Regression guard: /login document still links the stylesheet.
  r = await fetch(`${base}/login`);
  body = await r.text();
  assert.ok(body.includes('/static/panel.css'), 'login page must link /static/panel.css');
  console.log('OK: GET /login links /static/panel.css (styled pre-session)');

  console.log('ALL_PANEL_HTTP_TESTS_PASSED');
}

main().catch((err) => {
  console.error('TEST_FAILED', err);
  process.exit(1);
});
