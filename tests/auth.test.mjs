import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleAuth, resolveIdentity } from '../worker/auth.mjs';
import { api } from '../worker/api.mjs';
let db, env;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../migrations/0001.sql', import.meta.url), 'utf8'));
  env = { DB: { prepare(sql) {
    const prepared = db.prepare(sql); let args = [];
    return { bind(...values) { args = values; return this; }, async first() { return prepared.get(...args) || null; },
      async all() { return { results: prepared.all(...args) }; }, async run() { return { meta: { changes: Number(prepared.run(...args).changes) } }; } };
  }, async batch(statements) {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } };
});
afterEach(() => db.close());
const origin = 'https://atlas.example';
const pass = 'my-good-password-123';
async function request(path, body, cookie, options = {}) {
  const url = (options.origin || origin) + path;
  const headers = { origin: options.sendOrigin ?? (options.origin || origin), 'cf-connecting-ip': '192.0.2.10' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const req = new Request(url, { method: options.method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await handleAuth(req, env) || await api(req, env, resolveIdentity);
  return { status: result.status, body: await result.json(), cookie: result.headers.get('set-cookie')?.split(';')[0], headers: result.headers };
}
const register = (username = 'cloudchaser', options) => request('/api/auth/register', { username, password: pass, name: '追云的人' }, null, options);

test('native registration creates a secure session and persists only password, recovery and session hashes', async () => {
  const result = await register('CloudChaser');
  assert.equal(result.status, 201);
  assert.match(result.body.recoveryCode, /^[a-f0-9]{64}$/);
  assert.match(result.cookie, /^__Host-atlas_session=/);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(result.headers.get('set-cookie').includes(flag));
  const account = db.prepare('SELECT * FROM auth_accounts').get();
  assert.equal(account.username, 'cloudchaser');
  assert.notEqual(account.password_hash, pass);
  assert.notEqual(account.recovery_hash, result.body.recoveryCode);
  const session = db.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(session.token_hash.length, 64);
  assert.notEqual(session.token_hash, result.cookie.split('=')[1]);
  const me = await request('/api/me', undefined, result.cookie);
  assert.equal(me.status, 200); assert.equal(me.body.user.name, '追云的人');
  assert.match(me.body.user.code, /^[A-F0-9]{16}$/);
  assert.equal((await register('CLOUDCHASER')).status, 409);
});

test('login errors do not reveal whether an account exists; logout revokes the session', async () => {
  await register();
  const unknown = await request('/api/auth/login', { username: 'unknown', password: 'wrong-password' });
  const wrong = await request('/api/auth/login', { username: 'cloudchaser', password: 'wrong-password' });
  assert.equal(unknown.status, 401); assert.deepEqual(unknown.body, wrong.body);
  const login = await request('/api/auth/login', { username: 'CloudChaser', password: pass });
  assert.equal(login.status, 200);
  assert.equal((await request('/api/me', undefined, login.cookie)).status, 200);
  const logout = await request('/api/auth/logout', {}, login.cookie);
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/me', undefined, login.cookie)).status, 401);
});

test('recovery code is one-time, rotates after use, changes password and revokes all existing sessions', async () => {
  const registered = await register();
  const session2 = await request('/api/auth/login', { username: 'cloudchaser', password: pass });
  const recovered = await request('/api/auth/recover', { username: 'cloudchaser', recoveryCode: registered.body.recoveryCode, newPassword: 'a-new-long-password' });
  assert.equal(recovered.status, 200);
  assert.notEqual(recovered.body.recoveryCode, registered.body.recoveryCode);
  for (const cookie of [registered.cookie, session2.cookie]) assert.equal((await request('/api/me', undefined, cookie)).status, 401);
  const reused = await request('/api/auth/recover', { username: 'cloudchaser', recoveryCode: registered.body.recoveryCode, newPassword: 'another-long-password' });
  assert.equal(reused.status, 401);
  const unknown = await request('/api/auth/recover', { username: 'does_not_exist', recoveryCode: registered.body.recoveryCode, newPassword: 'another-long-password' });
  assert.deepEqual(reused.body, unknown.body);
  assert.equal((await request('/api/auth/login', { username: 'cloudchaser', password: pass })).status, 401);
  assert.equal((await request('/api/auth/login', { username: 'cloudchaser', password: 'a-new-long-password' })).status, 200);
});

test('expired sessions and forged client identity headers never authenticate', async () => {
  const result = await register();
  db.exec('UPDATE auth_sessions SET expires_at=0');
  assert.equal((await request('/api/me', undefined, result.cookie)).status, 401);
  const forged = new Request(origin + '/api/me', { headers: { 'oai-authenticated-user-id': 'fake', 'x-user-id': 'fake' } });
  assert.equal(await resolveIdentity(forged, env), null);
});

test('persistent per-IP/username attempt limits stop repeated password guessing', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await request('/api/auth/login', { username: 'unknown', password: 'bad-password' })).status, 401);
  }
  assert.equal((await request('/api/auth/login', { username: 'unknown', password: 'bad-password' })).status, 429);
  const rows = db.prepare('SELECT * FROM auth_rate_limits').all();
  assert.ok(rows.length >= 2); assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.key)));
});

test('authentication writes require same-origin and enforce password/username bounds', async () => {
  assert.equal((await register('valid_name', { sendOrigin: 'https://evil.example' })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_accounts').get().count, 0);
  for (const username of ['xy', 'a'.repeat(33), 'invalid name', '旅行者']) {
    assert.equal((await request('/api/auth/register', { username, password: pass })).status, 400);
  }
  for (const password of ['short', 'x'.repeat(129)]) {
    assert.equal((await request('/api/auth/register', { username: 'valid_user', password })).status, 400);
  }
  assert.equal((await request('/api/auth/status')).body.configured, true);
});

test('localhost HTTP development uses its own HttpOnly cookie, without production secure cookie name', async () => {
  const local = await register('local_user', { origin: 'http://127.0.0.1:4173' });
  assert.equal(local.status, 201);
  assert.match(local.cookie, /^atlas_session=/);
  assert.ok(local.headers.get('set-cookie').includes('HttpOnly'));
  assert.ok(!local.headers.get('set-cookie').includes('; Secure'));
  assert.equal((await request('/api/me', undefined, local.cookie, { origin: 'http://127.0.0.1:4173' })).status, 200);
});

test('blank optional nickname defaults to username and signup is atomic with session creation', async () => {
  const registered = await request('/api/auth/register', { username: 'no_nickname', password: pass, name: '' });
  assert.equal(registered.status, 201);
  assert.equal((await request('/api/me', undefined, registered.cookie)).body.user.name, 'no_nickname');
  db.exec("CREATE TRIGGER reject_test_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'test session failure'); END");
  const failed = await request('/api/auth/register', { username: 'atomic_user', password: pass });
  assert.equal(failed.status, 500);
  assert.equal(db.prepare('SELECT id FROM auth_accounts WHERE username=?').get('atomic_user'), undefined);
});
