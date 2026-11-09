import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, calculateSet, validateState, migrateProject} from '../web/core.js';

const cities = [
  {code: '320500', name: '苏州市'},
  {code: '510100', name: '成都市'},
  {code: '513200', name: '阿坝藏族羌族自治州'},
  {code: '110000', name: '北京市'}
];
const cityCodes = cities.map(city => city.code);

test('all six set operations deduplicate, preserve inputs, and obey finite universe', () => {
  const a = Object.freeze(['320500', '510100', '320500']);
  const b = Object.freeze(['510100', '513200']);
  assert.deepEqual(calculateSet(a, b, 'intersection', cityCodes), ['510100']);
  assert.deepEqual(calculateSet(a, b, 'union', cityCodes), ['320500', '510100', '513200']);
  assert.deepEqual(calculateSet(a, b, 'difference', cityCodes), ['320500']);
  assert.deepEqual(calculateSet(a, b, 'xor', cityCodes), ['320500', '513200']);
  assert.deepEqual(calculateSet(a, b, 'complement', cityCodes), ['513200', '110000']);
  assert.deepEqual(calculateSet(a, b, 'neither', cityCodes), ['110000']);
  assert.deepEqual(calculateSet([], [], 'neither', cityCodes), cityCodes);
  assert.throws(() => calculateSet(a, b, 'unexpected'), /未知/);
});

test('state defaults are independent and validation clones normalized fields only', () => {
  const input = createState();
  input.layers[0].codes.push('320500', '320500');
  input.layers[0].color = '#ABC';
  input.layers[0].name = '  去过的地方\u0000 ';
  input.layers[0].untrusted = '<script>';
  input.background = '#DEF';
  const output = validateState(input, cities);
  assert.deepEqual(output.layers[0].codes, ['320500']);
  assert.equal(output.layers[0].color, '#aabbcc');
  assert.equal(output.background, '#ddeeff');
  assert.equal(output.layers[0].name, '去过的地方');
  assert.equal('untrusted' in output.layers[0], false);
  output.layers[0].codes.push('110000');
  assert.equal(input.layers[0].codes.length, 2);
  assert.equal(createState().layers[0].codes.length, 0);
});

test('validation rejects schema failures and unknown regions', () => {
  for (const mutate of [
    state => { state.layers[1].id = state.layers[0].id; },
    state => { state.layers[0].id = '__proto__'; },
    state => { state.layers[0].color = 'url(javascript:alert(1))'; },
    state => { state.layers[0].visible = 'false'; },
    state => { state.layers[0].name = ' '; },
    state => { state.layers[0].codes = ['999999']; },
    state => { state.activeLayerId = 'missing'; },
    state => { state.background = 'transparent'; },
    state => { state.layers = []; }
  ]) {
    const state = createState(); mutate(state);
    assert.throws(() => validateState(state, cities));
  }
});

test('legacy exports migrate city names, color remarks, hidden colors and shorthand hex', () => {
  const input = {format: 'china-prefecture-color-map', version: 2, colors: {'苏州': '#F00', '510100': '#00AA66', '阿坝藏族羌族自治州': '#F00'}, colorNotes: {'#ff0000': '自驾旅行'}, hiddenColors: ['#0a6']};
  const {state, warnings} = migrateProject(input, cities);
  assert.equal(state.layers.length, 2);
  const red = state.layers.find(layer => layer.color === '#ff0000');
  const green = state.layers.find(layer => layer.color === '#00aa66');
  assert.deepEqual(red.codes, ['320500', '513200']);
  assert.equal(red.name, '自驾旅行');
  assert.equal(green.visible, false);
  assert.ok(state.layers.every(layer => layer.visited));
  assert.equal(warnings.length, 1);
  assert.deepEqual(validateState(state, cities), state);
});

test('legacy arrays use original aliases and final city assignment', () => {
  const {state, warnings} = migrateProject([
    {city: '苏州', fill: '#f00'},
    {adcode: '320500', color: '#00f'},
    {region: '成都', hex: '#0f0'},
    {name: '不认识的城市', color: '#0f0'},
    {name: '北京', color: 'red'}
  ], cities);
  assert.deepEqual(state.layers.map(layer => layer.color), ['#0000ff', '#00ff00']);
  assert.equal(state.layers.flatMap(layer => layer.codes).length, 2);
  assert.equal(warnings.length, 3);
});

test('v3 migration warns on unknown regions, preserves a valid empty project, and fails wholly invalid data', () => {
  const state = createState();
  state.layers[0].codes = ['320500', '999999'];
  const imported = migrateProject({version: 3, state}, cities);
  assert.deepEqual(imported.state.layers[0].codes, ['320500']);
  assert.equal(imported.warnings.length, 1);
  assert.equal(state.layers[0].codes.length, 2);
  assert.deepEqual(migrateProject({state: createState()}, cities).state, createState());
  state.layers[0].codes = ['999999'];
  assert.throws(() => migrateProject({state}, cities), /均无法识别/);
  assert.throws(() => migrateProject({'未知': '#ff0000'}, cities), /没有找到有效/);
  assert.throws(() => migrateProject({'苏州': null}, cities), /没有找到有效/);
});

test('malicious keys and inherited records cannot pollute prototypes or supply hidden fields', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"苏州":"#f00"}');
  const imported = migrateProject(input, cities);
  assert.equal(imported.state.layers.length, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(imported.state), Object.prototype);
  assert.throws(() => migrateProject(Object.create({'苏州': '#f00'}), cities));
  const state = createState();
  state.layers[0] = Object.create(state.layers[0]);
  assert.throws(() => validateState(state, cities));
  assert.throws(() => migrateProject(JSON.parse('{"state":{"__proto__":{"layers":[]}}}'), cities));
});

test('ambiguous normalized names are skipped and explicit names still import', () => {
  const duplicates = [{code: '111100', name: '同名市'}, {code: '222200', name: '同名地区'}, ...cities];
  const result = migrateProject({'同名': '#f00', '苏州市': '#0f0'}, duplicates);
  assert.deepEqual(result.state.layers[0].codes, ['320500']);
  assert.ok(result.warnings.some(message => message.includes('同名')));
});
