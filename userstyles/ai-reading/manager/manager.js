'use strict';

const state = {url: null, tabId: undefined, snapshot: null, filter: 'matching', busy: false};
const element = id => document.getElementById(id);
const filterButtons = [...document.querySelectorAll('[data-filter]')];
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const message = error => typeof error === 'string' ? error : error?.message || '操作未完成，请刷新后重试。';

function showError(error) {
  element('error').textContent = message(error);
  element('error').hidden = false;
  element('feedback').hidden = true;
}

function showFeedback(text) {
  element('error').hidden = true;
  element('feedback').textContent = text;
  element('feedback').hidden = !text;
}

function callChrome(operation) {
  return new Promise((resolve, reject) => {
    try {
      operation(result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) { reject(error); }
  });
}

async function invoke(method, args) {
  // Chrome message serialization turns array undefined into null. Omit the
  // optional tab id when no real tab exists (for a site's fallback home URL).
  args = [...args];
  while (args.length && args[args.length - 1] === undefined) args.pop();
  const response = await callChrome(done => chrome.runtime.sendMessage({
    data: {method: 'invokeAPI', path: 'novelwebReading.' + method, args},
  }, done));
  if (response?.error) throw new Error(message(response.error));
  if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) {
    throw new Error('样式管理接口没有返回状态。请确认当前 Stylus 已加载阅读管理功能，然后刷新。');
  }
  return response.data;
}

function httpUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? value : null;
  } catch (_) { return null; }
}

function optionalTabId(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

function applySnapshot(snapshot) {
  if (!snapshot || !httpUrl(snapshot.url) || !Array.isArray(snapshot.styles)
      || !['single', 'stack'].includes(snapshot.mode) || !Array.isArray(snapshot.selectedIds)
      || typeof snapshot.themeActiveCount !== 'number' || typeof snapshot.fontActiveCount !== 'number') {
    throw new Error('样式管理接口返回了不完整的状态。请刷新后重试。');
  }
  state.snapshot = snapshot;
  state.url = snapshot.url;
  const query = new URLSearchParams(location.search);
  query.set('url', state.url);
  if (state.tabId !== undefined) query.set('tabId', String(state.tabId));
  else query.delete('tabId');
  history.replaceState(null, '', location.pathname + '?' + query.toString());
  render();
}

function refreshControls() {
  const ready = Boolean(state.snapshot);
  element('mode-picker').disabled = state.busy || !ready;
  element('refresh').disabled = state.busy || !state.url;
  element('disable-all').disabled = state.busy || !ready
    || (state.snapshot.selectedIds.length === 0 && state.snapshot.fontStyleId == null);
  for (const id of ['switch-chatgpt', 'switch-gemini', 'native-manager', 'global-manager']) element(id).disabled = state.busy;
  for (const button of filterButtons) button.disabled = state.busy;
  for (const input of document.querySelectorAll('.style-selector')) {
    input.disabled = state.busy || input.dataset.allowed !== 'true';
  }
  for (const button of document.querySelectorAll('.toggle')) {
    button.disabled = state.busy || button.dataset.allowed !== 'true';
  }
  for (const button of document.querySelectorAll('.configure')) button.disabled = state.busy;
  element('style-list').setAttribute('aria-busy', String(state.busy));
}

async function run(action, successText = '') {
  if (state.busy) return;
  state.busy = true;
  element('error').hidden = true;
  element('feedback').hidden = true;
  refreshControls();
  try {
    await action();
    if (successText) showFeedback(successText);
  } catch (error) {
    showError(error);
    // Radio/checkbox inputs may have changed before the operation failed.
    // Redraw the last confirmed snapshot instead of displaying an unaccepted choice.
    render();
    if (!state.snapshot) {
      if (!state.url) element('target-host').textContent = '尚未选择网页';
      element('empty-title').textContent = '暂时无法读取样式';
      element('empty-description').textContent = state.url
        ? '请查看上方错误信息，再用“刷新状态”重试。'
        : '可用 ChatGPT / Gemini 快捷按钮选择要管理的网页。';
    }
  } finally {
    state.busy = false;
    refreshControls();
  }
}

async function loadTarget(url, tabId) {
  const valid = httpUrl(url);
  if (!valid) throw new Error('需要一个真实的 HTTP 或 HTTPS 网页地址。');
  // Keep the initial target retryable even if its first snapshot request fails.
  // Once a snapshot exists, a failed site switch leaves that confirmed context intact.
  if (!state.snapshot) {
    state.url = valid;
    state.tabId = tabId;
    element('target-host').textContent = new URL(valid).host;
    element('target-url').textContent = valid;
  }
  const snapshot = await invoke('snapshot', [valid, tabId]);
  state.tabId = tabId;
  applySnapshot(snapshot);
}

function isSelected(style) {
  if (style.reading) return state.snapshot.fontStyleId === style.id;
  return state.snapshot.selectedIds.some(id => String(id) === String(style.id));
}

function styleStatus(style) {
  if (style.active) return '本站已启用';
  if (isSelected(style)) return '已选 · 未生效';
  if (!style.matches) return '用于其他网站';
  if (style.excluded) return '本站已排除';
  if (style.empty) return '没有适用规则';
  if (style.managedBlocked) return '本站未选用';
  return '本站未启用';
}

function canEnable(style) {
  return Boolean(style.matches && !style.excluded && !style.empty);
}

function detailsFor(style) {
  if (isSelected(style) && !style.active && state.snapshot.globalDisabled) {
    return '已选择，等待 Stylus 总开关开启；也可取消选择。';
  }
  if (!style.matches) return '此样式不匹配当前完整网址。';
  if (style.excluded) return '该网址在此样式的排除规则中。';
  if (style.empty) return '当前网页没有可应用的样式规则。';
  if (style.reading) return '字体与阅读排版独立启用，切换主题不会关闭它；“字体设置”可调整中英文字体。';
  if (style.active) return state.snapshot.mode === 'single' ? '当前单选样式' : '已加入本站叠加组合';
  if (isSelected(style)) return '已选择但暂未实际作用，可取消选择。';
  return state.snapshot.mode === 'single' ? '选择后替换本站当前样式' : '选择后加入本站样式组合';
}

function setEnabled(style, enabled) {
  return run(async () => {
    applySnapshot(await invoke('setEnabled', [state.url, style.id, enabled, state.tabId]));
  }, enabled ? '已更新本站样式选择，实际作用状态见各项标记。' : '已取消本站对这个样式的选择。');
}

function openExtensionPage(relativePath) {
  return run(async () => {
    await callChrome(done => chrome.tabs.create({url: chrome.runtime.getURL(relativePath)}, done));
  });
}

function renderCard(style) {
  const card = element('style-card-template').content.firstElementChild.cloneNode(true);
  const selected = isSelected(style);
  const canDisable = selected || Boolean(style.active);
  card.dataset.styleId = String(style.id);
  card.classList.toggle('is-active', Boolean(style.active));
  card.classList.toggle('is-selected', selected);
  const name = String(style.name || '未命名样式');
  card.querySelector('.style-name').textContent = name;
  const kind = card.querySelector('.style-kind');
  kind.textContent = style.reading ? '独立字体' : '外观主题';
  card.querySelector('.style-state').textContent = styleStatus(style);
  card.querySelector('.style-detail').textContent = detailsFor(style);
  const scopes = Array.isArray(style.scopes) ? style.scopes.map(String) : [];
  card.querySelector('.scope-text').textContent = scopes.length ? scopes.join(' · ') : '样式未提供适用范围说明';
  const riskList = card.querySelector('.risk-list');
  for (const risk of Array.isArray(style.risk) ? style.risk : []) {
    const item = document.createElement('li');
    item.textContent = String(risk);
    riskList.append(item);
  }
  riskList.hidden = !riskList.childElementCount;

  const selector = card.querySelector('.style-selector');
  selector.type = !style.reading && state.snapshot.mode === 'single' ? 'radio' : 'checkbox';
  selector.name = style.reading ? 'site-font' : 'site-style';
  selector.checked = selected;
  selector.dataset.allowed = String(canDisable || canEnable(style));
  selector.setAttribute('aria-label', name + '：' + styleStatus(style));
  selector.addEventListener('change', () => setEnabled(style, selector.checked));
  const toggle = card.querySelector('.toggle');
  toggle.dataset.styleId = String(style.id);
  toggle.textContent = style.active ? '停用' : selected ? '取消选择' : style.matches ? '启用' : '用于其他网站';
  toggle.dataset.allowed = String(canDisable || canEnable(style));
  toggle.setAttribute('aria-label', (canDisable ? '在本站取消选择' : '在本站选择') + name);
  toggle.addEventListener('click', () => setEnabled(style, !canDisable));
  const configure = card.querySelector('.configure');
  if (style.reading) configure.textContent = '字体设置 ↗';
  configure.setAttribute('aria-label', (style.reading ? '字体设置：' : '配置') + name);
  configure.addEventListener('click', () => openExtensionPage('edit.html?id=' + encodeURIComponent(style.id)));
  return card;
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    refreshControls();
    return;
  }
  const host = new URL(snapshot.url).host;
  element('target-host').textContent = host;
  element('target-url').textContent = snapshot.url;
  element('target-url').title = snapshot.url;
  document.title = '样式管理 · ' + host;
  element('switch-chatgpt').setAttribute('aria-pressed', String(new URL(snapshot.url).hostname === 'chatgpt.com'));
  element('switch-gemini').setAttribute('aria-pressed', String(new URL(snapshot.url).hostname === 'gemini.google.com'));
  element('installed-count').textContent = String(snapshot.installedCount);
  element('matching-count').textContent = String(snapshot.styles.filter(style => style.matches).length);
  element('active-count').textContent = String(snapshot.activeCount);
  element('active-breakdown').textContent = `${snapshot.themeActiveCount} 个主题 · `
    + (snapshot.fontActiveCount ? '阅读字体已启用' : snapshot.fontStyleId != null ? '阅读字体已选，暂未生效' : '阅读字体未启用');
  element('global-disabled').hidden = !snapshot.globalDisabled;
  for (const input of modeInputs) input.checked = input.value === snapshot.mode;
  element('mode-description').textContent = snapshot.mode === 'single'
    ? '主题一次只选一个；阅读字体单独勾选，切换主题不会改变字体选择。'
    : '多个外观主题同时生效，可能互相覆盖。阅读字体仍单独控制。';
  for (const button of filterButtons) {
    const selected = button.dataset.filter === state.filter;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  element('style-list').setAttribute('aria-labelledby', 'filter-' + state.filter);
  const visible = snapshot.styles.filter(style => state.filter === 'all'
    || (state.filter === 'matching' ? style.matches : style.active));
  const fragment = document.createDocumentFragment();
  for (const style of visible) fragment.append(renderCard(style));
  element('style-list').replaceChildren(fragment);
  element('empty-state').hidden = visible.length > 0;
  const emptyText = state.filter === 'all'
    ? ['还没有安装样式', '可在原生管理页导入已有样式。']
    : state.filter === 'active'
      ? ['本站暂未启用样式', '在“本站可用”中选择一个样式即可启用。']
      : ['没有匹配这个网址的样式', '其他网站的样式可在“全部已安装”中查看。'];
  element('empty-title').textContent = emptyText[0];
  element('empty-description').textContent = emptyText[1];
  refreshControls();
}

async function switchSite(host, fallbackUrl) {
  await run(async () => {
    const tabs = await callChrome(done => chrome.tabs.query({}, done));
    const matching = tabs.filter(tab => httpUrl(tab.url) && new URL(tab.url).hostname === host);
    matching.sort((a, b) => Number(b.id === state.tabId) - Number(a.id === state.tabId)
      || Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const tab = matching[0];
    await loadTarget(tab ? tab.url : fallbackUrl, tab?.id);
  });
}

for (const input of modeInputs) input.addEventListener('change', () => {
  if (!input.checked || input.value === state.snapshot?.mode) return;
  run(async () => {
    applySnapshot(await invoke('setMode', [state.url, input.value, state.tabId]));
  }, input.value === 'single' ? '已切换为单选模式。' : '已明确开启叠加模式。');
});

for (const button of filterButtons) {
  button.addEventListener('click', () => { state.filter = button.dataset.filter; render(); });
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = filterButtons.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? filterButtons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + filterButtons.length) % filterButtons.length;
    filterButtons[next].focus();
    filterButtons[next].click();
  });
}

element('refresh').addEventListener('click', () => run(async () => {
  applySnapshot(await invoke('snapshot', [state.url, state.tabId]));
}, '已刷新本站的实际样式状态。'));

element('disable-all').addEventListener('click', () => run(async () => {
  // Use the confirmed site selection, and await each update before the next.
  const ids = [...new Set([...state.snapshot.selectedIds, state.snapshot.fontStyleId].filter(id => id != null))];
  for (const id of ids) {
    applySnapshot(await invoke('setEnabled', [state.url, id, false, state.tabId]));
  }
}, '已停用本站所有已选样式。'));

element('switch-chatgpt').addEventListener('click', () => switchSite('chatgpt.com', 'https://chatgpt.com/'));
element('switch-gemini').addEventListener('click', () => switchSite('gemini.google.com', 'https://gemini.google.com/'));
element('native-manager').addEventListener('click', () => openExtensionPage('manage.html'));
element('global-manager').addEventListener('click', () => openExtensionPage('manage.html'));

run(async () => {
  if (!globalThis.chrome?.runtime?.sendMessage || !chrome.tabs?.query) {
    throw new Error('请从安装了阅读管理功能的 Stylus 扩展中打开此页。');
  }
  const query = new URLSearchParams(location.search);
  const requestedUrl = query.get('url');
  const requestedTabId = optionalTabId(query.get('tabId'));
  if (requestedUrl !== null) {
    await loadTarget(requestedUrl, requestedTabId);
    return;
  }
  if (requestedTabId !== undefined) {
    const tab = await callChrome(done => chrome.tabs.get(requestedTabId, done));
    if (httpUrl(tab?.url)) {
      await loadTarget(tab.url, tab.id);
      return;
    }
  }
  const active = await callChrome(done => chrome.tabs.query({active: true, currentWindow: true}, done));
  const tab = active.find(tab => httpUrl(tab.url));
  if (!tab) {
    element('target-host').textContent = '尚未选择网页';
    element('target-url').textContent = '请从目标网页打开管理页，或用上方快捷按钮选择 ChatGPT / Gemini。';
    element('empty-title').textContent = '先选择要管理的网页';
    element('empty-description').textContent = '管理页会显示所选网址的实际样式状态。';
    throw new Error('当前活动标签页不是 HTTP / HTTPS 网页。可以使用 ChatGPT / Gemini 快捷按钮继续。');
  }
  await loadTarget(tab.url, tab.id);
});
