import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildCityIndex, searchCities, recentCityCodes} from '../web/city-picker.js';

const map = JSON.parse(await readFile(new URL('../web/map-data.json', import.meta.url), 'utf8'));
const index = buildCityIndex(map.cities, map.provinces);

test('all 340 map regions belong to a valid province; non-six-digit outline is omitted', () => {
  assert.equal(index.cities.length, 340);
  assert.equal(index.provinces.length, 34);
  assert.equal(index.provinces.reduce((sum, province) => sum + province.cities.length, 0), 340);
  assert(!index.provinces.some((province) => province.code === '100000_JD'));
  assert(index.byProvince.get('32').cities.some((city) => city.name === '苏州市'));
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
