const OPERATIONS = new Set(['friend', 'intersection', 'union', 'mine', 'theirs', 'neither']);

/** Hidden layers still count; only an explicit visited flag marks a footprint. */
function visitedCodes(state) {
  const codes = new Set();
  if (!Array.isArray(state?.layers)) return codes;
  for (const layer of state.layers) {
    if (layer?.visited !== true || !Array.isArray(layer.codes)) continue;
    for (const code of layer.codes) {
      if (typeof code === 'string') codes.add(code);
    }
  }
  return codes;
}

/**
 * Compare me with one to three friends inside the supplied map's universe.
 * Returns original city objects in map order, once per city code. Inputs are
 * never changed. A null account state means that account has no footprints.
 * `friend` shows one friend's footprints and requires exactly one friend.
 */
export function compareFootprints(myState, friendStates, cities, operation) {
  if (!Array.isArray(friendStates) || friendStates.length < 1 || friendStates.length > 3) {
    throw new Error('请选择 1–3 位好友');
  }
  if (!OPERATIONS.has(operation)) throw new Error('未知好友对比方式');
  if (operation === 'friend' && friendStates.length !== 1) throw new Error('查看好友足迹时请选择一位好友');
  if (!Array.isArray(cities)) throw new Error('行政区目录不可用');

  const mine = visitedCodes(myState);
  const friends = friendStates.map(visitedCodes);
  const seen = new Set();
  const result = [];
  for (const city of cities) {
    if (!city || typeof city.code !== 'string' || !/^\d{6}$/.test(city.code) || seen.has(city.code)) continue;
    seen.add(city.code);
    const a = mine.has(city.code);
    const anyFriend = friends.some((set) => set.has(city.code));
    let matches = false;
    if (operation === 'friend') matches = anyFriend;
    else if (operation === 'intersection') matches = a && friends.every((set) => set.has(city.code));
    else if (operation === 'union') matches = a || anyFriend;
    else if (operation === 'mine') matches = a && !anyFriend;
    else if (operation === 'theirs') matches = !a && anyFriend;
    else if (operation === 'neither') matches = !a && !anyFriend;
    if (matches) result.push(city);
  }
  return result;
}
