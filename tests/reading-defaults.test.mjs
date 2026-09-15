import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import {cleanCompiledDefault} from '../userstyles/ai-reading/export-defaults.mjs';

const source = (await readFile(new URL('../userstyles/ai-reading/manager/background.js', import.meta.url), 'utf8'))
  .replace('__NOVELWEB_READING_SOURCE_HASH__', 'b'.repeat(64));
const bundle = JSON.parse(await readFile(new URL('../userstyles/ai-reading/ai-reading.stylus.json', import.meta.url), 'utf8'));
const DEFAULTS_KEY = 'novelwebReadingDefaultsV1';
const MANAGER_KEY = 'novelwebReadingManagerV1';
const HASH = 'b'.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));

// Model the actual install API: save precompiled sections, emit its save hook,
// and expose installed state before any host selection can be initialized.
async function boot({styles = [], storage = {}, defaults = bundle, failInstall, failMarker = false, failFetch = false, workerHash = HASH} = {}) {
  const saved = clone(storage);
  const entries = new Map(clone(styles).map(style => [style.id, style]));
  const imports = [];
  const fetches = [];
  let sandbox;
  const matching = url => [...entries.values()].filter(style =>
    style.sections.some(section => section.domains?.includes(new URL(url).hostname)));
  const excludes = (style, url) => (style.exclusions || []).some(rule =>
    new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*') + '$').test(url));
  const candidates = url => matching(url).map(style => ({style, excluded: excludes(style, url)}));
  const API = {styles: {
    get: id => entries.get(id), getAll: () => [...entries.values()],
    getByUrl: candidates, matchOverrides: excludes,
    getSectionsByUrl: url => ({sections: matching(url).filter(style => style.enabled && !excludes(style, url)).map(style => ({id: style.id}))}),
    async install(style) {
      imports.push(clone(style));
      assert.deepEqual(saved[MANAGER_KEY], storage[MANAGER_KEY], 'first-run host state must not precede seed');
      if (failInstall === style.name) throw new Error('Simulated install failure');
      const id = Math.max(0, ...entries.keys()) + 1;
      entries.set(id, {...clone(style), id});
      sandbox.novelwebReadingOnSaved(entries.get(id), 'install');
      return entries.get(id);
    },
    async config(id, key, value) {
      entries.get(id)[key] = clone(value);
      sandbox.novelwebReadingOnSaved(entries.get(id), 'config');
    },
    async toggleTabOvrMany() {},
  }};
  sandbox = vm.createContext({
    API, URL, queueMicrotask, structuredClone, novelwebReadingWorkerSourceHash: workerHash,
    console: {error() {}},
    async fetch(url) {
      fetches.push(url);
      assert.ok(url.endsWith('/defaults.json'));
      if (failFetch) return {ok: false, status: 404};
      return {ok: true, json: async () => clone(defaults)};
    },
    chrome: {
      runtime: {getURL: path => 'chrome-extension://test/' + path},
      storage: {local: {
        async get(key) { return saved[key] ? {[key]: clone(saved[key])} : {}; },
        async set(values) {
          if (failMarker && values[DEFAULTS_KEY]) throw new Error('Simulated storage failure');
          Object.assign(saved, clone(values));
        },
      }},
      tabs: {async query() { return []; }},
    },
  });
  vm.runInContext(source, sandbox, {filename: 'reading-manager/background.js'});
  const health = clone(await API.novelwebReading.getHealth());
  return {API, health, imports, fetches, storage: saved, styles: [...entries.values()]};
}

test('fresh profile seeds only the two bundled fonts before host selection and reports loaded build', async () => {
  const app = await boot();
  assert.equal(app.health.version, '1.2.0');
  assert.equal(app.health.sourceHash, HASH);
  assert.deepEqual(app.health.loadedBuild, {backgroundHash: HASH, workerHash: HASH});
  assert.equal(app.health.defaults.status, 'complete');
  assert.equal(app.health.error, null);
  assert.deepEqual(app.imports.map(style => style.name), ['ChatGPT · 中文阅读', 'Gemini · 中文阅读']);
  assert.equal(app.storage[MANAGER_KEY].hosts['chatgpt.com'].fontStyleId, 1);
  assert.equal(app.storage[MANAGER_KEY].hosts['gemini.google.com'].fontStyleId, 2);
  assert.deepEqual(app.storage[MANAGER_KEY].hosts['chatgpt.com'].selectedIds, []);
  assert.equal(app.storage[DEFAULTS_KEY].completed.length, 2);
});

test('mismatched executable build constants stop bootstrap before fetching defaults or writing settings', async () => {
  const app = await boot({workerHash: 'old-worker-hash'});
  assert.match(app.health.error, /已加载源码不一致/);
  assert.deepEqual(app.health.loadedBuild, {backgroundHash: HASH, workerHash: 'old-worker-hash'});
  assert.equal(app.fetches.length, 0);
  assert.equal(app.imports.length, 0);
  assert.deepEqual(app.storage, {});
});

test('existing style identity retains font variables, enabled state and original exclusions', async () => {
  const custom = clone(bundle[0]);
  Object.assign(custom, {id: 5, enabled: false, exclusions: ['*://chatgpt.com/private/*'], customName: 'My font'});
  custom.usercssData.vars['nr-font'].value = 'lxgw_wenkai';
  const app = await boot({styles: [custom]});
  assert.deepEqual(app.imports.map(style => style.name), ['Gemini · 中文阅读']);
  const preserved = app.styles.find(style => style.id === 5);
  assert.equal(preserved.enabled, false);
  assert.equal(preserved.customName, 'My font');
  assert.deepEqual(preserved.usercssData, custom.usercssData);
  assert.ok(preserved.exclusions.includes('*://chatgpt.com/private/*'));
  assert.equal(app.storage[MANAGER_KEY].hosts['chatgpt.com'].fontStyleId, null);
});

test('existing theme and explicitly disabled font selections survive bootstrap', async () => {
  const styles = bundle.map((style, index) => ({...clone(style), id: index + 1}));
  styles.push({id: 9, name: 'My theme', enabled: true, sections: [{domains: ['chatgpt.com'], code: 'body { color: red }'}]});
  const storage = {[MANAGER_KEY]: {version: 2, hosts: {
    'chatgpt.com': {mode: 'stack', selectedIds: [9], fontStyleId: null, ownedExclusions: {}},
    'gemini.google.com': {mode: 'single', selectedIds: [], fontStyleId: 2, ownedExclusions: {}},
  }}};
  const app = await boot({styles, storage});
  assert.equal(app.imports.length, 0);
  const host = app.storage[MANAGER_KEY].hosts['chatgpt.com'];
  assert.equal(host.mode, 'stack');
  assert.deepEqual(host.selectedIds, [9]);
  assert.equal(host.fontStyleId, null);
});

test('successful seed is not repeated and deleting a default remains a user choice', async () => {
  const first = await boot();
  const restarted = await boot({styles: first.styles.filter(style => style.id !== 1), storage: first.storage, failFetch: true});
  assert.equal(restarted.health.defaults.status, 'complete');
  assert.equal(restarted.imports.length, 0);
  assert.equal(restarted.fetches.some(url => url.endsWith('/defaults.json')), false);
  assert.deepEqual(restarted.health.defaults.installed.map(style => style.name), ['Gemini · 中文阅读']);
  assert.equal(restarted.storage[MANAGER_KEY].hosts['chatgpt.com'].fontStyleId, null);
});

test('partial failure leaves no completion marker and retries missing identity only', async () => {
  const first = await boot({failInstall: 'Gemini · 中文阅读'});
  assert.equal(first.health.defaults.status, 'error');
  assert.match(first.health.error, /Simulated install failure/);
  assert.equal(first.storage[DEFAULTS_KEY], undefined);
  assert.equal(first.storage[MANAGER_KEY], undefined);
  assert.equal(first.styles.length, 1);
  const retry = await boot({styles: first.styles, storage: first.storage});
  assert.equal(retry.health.defaults.status, 'complete');
  assert.deepEqual(retry.imports.map(style => style.name), ['Gemini · 中文阅读']);
  assert.equal(retry.styles.length, 2);
  assert.equal(retry.storage[MANAGER_KEY].hosts['chatgpt.com'].fontStyleId, 1);
});

test('marker write failure can retry without duplicating either installed default', async () => {
  const first = await boot({failMarker: true});
  assert.equal(first.health.defaults.status, 'error');
  assert.equal(first.storage[DEFAULTS_KEY], undefined);
  assert.equal(first.styles.length, 2);
  const retry = await boot({styles: first.styles, storage: first.storage});
  assert.equal(retry.health.defaults.status, 'complete');
  assert.equal(retry.imports.length, 0);
});

test('bundle validation rejects cross-site or unexpected defaults before installing anything', async () => {
  for (const mutate of [
    styles => { styles[0].sections[0].domains = ['google.com']; },
    styles => { styles[0].sections[0].urlPrefixes = ['https://example.com']; },
    styles => { styles[0].usercssData.namespace = 'another-project'; },
    styles => { styles[0].name = 'Other theme'; },
    styles => { styles[1] = styles[0]; },
  ]) {
    const defaults = clone(bundle);
    mutate(defaults);
    const app = await boot({defaults});
    assert.equal(app.health.defaults.status, 'error');
    assert.equal(app.imports.length, 0);
    assert.equal(app.storage[DEFAULTS_KEY], undefined);
  }
});

test('seed never forwards exported IDs, exclusions or other profile state', async () => {
  const defaults = clone(bundle);
  Object.assign(defaults[0], {id: 900, _id: 'old-profile', enabled: false, exclusions: ['*://*/*'], inclusions: ['https://other.site/*']});
  const app = await boot({defaults});
  assert.equal(app.health.defaults.status, 'complete');
  assert.equal(app.imports[0].enabled, true);
  for (const key of ['id', '_id', 'exclusions', 'inclusions']) assert.equal(key in app.imports[0], false);
});

test('missing defaults reports an actionable bootstrap error without initializing empty hosts', async () => {
  const app = await boot({failFetch: true});
  assert.equal(app.health.version, '1.2.0');
  assert.equal(app.health.defaults.status, 'error');
  assert.match(app.health.defaults.error, /404/);
  assert.equal(app.storage[MANAGER_KEY], undefined);
});

test('maintainer export keeps only canonical compiled defaults and rejects saved font choices', () => {
  const style = clone(bundle[0]);
  const target = {name: 'ChatGPT · 中文阅读', host: 'chatgpt.com'};
  Object.assign(style, {id: 123, enabled: false, exclusions: ['*://*/*'], customName: 'Private choice'});
  const clean = cleanCompiledDefault(style, style.sourceCode, target);
  assert.equal(clean.enabled, true);
  assert.deepEqual(Object.keys(clean), ['name', 'enabled', 'sections', 'sourceCode', 'usercssData']);
  assert.deepEqual(clean.sections.map(section => section.domains), [['chatgpt.com']]);
  style.usercssData.vars['nr-font'].value = 'custom';
  assert.throws(() => cleanCompiledDefault(style, style.sourceCode, target), /已选择的字体参数/);
});

test('maintainer export rejects compiled scope or source mismatches', () => {
  const style = clone(bundle[0]);
  const target = {name: 'ChatGPT · 中文阅读', host: 'chatgpt.com'};
  assert.throws(() => cleanCompiledDefault(style, style.sourceCode + '\nbody {}', target), /网站范围/);
  style.sections[0].domains = ['google.com'];
  assert.throws(() => cleanCompiledDefault(style, style.sourceCode, target), /网站范围/);
});
