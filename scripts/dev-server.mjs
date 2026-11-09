// Local development only. Production uses the Worker entry point and D1/R2.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { api } from '../worker/api.mjs';
import { handleAuth, resolveIdentity } from '../worker/auth.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(project, 'web');
const tmpRoot = resolve(project, '.task-tmp');
const within = (root, target) => {
  const part = relative(root, target);
  return part === '' || (!part.startsWith('..') && !isAbsolute(part));
};
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon'
};
function localEnvironment(dataDir) {
  if (!within(tmpRoot, dataDir) || dataDir === tmpRoot) throw new Error('Local data must be inside this project’s .task-tmp directory');
  mkdirSync(dataDir, { recursive: true });
  if (!within(realpathSync(tmpRoot), realpathSync(dataDir))) throw new Error('Local data symlink escapes the task directory');
  const dbPath = resolve(dataDir, 'atlas.sqlite');
  if (existsSync(dbPath) && !within(realpathSync(dataDir), realpathSync(dbPath))) throw new Error('Local database escapes the task directory');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY NOT NULL)');
  const migrations = resolve(project, 'migrations');
  for (const filename of readdirSync(migrations).filter(name => /^\d[\w-]*\.sql$/.test(name)).sort()) {
    if (db.prepare('SELECT name FROM _local_migrations WHERE name=?').get(filename)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(resolve(migrations, filename), 'utf8'));
      db.prepare('INSERT INTO _local_migrations(name) VALUES(?)').run(filename);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const photos = resolve(dataDir, 'photos');
  mkdirSync(photos, { recursive: true });
  if (!within(realpathSync(dataDir), realpathSync(photos))) { db.close(); throw new Error('Local photos escape the task directory'); }
  const photoPath = key => resolve(photos, createHash('sha256').update(String(key)).digest('hex') + '.bin');
  const env = {
    ALLOWED_CITY_CODES: new Set(JSON.parse(readFileSync(resolve(webRoot, 'map-data.json'), 'utf8')).cities.map(city => city.code)),
    DB: {
      prepare(sql) {
        const prepared = db.prepare(sql); let args = [];
        const execute = () => ({ success: true, meta: { changes: Number(prepared.run(...args).changes) } });
        return {
          bind(...values) { args = values; return this; },
          async first() { return prepared.get(...args) || null; },
          async all() { return { success: true, results: prepared.all(...args) }; },
          async run() { return execute(); },
          _runSync: execute
        };
      },
      async batch(statements) {
        db.exec('BEGIN');
        try { const results = statements.map(statement => statement._runSync()); db.exec('COMMIT'); return results; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
    },
    BUCKET: {
      async put(key, bytes) { await writeFile(photoPath(key), bytes); return { key }; },
      async get(key) {
        try { return { body: new Uint8Array(await readFile(photoPath(key))) }; }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      },
      async delete(key) { try { await unlink(photoPath(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
  };
  return { env, db };
}
function plain(message, status = 400) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function staticFile(url, method) {
  if (method !== 'GET' && method !== 'HEAD') return plain('Method not allowed', 405);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return plain('Bad URL'); }
  if (path.includes('\0') || path.includes('\\') || path.split('/').some(part => part === '..' || part.startsWith('.'))) return plain('Forbidden', 403);
  const target = resolve(webRoot, '.' + (path === '/' ? '/index.html' : path));
  if (!within(webRoot, target)) return plain('Forbidden', 403);
  try {
    const real = realpathSync(target);
    if (!within(realpathSync(webRoot), real) || !statSync(real).isFile()) return plain('Not found', 404);
    const body = method === 'HEAD' ? null : await readFile(real);
    return new Response(body, { headers: { 'Content-Type': types[extname(real).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return plain('Not found', 404); throw error; }
}
export async function startDevServer({ port = 4317, dataDir = resolve(tmpRoot, 'local-data'), quiet = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const { env, db } = localEnvironment(resolve(dataDir));
  let boundPort = port;
  const server = createServer(async (incoming, outgoing) => {
    let result;
    try {
      const host = incoming.headers.host || '';
      const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
      if (!allowedHosts.has(host) || !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) result = plain('Invalid host', 403);
      else {
        const url = new URL(`http://${host}${incoming.url}`);
        if (url.pathname.startsWith('/api/')) {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          // Match Cloudflare's trusted connecting-IP semantics; never trust the inbound value.
          headers.set('cf-connecting-ip', incoming.socket.remoteAddress || '127.0.0.1');
          const method = incoming.method || 'GET';
          const options = { method, headers };
          if (!['GET', 'HEAD'].includes(method)) { options.body = Readable.toWeb(incoming); options.duplex = 'half'; }
          const request = new Request(url, options);
          result = await handleAuth(request, env) || await api(request, env, resolveIdentity) || plain('Not found', 404);
        } else result = await staticFile(url, incoming.method || 'GET');
      }
    } catch (error) {
      console.error('Local request failed:', error?.code || error?.name || 'unknown error');
      result = plain('Local service unavailable', 500);
    }
    outgoing.statusCode = result.status;
    result.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.setHeader('X-Content-Type-Options', 'nosniff');
    if (incoming.method === 'HEAD' || !result.body) outgoing.end();
    else {
      try { for await (const chunk of result.body) outgoing.write(chunk); outgoing.end(); }
      catch { outgoing.destroy(); }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  try { await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); }); }
  catch (error) { db.close(); throw error; }
  boundPort = server.address().port;
  const url = `http://127.0.0.1:${boundPort}`;
  if (!quiet) console.log(`Local URL: ${url}`);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await new Promise(resolveClose => { server.close(resolveClose); server.closeIdleConnections(); });
    db.close();
  };
  return { server, url, dataDir: resolve(dataDir), close };
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const port = process.env.PORT ? Number(process.env.PORT) : 4317;
  const instance = await startDevServer({ port });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await instance.close(); process.exit(0); });
}
