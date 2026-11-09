import test from 'node:test';
import assert from 'node:assert/strict';
import {compareFootprints} from '../web/friend-comparison.js';

const cities = Array.from({length: 8}, (_, i) => ({code: `${i + 1}10000`, name: `城市 ${i + 1}`}));
const [A, B, C, D, E, F, G, H] = cities.map(city => city.code);
const visited = (codes, otherLayers = []) => ({layers: [{visited: true, visible: true, codes}, ...otherLayers]});
const codes = result => result.map(city => city.code);

test('three-friend comparisons use all participants and keep the two differences directional', () => {
  const me = visited([A, B, E]);
  const friends = [visited([B, C]), visited([B, D]), visited([B, F])];
  assert.deepEqual(codes(compareFootprints(me, friends, cities, 'intersection')), [B]);
  assert.deepEqual(codes(compareFootprints(me, friends, cities, 'union')), [A, B, C, D, E, F]);
  assert.deepEqual(codes(compareFootprints(me, friends, cities, 'mine')), [A, E]);
  assert.deepEqual(codes(compareFootprints(me, friends, cities, 'theirs')), [C, D, F]);
  assert.deepEqual(codes(compareFootprints(me, friends, cities, 'neither')), [G, H]);
  // Two friends agree on B, but the third friend has not been there.
  assert.deepEqual(compareFootprints(me, [friends[0], friends[1], visited([F])], cities, 'intersection'), []);
});

test('single-friend footprint display ignores my footprints and includes hidden visited layers', () => {
  const me = visited([A, E]);
  const friend = visited([B, B], [
    {visited: true, visible: false, codes: [C, B]},
    {visited: false, visible: true, codes: [D]},
    {visited: 'true', codes: [F]}
  ]);
  assert.deepEqual(codes(compareFootprints(me, [friend], cities, 'friend')), [B, C]);
  assert.deepEqual(codes(compareFootprints(me, [friend], cities, 'intersection')), []);
  assert.deepEqual(codes(compareFootprints(me, [friend], cities, 'theirs')), [B, C]);
});

test('null or empty states count as no visits, and complements stay within the live map', () => {
  const me = visited([A, '999999']);
  assert.deepEqual(compareFootprints(me, [visited([A]), null], cities, 'intersection'), []);
  assert.deepEqual(codes(compareFootprints(null, [null, {layers: []}], cities, 'neither')), cities.map(city => city.code));
  assert.deepEqual(codes(compareFootprints(me, [null], cities, 'mine')), [A]);
  assert.deepEqual(codes(compareFootprints(me, [visited(['999999'])], cities, 'union')), [A]);
  assert.deepEqual(compareFootprints(me, [null], cities, 'friend'), []);
});

test('results deduplicate by code, preserve map order and never mutate inputs', () => {
  const me = visited([C, A, C]);
  const friend = visited([B, A]);
  const ordered = [cities[2], cities[0], {...cities[2]}, cities[1]];
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  freeze(me); freeze(friend); freeze(ordered);
  const result = compareFootprints(me, [friend], ordered, 'union');
  assert.deepEqual(codes(result), [C, A, B]);
  assert.equal(result[0], ordered[0]);
  assert.equal(result[1], ordered[1]);
  assert.deepEqual(me.layers[0].codes, [C, A, C]);
  assert.equal(ordered.length, 4);
});

test('invalid participant counts and incompatible single-friend display fail explicitly', () => {
  assert.throws(() => compareFootprints(null, [], cities, 'union'), /1–3/);
  assert.throws(() => compareFootprints(null, [null, null, null, null], cities, 'union'), /1–3/);
  assert.throws(() => compareFootprints(null, null, cities, 'union'), /1–3/);
  assert.throws(() => compareFootprints(null, [null, null], cities, 'friend'), /一位/);
  assert.throws(() => compareFootprints(null, [null], cities, 'xor'), /未知/);
  assert.throws(() => compareFootprints(null, [null], null, 'union'), /目录/);
});
