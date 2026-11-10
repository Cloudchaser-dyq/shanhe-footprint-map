import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { readdirSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer } from '../scripts/dev-server.mjs';

test('real local HTTP serves assets, persists native accounts and photos, and blocks external paths and hosts', async () => {
  const tmpRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.task-tmp');
  const dataDir = resolve(tmpRoot, 'dev-server-test-' + crypto.randomUUID());
  let instance = await startDevServer({ port: 0, dataDir, quiet: true });
  let base = instance.url;
  const request = async (path, { body, cookie, method, form, origin = base } = {}) => {
    const headers = { origin, connection: 'close' };
    if (cookie) headers.cookie = cookie;
    if (body) headers['content-type'] = 'application/json';
    return fetch(base + path, { method: method || (body || form ? 'POST' : 'GET'), headers, body: form || (body ? JSON.stringify(body) : undefined) });
  };
  try {
    const index = await request('/'); assert.equal(index.status, 200); assert.ok((await index.text()).includes('<html'));
    assert.equal((await request('/.task-tmp/local-data/atlas.sqlite')).status, 403);
    assert.equal((await request('/..%5cworker%5cauth.mjs')).status, 403);
    const hostileHost = await new Promise((resolveStatus, reject) => {
      const r = rawRequest(base, { headers: { host: 'evil.example' } }, res => { res.resume(); resolveStatus(res.statusCode); });
      r.once('error', reject); r.end();
    });
    assert.equal(hostileHost, 403);
    assert.equal((await request('/api/auth/register', { body: { username: 'local_test', password: 'local-test-password' }, origin: 'https://evil.example' })).status, 403);
    const registered = await request('/api/auth/register', { body: { username: 'local_test', password: 'local-test-password', name: '' } });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie').split(';')[0];
    const me = await request('/api/me', { cookie }); assert.equal(me.status, 200);
    assert.equal((await me.json()).user.name, 'local_test');
    const savedState = { layers: [{ id: 'visited', name: '原有和补齐的足迹', color: '#218374', visible: true, visited: true, codes: ['320500', '419001', '429021', '469021', '659001'] }], activeLayerId: 'visited', background: '#eaf1ef' };
    assert.equal((await request('/api/state', { method: 'PUT', body: { state: savedState, revision: 0 }, cookie })).status, 200);
    const form = new FormData(); form.set('city', '320500'); form.set('text', '真实 HTTP 上传测试'); form.set('visibility', 'public');
    const image = new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0,1])], { type: 'image/png' });
    for (let index = 0; index < 3; index++) form.append('photo', image, `test-${index}.png`);
    const posted = await request('/api/posts', { form, cookie }); assert.equal(posted.status, 201);
    const post = (await posted.json()).post;
    assert.equal(post.photos.length, 3);
    assert.equal((await request(post.photoUrl)).status, 200);
    for (const photo of post.photos) assert.equal((await request(photo.url)).status, 200);
    form.append('photo', image, 'fourth.png');
    const rejected = await request('/api/posts', { form, cookie });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'too_many_photos');
    assert.equal(readdirSync(resolve(dataDir, 'photos')).length, 3);
    const previousPort = Number(new URL(base).port);
    await instance.close();
    instance = await startDevServer({ port: previousPort, dataDir, quiet: true }); base = instance.url;
    const persisted = await request('/api/me', { cookie });
    assert.equal(persisted.status, 200);
    assert.deepEqual((await persisted.json()).state, savedState);
    assert.equal((await request(post.photoUrl)).status, 200);
    for (const photo of post.photos) assert.equal((await request(photo.url)).status, 200);
  } finally {
    await instance.close();
    // Only the uniquely-created test directory is removed; guard its absolute scope.
    const part = relative(tmpRoot, dataDir);
    assert.ok(part.startsWith('dev-server-test-') && !part.includes('..') && !isAbsolute(part));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
