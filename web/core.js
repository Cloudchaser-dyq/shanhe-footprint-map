const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_LAYERS = 40;
const MAX_CODES = 400;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function createState() {
  return {
    layers: [
      {id: 'visited', name: '去过的地方', color: '#218374', visible: true, visited: true, codes: []},
      {id: 'wishlist', name: '想去的地方', color: '#e1a24a', visible: true, visited: false, codes: []}
    ],
    activeLayerId: 'visited',
    background: '#eaf1ef'
  };
}

export function calculateSet(a, b, op, universe = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || !Array.isArray(universe)) throw new Error('集合须为数组');
  const A = new Set(a), B = new Set(b), U = new Set(universe);
  switch (op) {
    case 'intersection': return [...A].filter(code => B.has(code));
    case 'union': return [...new Set([...A, ...B])];
    case 'difference': return [...A].filter(code => !B.has(code));
    case 'xor': return [...new Set([...A, ...B])].filter(code => A.has(code) !== B.has(code));
    case 'complement': return [...U].filter(code => !A.has(code));
    case 'neither': return [...U].filter(code => !A.has(code) && !B.has(code));
    default: throw new Error('未知集合运算');
  }
}

function hex(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return '#' + color.slice(1).split('').map(char => char + char).join('');
  return null;
}
function cleanName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
}
function cityIndex(cities) {
  if (!Array.isArray(cities)) throw new Error('行政区目录不可用');
  const byCode = new Map(), byName = new Map(), byShortName = new Map();
  for (const city of cities) {
    if (!record(city) || !own(city, 'code') || !own(city, 'name') || !/^\d{6}$/.test(city.code) || typeof city.name !== 'string') continue;
    byCode.set(city.code, city);
    if (!byName.has(city.name)) byName.set(city.name, new Set());
    byName.get(city.name).add(city.code);
    const shortName = normalizeRegionName(city.name);
    if (!byShortName.has(shortName)) byShortName.set(shortName, new Set());
    byShortName.get(shortName).add(city.code);
  }
  if (!byCode.size) throw new Error('行政区目录为空');
  return {byCode, resolve(key) {
    const name = String(key ?? '').trim();
    if (byCode.has(name)) return name;
    const matches = byName.get(name) || byShortName.get(normalizeRegionName(name));
    return matches?.size === 1 ? [...matches][0] : null;
  }};
}
function normalizeRegionName(value) {
  return String(value).trim().replace(/\s+/g, '').replace(/特别行政区$/, '').replace(/自治州$/, '').replace(/地区$/, '').replace(/盟$/, '').replace(/市$/, '');
}

function normalizeState(value, cities, warnings = null) {
  if (!record(value) || !own(value, 'layers') || !Array.isArray(value.layers) || !value.layers.length || value.layers.length > MAX_LAYERS) throw new Error('图层数量须为 1–40 个');
  const index = cityIndex(cities);
  const ids = new Set();
  let incomingCodes = 0, retainedCodes = 0;
  const layers = value.layers.map((layer, i) => {
    if (!record(layer)) throw new Error(`第 ${i + 1} 个图层格式错误`);
    const required = ['id', 'name', 'color', 'visible', 'visited', 'codes'];
    if (required.some(key => !own(layer, key))) throw new Error(`第 ${i + 1} 个图层缺少必要字段`);
    if (typeof layer.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(layer.id) || RESERVED_IDS.has(layer.id) || ids.has(layer.id)) throw new Error('图层编号无效或重复');
    ids.add(layer.id);
    const name = cleanName(layer.name);
    if (!name || name.length > 60) throw new Error('图层名称须为 1–60 个字符');
    const color = hex(layer.color);
    if (!color) throw new Error(`图层「${name}」的颜色无效`);
    if (typeof layer.visible !== 'boolean' || typeof layer.visited !== 'boolean') throw new Error(`图层「${name}」的显示或足迹设置无效`);
    if (!Array.isArray(layer.codes) || layer.codes.length > MAX_CODES) throw new Error(`图层「${name}」的行政区数量无效`);
    const codes = [];
    const seen = new Set();
    for (const code of layer.codes) {
      incomingCodes++;
      if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !index.byCode.has(code)) {
        if (warnings) { warnings.push(`图层「${name}」跳过未知行政区：${String(code).slice(0, 100)}`); continue; }
        throw new Error(`图层「${name}」含有未知行政区`);
      }
      retainedCodes++;
      if (!seen.has(code)) { seen.add(code); codes.push(code); }
    }
    return {id: layer.id, name, color, visible: layer.visible, visited: layer.visited, codes};
  });
  if (!own(value, 'activeLayerId') || !ids.has(value.activeLayerId)) throw new Error('当前图层不存在');
  const background = own(value, 'background') ? hex(value.background) : null;
  if (!background) throw new Error('背景颜色无效');
  if (warnings && incomingCodes > 0 && retainedCodes === 0) throw new Error('导入文件中的行政区均无法识别，当前数据未修改');
  return {layers, activeLayerId: value.activeLayerId, background};
}

export function validateState(input, cities) {
  return normalizeState(input, cities);
}

const METADATA_KEYS = new Set(['format', 'version', 'savedAt', 'replace', 'colorNotes', 'hiddenColors', '__proto__', 'prototype', 'constructor']);
function firstOwn(item, keys) {
  for (const key of keys) if (own(item, key) && item[key] != null) return item[key];
  return undefined;
}
function legacyEntries(input) {
  if (Array.isArray(input)) return input.map(item => {
    if (!record(item)) return [null, undefined];
    return [firstOwn(item, ['adcode', 'code', 'name', 'city', 'region']), firstOwn(item, ['color', 'fill', 'hex'])];
  });
  if (!record(input)) throw new Error('JSON 须为地图工程、城市配色对象或数组');
  if (own(input, 'colors')) {
    if (!record(input.colors) && !Array.isArray(input.colors)) throw new Error('colors 须为对象或数组');
    return legacyEntries(input.colors);
  }
  return Object.entries(input).filter(([key]) => !METADATA_KEYS.has(key));
}

export function migrateProject(input, cities) {
  const warnings = [];
  if (record(input) && own(input, 'state')) {
    return {state: normalizeState(input.state, cities, warnings), warnings};
  }
  if (record(input) && own(input, 'layers')) {
    return {state: normalizeState(input, cities, warnings), warnings};
  }
  const entries = legacyEntries(input);
  const index = cityIndex(cities);
  const notes = new Map();
  if (record(input) && own(input, 'colorNotes') && record(input.colorNotes)) {
    for (const [color, value] of Object.entries(input.colorNotes)) {
      const normalized = hex(color), name = cleanName(value);
      if (normalized && name) notes.set(normalized, name.slice(0, 60));
    }
  }
  const hidden = new Set(record(input) && own(input, 'hiddenColors') && Array.isArray(input.hiddenColors) ? input.hiddenColors.map(hex).filter(Boolean) : []);
  // A legacy city can occur more than once under a code and a name. Preserve
  // the old file's final assignment instead of placing it in two new layers.
  const assignments = new Map();
  for (const [key, value] of entries) {
    const code = key == null ? null : index.resolve(key);
    if (!code) { warnings.push(`跳过未匹配行政区：${String(key ?? '缺少名称').slice(0, 100)}`); continue; }
    if (value == null || value === '') {
      assignments.delete(code);
      warnings.push(`「${String(key).slice(0, 100)}」为空配色，未加入图层`);
      continue;
    }
    const color = hex(value);
    if (!color) { warnings.push(`跳过「${String(key).slice(0, 100)}」的无效颜色`); continue; }
    assignments.set(code, color);
  }
  if (!assignments.size) throw new Error('没有找到有效的城市配色，当前数据未修改');
  const groups = new Map();
  for (const [code, color] of assignments) {
    if (!groups.has(color)) groups.set(color, []);
    groups.get(color).push(code);
  }
  if (groups.size > MAX_LAYERS) throw new Error('配色超过 40 种，请将文件拆分后导入');
  const layers = [...groups].map(([color, codes], i) => ({id: `imported-${i + 1}`, name: notes.get(color) || `导入图层 ${i + 1}`, color, visible: !hidden.has(color), visited: true, codes}));
  warnings.push('旧版配色已按颜色拆分图层，默认计入「去过」；可在图层设置中调整。');
  return {state: {layers, activeLayerId: layers[0].id, background: createState().background}, warnings};
}
