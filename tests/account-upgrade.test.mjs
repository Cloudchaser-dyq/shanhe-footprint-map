import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { handleAuth, resolveIdentity } from '../worker/auth.mjs';
import { api } from '../worker/api.mjs';

// PUBLIC, SYNTHETIC TEST DATA ONLY. Never seed a real installation with this.
// Frozen from the encoding contract at d4fb02c (before city-picker / multi-photo).
// Password: PBKDF2-SHA256, 100000 iterations, 32 bytes, base64 salt/hash.
// Session and recovery: SHA256 of the UTF-8 token/code, lowercase hexadecimal.
// These expected values were calculated once, independently of worker/auth.mjs.
// Do NOT regenerate them with current authentication code during the test, or
// replace them when an algorithm changes: future code must still accept them.
const LEGACY = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  username: 'legacy_synthetic_user',
  name: '历史合成账号',
  code: 'A1B2C3D4E5F60718',
  password: 'Legacy-only-test-2026!',
  passwordSalt: 'AAECAwQFBgcICQoLDA0ODw==',
  passwordHash: 'PL9AAn44RdfDa7c3H96tSRfVx0hFhS8E0dkQv5dty58=',
  sessionToken: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  sessionHash: 'cf0931e168b49e987503caf18af6fe253b6b3d82a81008c3e8e1ee67c7c8dc55',
  recoveryCode: '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
  recoveryHash: 'cca0e26b70b7ed5a3dec02c102ca2bf8c8b8477e00cfbc56d726f9c4592cbd15',
  createdAt: 1794182400000, // 2026-11-09 UTC
  expiresAt: 1796774400000, // Original 30-day expiry; never extended by this fixture.
  authVersion: 1
});
const LEGACY_STATE = Object.freeze({
  layers: [
    { id: 'visited', name: '原来的足迹', color: '#218374', visible: true, visited: true, codes: ['320500', '510100'] },
    { id: 'wishlist', name: '原来的计划', color: '#e1a24a', visible: true, visited: false, codes: ['110000'] }
  ],
  activeLayerId: 'visited', background: '#eaf1ef'
});
const FRIEND = Object.freeze({ id: '22222222-2222-4222-8222-222222222222', name: '历史合成好友', code: 'B1B2C3D4E5F60718' });
const ORIGINAL_COOKIE = `__Host-atlas_session=${LEGACY.sessionToken}`;
const ORIGIN = 'https://atlas.example';
const BASELINE_TAG = '0000_deep_cannonball';
const BASELINE_SCHEMA_SHA256 = 'd14763f1463fd96e870d8681463f98ca9c9f9e58c77c8abcf37542f5b6f0c489';

function setupUpgradedDatabase(t) {
  // Keep the real historical expiry and freeze time inside its original lifetime.
  // This prevents calendar time from turning this compatibility test into an expiry test.
  t.mock.timers.enable({ apis: ['Date'], now: 1794268800000 }); // 2026-11-10 UTC
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const baseline = readFileSync(new URL(`../drizzle/${BASELINE_TAG}.sql`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(baseline).digest('hex'), BASELINE_SCHEMA_SHA256, 'Applied historical schema must remain immutable');
  db.exec(baseline);

  // Insert historical rows directly. Calling today's register endpoint here
  // would allow registration and verification to drift together undetected.
  db.prepare('INSERT INTO auth_accounts(id,username,display_name,password_salt,password_hash,recovery_hash,auth_version,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(LEGACY.id, LEGACY.username, LEGACY.name, LEGACY.passwordSalt, LEGACY.passwordHash, LEGACY.recoveryHash, LEGACY.authVersion, LEGACY.createdAt);
  db.prepare('INSERT INTO auth_sessions(token_hash,account_id,auth_version,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(LEGACY.sessionHash, LEGACY.id, LEGACY.authVersion, LEGACY.createdAt, LEGACY.expiresAt);
  for (const user of [LEGACY, FRIEND]) {
    db.prepare('INSERT INTO users(id,name,code,created_at) VALUES(?,?,?,?)').run(user.id, user.name, user.code, '2026-11-09T00:00:00.000Z');
  }
  db.prepare('INSERT INTO map_states(user_id,state_json,revision,updated_at) VALUES(?,?,?,?)')
    .run(LEGACY.id, JSON.stringify(LEGACY_STATE), 7, '2026-11-09T12:00:00.000Z');
  db.prepare("INSERT INTO friendships(id,sender_id,receiver_id,pair_a,pair_b,status,created_at) VALUES(?,?,?,?,?,'accepted',?)")
    .run('legacy-friendship', LEGACY.id, FRIEND.id, LEGACY.id, FRIEND.id, '2026-11-09T12:00:00.000Z');

  const credentialsBefore = db.prepare('SELECT * FROM auth_accounts WHERE id=?').get(LEGACY.id);
  const sessionBefore = db.prepare('SELECT * FROM auth_sessions WHERE token_hash=?').get(LEGACY.sessionHash);
  const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  assert.equal(journal.entries[0].tag, BASELINE_TAG);
  assert.equal(journal.entries[0].idx, 0);
  for (const [index, entry] of journal.entries.entries()) {
    assert.equal(entry.idx, index, 'Migrations must retain their original order');
    if (index === 0) continue;
    db.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  }
  const credentialsAfter = db.prepare('SELECT * FROM auth_accounts WHERE id=?').get(LEGACY.id);
  const sessionAfter = db.prepare('SELECT * FROM auth_sessions WHERE token_hash=?').get(LEGACY.sessionHash);
  // Allow additive schema fields, while preserving each existing stored value.
  for (const [key, value] of Object.entries(credentialsBefore)) assert.equal(credentialsAfter?.[key], value, `Migration changed legacy credential field ${key}`);
  for (const [key, value] of Object.entries(sessionBefore)) assert.equal(sessionAfter?.[key], value, `Migration changed legacy session field ${key}`);

  const env = { DB: {
    prepare(sql) {
      const statement = db.prepare(sql); let args = [];
      const runSync = () => ({ meta: { changes: Number(statement.run(...args).changes) } });
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { return runSync(); },
        runSync
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const results = statements.map(statement => statement.runSync()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  } };
  async function request(path, { body, cookie } = {}) {
    const headers = { origin: ORIGIN, 'cf-connecting-ip': '192.0.2.44' };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = new Request(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const response = await handleAuth(req, env) || await api(req, env, resolveIdentity);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  function assertSameAccount(me) {
    assert.equal(me.status, 200);
    assert.deepEqual(me.data.user, { id: LEGACY.id, name: LEGACY.name, code: LEGACY.code });
    assert.deepEqual(me.data.state, LEGACY_STATE);
    assert.equal(me.data.revision, 7);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_accounts').get().count, 1, 'Upgrade/login must not create a replacement account');
  }
  return { db, request, assertSameAccount };
}

test('historical session survives every additive migration and keeps the original account, friend code, map and friendships', async t => {
  const { request, assertSameAccount } = setupUpgradedDatabase(t);
  assertSameAccount(await request('/api/me', { cookie: ORIGINAL_COOKIE }));
  const friends = await request('/api/friends', { cookie: ORIGINAL_COOKIE });
  assert.equal(friends.status, 200);
  assert.deepEqual(friends.data.friends, [FRIEND]);
  const tampered = ORIGINAL_COOKIE.slice(0, -1) + 'A';
  assert.equal((await request('/api/me', { cookie: tampered })).status, 401);
});

test('a fixed historical password hash still logs in to the same account without invalidating its existing session', async t => {
  const { request, assertSameAccount } = setupUpgradedDatabase(t);
  assert.equal((await request('/api/auth/login', { body: { username: LEGACY.username, password: 'incorrect-synthetic-password' } })).status, 401);
  const login = await request('/api/auth/login', { body: { username: LEGACY.username, password: LEGACY.password } });
  assert.equal(login.status, 200);
  assert.ok(login.cookie, 'Successful login must issue a session cookie');
  assertSameAccount(await request('/api/me', { cookie: login.cookie }));
  assertSameAccount(await request('/api/me', { cookie: ORIGINAL_COOKIE }));
});

test('a fixed historical recovery code can recover the same account and revokes old sessions only on explicit recovery', async t => {
  const { request, assertSameAccount } = setupUpgradedDatabase(t);
  const newPassword = 'Recovered-synthetic-password-2026!';
  const recovered = await request('/api/auth/recover', { body: { username: LEGACY.username, recoveryCode: LEGACY.recoveryCode, newPassword } });
  assert.equal(recovered.status, 200);
  assert.notEqual(recovered.data.recoveryCode, LEGACY.recoveryCode);
  assert.equal((await request('/api/me', { cookie: ORIGINAL_COOKIE })).status, 401);
  assert.equal((await request('/api/auth/login', { body: { username: LEGACY.username, password: LEGACY.password } })).status, 401);
  assert.equal((await request('/api/auth/recover', { body: { username: LEGACY.username, recoveryCode: LEGACY.recoveryCode, newPassword } })).status, 401);
  const login = await request('/api/auth/login', { body: { username: LEGACY.username, password: newPassword } });
  assert.equal(login.status, 200);
  assertSameAccount(await request('/api/me', { cookie: login.cookie }));
});
