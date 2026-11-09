// Native account authentication. Passwords, recovery codes and session tokens
// are never stored in plaintext. The hosting entry point injects resolveIdentity
// into api(request, env, resolveIdentity).
const enc = new TextEncoder();
const SESSION_DAYS = 30;
const ITERATIONS = 100000;
const randomBytes = length => crypto.getRandomValues(new Uint8Array(length));
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const fromB64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const token = () => b64(randomBytes(32)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
const stmt = (env, sql, ...params) => env.DB.prepare(sql).bind(...params);
const first = (env, sql, ...params) => stmt(env, sql, ...params).first();
const run = (env, sql, ...params) => stmt(env, sql, ...params).run();
class AuthError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'auth_failed'; }
}
const fail = (status, message, code) => { throw new AuthError(status, message, code); };
function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extraHeaders
  } });
}
function verifyOrigin(request) {
  if (request.method === 'GET') return;
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    fail(403, '请在本站页面中完成此操作', 'invalid_origin');
  }
}
async function readBody(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) fail(415, '请使用 JSON 格式');
  if (Number(request.headers.get('content-length') || 0) > 8192) fail(413, '请求内容过大');
  if (!request.body) fail(400, '请求内容为空');
  const reader = request.body.getReader(); let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); fail(413, '请求内容过大'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'JSON 格式不正确'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '请求内容须为对象');
  return body;
}
function username(value) {
  if (typeof value !== 'string') fail(400, '用户名须为 3–32 位字母、数字或下划线');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(normalized)) fail(400, '用户名须为 3–32 位字母、数字或下划线');
  return normalized;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) fail(400, '密码须为 10–128 个字符');
  return value;
}
async function passwordHash(value, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(value), 'PBKDF2', false, ['deriveBits']);
  const result = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromB64(salt), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return b64(new Uint8Array(result));
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let result = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) result |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return result === 0;
}
function cookieName(request) { return new URL(request.url).protocol === 'https:' ? '__Host-atlas_session' : 'atlas_session'; }
function cookie(request, value, expired = false) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expired ? 0 : SESSION_DAYS * 86400}${secure}`;
}
function cookieToken(request) {
  const name = cookieName(request);
  const matches = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
async function rateLimit(env, key, max, duration) {
  const current = Date.now();
  await run(env, `INSERT INTO auth_rate_limits(key, window_started, attempts) VALUES(?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN auth_rate_limits.window_started <= ? THEN 1 ELSE auth_rate_limits.attempts + 1 END,
      window_started = CASE WHEN auth_rate_limits.window_started <= ? THEN ? ELSE auth_rate_limits.window_started END`,
  key, current, current - duration, current - duration, current);
  const row = await first(env, 'SELECT attempts FROM auth_rate_limits WHERE key = ?', key);
  if (row.attempts > max) fail(429, '尝试次数较多，请稍后重试', 'rate_limited');
}
async function limitAttempt(request, env, action, name = '') {
  // CF-Connecting-IP is provided by Cloudflare, not a visitor identity field.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const duration = action === 'login' ? 15 * 60 * 1000 : 60 * 60 * 1000;
  const scoped = await digest(`${action}\u0000${ip}\u0000${name}`);
  const global = await digest(`${action}:ip\u0000${ip}`);
  await rateLimit(env, global, action === 'login' ? 60 : 15, duration);
  await rateLimit(env, scoped, action === 'recover' ? 5 : 10, duration);
  // Bounded retention of abuse counters and expired sessions.
  await run(env, 'DELETE FROM auth_rate_limits WHERE window_started < ?', Date.now() - 86400000);
  await run(env, 'DELETE FROM auth_sessions WHERE expires_at <= ?', Date.now());
  return scoped;
}
async function newSession(env, account, request) {
  const raw = token(), current = Date.now();
  await run(env, 'INSERT INTO auth_sessions(token_hash, account_id, auth_version, created_at, expires_at) VALUES(?, ?, ?, ?, ?)',
    await digest(raw), account.id, account.auth_version, current, current + SESSION_DAYS * 86400000);
  return cookie(request, raw);
}
export async function resolveIdentity(request, env) {
  const raw = cookieToken(request);
  if (!raw || !env.DB) return null;
  const row = await first(env, `SELECT a.id, a.display_name FROM auth_sessions s
    JOIN auth_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND s.auth_version = a.auth_version`, await digest(raw), Date.now());
  return row ? { id: row.id, name: row.display_name } : null;
}
export async function handleAuth(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/auth/')) return null;
  try {
    if (!env.DB) fail(503, '账号服务尚未连接', 'storage_unavailable');
    verifyOrigin(request);
    if (path === '/api/auth/status' && request.method === 'GET') return json({ configured: true });
    if (request.method !== 'POST') fail(405, '请求方式不支持');
    if (path === '/api/auth/logout') {
      const raw = cookieToken(request);
      if (raw) await run(env, 'DELETE FROM auth_sessions WHERE token_hash = ?', await digest(raw));
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', true) });
    }
    const body = await readBody(request);
    if (path === '/api/auth/register') {
      const name = username(body.username), pass = password(body.password);
      const displayName = (typeof body.name === 'string' ? body.name.trim() : '') || name;
      if (displayName.length > 40) fail(400, '昵称须为 1–40 个字符');
      await limitAttempt(request, env, 'register');
      const salt = b64(randomBytes(16)), recoveryCode = hex(randomBytes(32));
      const account = { id: crypto.randomUUID(), auth_version: 1 };
      const hashed = await passwordHash(pass, salt);
      const existing = await first(env, 'SELECT id FROM auth_accounts WHERE username = ?', name);
      if (existing) fail(409, '注册未成功，请使用其他用户名或稍后重试', 'registration_failed');
      const rawSession = token(), current = Date.now();
      try {
        await env.DB.batch([
          stmt(env, 'INSERT INTO auth_accounts(id, username, display_name, password_salt, password_hash, recovery_hash, auth_version, created_at) VALUES(?, ?, ?, ?, ?, ?, 1, ?)',
            account.id, name, displayName, salt, hashed, await digest(recoveryCode), current),
          stmt(env, 'INSERT INTO auth_sessions(token_hash, account_id, auth_version, created_at, expires_at) VALUES(?, ?, 1, ?, ?)',
            await digest(rawSession), account.id, current, current + SESSION_DAYS * 86400000)
        ]);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) fail(409, '注册未成功，请使用其他用户名或稍后重试', 'registration_failed');
        throw error;
      }
      return json({ ok: true, recoveryCode }, 201, { 'Set-Cookie': cookie(request, rawSession) });
    }
    if (path === '/api/auth/login') {
      const name = username(body.username);
      // Use the same response for missing accounts and wrong passwords.
      const pass = typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
      const rateKey = await limitAttempt(request, env, 'login', name);
      const account = await first(env, 'SELECT id, password_salt, password_hash, auth_version FROM auth_accounts WHERE username = ?', name);
      const hashed = await passwordHash(pass, account?.password_salt || 'AAAAAAAAAAAAAAAAAAAAAA==');
      if (!account || !equal(hashed, account.password_hash)) fail(401, '用户名或密码不正确', 'invalid_credentials');
      await run(env, 'DELETE FROM auth_rate_limits WHERE key = ?', rateKey);
      return json({ ok: true }, 200, { 'Set-Cookie': await newSession(env, account, request) });
    }
    if (path === '/api/auth/recover') {
      const name = username(body.username), newPassword = password(body.newPassword);
      await limitAttempt(request, env, 'recover', name);
      const account = await first(env, 'SELECT id, recovery_hash FROM auth_accounts WHERE username = ?', name);
      const supplied = typeof body.recoveryCode === 'string' ? body.recoveryCode.trim().toLowerCase() : '';
      const suppliedHash = await digest(supplied);
      if (!account || supplied.length !== 64 || !equal(suppliedHash, account.recovery_hash)) fail(401, '用户名或恢复码不正确', 'invalid_recovery');
      const recoveryCode = hex(randomBytes(32)), salt = b64(randomBytes(16)), hashed = await passwordHash(newPassword, salt);
      const updated = await run(env, 'UPDATE auth_accounts SET password_salt = ?, password_hash = ?, recovery_hash = ?, auth_version = auth_version + 1 WHERE id = ? AND recovery_hash = ?',
        salt, hashed, await digest(recoveryCode), account.id, suppliedHash);
      if (!updated.meta.changes) fail(401, '用户名或恢复码不正确', 'invalid_recovery');
      // auth_version invalidates every old session atomically with password change.
      await run(env, 'DELETE FROM auth_sessions WHERE account_id = ? AND auth_version <> (SELECT auth_version FROM auth_accounts WHERE id = ?)', account.id, account.id);
      return json({ ok: true, recoveryCode }, 200, { 'Set-Cookie': cookie(request, '', true) });
    }
    fail(404, '账号接口不存在');
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.message, code: error.code }, error.status);
    console.error('Authentication operation failed');
    return json({ error: '账号服务暂时不可用，请稍后重试', code: 'auth_unavailable' }, 500);
  }
}
