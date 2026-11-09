import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { api } from '../worker/api.mjs';

// Real SQLite executes the production SQL; this adapter only matches D1's API.
let sqlite, env;
function prepare(sql) {
  const statement = sqlite.prepare(sql);
  let args = [];
  return {
    bind(...values) { args = values; return this; },
    async first() { return statement.get(...args) || null; },
    async all() { return { results: statement.all(...args) }; },
    async run() { const r = statement.run(...args); return { meta: { changes: Number(r.changes) } }; }
  };
}
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_post_photos.sql', import.meta.url), 'utf8'));
  const photos = new Map();
  env = {
    DB: { prepare, async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } },
    BUCKET: {
      async put(key, bytes, options) { photos.set(key, { bytes, options }); },
      async get(key) { const item = photos.get(key); return item ? { body: item.bytes } : null; },
      async delete(key) { photos.delete(key); },
      photos
    }
  };
});
afterEach(() => sqlite.close());

const identities = { alice: { id: 'alice', name: '小齐' }, bob: { id: 'bob', name: '小陈' }, eve: { id: 'eve', name: '<img src=x onerror=alert(1)>' } };
const resolveIdentity = async request => identities[request.headers.get('test-session')] || null;
const base = 'https://map.example';
async function req(path, actor = 'alice', method = 'GET', body, headers = {}) {
  const h = { origin: base, ...headers };
  if (actor) h['test-session'] = actor;
  let content = body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') { content = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const response = await api(new Request(base + path, { method, headers: h, body: content }), env, resolveIdentity);
  return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer(), response };
}
const state = () => ({ layers: [
  { id: 'visited', name: '去过', color: '#178763', visible: true, visited: true, codes: ['320500', '510100'] },
  { id: 'wish', name: '想去', color: '#f0ad4e', visible: true, visited: false, codes: ['320500'] }
], activeLayerId: 'visited', background: '#f1f5f2' });
async function befriend() {
  const { data: bob } = await req('/api/me', 'bob');
  const request = await req('/api/friends', 'alice', 'POST', { code: bob.user.code });
  assert.equal(request.status, 201);
  assert.equal((await req(`/api/friends/${request.data.id}/accept`, 'bob', 'POST')).status, 200);
  return request.data.id;
}
async function createPost(actor = 'alice', visibility = 'friends', photo = false) {
  const form = new FormData();
  form.set('city', '320500'); form.set('text', '苏州的一次日落'); form.set('visibility', visibility);
  if (photo) form.set('photo', new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0,1])], { type: 'image/png' }), 'sunset.png');
  return req('/api/posts', actor, 'POST', form);
}
const photoBytes = [
  new Uint8Array([137,80,78,71,13,10,26,10,0,1]),
  new Uint8Array([255,216,255,0,2]),
  new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80,3])
];
function photoForm(count = 3, visibility = 'public') {
  const form = new FormData();
  form.set('city', '320500'); form.set('text', '一座城市，三个瞬间'); form.set('visibility', visibility);
  for (let i = 0; i < count; i++) form.append('photo', new Blob([photoBytes[i % 3]], { type: ['image/png','image/jpeg','image/webp'][i % 3] }), `trip-${i}`);
  return form;
}

test('authentication is verified by injected adapter and unauthenticated access cannot create users', async () => {
  assert.equal((await req('/api/me', null)).status, 401);
  const forged = await api(new Request(base + '/api/me', { headers: { 'oai-authenticated-user-id': 'alice' } }), env);
  assert.equal(forged.status, 401);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  const me = await req('/api/me');
  assert.deepEqual(Object.keys(me.data.user).sort(), ['code', 'id', 'name']);
  assert.equal(me.data.user.name, '小齐');
  assert.equal(me.data.revision, 0);
});

test('map state preserves overlapping layers, rejects stale devices and invalid state without overwriting', async () => {
  const first = await req('/api/state', 'alice', 'PUT', { state: state(), revision: 0 });
  assert.equal(first.status, 200); assert.equal(first.data.revision, 1);
  const stale = await req('/api/state', 'alice', 'PUT', { state: state(), revision: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.data.revision, 1);
  assert.equal(stale.data.state.layers[0].codes.includes('320500'), true);
  assert.equal(stale.data.state.layers[1].codes.includes('320500'), true);
  const bad = state(); bad.layers[0].codes.push('invalid');
  assert.equal((await req('/api/state', 'alice', 'PUT', { state: bad, revision: 1 })).status, 400);
  const coercion = state(); coercion.layers[0].color = ['#ffffff'];
  assert.equal((await req('/api/state', 'alice', 'PUT', { state: coercion, revision: 1 })).status, 400);
  assert.equal((await req('/api/me')).data.revision, 1);
  assert.equal((await req('/api/me', 'bob')).data.state, null);
});

test('cross-origin writes are denied before mutation', async () => {
  assert.equal((await req('/api/profile', 'alice', 'POST', { name: '被篡改' }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await req('/api/profile', 'alice', 'POST', { name: '被篡改' }, { origin: '' })).status, 403);
  assert.equal((await req('/api/me')).data.user.name, '小齐');
});

test('friend requests require receiver acceptance and duplicate/self requests are rejected', async () => {
  const a = (await req('/api/me')).data.user;
  const b = (await req('/api/me', 'bob')).data.user;
  assert.equal((await req('/api/friends', 'alice', 'POST', { code: a.code })).status, 400);
  const request = await req('/api/friends', 'alice', 'POST', { code: b.code });
  const id = request.data.id;
  assert.equal((await req('/api/friends/bob/state')).status, 403);
  assert.equal((await req(`/api/friends/${id}/accept`, 'alice', 'POST')).status, 404);
  assert.equal((await req(`/api/friends/${id}/accept`, 'eve', 'POST')).status, 404);
  assert.equal((await req('/api/friends', 'bob', 'POST', { code: a.code })).status, 409);
  assert.equal((await req('/api/friends', 'bob')).data.incoming[0].from.id, 'alice');
  assert.equal((await req(`/api/friends/${id}/accept`, 'bob', 'POST')).status, 200);
  assert.equal((await req('/api/friends')).data.friends[0].id, 'bob');
  assert.equal((await req('/api/friends/bob/state')).status, 200);
  assert.equal((await req('/api/friends/alice', 'alice', 'DELETE')).status, 400);
  assert.equal((await req('/api/friends/bob', 'alice', 'DELETE')).status, 200);
  assert.equal((await req('/api/friends/bob/state')).status, 403);
});

test('friends-only photos and posts are hidden until accepted, and access is revoked on unfriend', async () => {
  const created = await createPost('alice', 'friends', true);
  assert.equal(created.status, 201);
  const post = created.data.post;
  assert.equal((await req('/api/posts?city=320500', 'bob')).data.posts.length, 0);
  assert.equal((await req(post.photoUrl, 'bob')).status, 404);
  assert.equal((await req(post.photoUrl, null)).status, 404);
  await befriend();
  assert.equal((await req('/api/posts?city=320500', 'bob')).data.posts.length, 1);
  assert.equal((await req(post.photoUrl, 'bob')).status, 200);
  assert.equal((await req(post.photoUrl, 'eve')).status, 404);
  await req('/api/friends/alice', 'bob', 'DELETE');
  assert.equal((await req(post.photoUrl, 'bob')).status, 404);
  assert.equal((await req(post.photoUrl)).response.headers.get('cache-control'), 'private, no-store');
});

test('public posts and photos are visible anonymously, but commenting requires login and content access', async () => {
  const post = (await createPost('alice', 'public', true)).data.post;
  assert.equal((await req('/api/posts?city=320500', null)).data.posts.length, 1);
  assert.equal((await req(post.photoUrl, null)).status, 200);
  assert.equal((await req(`/api/posts/${post.id}/comments`, null, 'POST', { text: '漂亮' })).status, 401);
  const comment = await req(`/api/posts/${post.id}/comments`, 'bob', 'POST', { text: '漂亮' });
  assert.equal(comment.status, 201);
  assert.equal(comment.data.comment.author.id, 'bob');
  assert.equal((await req(`/api/comments/${comment.data.comment.id}`, 'eve', 'DELETE')).status, 404);
  assert.equal((await req(`/api/comments/${comment.data.comment.id}`, 'bob', 'DELETE')).status, 200);
  const privatePost = (await createPost()).data.post;
  assert.equal((await req(`/api/posts/${privatePost.id}/comments`, 'bob', 'POST', { text: '猜测内容' })).status, 404);
});

test('post deletion is owner-only and removes comments and stored photo', async () => {
  const post = (await createPost('alice', 'public', true)).data.post;
  await req(`/api/posts/${post.id}/comments`, 'bob', 'POST', { text: '留下足迹' });
  assert.equal((await req(`/api/posts/${post.id}`, 'bob', 'DELETE')).status, 404);
  assert.equal(env.BUCKET.photos.size, 1);
  assert.equal((await req(`/api/posts/${post.id}`, 'alice', 'DELETE')).status, 200);
  assert.equal(env.BUCKET.photos.size, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 0);
  assert.equal((await req(post.photoUrl, null)).status, 404);
});

test('invalid uploads and empty posts are rejected before persistence', async () => {
  const form = new FormData();
  form.set('city', '320500'); form.set('visibility', 'public'); form.set('text', '');
  assert.equal((await req('/api/posts', 'alice', 'POST', form)).status, 400);
  form.set('photo', new Blob(['<svg onload="alert(1)"></svg>'], { type: 'image/png' }), 'fake.png');
  assert.equal((await req('/api/posts', 'alice', 'POST', form)).status, 400);
  assert.equal(env.BUCKET.photos.size, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
});

test('profile name updates propagate to existing post/comment projections without leaking private identifiers', async () => {
  const post = (await createPost('alice', 'public')).data.post;
  assert.equal((await req('/api/profile', 'alice', 'POST', { name: '追云的人' })).status, 200);
  const data = (await req('/api/posts?city=320500', 'bob')).data;
  assert.equal(data.posts[0].author.name, '追云的人');
  assert.equal(data.posts[0].id, post.id);
  assert.equal('code' in data.posts[0].author, false);
});

test('post pagination keeps all records with identical timestamps', async () => {
  await req('/api/me');
  const insert = sqlite.prepare("INSERT INTO posts(id,city,author_id,text,visibility,created_at) VALUES(?,'320500','alice','随笔','public','2026-11-09T12:00:00.000Z')");
  for (let i = 0; i < 31; i++) insert.run('post-' + String(i).padStart(2, '0'));
  const page1 = await req('/api/posts?city=320500', null);
  const page2 = await req('/api/posts?city=320500&before=' + encodeURIComponent(page1.data.nextBefore), null);
  assert.equal(page1.data.posts.length, 30); assert.equal(page2.data.posts.length, 1);
  assert.equal(new Set([...page1.data.posts, ...page2.data.posts].map(post => post.id)).size, 31);
});

test('state rejects reserved layer IDs and unknown map regions before touching saved data', async () => {
  env.ALLOWED_CITY_CODES = new Set(['320500', '510100']);
  assert.equal((await req('/api/state', 'alice', 'PUT', { state: state(), revision: 0 })).status, 200);
  const unknown = state(); unknown.layers[0].codes.push('999999');
  assert.equal((await req('/api/state', 'alice', 'PUT', { state: unknown, revision: 1 })).status, 400);
  const reserved = state(); reserved.layers[0].id = '__proto__'; reserved.activeLayerId = '__proto__';
  assert.equal((await req('/api/state', 'alice', 'PUT', { state: reserved, revision: 1 })).status, 400);
  assert.equal((await req('/api/me')).data.revision, 1);
  assert.equal((await req('/api/posts?city=999999', null)).status, 400);
});

test('three photos retain upload order, MIME types and the legacy first-photo URL', async () => {
  const created = await req('/api/posts', 'alice', 'POST', photoForm());
  assert.equal(created.status, 201);
  const post = created.data.post;
  assert.equal(post.photos.length, 3);
  assert.equal(post.photoUrl, `/api/photos/${post.id}`);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(post.photos[i], { url: `/api/photos/${post.id}/${i}` });
    const result = await req(post.photos[i].url, null);
    assert.equal(result.status, 200);
    assert.deepEqual(new Uint8Array(result.data), photoBytes[i]);
    assert.equal(result.response.headers.get('content-type'), ['image/png','image/jpeg','image/webp'][i]);
  }
  assert.deepEqual(new Uint8Array((await req(post.photoUrl, null)).data), photoBytes[0]);
  assert.equal((await req(`/api/photos/${post.id}/3`, null)).status, 404);
  assert.equal((await req(`/api/photos/${post.id}/-1`, null)).status, 404);
  assert.equal((await req('/api/posts?city=320500', null)).data.posts[0].photos.length, 3);
  assert.equal((await createPost('alice', 'public', false)).data.post.photos.length, 0);
});

test('server rejects four photos, invalid later images and individually oversized images without uploading', async () => {
  const four = await req('/api/posts', 'alice', 'POST', photoForm(4));
  assert.equal(four.status, 400); assert.equal(four.data.code, 'too_many_photos');
  const invalid = photoForm(2);
  invalid.append('photo', new Blob(['<svg onload=alert(1)>'], { type: 'image/png' }), 'fake.png');
  assert.equal((await req('/api/posts', 'alice', 'POST', invalid)).status, 400);
  const oversized = photoForm(2);
  oversized.append('photo', new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png');
  assert.equal((await req('/api/posts', 'alice', 'POST', oversized)).status, 413);
  assert.equal(env.BUCKET.photos.size, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
});

test('every image in a friends-only record uses the record authorization, including after unfriend', async () => {
  const post = (await req('/api/posts', 'alice', 'POST', photoForm(3, 'friends'))).data.post;
  const urls = [post.photoUrl, ...post.photos.map(photo => photo.url)];
  for (const url of urls) {
    assert.equal((await req(url, 'bob')).status, 404);
    assert.equal((await req(url, null)).status, 404);
  }
  await befriend();
  for (const url of urls) assert.equal((await req(url, 'bob')).status, 200);
  await req('/api/friends/alice', 'bob', 'DELETE');
  for (const url of urls) assert.equal((await req(url, 'bob')).status, 404);
  assert.equal((await req(`/api/posts/${post.id}`, 'alice', 'DELETE')).status, 200);
  assert.equal(env.BUCKET.photos.size, 0);
  for (const url of urls) assert.equal((await req(url, 'alice')).status, 404);
});

test('partially failed uploads and failed database writes clean up every attempted photo', async () => {
  const put = env.BUCKET.put;
  let attempted = 0;
  env.BUCKET.put = async (...args) => { await put(...args); if (++attempted === 2) throw new Error('injected storage failure'); };
  assert.equal((await req('/api/posts', 'alice', 'POST', photoForm())).status, 500);
  assert.equal(env.BUCKET.photos.size, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
  env.BUCKET.put = put;
  sqlite.exec("CREATE TRIGGER reject_post BEFORE INSERT ON posts BEGIN SELECT RAISE(ABORT, 'injected database failure'); END");
  assert.equal((await req('/api/posts', 'alice', 'POST', photoForm())).status, 500);
  assert.equal(env.BUCKET.photos.size, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
});

test('legacy single-photo rows remain readable through both URL forms and delete their original object', async () => {
  await req('/api/me');
  await env.BUCKET.put('photos/legacy-post', photoBytes[0]);
  sqlite.prepare("INSERT INTO posts(id,city,author_id,text,photo_key,photo_type,visibility,created_at) VALUES('legacy-post','320500','alice','旧记录','photos/legacy-post','image/png','public','2026-11-09T12:00:00Z')").run();
  const post = (await req('/api/posts?city=320500', null)).data.posts[0];
  assert.equal(post.photos.length, 1); assert.equal(post.photoUrl, '/api/photos/legacy-post');
  assert.equal((await req(post.photoUrl, null)).status, 200);
  assert.equal((await req(post.photos[0].url, null)).status, 200);
  assert.equal((await req('/api/photos/legacy-post/1', null)).status, 404);
  assert.equal((await req('/api/posts/legacy-post', 'alice', 'DELETE')).status, 200);
  assert.equal(env.BUCKET.photos.size, 0);
});

test('additive photo migrations preserve existing rows in local and deployment schemas', () => {
  for (const [initial, added] of [
    ['../migrations/0001.sql', '../migrations/0002_post_photos.sql'],
    ['../drizzle/0000_deep_cannonball.sql', '../drizzle/0001_post_photos.sql']
  ]) {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(readFileSync(new URL(initial, import.meta.url), 'utf8'));
      database.exec("INSERT INTO users VALUES('legacy','旧用户','legacycode','2026-11-01'); INSERT INTO posts(id,city,author_id,text,photo_key,photo_type,visibility,created_at) VALUES('p','320500','legacy','保留记录','photos/p','image/png','public','2026-11-01')");
      database.exec(readFileSync(new URL(added, import.meta.url), 'utf8'));
      const row = database.prepare('SELECT text,photo_key,photos_json FROM posts WHERE id=?').get('p');
      assert.equal(row.text, '保留记录'); assert.equal(row.photo_key, 'photos/p'); assert.equal(row.photos_json, null);
    } finally { database.close(); }
  }
});
