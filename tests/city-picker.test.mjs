import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildCityIndex, searchCities, recentCityCodes} from '../web/city-picker.js';

const map = JSON.parse(await readFile(new URL('../web/map-data.json', import.meta.url), 'utf8'));
const index = buildCityIndex(map.cities, map.provinces);

test('all 370 map regions belong to a valid province; non-six-digit outline is omitted', () => {
  assert.equal(index.cities.length, 370);
  assert.equal(index.provinces.length, 34);
  assert.equal(index.provinces.reduce((sum, province) => sum + province.cities.length, 0), 370);
  assert(!index.provinces.some((province) => province.code === '100000_JD'));
  assert(index.byProvince.get('32').cities.some((city) => city.name === '苏州市'));
});

test('direct-administered regions fill the four affected provinces and remain searchable', () => {
  for (const [prefix, count] of [['41', 18], ['42', 17], ['46', 19], ['65', 24]]) assert.equal(index.byProvince.get(prefix).cities.length, count);
  for (const [query, code] of [['济源', '419001'], ['湖北神农架', '429021'], ['仙桃', '429004'], ['海南定安', '469021'], ['琼中', '469030'], ['新疆石河子', '659001'], ['胡杨河', '659010']]) {
    assert.equal(searchCities(index, query).items[0]?.code, code, query);
  }
  for (const region of map.cities) {
    assert.ok(region.path.startsWith('M') && region.path.endsWith('Z'), region.code);
    assert.ok(!/NaN|Infinity/.test(region.path), region.code);
  }
  assert.equal(new Set(map.cities.map(city => city.code)).size, map.cities.length);
});

test('municipalities, Hong Kong, Macao and Taiwan retain their selectable map region', () => {
  for (const code of ['110000','120000','310000','500000','710000','810000','820000']) {
    assert(index.byProvince.get(code.slice(0, 2)).cities.some((city) => city.code === code), code);
  }
  assert.equal(index.byProvince.get('45').shortName, '广西');
  assert.equal(index.byProvince.get('65').shortName, '新疆');
});

test('search ranks city names, supports codes and province plus city, and bounds large result lists', () => {
  assert.equal(searchCities(index, '苏州').items[0].code, '320500');
  assert.equal(searchCities(index, '320500').items[0].name, '苏州市');
  assert.equal(searchCities(index, '江苏苏州').items[0].code, '320500');
  const broad = searchCities(index, '市');
  assert(broad.total > 12);
  assert.equal(broad.items.length, 12);
  assert.deepEqual(searchCities(index, '不存在的城市'), {items:[], total:0});
  assert.deepEqual(searchCities(index, '  '), {items:[], total:0});
});

test('recent choices are most-recent-first, unique, bounded and filtered against the live map', () => {
  const codes = index.cities.slice(0, 9).map((city) => city.code);
  let recent = [];
  for (const code of codes) recent = recentCityCodes(recent, code, index);
  assert.deepEqual(recent, codes.slice(3).reverse());
  recent = recentCityCodes([...recent, '999999', null], codes[5], index);
  assert.equal(recent[0], codes[5]);
  assert.equal(new Set(recent).size, 6);
  assert.equal(recent.length, 6);
  assert(!recent.includes('999999'));
});
