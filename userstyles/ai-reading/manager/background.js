/* NovelWeb Reading Manager. Runs inside the locally installed Stylus service worker. */
(() => {
  'use strict';

  const API = globalThis.API;
  if (!API?.styles) throw new Error('阅读样式管理器需要 Stylus 的后台 API。');

  const STORAGE_KEY = 'novelwebReadingManagerV1';
  const DEFAULTS_KEY = 'novelwebReadingDefaultsV1';
  const MANAGER_VERSION = '1.2.0';
  // The installer embeds the same source hash into both executable files.
  // Capture their executed constants, never a JSON file fetched after startup.
  const BACKGROUND_SOURCE_HASH = '__NOVELWEB_READING_SOURCE_HASH__';
  const WORKER_SOURCE_HASH = globalThis.novelwebReadingWorkerSourceHash;
  const DEFAULT_STYLES = new Map([
    ['ChatGPT · 中文阅读', 'chatgpt.com'],
    ['Gemini · 中文阅读', 'gemini.google.com'],
  ]);
  const DEFAULT_URLS = ['https://chatgpt.com/', 'https://gemini.google.com/'];
  const MANAGER_URL = chrome.runtime.getURL('manager/index.html');
  const ignoredSaves = new Map();
  let state = {version: 2, hosts: Object.create(null)};
  let queue = Promise.resolve();
  let hookPending = false;
  let pendingEvents = [];
  let lastError = null;
  let defaultsState = {status: 'pending', completed: [], error: null};

  const validId = value => Number.isSafeInteger(value) && value > 0;
  const uniqueIds = values => [...new Set((Array.isArray(values) ? values : []).filter(validId))];
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isReading = style => style?.usercssData?.namespace === 'novelweb-ai-reading';
  const identity = style => isReading(style) ? `novelweb-ai-reading::${style.name}` : null;
  const defaultIdentities = [...DEFAULT_STYLES.keys()].map(name => `novelweb-ai-reading::${name}`);

  async function seedDefaults() {
    try {
      const saved = (await chrome.storage.local.get(DEFAULTS_KEY))[DEFAULTS_KEY];
      if (saved != null && (saved.version !== 1 || !Array.isArray(saved.completed))) {
        throw new Error('默认阅读样式的初始化记录不兼容，未修改现有样式。');
      }
      const completed = new Set((saved?.completed || []).filter(id => defaultIdentities.includes(id)));
      defaultsState.completed = [...completed];
      // Remember identities independently of installed IDs: deleting a seeded
      // style is an explicit choice and must survive subsequent worker starts.
      if (!defaultIdentities.every(id => completed.has(id))) {
        const response = await fetch(chrome.runtime.getURL('manager/defaults.json'));
        if (!response.ok) throw new Error(`默认阅读样式读取失败（${response.status}）。`);
        const bundle = await response.json();
        if (!Array.isArray(bundle) || bundle.length !== DEFAULT_STYLES.size) {
          throw new Error('默认阅读样式包应仅包含 ChatGPT 和 Gemini 两份字体样式。');
        }
        const seen = new Set();
        for (const style of bundle) {
          const host = DEFAULT_STYLES.get(style?.name);
          const id = identity(style);
          if (!host || !id || seen.has(id) || style.usercssData.name !== style.name ||
              typeof style.sourceCode !== 'string' || !style.sourceCode.trim() ||
              !Array.isArray(style.sections) || !style.sections.length ||
              style.sections.some(section => typeof section.code !== 'string' ||
                !section.code.trim() || !equal(section.domains, [host]) ||
                ['urls', 'urlPrefixes', 'regexps'].some(key => section[key]?.length))) {
            throw new Error('默认阅读样式包包含不受支持的名称、命名空间或网站范围。');
          }
          seen.add(id);
        }
        const installed = new Set(API.styles.getAll().map(identity));
        const missing = bundle.filter(style => !completed.has(identity(style)) && !installed.has(identity(style)));
        if (missing.length) {
          // These bundled sections are already compiled. styles.install saves
          // them directly, without starting a UserCSS compiler during worker boot.
          // Never forward exported IDs or profile settings to the install API.
          for (const {name, sections, sourceCode, usercssData} of missing) {
            await API.styles.install(structuredClone({name, enabled: true, sections, sourceCode, usercssData}));
          }
        }
        const installedAfter = new Set(API.styles.getAll().map(identity));
        if (!defaultIdentities.every(id => completed.has(id) || installedAfter.has(id))) {
          throw new Error('默认阅读样式尚未全部安装；下次启动会重试缺少的样式。');
        }
        // Commit only after every style is accounted for. A failed batch may
        // still install some entries; the installed-identity check makes retry safe.
        await chrome.storage.local.set({[DEFAULTS_KEY]: {version: 1, completed: defaultIdentities}});
        defaultsState.completed = [...defaultIdentities];
      }
      defaultsState.status = 'complete';
    } catch (error) {
      defaultsState.status = 'error';
      defaultsState.error = error.message || String(error);
      throw error;
    }
  }

  function parseUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('请选择一个有效的网页 URL。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error('阅读样式只管理 http / https 网页。');
    }
    return {url: url.href, host: url.hostname};
  }

  // Exact hostname, including URLs using a nondefault port; never match sibling/subdomains.
  const hostRules = host => [`*://${host}/*`, `*://${host}:*/*`];

  function cleanHost(host, saved, version) {
    const rules = hostRules(host);
    const ownedExclusions = {};
    for (const [id, values] of Object.entries(saved?.ownedExclusions || {})) {
      if (!validId(Number(id))) continue;
      const kept = [...new Set((Array.isArray(values) ? values : []).filter(rule => rules.includes(rule)))];
      if (kept.length) ownedExclusions[id] = kept;
    }
    const mode = saved?.mode === 'stack' ? 'stack' : 'single';
    const previousIds = uniqueIds(saved?.selectedIds);
    // Separate the reading layer before enforcing theme single-selection: old
    // stacked selections can contain the reading style before their theme.
    const selectedIds = previousIds.filter(id => !isReading(API.styles.get(id)));
    const hostState = {
      mode,
      selectedIds: mode === 'single' ? selectedIds.slice(0, 1) : selectedIds,
      fontStyleId: version === 2 && validId(saved?.fontStyleId) && isReading(API.styles.get(saved.fontStyleId))
        ? saved.fontStyleId : null,
      ownedExclusions,
    };
    if (version === 1 && previousIds.length) {
      const ctx = parseUrl(`https://${host}/`);
      const eligible = candidates(ctx).filter(item => isReading(item.style) && matchesHere(item) &&
        !item.empty && !item.excludedScheme && item.style.enabled &&
        !userExcludesHere(item.style, ctx, hostState));
      // V1 accidentally excluded the font whenever a theme was selected. Restore
      // that layer once, while respecting global disables and original exclusions.
      const reading = eligible.find(item => previousIds.includes(item.style.id)) || eligible[0];
      hostState.fontStyleId = reading?.style.id ?? null;
    }
    return hostState;
  }

  const ready = Promise.resolve(globalThis._busy).then(async () => {
    if (!/^[a-f\d]{64}$/i.test(BACKGROUND_SOURCE_HASH) || BACKGROUND_SOURCE_HASH !== WORKER_SOURCE_HASH) {
      throw new Error('阅读样式后台与服务工作线程的已加载源码不一致，请关闭 Runner 后重新运行 START.bat。');
    }
    const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (saved != null && (![1, 2].includes(saved.version) || !saved.hosts || typeof saved.hosts !== 'object')) {
      throw new Error('阅读样式管理器的已保存数据格式不兼容，未修改现有样式。');
    }
    // Seed before creating host selections, so a fresh profile selects its font
    // immediately. Existing host choices and installed style settings are retained.
    await seedDefaults();
    for (const [host, hostState] of Object.entries(saved?.hosts || {})) {
      try {
        if (parseUrl(`https://${host}/`).host !== host) continue;
      } catch { continue; /* Never use invalid saved hostname keys as URL rules. */ }
      state.hosts[host] = cleanHost(host, hostState, saved.version);
    }
    // Persist the migration even if no exclusion needs changing. A subsequent
    // restart must not treat an explicitly disabled V2 font as a V1 regression.
    if (saved?.version === 1) await persist();
  });

  function enqueue(task) {
    const job = queue.then(() => ready).then(task);
    queue = job.catch(error => { lastError = error.message || String(error); });
    return job;
  }

  async function persist() {
    await chrome.storage.local.set({[STORAGE_KEY]: state});
  }

  async function context(value, tabId) {
    const result = parseUrl(value);
    if (tabId == null) return result;
    if (!validId(tabId)) throw new Error('来源标签页 ID 无效。');
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { throw new Error('来源标签页已经关闭，请从网页重新打开样式管理器。'); }
    if (parseUrl(tab.url).host !== result.host) {
      throw new Error('来源标签页已经切换网站，请从当前网页重新打开样式管理器。');
    }
    // SPA navigation changes paths/search parameters. The current tab is authoritative.
    return {...parseUrl(tab.url), tabId, tab};
  }

  function candidates(ctx) {
    return API.styles.getByUrl(ctx.url, undefined, ctx.tabId, true);
  }

  function matchesHere(candidate) {
    return Boolean(candidate && !candidate.incOvr && !candidate.sloppy);
  }

  function injection(ctx) {
    const sender = ctx.tabId == null ? {} : {
      tabId: ctx.tabId,
      frameId: 0,
      tab: {id: ctx.tabId, url: ctx.url},
    };
    return API.styles.getSectionsByUrl.call({sender}, ctx.url, {init: true});
  }

  function userExclusions(style, hostState) {
    const ownedRules = hostState.ownedExclusions[style.id] || [];
    return (style.exclusions || []).filter(rule => !ownedRules.includes(rule));
  }

  function userExcludesHere(style, ctx, hostState) {
    const exclusions = userExclusions(style, hostState);
    return Boolean(exclusions.length && API.styles.matchOverrides({exclusions}, ctx.url));
  }

  async function ensureHost(ctx) {
    if (own(state.hosts, ctx.host)) return state.hosts[ctx.host];
    const eligible = candidates(ctx).filter(item => matchesHere(item) && !item.empty &&
      !item.excluded && !item.excludedScheme && item.style.enabled);
    const reading = eligible.find(item => isReading(item.style));
    const selected = eligible.find(item => !isReading(item.style));
    const hostState = state.hosts[ctx.host] = {
      mode: 'single',
      selectedIds: selected ? [selected.style.id] : [],
      fontStyleId: reading?.style.id ?? null,
      ownedExclusions: {},
    };
    await persist();
    return hostState;
  }

  async function ownConfig(id, exclusions) {
    const token = {reason: 'config', exclusions};
    ignoredSaves.set(id, token);
    try { await API.styles.config(id, 'exclusions', exclusions.length ? exclusions : null); }
    finally { if (ignoredSaves.get(id) === token) ignoredSaves.delete(id); }
  }

  async function ownToggle(id, enabled) {
    const token = {reason: 'toggle', enabled};
    ignoredSaves.set(id, token);
    try { await API.styles.toggle(id, enabled); }
    finally { if (ignoredSaves.get(id) === token) ignoredSaves.delete(id); }
  }

  async function blockStyle(host, hostState, id) {
    const style = API.styles.get(id);
    if (!style) return;
    const exclusions = [...(style.exclusions || [])];
    const added = hostRules(host).filter(rule => !exclusions.includes(rule));
    if (!added.length) return;
    // Record ownership BEFORE adding rules, so a worker interruption cannot orphan our blocks.
    hostState.ownedExclusions[id] = [...new Set([...(hostState.ownedExclusions[id] || []), ...added])];
    await persist();
    await ownConfig(id, exclusions.concat(added));
  }

  async function unblockStyle(hostState, id) {
    const rules = hostState.ownedExclusions[id];
    if (!rules?.length) return;
    const style = API.styles.get(id);
    if (style) {
      const exclusions = (style.exclusions || []).filter(rule => !rules.includes(rule));
      if (!equal(exclusions, style.exclusions || [])) await ownConfig(id, exclusions);
    }
    // Remove ownership AFTER the rules, allowing an interrupted operation to resume safely.
    delete hostState.ownedExclusions[id];
    await persist();
  }

  async function clearUnselectedTabOverrides(host, selectedIds) {
    for (const tab of await chrome.tabs.query({})) {
      let ctx;
      try { ctx = {...parseUrl(tab.url), tabId: tab.id, tab}; } catch { continue; }
      if (ctx.host !== host) continue;
      const overrides = {};
      for (const candidate of candidates(ctx)) {
        if (candidate.tabOvr === true && !selectedIds.includes(candidate.style.id)) {
          overrides[candidate.style.id] = null;
        }
      }
      if (Object.keys(overrides).length) await API.styles.toggleTabOvrMany(tab.id, overrides);
    }
  }

  async function normalizeHost(host, hostState) {
    const styles = API.styles.getAll();
    const installed = new Set(styles.map(style => style.id));
    const selected = hostState.selectedIds.filter(id => installed.has(id) && !isReading(API.styles.get(id)));
    const themes = hostState.mode === 'single' ? selected.slice(0, 1) : selected;
    const fontStyleId = isReading(API.styles.get(hostState.fontStyleId)) ? hostState.fontStyleId : null;
    let changed = !equal(themes, hostState.selectedIds) || fontStyleId !== hostState.fontStyleId;
    hostState.selectedIds = themes;
    hostState.fontStyleId = fontStyleId;
    const desired = fontStyleId == null ? themes : [...themes, fontStyleId];
    for (const id of Object.keys(hostState.ownedExclusions)) {
      if (!installed.has(Number(id))) {
        delete hostState.ownedExclusions[id];
        changed = true;
      }
    }
    if (changed) await persist();
    // Blocking all unselected styles also covers path-only rules and later CSS scope changes.
    // These exact-host exclusions have no effect on any other website.
    for (const style of styles) {
      if (!desired.includes(style.id)) await blockStyle(host, hostState, style.id);
    }
    await clearUnselectedTabOverrides(host, desired);
    for (const id of desired) await unblockStyle(hostState, id);
  }

  async function normalizeAll(events = []) {
    let changed = false;
    // A native global disable remains a disable. Installing a new style never silently
    // replaces the current site's explicit selection, even when the new CSS is global.
    for (const event of events) {
      const style = API.styles.get(event.id);
      if (style && style.enabled) {
        // A native Stylus toggle is an explicit font choice too. Parameter saves
        // and newly installed styles must not silently reactivate a disabled font.
        if (isReading(style) && event.reason === 'toggle') {
          for (const [host, hostState] of Object.entries(state.hosts)) {
            const ctx = parseUrl(`https://${host}/`);
            const candidate = candidates(ctx).find(item => item.style.id === style.id);
            if (matchesHere(candidate) && !candidate.empty && !userExcludesHere(style, ctx, hostState) &&
                hostState.fontStyleId !== style.id) {
              hostState.fontStyleId = style.id;
              changed = true;
            }
          }
        }
        continue;
      }
      for (const hostState of Object.values(state.hosts)) {
        if (hostState.selectedIds.includes(event.id)) {
          hostState.selectedIds = hostState.selectedIds.filter(id => id !== event.id);
          changed = true;
        }
        if (hostState.fontStyleId === event.id) {
          hostState.fontStyleId = null;
          changed = true;
        }
      }
    }
    if (changed) await persist();
    for (const [host, hostState] of Object.entries(state.hosts)) await normalizeHost(host, hostState);
    lastError = null;
  }

  function scopesFor(style) {
    if (style.overridden && style.inclusions?.length) return [...style.inclusions];
    const scopes = new Set(style.inclusions || []);
    for (const section of style.sections || []) {
      const restricted = ['domains', 'urlPrefixes', 'urls', 'regexps'].some(key => section[key]?.length);
      if (!restricted && hasCode(section.code)) scopes.add('所有网站');
      for (const domain of section.domains || []) scopes.add(`域名：${domain}`);
      for (const prefix of section.urlPrefixes || []) scopes.add(`前缀：${prefix}`);
      for (const url of section.urls || []) scopes.add(url);
      for (const regexp of section.regexps || []) scopes.add(`正则：${regexp}`);
    }
    return [...scopes];
  }

  function hasCode(code) {
    return Boolean(String(code || '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
  }

  function riskFor(style, candidate) {
    const risk = [];
    for (const section of style.sections || []) {
      if (!hasCode(section.code)) continue;
      if (!['domains', 'urlPrefixes', 'urls', 'regexps'].some(key => section[key]?.length)) {
        risk.push(style.overridden && style.inclusions?.length ? '原始代码有全站规则，已由站点范围限制' : '包含全站规则');
      }
      if (section.domains?.includes('google.com')) risk.push('google.com 域名规则也包含 Gemini 子域名');
    }
    if (candidate?.sloppy) risk.push('正则表达式未准确匹配，Stylus 不会正常应用');
    if (candidate?.excludedScheme) risk.push('当前明暗主题不符合样式设置');
    if (candidate?.tabOvr === false) risk.push('当前标签页临时禁用');
    return [...new Set(risk)];
  }

  function makeSnapshot(ctx) {
    const hostState = state.hosts[ctx.host];
    const byId = new Map(candidates(ctx).map(item => [item.style.id, item]));
    const applied = injection(ctx);
    const activeIds = new Set((applied.sections || []).map(section => section.id));
    const styles = API.styles.getAll().map(style => {
      const candidate = byId.get(style.id);
      const matches = matchesHere(candidate);
      const managedBlocked = matches && (hostState.ownedExclusions[style.id] || [])
        .some(rule => (style.exclusions || []).includes(rule));
      return {
        id: style.id,
        name: style.customName || style.name || `样式 ${style.id}`,
        enabled: Boolean(style.enabled),
        reading: isReading(style),
        matches,
        active: activeIds.has(style.id),
        managedBlocked,
        // The UI must still let users choose a style blocked by this manager.
        // `excluded` describes original user rules; manager-owned blocks are separate.
        excluded: Boolean(candidate?.incOvr || userExcludesHere(style, ctx, hostState)),
        effectiveExcluded: Boolean(candidate?.excluded || candidate?.incOvr),
        empty: Boolean(candidate?.empty),
        scopes: scopesFor(style),
        risk: riskFor(style, candidate),
        usercss: Boolean(style.usercssData),
      };
    });
    return {
      url: ctx.url,
      host: ctx.host,
      tabId: ctx.tabId ?? null,
      mode: hostState.mode,
      selectedIds: [...hostState.selectedIds],
      fontStyleId: hostState.fontStyleId,
      styles,
      activeCount: styles.filter(style => style.active).length,
      fontActiveCount: styles.filter(style => style.active && style.reading).length,
      themeActiveCount: styles.filter(style => style.active && !style.reading).length,
      installedCount: styles.length,
      globalDisabled: Boolean(applied.cfg?.off),
      error: lastError,
    };
  }

  API.novelwebReading = {
    async getHealth() {
      await ready.catch(() => {});
      await queue;
      return {
        version: MANAGER_VERSION,
        sourceHash: BACKGROUND_SOURCE_HASH,
        loadedBuild: {backgroundHash: BACKGROUND_SOURCE_HASH, workerHash: WORKER_SOURCE_HASH || null},
        defaults: {
          ...defaultsState,
          completed: [...defaultsState.completed],
          installed: API.styles.getAll().filter(style => defaultIdentities.includes(identity(style)))
            .map(style => ({name: style.name, id: style.id})),
        },
        error: lastError,
      };
    },

    snapshot(url, tabId) {
      return enqueue(async () => {
        const ctx = await context(url, tabId);
        const hostState = await ensureHost(ctx);
        await normalizeHost(ctx.host, hostState);
        return makeSnapshot(ctx);
      });
    },

    setMode(url, mode, tabId) {
      return enqueue(async () => {
        if (!['single', 'stack'].includes(mode)) throw new Error('样式模式必须为 single 或 stack。');
        const ctx = await context(url, tabId);
        const hostState = await ensureHost(ctx);
        hostState.mode = mode;
        if (mode === 'single') hostState.selectedIds = hostState.selectedIds.slice(0, 1);
        // Entering stack mode preserves the current selection; it never enables all downloads.
        await persist();
        await normalizeHost(ctx.host, hostState);
        lastError = null;
        return makeSnapshot(ctx);
      });
    },

    setEnabled(url, id, enabled, tabId) {
      return enqueue(async () => {
        if (!validId(id) || typeof enabled !== 'boolean') throw new Error('样式 ID 或启用状态无效。');
        const ctx = await context(url, tabId);
        const hostState = await ensureHost(ctx);
        const style = API.styles.get(id);
        if (!style) throw new Error('该样式已经不在已安装列表中。');
        const candidate = candidates(ctx).find(item => item.style.id === id);
        if (enabled) {
          if (!matchesHere(candidate)) throw new Error('此样式不匹配当前网页，不能跨网站强制启用。');
          if (candidate.empty) throw new Error('此样式在当前网页没有可应用的 CSS。');
          if (candidate.excludedScheme) throw new Error('此样式只支持另一种明暗主题，请先在 Stylus 中调整该样式的主题限制。');
          if (userExcludesHere(style, ctx, hostState)) throw new Error('此网页被该样式原有的排除规则禁用，请先在 Stylus 中调整原规则。');
          if (injection(ctx).cfg?.off) throw new Error('Stylus 的总开关已停用所有样式，请先打开总开关。');
          if (isReading(style)) hostState.fontStyleId = id;
          else hostState.selectedIds = hostState.mode === 'single' ? [id] : uniqueIds([...hostState.selectedIds, id]);
        } else {
          if (isReading(style)) {
            if (hostState.fontStyleId === id) hostState.fontStyleId = null;
          } else hostState.selectedIds = hostState.selectedIds.filter(selected => selected !== id);
        }
        await persist();
        await normalizeHost(ctx.host, hostState);
        if (enabled) {
          if (!API.styles.get(id)?.enabled) await ownToggle(id, true);
          if (candidate.tabOvr === false && ctx.tabId != null) {
            await API.styles.toggleTabOvrMany(ctx.tabId, {[id]: null});
          }
        }
        lastError = null;
        const snapshot = makeSnapshot(ctx);
        if (enabled && !snapshot.styles.find(item => item.id === id)?.active) {
          throw new Error('设置已保存，但 Stylus 未向当前网页应用该样式，请刷新管理页检查站点或临时排除规则。');
        }
        return snapshot;
      });
    },

    async open(url) {
      await ready;
      let tab;
      // Read the sender's current tab, never its cached content-script URL (SPA navigation).
      if (this?.sender?.tab?.id != null) {
        try { tab = await chrome.tabs.get(this.sender.tab.id); } catch { /* Surface a useful error below. */ }
      }
      if (url == null) {
        if (!tab) tab = (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0];
        url = tab?.url;
      }
      const ctx = parseUrl(url);
      if (tab) {
        try { if (parseUrl(tab.url).host !== ctx.host) tab = undefined; }
        catch { tab = undefined; }
      }
      if (!tab) tab = (await chrome.tabs.query({})).find(item => item.url === ctx.url);
      const manager = new URL(MANAGER_URL);
      manager.searchParams.set('url', ctx.url);
      if (tab?.id != null) manager.searchParams.set('tabId', String(tab.id));
      const existing = (await chrome.tabs.query({})).find(item => item.url?.split('?', 1)[0] === MANAGER_URL);
      const opened = existing
        ? await chrome.tabs.update(existing.id, {url: manager.href, active: true})
        : await chrome.tabs.create({url: manager.href, active: true});
      return {tabId: opened.id, url: manager.href};
    },
  };

  globalThis.novelwebReadingOnSaved = (style, reason) => {
    if (!validId(style?.id)) return;
    const ignored = ignoredSaves.get(style.id);
    if (ignored && reason === ignored.reason &&
        (reason === 'config' ? equal(style.exclusions || [], ignored.exclusions) : style.enabled === ignored.enabled)) return;
    pendingEvents.push({id: style.id, reason});
    if (hookPending) return;
    hookPending = true;
    queueMicrotask(() => {
      enqueue(async () => {
        const events = pendingEvents;
        pendingEvents = [];
        hookPending = false;
        await normalizeAll(events);
      }).catch(error => console.error('[NovelWeb reading manager]', error));
    });
  };

  // Native per-tab force-enable otherwise bypasses exclusions. Normalize it too.
  const originalTabOverride = API.styles.toggleTabOvrMany;
  API.styles.toggleTabOvrMany = function (tabId, overrides) {
    const result = originalTabOverride.call(this, tabId, overrides);
    if (Object.values(overrides || {}).some(value => value === true)) {
      Promise.resolve(result).then(() => {
        enqueue(() => normalizeAll()).catch(error => console.error('[NovelWeb reading manager]', error));
      });
    }
    return result;
  };

  enqueue(async () => {
    for (const url of DEFAULT_URLS) await ensureHost(parseUrl(url));
    await normalizeAll();
  }).catch(error => console.error('[NovelWeb reading manager startup]', error));
})();
