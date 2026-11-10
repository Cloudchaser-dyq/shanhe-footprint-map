import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProvinceRegions } from '../scripts/map-regions.mjs';
import { readFileSync } from 'node:fs';
import { createState, validateState, calculateSet, migrateProject } from '../web/core.js';

const feature = (adcode, level = 'city') => ({ properties: { adcode, level }, geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[0,1],[0,0]]] } });

test('region selection includes direct-administered cities, counties and forest districts without suffix or level assumptions', () => {
  for (const [province, codes] of [
    ['410000', ['410100', '419001']],
    ['420000', ['420100', '429004', '429005', '429006', '429021']],
    ['460000', ['460100', '469001', '469021', '469030']],
    ['650000', ['650100', '659001', '659010']]
  ]) {
    const children = codes.map((code, index) => feature(code, index ? 'district' : 'city'));
    assert.deepEqual(selectProvinceRegions(feature(province), { features: [feature(province), ...children, feature('100000_JD')] }), children);
  }
});

test('municipalities, Taiwan, Hong Kong and Macao retain their existing whole-region codes', () => {
  for (const code of ['110000', '120000', '310000', '500000', '710000', '810000', '820000']) {
    const province = feature(code);
    assert.deepEqual(selectProvinceRegions(province), [province]);
  }
});

test('missing, duplicate, foreign or non-polygon regions stop map generation', () => {
  const province = feature('460000');
  assert.throws(() => selectProvinceRegions(province, { features: [] }), /No administrative/);
  assert.throws(() => selectProvinceRegions(province, { features: [feature('460100'), feature('460100')] }), /Invalid or duplicate/);
  assert.throws(() => selectProvinceRegions(province, { features: [feature('429004')] }), /Invalid or duplicate/);
  const line = feature('469021'); line.geometry.type = 'LineString';
  assert.throws(() => selectProvinceRegions(province, { features: [line] }), /Invalid or duplicate/);
});

test('new regions participate in saved state, legacy imports and set complements', () => {
  const { cities } = JSON.parse(readFileSync(new URL('../web/map-data.json', import.meta.url), 'utf8'));
  const codes = ['419001', '429004', '429005', '429006', '429021', '469001', '469021', '469030', '659001', '659010'];
  const state = createState(); state.layers[0].codes = ['320500', ...codes];
  assert.deepEqual(validateState(state, cities), state);
  const imported = migrateProject({ '济源': '#f00', '神农架林区': '#f00', '定安县': '#f00', '石河子': '#f00' }, cities);
  assert.deepEqual(imported.state.layers[0].codes, ['419001', '429021', '469021', '659001']);
  const complement = calculateSet(['320500'], [], 'complement', cities.map(city => city.code));
  for (const code of codes) assert.ok(complement.includes(code), code);
});
