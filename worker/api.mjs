// Authentication is injected by the hosting entry point. It must verify a
// server-side session and return {id, name}; client-supplied IDs are never trusted.
const JSON_LIMIT = 256 * 1024;
const PHOTO_LIMIT = 5 * 1024 * 1024;
const PHOTO_COUNT_LIMIT = 3;
const CITY = /^\d{6}$/;
const COLOR = /^#[\da-f]{6}$/i;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message); this.status = status; this.code = code;
  }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
const first = (env, sql, ...params) => env.DB.prepare(sql).bind(...params).first();
const all = async (env, sql, ...params) => (await env.DB.prepare(sql).bind(...params).all()).results || [];
const run = (env, sql, ...params) => env.DB.prepare(sql).bind(...params).run();
const userView = (row) => ({ id: row.id, name: row.name, code: row.code });
const textField = (value, max, label, optional = false) => {
  if (typeof value !== 'string') fail(400, `请填写${label}`);
  const result = value.trim();
  if ((!optional && !result) || result.length > max) fail(400, `${label}须为 ${optional ? 0 : 1}–${max} 个字符`);
  return result;
};
async function bodyBytes(request, max) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > max) fail(413, '内容太大，请缩小后再试');
  if (!request.body) fail(400, '请求内容为空');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > max) { await reader.cancel(); fail(413, '内容太大，请缩小后再试'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
async function readJson(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) fail(415, '请使用 JSON 格式');
  let value;
  try { value = JSON.parse(new TextDecoder().decode(await bodyBytes(request, JSON_LIMIT))); }
  catch (error) { if (error instanceof HttpError) throw error; fail(400, 'JSON 格式不正确'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '请求内容须为对象');
  return value;
}
function verifyOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    fail(403, '请在本站页面中完成此操作', 'invalid_origin');
  }
}
export async function resolveUser(request, env, resolveIdentity, optional = false) {
  const identity = resolveIdentity ? await resolveIdentity(request, env) : null;
  const id = identity?.id;
  if (typeof id !== 'string' || !id || id.length > 250) {
    if (optional) return null;
    fail(401, '请先登录账号', 'sign_in_required');
  }
  let row = await first(env, 'SELECT id, name, code FROM users WHERE id = ?', id);
  if (row) return row;
  let name = typeof identity.name === 'string' ? identity.name : '旅行者';
  name = name.trim().slice(0, 40) || '旅行者';
  const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  await run(env, 'INSERT OR IGNORE INTO users(id, name, code, created_at) VALUES(?, ?, ?, ?)', id, name, code, now());
  row = await first(env, 'SELECT id, name, code FROM users WHERE id = ?', id);
  if (!row) fail(503, '账号初始化失败，请重试');
  return row;
}
async function stateFor(env, id) {
  const row = await first(env, 'SELECT state_json, revision FROM map_states WHERE user_id = ?', id);
  return { state: row?.state_json ? JSON.parse(row.state_json) : null, revision: row?.revision || 0 };
}
export function validateState(value, allowedCodes = null) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.layers) || !value.layers.length || value.layers.length > 40) {
    fail(400, '图层数量须为 1–40 个');
  }
  const ids = new Set();
  const layers = value.layers.map(layer => {
    if (!layer || typeof layer !== 'object' || typeof layer.id !== 'string' || !ID.test(layer.id) || RESERVED_IDS.has(layer.id) || ids.has(layer.id)) fail(400, '图层编号无效或重复');
    ids.add(layer.id);
    if (typeof layer.color !== 'string' || !COLOR.test(layer.color)) fail(400, '图层颜色无效');
    if (!Array.isArray(layer.codes) || layer.codes.length > 400 || layer.codes.some(code => typeof code !== 'string' || !CITY.test(code))) fail(400, '图层行政区编号无效');
    if (allowedCodes && layer.codes.some(code => !allowedCodes.has(code))) fail(400, '图层含有本地图之外的行政区');
    if (typeof layer.visible !== 'boolean' || typeof layer.visited !== 'boolean') fail(400, '图层设置无效');
    return { id: layer.id, name: textField(layer.name, 60, '图层名称'), color: layer.color.toLowerCase(), visible: layer.visible, visited: layer.visited, codes: [...new Set(layer.codes)] };
  });
  if (!ids.has(value.activeLayerId)) fail(400, '请选择有效的当前图层');
  if (typeof value.background !== 'string' || !COLOR.test(value.background)) fail(400, '背景颜色无效');
  return { layers, activeLayerId: value.activeLayerId, background: value.background.toLowerCase() };
}
async function areFriends(env, a, b) {
  if (!a || !b) return false;
  const pair = [a, b].sort();
  return !!await first(env, "SELECT id FROM friendships WHERE pair_a = ? AND pair_b = ? AND status = 'accepted'", ...pair);
}
async function readablePost(env, id, actor) {
  const post = await first(env, 'SELECT p.*, u.name AS author_name FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?', id);
  if (!post || !(post.author_id === actor || post.visibility === 'public' || await areFriends(env, post.author_id, actor))) fail(404, '内容不存在或暂不可见', 'not_found');
  return post;
}
function postPhotos(post) {
  if (post.photos_json != null) return JSON.parse(post.photos_json);
  return post.photo_key ? [{ key: post.photo_key, type: post.photo_type }] : [];
}
async function removePhotoObjects(env, keys) {
  if (!keys.length || !env.BUCKET) return;
  const results = await Promise.allSettled([...new Set(keys)].map(async key => env.BUCKET.delete(key)));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new Error(`Failed to remove ${failures.length} photo object(s)`);
}
async function postView(env, post) {
  const comments = await all(env, 'SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 100', post.id);
  const photos = postPhotos(post).map((_, index) => ({ url: `/api/photos/${post.id}/${index}` }));
  return {
    id: post.id, city: post.city, author: { id: post.author_id, name: post.author_name },
    text: post.text, photos, photoUrl: photos.length ? `/api/photos/${post.id}` : null,
    visibility: post.visibility, createdAt: post.created_at,
    comments: comments.map(c => ({ id: c.id, author: { id: c.author_id, name: c.author_name }, text: c.text, createdAt: c.created_at }))
  };
}
function photoType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  fail(400, '照片支持 JPEG、PNG 或 WebP 图片');
}
async function rateLimit(env, table, actor, limit) {
  // The table name is an internal constant, never request data.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = await first(env, `SELECT COUNT(*) AS count FROM ${table} WHERE author_id = ? AND created_at > ?`, actor, since);
  if (row.count >= limit) fail(429, '今日发布次数已达上限，请明天再来');
}
export async function api(request, env, resolveIdentity = null) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  try {
    if (!env.DB) fail(503, '云端数据服务尚未连接', 'storage_unavailable');
    verifyOrigin(request);
    const path = url.pathname;
    const method = request.method;
    const publicRead = method === 'GET' && (path === '/api/posts' || /^\/api\/photos\/[^/]+(?:\/[^/]+)?$/.test(path));
    const actor = await resolveUser(request, env, resolveIdentity, publicRead) || { id: '' };
    if (path === '/api/me' && method === 'GET') return json({ user: userView(actor), ...await stateFor(env, actor.id) });
    if (path === '/api/profile' && method === 'GET') return json({ user: userView(actor) });
    if (path === '/api/profile' && method === 'POST') {
      const body = await readJson(request);
      const name = textField(body.name, 40, '昵称');
      await run(env, 'UPDATE users SET name = ? WHERE id = ?', name, actor.id);
      return json({ user: { ...userView(actor), name } });
    }
    if (path === '/api/state' && method === 'PUT') {
      const body = await readJson(request);
      const state = validateState(body.state, env.ALLOWED_CITY_CODES);
      if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, '同步版本无效');
      const stamp = now();
      await run(env, 'INSERT OR IGNORE INTO map_states(user_id, state_json, revision, updated_at) VALUES(?, NULL, 0, ?)', actor.id, stamp);
      const result = await run(env, 'UPDATE map_states SET state_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?', JSON.stringify(state), stamp, actor.id, body.revision);
      if (!result.meta.changes) return json({ error: '其他设备已更新地图，请先加载云端版本再继续', code: 'revision_conflict', ...await stateFor(env, actor.id) }, 409);
      return json({ revision: body.revision + 1, savedAt: stamp });
    }
    if (path === '/api/friends' && method === 'GET') {
      const rows = await all(env, 'SELECT f.*, a.name AS sender_name, a.code AS sender_code, b.name AS receiver_name, b.code AS receiver_code FROM friendships f JOIN users a ON a.id = f.sender_id JOIN users b ON b.id = f.receiver_id WHERE f.sender_id = ? OR f.receiver_id = ? ORDER BY f.created_at DESC', actor.id, actor.id);
      const friends = [], incoming = [], outgoing = [];
      for (const row of rows) {
        const from = { id: row.sender_id, name: row.sender_name, code: row.sender_code };
        const to = { id: row.receiver_id, name: row.receiver_name, code: row.receiver_code };
        if (row.status === 'accepted') friends.push(row.sender_id === actor.id ? to : from);
        else if (row.receiver_id === actor.id) incoming.push({ id: row.id, from });
        else outgoing.push({ id: row.id, to });
      }
      return json({ friends, incoming, outgoing });
    }
    if (path === '/api/friends' && method === 'POST') {
      const body = await readJson(request);
      const code = textField(body.code, 32, '好友码').toUpperCase();
      const target = await first(env, 'SELECT id, name, code FROM users WHERE code = ?', code);
      if (!target) fail(404, '未找到此好友码，请核对后重试');
      if (target.id === actor.id) fail(400, '这是你自己的好友码');
      const pair = [actor.id, target.id].sort();
      const existing = await first(env, 'SELECT id, status FROM friendships WHERE pair_a = ? AND pair_b = ?', ...pair);
      if (existing) fail(409, existing.status === 'accepted' ? '你们已经是好友了' : '已有待处理的好友申请', 'friendship_exists');
      const id = uuid();
      const result = await run(env, "INSERT OR IGNORE INTO friendships(id, sender_id, receiver_id, pair_a, pair_b, status, created_at) VALUES(?, ?, ?, ?, ?, 'pending', ?)", id, actor.id, target.id, ...pair, now());
      if (!result.meta.changes) fail(409, '已有待处理的好友申请', 'friendship_exists');
      return json({ id, to: userView(target), status: 'pending' }, 201);
    }
    let match = path.match(/^\/api\/friends\/([^/]+)\/accept$/);
    if (match && method === 'POST') {
      const result = await run(env, "UPDATE friendships SET status = 'accepted' WHERE id = ? AND receiver_id = ? AND status = 'pending'", match[1], actor.id);
      if (!result.meta.changes) fail(404, '好友申请不存在或已处理');
      return json({ ok: true });
    }
    match = path.match(/^\/api\/friends\/([^/]+)\/state$/);
    if (match && method === 'GET') {
      const friendId = decodeURIComponent(match[1]);
      if (!await areFriends(env, actor.id, friendId)) fail(403, '成为好友后可查看对方足迹');
      const user = await first(env, 'SELECT id, name, code FROM users WHERE id = ?', friendId);
      return json({ user: userView(user), ...await stateFor(env, friendId) });
    }
    match = path.match(/^\/api\/friends\/([^/]+)$/);
    if (match && method === 'DELETE') {
      const id = decodeURIComponent(match[1]);
      if (id === actor.id) fail(400, '请选择要删除的好友');
      const result = await run(env, 'DELETE FROM friendships WHERE (sender_id = ? OR receiver_id = ?) AND (id = ? OR sender_id = ? OR receiver_id = ?)', actor.id, actor.id, id, id, id);
      if (!result.meta.changes) fail(404, '好友关系或申请不存在');
      return json({ ok: true });
    }
    if (path === '/api/posts' && method === 'GET') {
      const city = url.searchParams.get('city') || '';
      if (!CITY.test(city)) fail(400, '请选择一个行政区');
      if (env.ALLOWED_CITY_CODES && !env.ALLOWED_CITY_CODES.has(city)) fail(400, '此行政区不在本地图中');
      const before = url.searchParams.get('before');
      let beforeTime = '9999', beforeId = '';
      if (before) {
        const parts = before.split('~');
        if (before.length > 150 || parts.length > 2 || !Number.isFinite(Date.parse(parts[0])) || (parts[1] && !ID.test(parts[1]))) fail(400, '分页位置无效，请刷新记录');
        [beforeTime, beforeId = ''] = parts;
      }
      const rows = await all(env, `SELECT p.*, u.name AS author_name FROM posts p JOIN users u ON u.id = p.author_id WHERE p.city = ? AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?)) AND (p.author_id = ? OR p.visibility = 'public' OR EXISTS(SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND ((f.sender_id = p.author_id AND f.receiver_id = ?) OR (f.receiver_id = p.author_id AND f.sender_id = ?)))) ORDER BY p.created_at DESC, p.id DESC LIMIT 30`, city, beforeTime, beforeTime, beforeId, actor.id, actor.id, actor.id);
      const posts = await Promise.all(rows.map(row => postView(env, row)));
      const last = rows[rows.length - 1];
      return json({ posts, nextBefore: rows.length === 30 ? `${last.created_at}~${last.id}` : null });
    }
    if (path === '/api/posts' && method === 'POST') {
      await rateLimit(env, 'posts', actor.id, 40);
      const type = request.headers.get('content-type') || '';
      if (!type.toLowerCase().startsWith('multipart/form-data')) fail(415, '请使用照片随笔表单');
      const bytes = await bodyBytes(request, PHOTO_LIMIT * PHOTO_COUNT_LIMIT + 64 * 1024);
      let form;
      try { form = await new Response(bytes, { headers: { 'content-type': type } }).formData(); } catch { fail(400, '表单格式不正确'); }
      const city = form.get('city');
      if (typeof city !== 'string' || !CITY.test(city)) fail(400, '请选择一个行政区');
      if (env.ALLOWED_CITY_CODES && !env.ALLOWED_CITY_CODES.has(city)) fail(400, '此行政区不在本地图中');
      const text = textField(form.get('text') || '', 5000, '随笔', true);
      const visibility = form.get('visibility');
      if (!['public', 'friends'].includes(visibility)) fail(400, '请选择公开或好友可见');
      const uploads = form.getAll('photo');
      if (uploads.length > PHOTO_COUNT_LIMIT) fail(400, '每条记录最多上传 3 张照片', 'too_many_photos');
      const photos = [];
      for (const photo of uploads) {
        if (typeof photo === 'string' || !photo.size) fail(400, '请上传有效的照片文件');
        if (photo.size > PHOTO_LIMIT) fail(413, '每张照片最大 5 MB');
        const photoBytes = new Uint8Array(await photo.arrayBuffer());
        photos.push({ bytes: photoBytes, type: photoType(photoBytes) });
      }
      if (!text && !photos.length) fail(400, '请添加照片或写下一段随笔');
      if (photos.length && !env.BUCKET) fail(503, '照片存储尚未连接');
      const id = uuid();
      const metadata = photos.map((photo, index) => ({ key: `photos/${id}/${index}`, type: photo.type }));
      const attemptedKeys = [];
      try {
        for (let index = 0; index < photos.length; index++) {
          attemptedKeys.push(metadata[index].key);
          await env.BUCKET.put(metadata[index].key, photos[index].bytes, { httpMetadata: { contentType: photos[index].type } });
        }
        await run(env, 'INSERT INTO posts(id, city, author_id, text, photo_key, photo_type, photos_json, visibility, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)', id, city, actor.id, text, metadata[0]?.key || null, metadata[0]?.type || null, JSON.stringify(metadata), visibility, now());
      } catch (error) {
        // Include the failed PUT key: object storage may have accepted its bytes
        // before the connection failed. Attempt every cleanup even if one fails.
        try { await removePhotoObjects(env, attemptedKeys); } catch { console.error('Photo upload cleanup failed'); }
        throw error;
      }
      return json({ post: await postView(env, await readablePost(env, id, actor.id)) }, 201);
    }
    match = path.match(/^\/api\/posts\/([^/]+)\/comments$/);
    if (match && method === 'POST') {
      await readablePost(env, match[1], actor.id);
      await rateLimit(env, 'comments', actor.id, 150);
      const body = await readJson(request);
      const text = textField(body.text, 1000, '评论');
      const count = await first(env, 'SELECT COUNT(*) AS count FROM comments WHERE post_id = ?', match[1]);
      if (count.count >= 100) fail(409, '此随笔已有 100 条评论');
      const id = uuid(), createdAt = now();
      await run(env, 'INSERT INTO comments(id, post_id, author_id, text, created_at) VALUES(?, ?, ?, ?, ?)', id, match[1], actor.id, text, createdAt);
      return json({ comment: { id, author: { id: actor.id, name: actor.name }, text, createdAt } }, 201);
    }
    match = path.match(/^\/api\/posts\/([^/]+)$/);
    if (match && method === 'DELETE') {
      const post = await first(env, 'SELECT id, photo_key, photo_type, photos_json FROM posts WHERE id = ? AND author_id = ?', match[1], actor.id);
      if (!post) fail(404, '随笔不存在或无权删除');
      // SQL deletion first immediately revokes photo access, even if bucket cleanup fails.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM comments WHERE post_id = ?').bind(post.id),
        env.DB.prepare('DELETE FROM posts WHERE id = ? AND author_id = ?').bind(post.id, actor.id)
      ]);
      await removePhotoObjects(env, postPhotos(post).map(photo => photo.key));
      return json({ ok: true });
    }
    match = path.match(/^\/api\/comments\/([^/]+)$/);
    if (match && method === 'DELETE') {
      const result = await run(env, 'DELETE FROM comments WHERE id = ? AND author_id = ?', match[1], actor.id);
      if (!result.meta.changes) fail(404, '评论不存在或无权删除');
      return json({ ok: true });
    }
    match = path.match(/^\/api\/photos\/([^/]+)(?:\/([^/]+))?$/);
    if (match && method === 'GET') {
      if (match[2] !== undefined && !/^[0-2]$/.test(match[2])) fail(404, '照片不存在');
      const post = await readablePost(env, match[1], actor.id);
      const metadata = postPhotos(post)[Number(match[2] || 0)];
      if (!metadata || !env.BUCKET) fail(404, '照片不存在');
      const photo = await env.BUCKET.get(metadata.key);
      if (!photo) fail(404, '照片不存在');
      return new Response(photo.body, { headers: { 'Content-Type': metadata.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } });
    }
    fail(404, '接口不存在', 'not_found');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);
    console.error('API operation failed', error?.message || 'unknown error');
    return json({ error: '服务暂时不可用，请稍后重试', code: 'internal_error' }, 500);
  }
}
