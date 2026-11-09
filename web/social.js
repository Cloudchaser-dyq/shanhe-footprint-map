import {mountCityPicker} from './city-picker.js';
import {compareFootprints} from './friend-comparison.js';

const $ = (id) => document.getElementById(id);
const MAX_PHOTOS = 3;
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const jsonOptions = (method, body) => ({method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
const codePath = (value) => encodeURIComponent(String(value));
const initials = (name) => Array.from(String(name || '旅人')).slice(0, 1).join('');
const timeLabel = (value) => {
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
};
const errorLabel = (error) => error.status === 401 ? '登录后即可继续。' : String(error.message || '连接失败，请稍后重试。');

/** Social UI keeps all user content as text and relies on API authorization. */
export function initSocial(app) {
  const friendsPanel = $('friendsPanel');
  const feedPanel = $('feedPanel');
  const drawer = $('cityDrawer');
  if (!friendsPanel || !feedPanel || !drawer) throw new Error('社交页面容器未就绪');
  let friendsData = {friends:[],incoming:[],outgoing:[]};
  let activeCity = null;
  let drawerTrigger = null;
  let cityGeneration = 0;
  let friendsGeneration = 0;
  let comparisonGeneration = 0;
  let comparison = null;
  let selectedFriendIds = [];
  let compareOperation = 'intersection';
  let posts = [];
  let nextBefore = null;
  let loadedOlder = false;
  let friendsLoading = false;
  let postsLoading = false;
  let postsRequestId = 0;
  let photos = [];
  let cityPicker = null;
  let photoGeneration = 0;
  let photoLoading = false;
  let posting = false;
  let destroyed = false;
  let lastUserId = app.getUser?.()?.id || null;
  const cityDrafts = new Map();
  const timers = new Set();
  const buttonRuns = new WeakMap();
  const accountUser = () => app.getUser?.() || null;
  const signedIn = () => !!accountUser()?.id;
  const signIn = '<button type="button" class="social-signin" data-action="sign-in">登录 / 创建账号</button>';
  const button = (text, action, id = '', cls = '') => `<button type="button" class="social-button ${cls}" data-action="${action}"${id ? ` data-id="${escapeHTML(id)}"` : ''}>${text}</button>`;
  const showError = (container, text) => {
    if (container) { container.textContent = text; container.hidden = !text; }
  };
  const runButton = async (element, operation) => {
    if (!element || element.disabled) return;
    const run = {label:buttonRuns.get(element)?.label || element.textContent};
    buttonRuns.set(element,run);
    element.disabled = true;
    element.textContent = '处理中…';
    try { await operation(); }
    catch (error) { app.notify(errorLabel(error)); }
    finally {
      if (buttonRuns.get(element) === run) {
        buttonRuns.delete(element);
        if (element.isConnected) {
          element.disabled = element.dataset.action === 'compare' && selectedFriendIds.length === 0;
          element.textContent = run.label;
        }
      }
    }
  };

  function renderFriends() {
    if (!signedIn()) {
      friendsPanel.innerHTML = `<section class="social-welcome"><span class="social-kicker">一起，把地图走满</span><h2>看看你们的共同足迹</h2><p>登录后添加好友，比较共同去过、各自去过，以及都还没去过的地方。</p>${signIn}</section>`;
      return;
    }
    const user = accountUser();
    const oldCode = friendsPanel.querySelector('[name="friendCode"]')?.value || '';
    friendsPanel.innerHTML = `<section class="social-section"><div class="social-section-head"><h2>我的好友</h2>${button('刷新','refresh-friends','','social-subtle')}</div><div class="social-invite"><div><span class="social-label">我的好友码</span><strong>${escapeHTML(user.code || '加载中')}</strong></div>${button('复制','copy-code')}</div><form id="friendRequestForm" class="social-inline-form"><label class="sr-only" for="friendCodeInput">对方的好友码</label><input id="friendCodeInput" name="friendCode" value="${escapeHTML(oldCode)}" maxlength="32" autocomplete="off" placeholder="输入对方的好友码" required><button type="submit" class="social-button social-primary">添加</button></form><p class="social-help">对方同意后，就能互看足迹和好友可见的城市记录。</p><p id="friendError" class="social-error" role="alert" hidden></p><div id="friendRequests"></div><div id="friendList"></div></section><section class="social-section social-compare"><span class="social-kicker">FOOTPRINTS TOGETHER</span><h2>和好友比一比</h2><p class="social-help">选 1–3 位好友，比较你们的足迹。按每个人标记为「去过」的图层计算，不受显示开关影响。</p><div id="comparePicker"></div><div class="social-actions">${button('在地图上查看','compare','','social-primary')}${button('退出比较','clear-comparison','','social-subtle')}</div><div id="comparisonResult" aria-live="polite"></div></section>`;
    renderComparisonPicker();
    if (comparison) renderComparisonResult();
    renderFriendLists();
  }

  function renderComparisonPicker() {
    const root = $('comparePicker');
    if (!root) return;
    const focusedId = document.activeElement?.dataset?.compareFriend;
    const count = selectedFriendIds.length;
    const atLimit = count >= 3;
    root.innerHTML = `<fieldset class="social-friend-picker"><legend>选择好友 <span>${count} / 3</span></legend><div class="social-friend-options">${friendsData.friends.length ? friendsData.friends.map((friend) => {
      const selected = selectedFriendIds.includes(friend.id);
      return `<label class="social-friend-option${selected ? ' is-selected' : ''}${atLimit && !selected ? ' is-unavailable' : ''}"><input type="checkbox" data-compare-friend="${escapeHTML(friend.id)}"${selected ? ' checked' : ''}${atLimit && !selected ? ' disabled' : ''}><span>${escapeHTML(friend.name)}</span></label>`;
    }).join('') : '<p class="social-help">添加好友后，就能在这里选择一起比较的人。</p>'}</div><p class="social-help social-selection-hint" role="status">${atLimit ? '已选 3 位；取消一位后可以换选。' : '可选择 1–3 位好友，比较包含你自己的足迹。'}</p></fieldset><label class="social-field"><span>查看 / 比较方式</span><select id="compareOperation"><option value="friend"${count !== 1 ? ' disabled' : ''}>查看好友去过的地方（选 1 位）</option><option value="intersection">我们都去过 · 全员交集</option><option value="union">我们有人去过 · 全员并集</option><option value="mine">只有我去过 · 好友均未去过</option><option value="theirs">${count > 1 ? '仅好友去过 · 我未去过' : '只有好友去过 · 我未去过'}</option><option value="neither">我们都未去过 · 全员补集</option></select></label><p id="compareExplanation" class="social-help">${comparisonExplanation(compareOperation, count)}</p>`;
    $('compareOperation').value = compareOperation;
    const compareButton = friendsPanel.querySelector('[data-action="compare"]');
    if (compareButton) compareButton.disabled = count < 1;
    if (focusedId) [...root.querySelectorAll('[data-compare-friend]')].find((input) => input.dataset.compareFriend === focusedId)?.focus();
  }

  function comparisonExplanation(operation, count) {
    return {
      friend:'只展示这位好友去过的地方，不加入我的足迹。',
      intersection:'我和每一位所选好友都去过，才计入结果。',
      union:'我或任意一位所选好友去过，就计入结果。',
      mine:'我去过，且每一位所选好友都没有去过。',
      theirs:count > 1 ? '至少一位所选好友去过，且我没有去过。' : '这位好友去过，且我没有去过。',
      neither:'我和每一位所选好友都没有去过。'
    }[operation] || '';
  }

  function renderFriendLists() {
    const requestRoot = $('friendRequests');
    const listRoot = $('friendList');
    if (!requestRoot || !listRoot) return;
    requestRoot.innerHTML = friendsData.incoming.length || friendsData.outgoing.length ? `<div class="social-request-group"><h3>好友申请</h3>${friendsData.incoming.map((request) => `<div class="social-person"><span class="social-avatar">${escapeHTML(initials(request.from?.name))}</span><div class="social-person-body"><strong>${escapeHTML(request.from?.name || '旅人')}</strong><small>想和你一起记录旅程</small></div><div class="social-person-actions">${button('同意','accept-friend',request.id,'social-primary')}${button('忽略','remove-request',request.id,'social-subtle')}</div></div>`).join('')}${friendsData.outgoing.map((request) => `<div class="social-person"><span class="social-avatar">${escapeHTML(initials(request.to?.name))}</span><div class="social-person-body"><strong>${escapeHTML(request.to?.name || '旅人')}</strong><small>等待对方同意</small></div>${button('撤回','remove-request',request.id,'social-subtle')}</div>`).join('')}</div>` : '';
    listRoot.innerHTML = friendsData.friends.length ? `<p class="social-list-caption">${friendsData.friends.length} 位同行的人</p>${friendsData.friends.map((friend) => `<div class="social-person"><span class="social-avatar">${escapeHTML(initials(friend.name))}</span><div class="social-person-body"><strong>${escapeHTML(friend.name)}</strong><small>${escapeHTML(friend.code || '')}</small></div>${button('查看足迹','view-friend',friend.id)}${button('移除','remove-friend',friend.id,'social-subtle')}</div>`).join('')}` : `<div class="social-empty"><span>两个人的地图，会是什么样？</span><p>把好友码发给朋友，或输入对方的好友码，开始第一段共同旅程。</p></div>`;
  }

  async function refreshFriends({quiet = false} = {}) {
    if (!signedIn() || friendsLoading || destroyed) return;
    friendsLoading = true;
    const generation = ++friendsGeneration;
    const userId = accountUser().id;
    if (!quiet) showError($('friendError'), '');
    try {
      const data = await app.api('/api/friends');
      if (destroyed || generation !== friendsGeneration || accountUser()?.id !== userId) return;
      friendsData = {friends:data.friends || [],incoming:data.incoming || [],outgoing:data.outgoing || []};
      const validIds = new Set(friendsData.friends.map((friend) => friend.id));
      const selectionRemoved = selectedFriendIds.some((id) => !validIds.has(id));
      selectedFriendIds = selectedFriendIds.filter((id) => validIds.has(id));
      if (compareOperation === 'friend' && selectedFriendIds.length !== 1) compareOperation = 'intersection';
      renderFriendLists();
      renderComparisonPicker();
      if (selectionRemoved || comparison?.friends.some((friend) => !validIds.has(friend.id))) {
        clearComparison();
        showError($('friendError'),'好友关系已变化，请重新选择后查看。');
      }
    } catch (error) {
      if (generation === friendsGeneration && !destroyed) showError($('friendError'), errorLabel(error));
    } finally { if (generation === friendsGeneration) friendsLoading = false; }
  }

  function calculateComparison() {
    if (!comparison) return [];
    return compareFootprints(app.getState(),comparison.friends.map((friend) => friend.state),app.getCities(),comparison.operation);
  }

  function renderComparisonResult() {
    if (!comparison) return;
    const matching = calculateComparison();
    const label = {friend:'好友去过',intersection:'我们都去过',union:'我们有人去过',mine:'只有我去过',theirs:comparison.friends.length > 1 ? '仅好友去过' : '只有好友去过',neither:'我们都未去过'}[comparison.operation];
    const names = comparison.friends.map((friend) => friend.name).join('、');
    const participants = comparison.operation === 'friend' ? names : `我、${names}`;
    const resultRoot = $('comparisonResult');
    if (resultRoot) resultRoot.innerHTML = `<div class="social-result-count"><strong>${matching.length}</strong><span>${escapeHTML(label)}的行政区</span></div><p class="social-help social-comparison-people">${escapeHTML(participants)}</p><p class="social-help">${comparisonExplanation(comparison.operation,comparison.friends.length)}范围为本地图全部 ${app.getCities().length} 个可填色行政区。</p>${matching.length ? `<div class="social-city-chips">${matching.map((city) => button(escapeHTML(city.name),'open-city',city.code,'social-city-chip')).join('')}</div>` : '<p class="social-help">这个组合暂时没有符合的地方。</p>'}`;
    app.previewComparison({codes:matching.map((city) => city.code),title:`${participants} · ${label}`});
  }

  async function compareFriend() {
    const friendIds = [...new Set(selectedFriendIds)];
    const operation = compareOperation;
    const userId = accountUser()?.id;
    if (!userId) { app.openAuth(); return; }
    if (friendIds.length < 1 || friendIds.length > 3) { app.notify('请选择 1–3 位好友。'); return; }
    if (operation === 'friend' && friendIds.length !== 1) { app.notify('直接查看足迹时，请选择一位好友。'); return; }
    if (friendIds.some((id) => !friendsData.friends.some((friend) => friend.id === id))) { clearComparison(); await refreshFriends(); return; }
    clearComparison();
    const generation = ++comparisonGeneration;
    const current = () => generation === comparisonGeneration && !destroyed && accountUser()?.id === userId;
    if ($('comparisonResult')) $('comparisonResult').innerHTML = '<p class="social-loading" role="status">正在读取所选好友的足迹…</p>';
    try {
      const results = await Promise.all(friendIds.map(async (id) => {
        const data = await app.api(`/api/friends/${codePath(id)}/state`);
        return {id,name:data.user?.name || friendsData.friends.find((friend) => friend.id === id)?.name || '好友',state:data.state};
      }));
      if (!current()) return;
      comparison = {friends:results,operation};
      renderComparisonResult();
    } catch (error) {
      if (!current()) return;
      $('comparisonResult')?.replaceChildren();
      if (error.status === 403 || error.status === 404) {
        clearComparison();
        await refreshFriends();
      }
      throw error;
    }
  }

  function handleFriendsChange(event) {
    const target = event.target;
    if (target.dataset?.compareFriend) {
      const id = target.dataset.compareFriend;
      if (!friendsData.friends.some((friend) => friend.id === id)) { target.checked = false; return; }
      if (target.checked && !selectedFriendIds.includes(id)) {
        if (selectedFriendIds.length >= 3) { target.checked = false; app.notify('最多选择 3 位好友，先取消一位即可换选。'); return; }
        selectedFriendIds = [...selectedFriendIds,id];
      } else if (!target.checked) selectedFriendIds = selectedFriendIds.filter((friendId) => friendId !== id);
      if (compareOperation === 'friend' && selectedFriendIds.length !== 1) compareOperation = 'intersection';
      clearComparison();
      renderComparisonPicker();
    } else if (target.id === 'compareOperation') {
      compareOperation = target.value;
      clearComparison();
      const help = $('compareExplanation');
      if (help) help.textContent = comparisonExplanation(compareOperation,selectedFriendIds.length);
    }
  }

  function clearComparison() {
    clearComparisonState();
    app.clearComparison();
  }

  function clearComparisonState() {
    comparisonGeneration++;
    comparison = null;
    $('comparisonResult')?.replaceChildren();
  }

  function renderFeedIntro() {
    cityPicker?.destroy();
    feedPanel.innerHTML = `<section class="social-section"><span class="social-kicker">EVERY CITY, A STORY</span><h2>这一站，去哪里？</h2><p class="social-help">选省份找城市，或直接搜索。也可以点击地图，打开那里的照片与随笔。</p><div id="storyCityPicker"></div><div class="social-feed-notes"><p><span>01</span> 点选城市，翻开当地的故事</p><p><span>02</span> 添加最多 3 张照片，写下旅途随笔</p><p><span>03</span> 选择公开或好友可见，听听大家的回应</p></div></section>`;
    cityPicker = mountCityPicker($('storyCityPicker'),{cities:app.getCities(),provinces:app.getProvinces(),onSelect:openCity});
  }

  function saveCityDraft() {
    if (!activeCity) return;
    const text = $('postText')?.value || '';
    const visibility = $('postVisibility')?.value || 'friends';
    cityDrafts.set(activeCity.code,{text,visibility});
  }

  function clearPhoto() {
    photoGeneration++;
    photoLoading = false;
    photos.forEach((photo) => URL.revokeObjectURL(photo.url));
    photos = [];
  }

  function renderDrawer() {
    const draft = cityDrafts.get(activeCity.code) || {text:'',visibility:'friends'};
    drawer.hidden = false;
    drawer.classList.add('social-drawer-open');
    drawer.setAttribute('role','region');
    drawer.setAttribute('aria-label', `${activeCity.name}的城市故事`);
    drawer.innerHTML = `<div class="social-drawer-head"><div><span class="social-kicker">CITY STORIES</span><h2>${escapeHTML(activeCity.name)}</h2><p>在这里，收藏一段旅程</p></div>${button('×','close-drawer','','social-close')}</div><div class="social-drawer-scroll"><section class="social-composer">${signedIn() ? `<form id="postForm"><label class="sr-only" for="postText">写一段城市随笔</label><textarea id="postText" name="text" rows="4" maxlength="5000" placeholder="这一站，什么让你念念不忘？">${escapeHTML(draft.text)}</textarea><div id="photoPreview" class="social-photo-preview" hidden></div><div class="social-composer-tools"><label class="social-button social-photo-label"><span id="photoAddLabel">＋ 添加照片</span><input id="postPhoto" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-describedby="photoCount" class="sr-only"></label><label class="sr-only" for="postVisibility">谁可以看见</label><select id="postVisibility" name="visibility"><option value="friends"${draft.visibility === 'friends' ? ' selected' : ''}>好友可见</option><option value="public"${draft.visibility === 'public' ? ' selected' : ''}>所有访客可见</option></select></div><p id="photoCount" class="social-photo-count" role="status">已选 0 / 3 张 · 每条记录最多 3 张</p><div class="social-composer-bottom"><small>自动压缩 · JPG / PNG / WebP</small><button type="submit" class="social-button social-primary">发布记录</button></div><p id="postFormError" class="social-error" role="alert" hidden></p></form>` : `<div class="social-login-note"><p>登录后，为这座城市留下你的照片与随笔。</p>${signIn}</div>`}</section><div class="social-posts-header"><h3>城市记录 <span id="postCount"></span></h3>${button('刷新','refresh-posts','','social-subtle')}</div><p id="postsError" class="social-error" role="alert" hidden></p><div id="cityPosts" aria-live="polite"><p class="social-loading">正在翻开这座城市的故事…</p></div></div>`;
    drawer.querySelector('.social-close').setAttribute('aria-label','关闭城市故事');
    if (posting && $('postForm')) {
      Array.from($('postForm').elements).forEach((field) => { field.disabled = true; });
      $('postForm').querySelector('[type="submit"]').textContent = '正在发布…';
    }
  }

  function openCity(city) {
    const resolved = typeof city === 'string' ? app.getCities().find((item) => item.code === city) : city;
    if (!resolved?.code) return;
    if (posting) { app.notify('记录正在发布，请稍候。'); return; }
    if (activeCity?.code === String(resolved.code) && !drawer.hidden) {
      drawer.querySelector('.social-drawer-head h2')?.focus({preventScroll:true});
      return;
    }
    if (!drawer.contains(document.activeElement)) drawerTrigger = document.activeElement;
    saveCityDraft();
    clearPhoto();
    activeCity = {code:String(resolved.code),name:resolved.name || resolved.code};
    cityGeneration++;
    posts = [];
    nextBefore = null;
    loadedOlder = false;
    renderDrawer();
    const heading = drawer.querySelector('.social-drawer-head h2');
    heading.tabIndex = -1;
    heading.focus({preventScroll:true});
    refreshPosts();
  }

  function closeDrawer() {
    if (posting) { app.notify('记录正在发布，请稍候。'); return; }
    saveCityDraft();
    clearPhoto();
    activeCity = null;
    cityGeneration++;
    drawer.hidden = true;
    drawer.classList.remove('social-drawer-open');
    if (drawerTrigger?.isConnected) drawerTrigger.focus({preventScroll:true});
  }

  function safePhotoURL(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url,location.origin);
      return parsed.origin === location.origin && parsed.pathname.startsWith('/api/photos/') ? parsed.href : '';
    } catch { return ''; }
  }

  function renderPosts() {
    const root = $('cityPosts');
    if (!root) return;
    const user = accountUser();
    const drafts = new Map([...root.querySelectorAll('form[data-post]')].map((form) => [form.dataset.post,form.querySelector('input').value]));
    $('postCount').textContent = posts.length ? `· ${posts.length}${nextBefore ? '+' : ''}` : '';
    if (!posts.length) {
      root.innerHTML = `<div class="social-empty social-stories-empty"><span>这座城市，等你写下第一笔。</span><p>发布一张喜欢的照片，或写一段随笔。好友的记录也会出现在这里。</p></div>`;
      return;
    }
    root.innerHTML = posts.map((post) => {
      const photoURLs = (Array.isArray(post.photos) ? post.photos.map((photo) => photo.url) : [post.photoUrl]).map(safePhotoURL).filter(Boolean).slice(0,MAX_PHOTOS);
      return `<article class="social-post" data-post-id="${escapeHTML(post.id)}"><header class="social-post-head"><span class="social-avatar">${escapeHTML(initials(post.author?.name))}</span><div class="social-person-body"><strong>${escapeHTML(post.author?.name || '旅人')}</strong><small>${escapeHTML(timeLabel(post.createdAt))} · ${post.visibility === 'public' ? '公开' : '好友可见'}</small></div>${user?.id === post.author?.id ? button('删除','delete-post',post.id,'social-subtle') : ''}</header>${photoURLs.length ? `<div class="social-post-gallery" data-count="${photoURLs.length}">${photoURLs.map((photo,index) => `<a class="social-post-photo-link" href="${escapeHTML(photo)}" target="_blank" rel="noopener" aria-label="查看第 ${index + 1} 张照片，共 ${photoURLs.length} 张"><img class="social-post-photo" loading="lazy" src="${escapeHTML(photo)}" alt="${escapeHTML(post.author?.name || '旅人')}分享的${escapeHTML(activeCity.name)}照片 ${index + 1}"></a>`).join('')}</div>` : ''}${post.text ? `<p class="social-post-text">${escapeHTML(post.text)}</p>` : ''}<div class="social-comments">${(post.comments || []).map((comment) => `<div class="social-comment"><div class="social-comment-line"><strong>${escapeHTML(comment.author?.name || '旅人')}</strong><time>${escapeHTML(timeLabel(comment.createdAt))}</time>${user?.id === comment.author?.id ? button('删除','delete-comment',comment.id,'social-subtle') : ''}</div><p>${escapeHTML(comment.text)}</p></div>`).join('')}${signedIn() ? `<form class="social-comment-form" data-post="${escapeHTML(post.id)}"><label class="sr-only" for="comment-${escapeHTML(post.id)}">评论这条城市记录</label><input id="comment-${escapeHTML(post.id)}" name="comment" value="${escapeHTML(drafts.get(post.id) || '')}" maxlength="1000" placeholder="留下你的回应…" required><button type="submit" class="social-button">发送</button></form>` : `<p class="social-help">${signIn} 后参与评论</p>`}</div></article>`;
    }).join('') + (nextBefore ? `<div class="social-more-posts">${button('加载更早的记录','load-more-posts')}${loadedOlder ? '<p class="social-help">已展开历史记录，点击上方「刷新」查看最新动态。</p>' : ''}</div>` : (loadedOlder ? '<p class="social-help social-history-end">已显示全部记录。点击上方「刷新」查看最新动态。</p>' : ''));
  }

  async function refreshPosts({quiet = false} = {}) {
    if (!activeCity || destroyed) return;
    const generation = cityGeneration;
    const code = activeCity.code;
    if (quiet && (postsLoading || loadedOlder)) return;
    const requestId = ++postsRequestId;
    postsLoading = true;
    if (!quiet) showError($('postsError'), '');
    try {
      const data = await app.api(`/api/posts?city=${codePath(code)}`);
      if (destroyed || requestId !== postsRequestId || generation !== cityGeneration || activeCity?.code !== code) return;
      posts = data.posts || [];
      nextBefore = data.nextBefore || null;
      loadedOlder = false;
      // Keep an in-progress comment untouched during automatic refresh.
      if (!quiet || !drawer.querySelector('.social-comment-form:focus-within')) renderPosts();
      showError($('postsError'), '');
    } catch (error) {
      if (requestId === postsRequestId && generation === cityGeneration && !destroyed) {
        showError($('postsError'), errorLabel(error));
        if (!posts.length) $('cityPosts').replaceChildren();
      }
    } finally { if (requestId === postsRequestId) postsLoading = false; }
  }

  async function loadMorePosts() {
    if (!activeCity || !nextBefore || postsLoading || destroyed) return;
    const generation = cityGeneration, code = activeCity.code, before = nextBefore;
    const requestId = ++postsRequestId;
    postsLoading = true;
    try {
      const data = await app.api(`/api/posts?city=${codePath(code)}&before=${codePath(before)}`);
      if (destroyed || generation !== cityGeneration || requestId !== postsRequestId || activeCity?.code !== code) return;
      const existing = new Set(posts.map((post) => post.id));
      posts.push(...(data.posts || []).filter((post) => !existing.has(post.id)));
      nextBefore = data.nextBefore || null;
      loadedOlder = true;
      renderPosts();
      showError($('postsError'),'');
    } catch (error) {
      if (requestId === postsRequestId && generation === cityGeneration) showError($('postsError'),errorLabel(error));
    } finally { if (requestId === postsRequestId) postsLoading = false; }
  }

  async function preparePhoto(file) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
    if (file.size > 25 * 1024 * 1024) throw new Error('请选择 25 MB 以内的照片。');
    const objectURL = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve,reject) => {
        const node = new Image();
        node.onload = () => resolve(node);
        node.onerror = () => reject(new Error('无法读取这张图片，请换一张照片。'));
        node.src = objectURL;
      });
      const scale = Math.min(1,1600 / Math.max(image.naturalWidth,image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1,Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve,'image/jpeg',0.86));
      if (!blob) throw new Error('照片处理失败，请重新选择。');
      if (blob.size > 5 * 1024 * 1024) throw new Error('压缩后的照片仍超过 5 MB，请选择更小的图片。');
      return new File([blob],'city-photo.jpg',{type:'image/jpeg'});
    } finally { URL.revokeObjectURL(objectURL); }
  }

  async function choosePhotos(files) {
    if (!files.length || photoLoading || posting) return;
    if (photos.length + files.length > MAX_PHOTOS) {
      showError($('postFormError'),`每条记录最多 ${MAX_PHOTOS} 张照片。已选 ${photos.length} 张，还可以添加 ${MAX_PHOTOS - photos.length} 张。`);
      return;
    }
    const generation = ++photoGeneration;
    photoLoading = true;
    showError($('postFormError'),'');
    renderPhotoPreview();
    try {
      const prepared = [];
      // A failed batch leaves previously selected photos intact.
      for (const file of files) {
        prepared.push(await preparePhoto(file));
        if (generation !== photoGeneration || !activeCity || destroyed) return;
      }
      photos.push(...prepared.map((file) => ({id:crypto.randomUUID(),file,url:URL.createObjectURL(file)})));
    } catch (error) {
      if (generation === photoGeneration) showError($('postFormError'),errorLabel(error));
    } finally {
      if (generation === photoGeneration) { photoLoading = false; renderPhotoPreview(); }
    }
  }

  function renderPhotoPreview() {
    const preview = $('photoPreview');
    if (!preview) return;
    preview.hidden = !photos.length && !photoLoading;
    preview.innerHTML = photos.map((photo,index) => `<div class="social-photo-item"><img src="${escapeHTML(photo.url)}" alt="待发布的第 ${index + 1} 张照片"><button type="button" class="social-button social-photo-remove" data-action="remove-photo" data-id="${photo.id}" aria-label="移除第 ${index + 1} 张照片"${photoLoading || posting ? ' disabled' : ''}>×</button><small>${Math.round(photo.file.size / 1024)} KB</small></div>`).join('') + (photoLoading ? '<p class="social-loading" role="status">正在整理照片…</p>' : '');
    $('photoCount').textContent = `已选 ${photos.length} / ${MAX_PHOTOS} 张${photos.length === MAX_PHOTOS ? ' · 已达上限，可移除后更换' : ' · 每条记录最多 3 张'}`;
    const input = $('postPhoto');
    input.disabled = photos.length >= MAX_PHOTOS || photoLoading || posting;
    input.closest('label').classList.toggle('is-disabled',input.disabled);
    $('photoAddLabel').textContent = photoLoading ? '正在处理…' : photos.length >= MAX_PHOTOS ? '已选满 3 张' : '＋ 添加照片';
    const submit = $('postForm')?.querySelector('[type="submit"]');
    if (submit) submit.disabled = photoLoading || posting;
  }

  async function postStory(form) {
    if (posting || photoLoading || !activeCity) return;
    const text = form.elements.text.value.trim();
    if (!text && !photos.length) { showError($('postFormError'),'写一段随笔，或添加照片。'); return; }
    posting = true;
    const code = activeCity.code;
    const authorId = accountUser()?.id;
    const submit = form.querySelector('[type="submit"]');
    Array.from(form.elements).forEach((field) => { field.disabled = true; });
    submit.textContent = '正在发布…';
    showError($('postFormError'),'');
    try {
      const data = new FormData();
      data.set('city',code);
      data.set('text',text);
      data.set('visibility',form.elements.visibility.value);
      photos.forEach((photo) => data.append('photo',photo.file));
      await app.api('/api/posts',{method:'POST',body:data});
      if (!destroyed && accountUser()?.id === authorId) {
        cityDrafts.delete(code);
        if (activeCity?.code === code) {
          const currentForm = $('postForm');
          currentForm.elements.text.value = '';
          clearPhoto();
          currentForm.querySelector('[type="file"]').value = '';
          renderPhotoPreview();
          await refreshPosts();
        }
      }
      app.notify('城市记录已发布。');
    } catch (error) { showError($('postFormError'),errorLabel(error)); }
    finally {
      posting = false;
      const currentForm = !destroyed && $('postForm');
      if (currentForm) {
        Array.from(currentForm.elements).forEach((field) => { field.disabled = false; });
        currentForm.querySelector('[type="submit"]').textContent = '发布记录';
        renderPhotoPreview();
      }
    }
  }

  async function handleFriendsClick(event) {
    const target = event.target.closest('button[data-action]');
    if (!target) return;
    const id = target.dataset.id;
    const action = target.dataset.action;
    if (action === 'sign-in') app.openAuth();
    else if (action === 'copy-code') {
      try { await navigator.clipboard.writeText(accountUser()?.code || ''); app.notify('好友码已复制。'); }
      catch { app.notify(`我的好友码：${accountUser()?.code || ''}`); }
    } else if (action === 'refresh-friends') await runButton(target,() => refreshFriends());
    else if (action === 'accept-friend') await runButton(target,async () => { await app.api(`/api/friends/${codePath(id)}/accept`,{method:'POST'}); await refreshFriends(); app.notify('已成为好友。'); });
    else if (action === 'remove-request') await runButton(target,async () => { await app.api(`/api/friends/${codePath(id)}`,{method:'DELETE'}); await refreshFriends(); });
    else if (action === 'remove-friend') {
      const friend = friendsData.friends.find((item) => item.id === id);
      if (!window.confirm(`移除好友「${friend?.name || '这位旅人'}」？双方将无法查看彼此的好友可见记录。`)) return;
      await runButton(target,async () => {
        await app.api(`/api/friends/${codePath(id)}`,{method:'DELETE'});
        const affectsComparison = selectedFriendIds.includes(id) || comparison?.friends.some((friend) => friend.id === id);
        friendsData.friends = friendsData.friends.filter((friend) => friend.id !== id);
        selectedFriendIds = selectedFriendIds.filter((friendId) => friendId !== id);
        if (compareOperation === 'friend' && selectedFriendIds.length !== 1) compareOperation = 'intersection';
        if (affectsComparison) clearComparison();
        friendsGeneration++;
        friendsLoading = false;
        renderFriendLists();
        renderComparisonPicker();
        await refreshFriends();
        app.notify('已移除好友。');
      });
    } else if (action === 'view-friend') {
      if (!friendsData.friends.some((friend) => friend.id === id)) { await refreshFriends(); return; }
      selectedFriendIds = [id];
      compareOperation = 'friend';
      renderComparisonPicker();
      await runButton(target,compareFriend);
    }
    else if (action === 'compare') await runButton(target,compareFriend);
    else if (action === 'clear-comparison') clearComparison();
    else if (action === 'open-city') openCity(id);
  }

  async function handleFriendsSubmit(event) {
    if (event.target.id !== 'friendRequestForm') return;
    event.preventDefault();
    const form = event.target;
    const code = form.elements.friendCode.value.trim();
    if (!code) return;
    const submit = form.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = '发送中…';
    showError($('friendError'),'');
    try {
      await app.api('/api/friends',jsonOptions('POST',{code}));
      form.elements.friendCode.value = '';
      await refreshFriends();
      app.notify('好友申请已发送。');
    } catch (error) { showError($('friendError'),errorLabel(error)); }
    finally { submit.disabled = false; submit.textContent = '添加'; }
  }

  async function handleDrawerClick(event) {
    const target = event.target.closest('button[data-action]');
    if (!target) return;
    const action = target.dataset.action, id = target.dataset.id;
    if (action === 'sign-in') app.openAuth();
    else if (action === 'close-drawer') closeDrawer();
    else if (action === 'refresh-posts') await runButton(target,() => refreshPosts());
    else if (action === 'load-more-posts') await runButton(target,loadMorePosts);
    else if (action === 'remove-photo' && !photoLoading && !posting) {
      const removed = photos.find((photo) => photo.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      photos = photos.filter((photo) => photo.id !== id);
      $('postPhoto').value = '';
      showError($('postFormError'),'');
      renderPhotoPreview();
      $('postPhoto').focus();
    }
    else if (action === 'delete-post') {
      if (!window.confirm('删除这条城市记录及其评论？')) return;
      await runButton(target,async () => { await app.api(`/api/posts/${codePath(id)}`,{method:'DELETE'}); await refreshPosts(); app.notify('城市记录已删除。'); });
    } else if (action === 'delete-comment') {
      if (!window.confirm('删除这条评论？')) return;
      await runButton(target,async () => { await app.api(`/api/comments/${codePath(id)}`,{method:'DELETE'}); await refreshPosts(); });
    }
  }

  async function handleDrawerSubmit(event) {
    const form = event.target;
    if (form.id === 'postForm') { event.preventDefault(); await postStory(form); }
    else if (form.classList.contains('social-comment-form')) {
      event.preventDefault();
      const text = form.elements.comment.value.trim();
      if (!text) return;
      const code = activeCity?.code;
      const submit = form.querySelector('[type="submit"]');
      await runButton(submit,async () => {
        await app.api(`/api/posts/${codePath(form.dataset.post)}/comments`,jsonOptions('POST',{text}));
        form.elements.comment.value = '';
        if (activeCity?.code === code) await refreshPosts();
      });
    }
  }

  function handleDrawerChange(event) {
    if (event.target.id === 'postPhoto') {
      const files = Array.from(event.target.files);
      event.target.value = '';
      choosePhotos(files);
    }
    else if (event.target.id === 'postVisibility') saveCityDraft();
  }
  function handleDrawerInput(event) { if (event.target.id === 'postText') saveCityDraft(); }
  function handleEscape(event) { if (event.key === 'Escape' && activeCity) closeDrawer(); }
  function accountReady() {
    const currentUserId = accountUser()?.id || null;
    if (currentUserId !== lastUserId) { cityDrafts.clear(); clearPhoto(); selectedFriendIds = []; compareOperation = 'intersection'; }
    else saveCityDraft();
    lastUserId = currentUserId;
    friendsGeneration++;
    comparisonGeneration++;
    cityGeneration++;
    postsRequestId++;
    postsLoading = false;
    friendsLoading = false;
    friendsData = {friends:[],incoming:[],outgoing:[]};
    comparison = null;
    app.clearComparison();
    renderFriends();
    refreshFriends();
    if (activeCity) { posts = []; nextBefore = null; loadedOlder = false; renderDrawer(); renderPhotoPreview(); refreshPosts(); }
  }
  function mapChanged() {
    if (comparison) renderComparisonResult();
    if (!cityPicker) renderFeedIntro();
  }
  friendsPanel.addEventListener('click',handleFriendsClick);
  friendsPanel.addEventListener('submit',handleFriendsSubmit);
  friendsPanel.addEventListener('change',handleFriendsChange);
  drawer.addEventListener('click',handleDrawerClick);
  drawer.addEventListener('submit',handleDrawerSubmit);
  drawer.addEventListener('change',handleDrawerChange);
  drawer.addEventListener('input',handleDrawerInput);
  window.addEventListener('keydown',handleEscape);
  window.addEventListener('account-ready',accountReady);
  window.addEventListener('map-state-changed',mapChanged);
  window.addEventListener('map-comparison-cleared',clearComparisonState);
  const unsubscribeCity = app.onCitySelected(openCity);
  const refreshTimer = setInterval(() => {
    if (document.hidden || destroyed) return;
    if (friendsPanel.getClientRects().length && signedIn()) refreshFriends({quiet:true});
    if (activeCity && !posting) refreshPosts({quiet:true});
  },30000);
  timers.add(refreshTimer);
  renderFriends();
  renderFeedIntro();
  drawer.hidden = true;
  refreshFriends();
  return {
    openCity,
    refresh:() => Promise.all([refreshFriends(),refreshPosts()]),
    destroy() {
      destroyed = true;
      cityGeneration++;
      friendsGeneration++;
      comparisonGeneration++;
      clearPhoto();
      cityPicker?.destroy();
      timers.forEach(clearInterval);
      friendsPanel.removeEventListener('click',handleFriendsClick);
      friendsPanel.removeEventListener('submit',handleFriendsSubmit);
      friendsPanel.removeEventListener('change',handleFriendsChange);
      drawer.removeEventListener('click',handleDrawerClick);
      drawer.removeEventListener('submit',handleDrawerSubmit);
      drawer.removeEventListener('change',handleDrawerChange);
      drawer.removeEventListener('input',handleDrawerInput);
      window.removeEventListener('keydown',handleEscape);
      window.removeEventListener('account-ready',accountReady);
      window.removeEventListener('map-state-changed',mapChanged);
      window.removeEventListener('map-comparison-cleared',clearComparisonState);
      if (typeof unsubscribeCity === 'function') unsubscribeCity();
    }
  };
}
