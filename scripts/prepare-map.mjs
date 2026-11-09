import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Preserve the source page's region selection and Mercator projection.
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const WIDTH = 1200, HEIGHT = 820, PAD = 24;
const SPECIAL = new Set(['110000', '120000', '310000', '500000', '710000', '810000', '820000']);
const codeOf = feature => String(feature.properties?.adcode ?? feature.properties?.code ?? '');
const nameOf = feature => String(feature.properties?.name ?? feature.properties?.NAME ?? codeOf(feature));

async function fetchJson(code) {
  const url = `${BASE}${code}_full.json`;
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(25000)});
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const json = await response.json();
      if (!Array.isArray(json.features) || !json.features.length) throw new Error('Empty feature collection');
      return json;
    } catch (error) { failure = error; }
  }
  throw new Error(`Unable to retrieve ${url}: ${failure?.message}`);
}

function eachPoint(coords, fn) {
  if (!Array.isArray(coords)) return;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') { fn(coords); return; }
  coords.forEach(c => eachPoint(c, fn));
}
function mercator(lon, lat) {
  const limited = Math.max(-85, Math.min(85, lat));
  return [lon * Math.PI / 180, -Math.log(Math.tan(Math.PI / 4 + limited * Math.PI / 360))];
}

const national = await fetchJson('100000');
const provinces = national.features.filter(f => codeOf(f));
const output = [];
// The source includes 100000_JD, a non-administrative border-line geometry.
// Keep it in the boundary layer and projection bounds, never as a clickable city.
const administrativeProvinces = provinces.filter(f => /^\d{6}$/.test(codeOf(f)));
const auxiliaryBoundaries = provinces.filter(f => !/^\d{6}$/.test(codeOf(f)));
const queue = [...administrativeProvinces];
let completed = 0;
await Promise.all(Array.from({length: 5}, async () => {
  while (queue.length) {
    const province = queue.shift();
    const pcode = codeOf(province);
    if (SPECIAL.has(pcode)) output.push(province);
    else {
      const data = await fetchJson(pcode);
      const children = data.features.filter(f => {
        const code = codeOf(f);
        return code.length === 6 && code.endsWith('00') && code !== pcode;
      });
      if (!children.length) throw new Error(`No prefecture-level children for ${pcode} ${nameOf(province)}; refusing a province fallback.`);
      output.push(...children);
    }
    console.log(`${++completed}/${administrativeProvinces.length} ${pcode} ${nameOf(province)}`);
  }
}));
const features = [...new Map(output.map(f => [codeOf(f), f])).values()].sort((a, b) => codeOf(a).localeCompare(codeOf(b)));
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
[...features, ...auxiliaryBoundaries].forEach(f => eachPoint(f.geometry?.coordinates, p => {
  const [x, y] = mercator(p[0], p[1]);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
}));
const scale = Math.min((WIDTH - PAD * 2) / (maxX - minX), (HEIGHT - PAD * 2) / (maxY - minY));
const offX = (WIDTH - (maxX - minX) * scale) / 2 - minX * scale;
const offY = (HEIGHT - (maxY - minY) * scale) / 2 - minY * scale;
const project = p => { const [x, y] = mercator(p[0], p[1]); return [x * scale + offX, y * scale + offY]; };
const ringPath = ring => !ring?.length ? '' : 'M' + ring.map(project).map((p, i) => (i ? 'L' : '') + p[0].toFixed(2) + ',' + p[1].toFixed(2)).join('') + 'Z';
const geomPath = geom => geom?.type === 'Polygon' ? geom.coordinates.map(ringPath).join('') : geom?.type === 'MultiPolygon' ? geom.coordinates.map(poly => poly.map(ringPath).join('')).join('') : '';
const convert = f => ({code: codeOf(f), name: nameOf(f), path: geomPath(f.geometry)});
const data = {width: WIDTH, height: HEIGHT, cities: features.map(convert), provinces: provinces.map(convert), source: BASE, fetchedAt: new Date().toISOString()};
if (data.cities.some(c => !/^\d{6}$/.test(c.code) || !c.path || /NaN|Infinity/.test(c.path))) throw new Error('Invalid generated city paths');
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'web'), {recursive: true});
const json = JSON.stringify(data);
await writeFile(path.join(root, 'web', 'map-data.json'), json);
console.log(`Wrote ${data.cities.length} regions, ${data.provinces.length} provincial boundaries, ${Buffer.byteLength(json)} bytes.`);
