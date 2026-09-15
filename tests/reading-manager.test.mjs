import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../userstyles/ai-reading/manager/background.js', import.meta.url), 'utf8'))
  .replace('__NOVELWEB_READING_SOURCE_HASH__', 'a'.repeat(64));
const KEY = 'novelwebReadingManagerV1';
const CHAT = 'https://chatgpt.com/c/test';
const GEMINI = 'https://gemini.google.com/app/test';
const clone = value => JSON.parse(JSON.stringify(value));
const rules = host => [`*://${host}/*`, `*://${host}:*/*`];

function style(id, host, reading = false) {
  return {
    id, name: `Style ${id}`, enabled: true,
    sections: [{domains: [host], code: 'p { font-family: serif }'}],
    ...(reading ? {usercssData: {namespace: 'novelweb-ai-reading', vars: {font: 'serif'}}} : {}),
  };
}

function fixtures() {
  return [
    style(1, 'chatgpt.com', true), style(2, 'gemini.google.com', true),
    style(10, 'chatgpt.com'), style(11, 'chatgpt.com'),
    style(20, 'gemini.google.com'), style(21, 'gemini.google.com'),
  ];
}

function legacy(styles, selections = {'chatgpt.com': [10], 'gemini.google.com': [20]}, mode = 'single') {
  const state = {version: 1, hosts: {}};
  for (const [host, selectedIds] of Object.entries(selections)) {
    const ownedExclusions = {};
    for (const item of styles) {
      if (selectedIds.includes(item.id)) continue;
      const existing = item.exclusions || [];
      const added = rules(host).filter(rule => !existing.includes(rule));
      if (added.length) {
        item.exclusions = [...existing, ...added];
        ownedExclusions[item.id] = added;
      }
    }
    state.hosts[host] = {mode, selectedIds, ownedExclusions};
  }
  return state;
}

function wildcard(pattern, url) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

// Execute the shipped background script against a stateful Stylus API model.
// Injection derives from enabled flags, domain matching, exclusions and tab
// overrides, so a selected ID alone cannot make these assertions pass.
async function manager({styles = fixtures(), saved, off = false} = {}) {
  const store = new Map(clone(styles).map(item => [item.id, item]));
  const storage = {
    ...(saved ? {[KEY]: clone(saved)} : {}),
    // These tests exercise manager migrations after the separate first-run seed.
    novelwebReadingDefaultsV1: {version: 1, completed: [
      'novelweb-ai-reading::ChatGPT · 中文阅读',
      'novelweb-ai-reading::Gemini · 中文阅读',
    ]},
  };
  const tabs = [{id: 100, url: CHAT}, {id: 200, url: GEMINI}];
  const overrides = new Map();
  const errors = [];
  const preferences = {off};
  let sandbox;
  const excludes = (item, url) => (item.exclusions || []).some(rule => wildcard(rule, url));
  const matches = (item, url) => item.sections.some(section => {
    const host = new URL(url).hostname;
    return !['domains', 'urlPrefixes', 'urls', 'regexps'].some(key => section[key]?.length) ||
      section.domains?.some(domain => host === domain || host.endsWith('.' + domain)) ||
      section.urlPrefixes?.some(prefix => url.startsWith(prefix)) || section.urls?.includes(url) ||
      section.regexps?.some(pattern => new RegExp(pattern).test(url));
  });
  const candidates = (url, tabId) => [...store.values()].filter(item => matches(item, url)).map(item => ({
    style: item, excluded: excludes(item, url), incOvr: false, sloppy: false,
    empty: !item.sections.some(section => section.code?.trim()),
    excludedScheme: Boolean(item.excludedScheme), tabOvr: overrides.get(tabId)?.[item.id],
  }));
  const savedEvent = (item, reason) => sandbox.novelwebReadingOnSaved?.(item, reason);
  const API = {styles: {
    get: id => store.get(id),
    getAll: () => [...store.values()],
    getByUrl: (url, id, tabId) => candidates(url, tabId).filter(item => id == null || item.style.id === id),
    matchOverrides: excludes,
    getSectionsByUrl(url) {
      const applied = preferences.off ? [] : candidates(url, this.sender?.tabId).filter(item =>
        item.style.enabled && !item.empty && !item.excludedScheme && item.tabOvr !== false &&
        (!item.excluded || item.tabOvr === true));
      return {sections: applied.map(item => ({id: item.style.id})), cfg: {off: preferences.off}};
    },
    async config(id, key, value) {
      const item = store.get(id);
      item[key] = clone(value);
      savedEvent(item, 'config');
    },
    async toggle(id, enabled) {
      const item = store.get(id);
      item.enabled = enabled;
      savedEvent(item, 'toggle');
    },
    async toggleTabOvrMany(tabId, values) {
      overrides.set(tabId, {...overrides.get(tabId), ...values});
    },
  }};
  sandbox = vm.createContext({
    API, URL, queueMicrotask, novelwebReadingWorkerSourceHash: 'a'.repeat(64),
    console: {error: (...args) => errors.push(args.map(String).join(' '))},
    chrome: {
      runtime: {getURL: path => 'chrome-extension://test/' + path},
      storage: {local: {
        async get(key) { return storage[key] ? {[key]: clone(storage[key])} : {}; },
        async set(values) { Object.assign(storage, clone(values)); },
      }},
      tabs: {
        async query() { return clone(tabs); },
        async get(id) { const tab = tabs.find(item => item.id === id); if (!tab) throw Error('Missing tab'); return clone(tab); },
      },
    },
  });
  vm.runInContext(source, sandbox, {filename: 'reading-manager/background.js'});
  const invoke = async (method, ...args) => clone(await API.novelwebReading[method](...args));
  await invoke('snapshot', CHAT, 100);
  assert.deepEqual(errors, [], 'background startup must succeed');
  return {
    invoke, API, preferences, overrides,
    get: id => store.get(id),
    saved: () => clone(storage[KEY]),
    styles: () => clone([...store.values()]),
    async remove(id) { store.delete(id); savedEvent({id}, 'remove'); await Promise.resolve(); },
    async install(item) { store.set(item.id, clone(item)); savedEvent(store.get(item.id), 'install'); await Promise.resolve(); },
  };
}

const active = snapshot => snapshot.styles.filter(item => item.active).map(item => item.id).sort((a, b) => a - b);

test('V1 migration restores the excluded reading layer while preserving each selected theme', async () => {
  const styles = fixtures();
  const app = await manager({styles, saved: legacy(styles)});
  const chat = await app.invoke('snapshot', CHAT, 100);
  const gemini = await app.invoke('snapshot', GEMINI, 200);
  assert.deepEqual(chat.selectedIds, [10]);
  assert.equal(chat.fontStyleId, 1);
  assert.deepEqual(active(chat), [1, 10]);
  assert.equal(chat.fontActiveCount, 1);
  assert.equal(chat.themeActiveCount, 1);
  assert.equal(chat.activeCount, 2);
  assert.equal(chat.styles.find(item => item.id === 1).reading, true);
  assert.equal(chat.styles.find(item => item.id === 10).reading, false);
  assert.deepEqual(active(gemini), [2, 20]);
  assert.equal(gemini.fontStyleId, 2);
  assert.equal(app.saved().version, 2);
  assert.ok(!app.get(1).exclusions?.includes(rules('chatgpt.com')[0]));
  assert.ok(app.get(1).exclusions.includes(rules('gemini.google.com')[0]));
  assert.equal(app.saved().hosts['chatgpt.com'].ownedExclusions[1], undefined);
});

test('migration separates fonts before theme truncation and preserves stack mode', async () => {
  for (const mode of ['single', 'stack']) {
    const styles = fixtures();
    const saved = legacy(styles, {'chatgpt.com': [1, 10, 11], 'gemini.google.com': [2, 20]}, mode);
    const app = await manager({styles, saved});
    const snapshot = await app.invoke('snapshot', CHAT, 100);
    assert.equal(snapshot.mode, mode);
    assert.equal(snapshot.fontStyleId, 1);
    assert.deepEqual(snapshot.selectedIds, mode === 'single' ? [10] : [10, 11]);
    assert.deepEqual(active(snapshot), mode === 'single' ? [1, 10] : [1, 10, 11]);
  }
});

test('switching themes preserves fonts, and font toggles preserve themes and the other site', async () => {
  const styles = fixtures();
  const app = await manager({styles, saved: legacy(styles)});
  const beforeGemini = await app.invoke('snapshot', GEMINI, 200);
  let chat = await app.invoke('setEnabled', CHAT, 11, true, 100);
  assert.deepEqual(chat.selectedIds, [11]);
  assert.deepEqual(active(chat), [1, 11]);
  assert.ok(app.get(10).exclusions.includes(rules('chatgpt.com')[0]));
  chat = await app.invoke('setEnabled', CHAT, 1, false, 100);
  assert.equal(chat.fontStyleId, null);
  assert.deepEqual(chat.selectedIds, [11]);
  assert.deepEqual(active(chat), [11]);
  assert.ok(app.get(1).exclusions.includes(rules('chatgpt.com')[0]));
  chat = await app.invoke('setEnabled', CHAT, 10, true, 100);
  assert.equal(chat.fontStyleId, null);
  assert.deepEqual(active(chat), [10]);
  chat = await app.invoke('setEnabled', CHAT, 1, true, 100);
  assert.deepEqual(active(chat), [1, 10]);
  assert.deepEqual(chat.selectedIds, [10]);
  assert.deepEqual(await app.invoke('snapshot', GEMINI, 200), beforeGemini);
  await assert.rejects(app.invoke('setEnabled', CHAT, 2, true, 100), /不能跨网站强制启用/);
});

test('theme stack and single modes never consume the independent font slot', async () => {
  const app = await manager();
  await app.invoke('setMode', CHAT, 'stack', 100);
  let chat = await app.invoke('setEnabled', CHAT, 11, true, 100);
  assert.deepEqual(active(chat), [1, 10, 11]);
  assert.equal(chat.themeActiveCount, 2);
  chat = await app.invoke('setMode', CHAT, 'single', 100);
  assert.deepEqual(chat.selectedIds, [10]);
  assert.equal(chat.fontStyleId, 1);
  assert.deepEqual(active(chat), [1, 10]);
});

test('font parameter saves do not reactivate a disabled layer or change theme selection', async () => {
  const app = await manager();
  await app.invoke('setEnabled', CHAT, 1, false, 100);
  assert.equal(app.get(1).enabled, true, 'per-site off must not globally disable the style');
  await app.API.styles.config(1, 'usercssData', {namespace: 'novelweb-ai-reading', vars: {font: 'handwriting'}});
  const chat = await app.invoke('snapshot', CHAT, 100);
  assert.equal(chat.fontStyleId, null);
  assert.deepEqual(chat.selectedIds, [10]);
  assert.deepEqual(active(chat), [10]);
  assert.ok(app.get(1).exclusions.includes(rules('chatgpt.com')[0]));
});

test('native font disable and re-enable synchronize the font slot without changing themes', async () => {
  const app = await manager();
  await app.API.styles.toggle(1, false);
  let chat = await app.invoke('snapshot', CHAT, 100);
  assert.equal(chat.fontStyleId, null);
  assert.deepEqual(active(chat), [10]);
  await app.API.styles.toggle(1, true);
  chat = await app.invoke('snapshot', CHAT, 100);
  assert.equal(chat.fontStyleId, 1);
  assert.deepEqual(chat.selectedIds, [10]);
  assert.deepEqual(active(chat), [1, 10]);
  assert.deepEqual(active(await app.invoke('snapshot', GEMINI, 200)), [2, 20]);
});

test('migration and native toggles retain original full-site font exclusions', async () => {
  const styles = fixtures();
  styles[0].exclusions = ['*://chatgpt.com/*'];
  const app = await manager({styles, saved: legacy(styles)});
  let chat = await app.invoke('snapshot', CHAT, 100);
  assert.equal(chat.fontStyleId, null);
  assert.deepEqual(active(chat), [10]);
  assert.equal(chat.styles.find(item => item.id === 1).excluded, true);
  await app.API.styles.toggle(1, true);
  chat = await app.invoke('snapshot', CHAT, 100);
  assert.equal(chat.fontStyleId, null);
  await assert.rejects(app.invoke('setEnabled', CHAT, 1, true, 100), /原有的排除规则/);
  assert.ok(app.get(1).exclusions.includes('*://chatgpt.com/*'));
  assert.ok(!app.saved().hosts['chatgpt.com'].ownedExclusions[1].includes('*://chatgpt.com/*'));
});

test('path exclusions survive migration, toggles, and real URL matching', async () => {
  const styles = fixtures();
  styles[0].exclusions = ['*://chatgpt.com/private/*'];
  const app = await manager({styles, saved: legacy(styles)});
  assert.deepEqual(active(await app.invoke('snapshot', CHAT, 100)), [1, 10]);
  const privatePage = await app.invoke('snapshot', 'https://chatgpt.com/private/test');
  assert.equal(privatePage.fontStyleId, 1);
  assert.equal(privatePage.fontActiveCount, 0);
  assert.deepEqual(active(privatePage), [10]);
  await app.invoke('setEnabled', CHAT, 1, false, 100);
  await app.invoke('setEnabled', CHAT, 1, true, 100);
  assert.ok(app.get(1).exclusions.includes('*://chatgpt.com/private/*'));
  assert.equal((await app.invoke('snapshot', 'https://chatgpt.com/private/test')).fontActiveCount, 0);
});

test('migration respects empty old selections and globally disabled fonts', async () => {
  const styles = fixtures();
  styles[0].enabled = false;
  const saved = legacy(styles, {'chatgpt.com': [10], 'gemini.google.com': []});
  const app = await manager({styles, saved});
  assert.deepEqual(active(await app.invoke('snapshot', CHAT, 100)), [10]);
  assert.equal((await app.invoke('snapshot', CHAT, 100)).fontStyleId, null);
  assert.equal(app.get(1).enabled, false);
  assert.deepEqual(active(await app.invoke('snapshot', GEMINI, 200)), []);
  assert.equal((await app.invoke('snapshot', GEMINI, 200)).fontStyleId, null);
});

test('V2 restart preserves an explicitly disabled font and never repeats restoration', async () => {
  const styles = fixtures();
  const first = await manager({styles, saved: legacy(styles)});
  await first.invoke('setEnabled', CHAT, 1, false, 100);
  await first.invoke('setEnabled', CHAT, 11, true, 100);
  const restarted = await manager({styles: first.styles(), saved: first.saved()});
  const chat = await restarted.invoke('snapshot', CHAT, 100);
  assert.equal(chat.fontStyleId, null);
  assert.deepEqual(chat.selectedIds, [11]);
  assert.deepEqual(active(chat), [11]);
  assert.ok(restarted.get(1).exclusions.includes(rules('chatgpt.com')[0]));
  assert.deepEqual(active(await restarted.invoke('snapshot', GEMINI, 200)), [2, 20]);
});

test('global off and temporary tab exclusions are reflected in actual font/theme counts', async () => {
  const app = await manager();
  app.preferences.off = true;
  let chat = await app.invoke('snapshot', CHAT, 100);
  assert.equal(chat.fontStyleId, 1);
  assert.equal(chat.globalDisabled, true);
  assert.equal(chat.fontActiveCount, 0);
  assert.equal(chat.themeActiveCount, 0);
  await assert.rejects(app.invoke('setEnabled', CHAT, 11, true, 100), /总开关/);
  app.preferences.off = false;
  await app.API.styles.toggleTabOvrMany(100, {1: false});
  chat = await app.invoke('snapshot', CHAT, 100);
  assert.deepEqual(active(chat), [10]);
  chat = await app.invoke('setEnabled', CHAT, 1, true, 100);
  assert.deepEqual(active(chat), [1, 10]);
  await app.API.styles.toggleTabOvrMany(100, {11: true});
  assert.deepEqual(active(await app.invoke('snapshot', CHAT, 100)), [1, 10]);
});

test('new global styles remain unselected, and removing a font preserves its theme', async () => {
  const app = await manager();
  await app.install({id: 30, name: 'New global theme', enabled: true, sections: [{code: 'body { color: red }'}]});
  let chat = await app.invoke('snapshot', CHAT, 100);
  assert.deepEqual(active(chat), [1, 10]);
  assert.ok(app.get(30).exclusions.includes(rules('chatgpt.com')[0]));
  assert.ok(app.get(30).exclusions.includes(rules('gemini.google.com')[0]));
  await app.remove(1);
  chat = await app.invoke('snapshot', CHAT, 100);
  assert.equal(chat.fontStyleId, null);
  assert.deepEqual(chat.selectedIds, [10]);
  assert.deepEqual(active(chat), [10]);
});
