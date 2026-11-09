const CODE = /^\d{6}$/;
const RECENT_KEY = 'atlas-city-picker-recent-v1';
const RECENT_LIMIT = 6;
const SEARCH_LIMIT = 12;
let pickerSequence = 0;

function normalized(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
}

function shortProvinceName(name) {
  return String(name).replace(/特别行政区$/, '').replace(/(?:壮族|回族|维吾尔)?自治区$/, '').replace(/[省市]$/, '');
}

/** The same two-digit grouping rule also covers municipalities, HK, Macao and Taiwan. */
export function buildCityIndex(cities = [], provinces = []) {
  const byCode = new Map();
  for (const city of cities) {
    if (city && CODE.test(String(city.code)) && typeof city.name === 'string' && city.name.trim() && !byCode.has(String(city.code))) {
      byCode.set(String(city.code), {...city, code:String(city.code)});
    }
  }
  const groups = new Map();
  for (const province of provinces) {
    if (!province || !CODE.test(String(province.code)) || typeof province.name !== 'string' || !province.name.trim()) continue;
    const prefix = String(province.code).slice(0, 2);
    if (!groups.has(prefix)) groups.set(prefix, {...province, code:String(province.code), prefix, shortName:shortProvinceName(province.name), cities:[]});
  }
  for (const city of byCode.values()) {
    const prefix = city.code.slice(0, 2);
    if (!groups.has(prefix)) groups.set(prefix, {code:`${prefix}0000`, prefix, name:`其他地区（${prefix}）`, shortName:`其他地区 ${prefix}`, cities:[]});
    groups.get(prefix).cities.push(city);
  }
  const available = [...groups.values()].filter((province) => province.cities.length).sort((a, b) => a.code.localeCompare(b.code));
  available.forEach((province) => province.cities.sort((a, b) => a.code.localeCompare(b.code)));
  return {cities:[...byCode.values()], byCode, provinces:available, byProvince:new Map(available.map((province) => [province.prefix, province]))};
}

export function searchCities(index, query, limit = SEARCH_LIMIT) {
  const text = normalized(query);
  if (!text) return {items:[], total:0};
  const matches = [];
  for (const city of index.cities) {
    const name = normalized(city.name);
    const province = index.byProvince.get(city.code.slice(0, 2));
    const provinceName = normalized(province?.name);
    const shortName = normalized(province?.shortName);
    let score = 99;
    if (name === text || city.code === text) score = 0;
    else if (name.replace(/市$/, '') === text) score = 1;
    else if (name.startsWith(text)) score = 2;
    else if (name.includes(text)) score = 3;
    else if (city.code.startsWith(text)) score = 4;
    else if (`${provinceName}${name}`.includes(text) || `${shortName}${name}`.includes(text)) score = 5;
    if (score !== 99) matches.push({city, score});
  }
  matches.sort((a, b) => a.score - b.score || a.city.code.localeCompare(b.city.code));
  return {items:matches.slice(0, Math.max(1, Math.min(30, Number(limit) || SEARCH_LIMIT))).map((match) => match.city), total:matches.length};
}

export function recentCityCodes(previous, code, index, limit = RECENT_LIMIT) {
  return [...new Set([code, ...(Array.isArray(previous) ? previous : [])])]
    .filter((item) => typeof item === 'string' && index.byCode.has(item)).slice(0, limit);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(text, action, className = '') {
  const button = element('button', `city-picker-button ${className}`.trim(), text);
  button.type = 'button';
  button.dataset.cityPickerAction = action;
  return button;
}

/** Mount once per container and destroy before replacing its parent markup. */
export function mountCityPicker(container, {cities = [], provinces = [], onSelect = () => {}} = {}) {
  if (!container || typeof container.replaceChildren !== 'function') throw new Error('城市选择容器不可用');
  const index = buildCityIndex(cities, provinces);
  const instanceId = `city-picker-${++pickerSequence}`;
  let selectedProvince = null;
  let selectedCity = null;
  let recentCodes = [];
  let destroyed = false;
  let query = '';
  let composing = false;
  try { recentCodes = recentCityCodes(JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'), '', index); } catch {}

  const root = element('section', 'city-picker');
  root.setAttribute('aria-label', '按省份查找城市');
  const searchWrap = element('div', 'city-picker-search');
  const searchLabel = element('label', 'city-picker-search-label', '搜索全国城市');
  searchLabel.htmlFor = `${instanceId}-search`;
  const searchLine = element('div', 'city-picker-search-line');
  const search = element('input', 'city-picker-search-input');
  search.id = `${instanceId}-search`;
  search.type = 'search';
  search.placeholder = '例如：苏州、成都、阿坝';
  search.autocomplete = 'off';
  search.maxLength = 60;
  search.setAttribute('aria-controls', `${instanceId}-results`);
  const clearSearch = actionButton('清除', 'clear-search', 'city-picker-text-button');
  clearSearch.setAttribute('aria-label', '清除搜索，返回按省份选择');
  clearSearch.hidden = true;
  searchLine.append(search, clearSearch);
  searchWrap.append(searchLabel, searchLine);
  const status = element('p', 'city-picker-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const body = element('div', 'city-picker-body');
  body.id = `${instanceId}-results`;
  root.append(searchWrap, status, body);
  container.replaceChildren(root);

  function cityButton(city, compact = false) {
    const province = index.byProvince.get(city.code.slice(0, 2));
    const button = actionButton('', 'choose-city', `city-picker-city${compact ? ' city-picker-city-compact' : ''}`);
    button.dataset.code = city.code;
    button.setAttribute('aria-label', `${province?.name || ''} ${city.name}`.trim());
    if (city.code === selectedCity) button.classList.add('is-selected');
    button.append(element('span', 'city-picker-city-name', city.name));
    if (!compact) button.append(element('small', 'city-picker-city-province', province?.shortName || ''));
    return button;
  }

  function recentSection() {
    const recent = recentCodes.map((code) => index.byCode.get(code)).filter(Boolean);
    if (!recent.length) return null;
    const section = element('section', 'city-picker-recent');
    section.setAttribute('aria-label', '最近选择');
    const heading = element('div', 'city-picker-heading');
    heading.append(element('h3', '', '最近选择'), element('span', 'city-picker-caption', '本机最近 6 个'));
    const list = element('div', 'city-picker-recent-list city-picker-grid');
    list.dataset.columns = '2';
    recent.forEach((city) => list.append(cityButton(city, true)));
    section.append(heading, list);
    return section;
  }

  function render() {
    if (destroyed) return;
    body.replaceChildren();
    clearSearch.hidden = !query;
    if (query) {
      const result = searchCities(index, query);
      const header = element('div', 'city-picker-heading');
      header.append(element('h3', '', '搜索结果'), actionButton('返回省份', 'back-search', 'city-picker-text-button'));
      body.append(header);
      status.textContent = result.total ? `找到 ${result.total} 个城市${result.total > result.items.length ? `，先显示前 ${result.items.length} 个；可补充名称缩小范围。` : '，选择后打开城市故事。'}` : '没有找到对应城市。';
      if (!result.items.length) {
        const empty = element('div', 'city-picker-empty');
        empty.append(element('strong', '', '换个关键词试试'), element('p', '', '可输入城市名称、部分名称或行政区代码，也可以返回按省份选择。'), actionButton('返回省份选择', 'back-search'));
        body.append(empty);
      } else {
        const list = element('div', 'city-picker-search-results city-picker-grid');
        list.dataset.columns = '2';
        result.items.forEach((city) => list.append(cityButton(city)));
        body.append(list);
      }
      return;
    }
    if (selectedProvince) {
      const province = index.byProvince.get(selectedProvince);
      if (!province) { selectedProvince = null; render(); return; }
      const header = element('div', 'city-picker-heading city-picker-breadcrumb');
      const back = actionButton('‹ 全国', 'back-provinces', 'city-picker-text-button');
      back.setAttribute('aria-label', '返回全国省份列表');
      header.append(back, element('h3', '', province.name), element('span', 'city-picker-caption', `${province.cities.length} 个区域`));
      body.append(header);
      status.textContent = `${province.name} · 选择一座城市，打开它的照片与随笔。`;
      const list = element('div', 'city-picker-city-list city-picker-grid');
      list.dataset.columns = '2';
      province.cities.forEach((city) => list.append(cityButton(city, true)));
      body.append(list);
      return;
    }
    status.textContent = index.provinces.length ? '先选省份，再选城市；也可以直接搜索。' : '暂无可选择的城市，请稍后重试。';
    const recent = recentSection();
    if (recent) body.append(recent);
    const heading = element('div', 'city-picker-heading');
    heading.append(element('h3', '', '选择省份'), element('span', 'city-picker-caption', '省 / 直辖市 / 港澳台'));
    body.append(heading);
    const list = element('div', 'city-picker-province-list city-picker-grid');
    list.dataset.columns = '3';
    index.provinces.forEach((province) => {
      const button = actionButton('', 'choose-province', 'city-picker-province');
      button.dataset.code = province.prefix;
      button.title = province.name;
      button.setAttribute('aria-label', `${province.name}，${province.cities.length} 个可选择的区域`);
      button.append(element('span', '', province.shortName), element('small', '', String(province.cities.length)));
      list.append(button);
    });
    body.append(list);
  }

  function updateRecent(code) {
    recentCodes = recentCityCodes(recentCodes, code, index);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentCodes)); } catch {}
    window.dispatchEvent(new CustomEvent('atlas-city-picker-recents', {detail:{source:instanceId,codes:recentCodes}}));
  }

  function goBack({all = false, focus = true} = {}) {
    query = '';
    search.value = '';
    if (all) selectedProvince = null;
    render();
    if (focus) search.focus();
  }

  function handleClick(event) {
    const button = event.target.closest('[data-city-picker-action]');
    if (!button || !root.contains(button)) return;
    const action = button.dataset.cityPickerAction;
    if (action === 'choose-province') {
      selectedProvince = button.dataset.code;
      render();
      body.querySelector('[data-city-picker-action="choose-city"]')?.focus();
    } else if (action === 'choose-city') {
      const city = index.byCode.get(button.dataset.code);
      if (!city) return;
      selectedCity = city.code;
      updateRecent(city.code);
      if (!query && !selectedProvince) render();
      else root.querySelectorAll('.city-picker-city').forEach((item) => item.classList.toggle('is-selected', item.dataset.code === selectedCity));
      onSelect(city);
    } else if (action === 'clear-search') goBack();
    else if (action === 'back-search' || action === 'back-provinces') goBack({all:true});
  }

  function handleInput() {
    if (composing) return;
    query = search.value.trim();
    render();
  }
  function startComposition() { composing = true; }
  function endComposition() { composing = false; handleInput(); }
  function handleKeydown(event) {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape') {
      if (query || selectedProvince) { event.preventDefault(); event.stopPropagation(); goBack({all:!query}); }
      return;
    }
    if (event.target === search && event.key === 'ArrowDown') {
      const first = body.querySelector(query ? '.city-picker-search-results button' : selectedProvince ? '.city-picker-city-list button' : '.city-picker-province-list button');
      if (first) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.target === search && event.key === 'Enter' && query) {
      const result = searchCities(index, query);
      if (result.total === 1) { event.preventDefault(); body.querySelector('.city-picker-search-results button')?.click(); }
      else if (result.items.length) { event.preventDefault(); body.querySelector('.city-picker-search-results button')?.focus(); }
      return;
    }
    const grid = event.target.closest('.city-picker-grid');
    if (!grid || !root.contains(grid)) return;
    const options = [...grid.querySelectorAll('button')];
    const current = options.indexOf(event.target);
    if (current < 0) return;
    const columns = Number(grid.dataset.columns) || 1;
    const offsets = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns};
    let next;
    if (Object.prototype.hasOwnProperty.call(offsets, event.key)) next = current + offsets[event.key];
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    if (next < 0 && event.key === 'ArrowUp') search.focus();
    else options[Math.max(0, Math.min(options.length - 1, next))]?.focus();
  }

  function receiveRecents(event) {
    if (event.detail?.source === instanceId) return;
    recentCodes = recentCityCodes(event.detail?.codes, '', index);
    if (!query && !selectedProvince) render();
  }
  function receiveStorage(event) {
    if (event.key !== RECENT_KEY) return;
    try { recentCodes = recentCityCodes(JSON.parse(event.newValue || '[]'), '', index); } catch { return; }
    if (!query && !selectedProvince) render();
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('keydown', handleKeydown);
  search.addEventListener('input', handleInput);
  search.addEventListener('compositionstart', startComposition);
  search.addEventListener('compositionend', endComposition);
  window.addEventListener('atlas-city-picker-recents', receiveRecents);
  window.addEventListener('storage', receiveStorage);
  render();
  return {
    focusSearch() { if (!destroyed) search.focus(); },
    reset() { if (!destroyed) goBack({all:true,focus:false}); },
    selectProvince(code) {
      if (destroyed) return;
      const prefix = String(code).slice(0, 2);
      if (!index.byProvince.has(prefix)) return;
      selectedProvince = prefix;
      query = '';
      search.value = '';
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.removeEventListener('click', handleClick);
      root.removeEventListener('keydown', handleKeydown);
      search.removeEventListener('input', handleInput);
      search.removeEventListener('compositionstart', startComposition);
      search.removeEventListener('compositionend', endComposition);
      window.removeEventListener('atlas-city-picker-recents', receiveRecents);
      window.removeEventListener('storage', receiveStorage);
      root.remove();
    }
  };
}
