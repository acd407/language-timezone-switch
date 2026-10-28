/*
 * 后台：读取配置 → 注册内容脚本（按站点）→ 注册 Accept-Language 改写规则 → 维护徽标。
 *
 * 浏览器差异处理：
 *   Chrome  → background.service_worker（经典 SW，用 importScripts 引入 common.js）
 *   Firefox → background.scripts（同一个全局作用域，common.js 先加载）
 */
'use strict';

if (typeof importScripts === 'function') {
  try {
    importScripts('common.js');
  } catch (e) {
    console.error('[LTS] importScripts(common.js) 失败', e);
  }
}

const api = globalThis.browser || globalThis.chrome;

const CS_ISOLATED = 'lts-isolated';
const CS_MAIN = 'lts-main';
const CS_IDS = [CS_ISOLATED, CS_MAIN];

/* DNR 里能安全使用的资源类型（不含 webtransport / webbundle，老版本 Firefox 没有） */
const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'
];

/* ------------------------------------------------------------------ 状态 */

let prefsCache = null;
let sitesCache = [];
let diagnostics = { scripts: '', headers: '', appliedAt: 0 };
let applyTimer = null;

/* diagnostics 是模块级变量，service worker 被回收后重启就归零了，
   设置页只能看到一条空的 ⚠。放到 storage.session 里活到浏览器关闭为止。 */
const DIAG_KEY = 'ltsDiagnostics';

async function persistDiagnostics() {
  try {
    if (api.storage.session) await api.storage.session.set({ [DIAG_KEY]: diagnostics });
  } catch (e) {
    /* 老版本没有 storage.session，保持内存态 */
  }
}

async function restoreDiagnostics() {
  try {
    if (!api.storage.session) return;
    const stored = await api.storage.session.get(DIAG_KEY);
    const saved = stored && stored[DIAG_KEY];
    if (saved && typeof saved === 'object') diagnostics = Object.assign({}, diagnostics, saved);
  } catch (e) {
    /* ignore */
  }
}

async function loadPrefs(force) {
  if (prefsCache && !force) return prefsCache;
  const stored = await api.storage.local.get(null);
  const prefs = Object.assign({}, LTS_DEFAULTS, stored);
  prefs.languages = ltsParseLanguages(prefs.languages);
  prefs.sites = Array.isArray(prefs.sites) ? prefs.sites.filter(s => typeof s === 'string') : [];
  prefsCache = prefs;
  sitesCache = ltsCompileSites(prefs.sites);
  return prefs;
}

async function savePrefs(patch) {
  await api.storage.local.set(patch);
  return loadPrefs(true);
}

/* --------------------------------------------------------- 内容脚本注册 */

/* 我们注册的内容脚本 id 前缀（旧版本用的是 lts-isolated / lts-main，也算在内） */
const CS_PREFIX = 'lts-';

async function unregisterOne(id) {
  try {
    await api.scripting.unregisterContentScripts({ ids: [id] });
    return true;
  } catch (e) {
    return false;
  }
}

/** 清掉上一轮注册的脚本（含旧版单条注册的 id） */
async function clearContentScripts() {
  let ids = [];
  try {
    const existing = await api.scripting.getRegisteredContentScripts();
    ids = (existing || []).map(s => s.id).filter(id => String(id).indexOf(CS_PREFIX) === 0);
  } catch (e) {
    // 没有 getRegisteredContentScripts 时退回按已知 id 删
    ids = CS_IDS.slice();
  }
  // 逐条删：Chrome 的 unregisterContentScripts 只要有一个 id 不存在就整批抛错
  for (const id of ids) await unregisterOne(id);
}

/**
 * 按站点逐个注册内容脚本。
 *
 * 之前是把所有 pattern 塞进一次 registerContentScripts：matches 里只要有一条非法
 * （例如用户写了 ws://example.com、http://user:pass@host、IPv6 字面量），整批注册全部失败，
 * 结果是「一个站点都没注入」，而 Accept-Language 规则却照旧生效。
 * 现在一条坏 pattern 只影响它自己，并写进诊断信息里。
 */
async function applyContentScripts(prefs, sites) {
  await clearContentScripts();

  if (!prefs.enabled) {
    diagnostics.scripts = '总开关已关闭';
    return;
  }
  if (!sites.length) {
    diagnostics.scripts = '站点列表为空';
    return;
  }

  // 同一个 pattern 只能注册一次：多个 id 同时命中同一页面会让 main.js 在同一个 world 里跑两遍
  const patterns = [];
  for (const site of sites) {
    if (site.pattern && patterns.indexOf(site.pattern) === -1) patterns.push(site.pattern);
  }

  const failures = [];
  let registered = 0;
  let variantIndex = 0;

  if (patterns.length === 0) {
    diagnostics.scripts = '站点列表里没有可用的站点（请检查格式）';
    return;
  }

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    const ids = [CS_PREFIX + i + '-isolated', CS_PREFIX + i + '-main'];
    let done = false;

    for (let v = variantIndex; v < CS_VARIANTS.length && !done; v++) {
      const base = Object.assign({ matches: [pattern] }, CS_VARIANTS[v]);
      try {
        await api.scripting.registerContentScripts([
          Object.assign({ id: ids[0], world: 'ISOLATED', js: ['inject/isolated.js'] }, base),
          Object.assign({ id: ids[1], world: 'MAIN', js: ['inject/main.js'] }, base)
        ]);
        done = true;
        variantIndex = v; // 这个选项组合可用，后面的站点直接用它
        registered += 1;
      } catch (e) {
        await unregisterOne(ids[0]);
        await unregisterOne(ids[1]);
        if (v === CS_VARIANTS.length - 1) {
          failures.push(pattern + '：' + ((e && e.message) || String(e)));
        }
      }
    }
  }

  if (failures.length === 0) {
    diagnostics.scripts = 'ok';
  } else {
    diagnostics.scripts =
      '已注册 ' + registered + ' 个站点，' + failures.length + ' 个失败（' + failures[0] + '）';
  }
  if (failures.length) console.error('[LTS] 内容脚本注册失败', failures);
}

/* registerContentScripts 的选项降级链：
   matchOriginAsFallback / persistAcrossSessions 在个别版本上可能不被接受，逐级退让。 */
const CS_VARIANTS = [
  { allFrames: true, runAt: 'document_start', matchOriginAsFallback: true, persistAcrossSessions: true },
  { allFrames: true, runAt: 'document_start', matchOriginAsFallback: true },
  { allFrames: true, runAt: 'document_start' }
];

/* --------------------------------------------------- Accept-Language 头 */

/**
 * 写 DNR 动态规则。
 * 整体 updateDynamicRules 失败时（一条规则不合法就会导致整批失败）退回逐条写，
 * 尽量保住其它站点的改写，而不是把全部规则一起清空。
 */
async function commitRules(removeRuleIds, addRules) {
  const dnr = api.declarativeNetRequest;
  try {
    await dnr.updateDynamicRules({ removeRuleIds, addRules });
    return { added: addRules.length, failed: [] };
  } catch (error) {
    try {
      await dnr.updateDynamicRules({ removeRuleIds, addRules: [] });
    } catch (e) {
      /* ignore */
    }
    const failed = [];
    let added = 0;
    for (const rule of addRules) {
      try {
        await dnr.updateDynamicRules({ addRules: [rule] });
        added += 1;
      } catch (e) {
        failed.push(rule.condition.requestDomains.join(','));
      }
    }
    return { added, failed, error };
  }
}

async function applyHeaderRules(prefs, sites) {
  if (!api.declarativeNetRequest) {
    diagnostics.headers = '当前浏览器不支持 declarativeNetRequest';
    return;
  }

  let removeRuleIds = [];
  try {
    const existing = await api.declarativeNetRequest.getDynamicRules();
    removeRuleIds = existing.map(r => r.id);
  } catch (e) {
    /* ignore */
  }

  const addRules = [];
  let id = 1;

  if (prefs.enabled && prefs.rewriteHeader) {
    const usedDomainSets = Object.create(null);
    const total = sites.length;

    sites.forEach((site, index) => {
      if (site.domains.length === 0) return;
      const languages = site.languages.length ? site.languages : prefs.languages;
      if (languages.length === 0) return;

      // 同一组域名只保留第一条（否则两条规则会互相覆盖，谁生效取决于引擎实现）
      const key = site.domains.join(',');
      if (usedDomainSets[key]) return;
      usedDomainSets[key] = true;

      addRules.push({
        id: id++,
        // 列表顺序即优先级：靠前的行优先级更高，和 ltsResolveSite「先命中先用」一致。
        // 之前所有规则都是 priority: 1，`example.com` 和 `sub.example.com` 同时命中时结果未定义。
        priority: Math.max(1, total - index),
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'accept-language',
            operation: 'set',
            value: ltsToAcceptLanguage(languages)
          }]
        },
        condition: {
          requestDomains: site.domains,
          // 注意：不写 resourceTypes 时 DNR 默认不匹配 main_frame，必须显式列出
          resourceTypes: RESOURCE_TYPES
        }
      });
    });
  }

  const result = await commitRules(removeRuleIds, addRules);
  if (result.failed.length) {
    diagnostics.headers =
      '已生效 ' + result.added + ' 条，' + result.failed.length + ' 条被拒绝（' +
      result.failed[0] + '）';
    console.error('[LTS] 部分 DNR 规则未生效', result.failed, result.error);
  } else {
    diagnostics.headers = result.added ? 'ok' : '未生成规则';
  }
}

/* -------------------------------------------------------------- 徽标/广播 */

function updateBadge(tabId, url) {
  const prefs = prefsCache;
  if (!prefs) return;
  const hit = prefs.enabled ? ltsResolveSite(sitesCache, url, prefs) : null;

  const text = hit ? 'ON' : '';
  try {
    api.action.setBadgeText({ tabId, text });
    api.action.setTitle({
      tabId,
      title: hit
        ? '已切换：' + (hit.timezone || '（不改时区）') + ' / ' +
          (hit.languages.length ? hit.languages.join(',') : '（不改语言）')
        : 'Language & Timezone Switch（本站未启用）'
    });
  } catch (e) {
    /* ignore */
  }
}

async function refreshBadges() {
  await loadPrefs();
  updateBadgeColors();
  let tabs = [];
  try {
    tabs = await api.tabs.query({});
  } catch (e) {
    return;
  }
  for (const tab of tabs) updateBadge(tab.id, tab.url);
}

let colorsSet = false;
function updateBadgeColors() {
  if (colorsSet) return;
  colorsSet = true;
  try {
    api.action.setBadgeBackgroundColor({ color: '#1f6feb' });
  } catch (e) {
    /* ignore */
  }
}

/** 配置变化后，把新值推送给已经打开的页面，无需刷新即可生效 */
async function broadcast(prefs, sites) {
  let tabs = [];
  try {
    tabs = await api.tabs.query({});
  } catch (e) {
    return;
  }
  for (const tab of tabs) {
    if (!tab.url) continue;
    const hit = prefs.enabled ? ltsResolveSite(sites, tab.url, prefs) : null;
    if (!hit) continue;
    try {
      await api.tabs.sendMessage(tab.id, {
        method: 'lts-prefs',
        prefs: { timezone: hit.timezone, languages: hit.languages }
      });
    } catch (e) {
      /* 页面里还没有监听者，忽略 */
    }
  }
}

/* -------------------------------------------------------------- 应用全部 */

/* 串行执行：storage.onChanged 与 popup 的 lts-rerun 可能同时触发，
   并发 unregister/register 会把内容脚本注册搅乱 */
let applyChain = Promise.resolve();

function apply() {
  applyChain = applyChain.then(() => applyNow()).catch(e => {
    console.error('[LTS] apply 失败', e);
    return diagnostics;
  });
  return applyChain;
}

async function applyNow() {
  const prefs = await loadPrefs(true);
  const sites = sitesCache;
  await applyContentScripts(prefs, sites);
  await applyHeaderRules(prefs, sites);
  diagnostics.appliedAt = Date.now();
  await persistDiagnostics();
  await refreshBadges();
  await broadcast(prefs, sites);
  return diagnostics;
}

function scheduleApply() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    apply().catch(e => console.error('[LTS] apply 失败', e));
  }, 120);
}

/* ------------------------------------------------------------ 首次初始化 */

async function seedIfNeeded() {
  const stored = await api.storage.local.get(null);
  if (Object.keys(stored).length !== 0) return;
  // 首次安装：用当前浏览器状态作为初始值，站点列表留空
  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (e) {
    /* ignore */
  }
  const languages = ltsParseLanguages(Array.from(navigator.languages || [navigator.language || 'en-US']));
  await api.storage.local.set({ timezone, languages, sites: [], enabled: true, rewriteHeader: true });
}

/* ------------------------------------------------------------------ 事件 */

api.runtime.onInstalled.addListener(() => {
  seedIfNeeded()
    .then(() => apply())
    .catch(e => console.error('[LTS] onInstalled 失败', e));
});

api.runtime.onStartup.addListener(() => {
  loadPrefs(true).then(() => apply()).catch(e => console.error('[LTS] onStartup 失败', e));
});

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  prefsCache = null;
  scheduleApply();
});

/* 导航提交时把配置同步塞进内容脚本，尽量抢在页面第一段脚本之前。
   注意：这一步无法 100% 保证（配置来自异步存储），漏掉时 isolated.js 会补一次，
   期间页面若已经读过 Date/navigator 就只能拿到原生值 —— 见 README「已知限制」。 */
const preseed = (details, prefs) => {
  const hit = ltsResolveSite(sitesCache, details.url, prefs);
  if (!hit) return;
  // 不要在这里 await 任何东西：executeScript 越早派发越好
  try {
    Promise.resolve(api.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      world: 'ISOLATED',
      injectImmediately: true,
      func: p => { self.ltsPrefs = p; },
      args: [{ timezone: hit.timezone, languages: hit.languages }]
    })).catch(() => {});
  } catch (e) {
    /* ignore */
  }
};

api.webNavigation.onCommitted.addListener(details => {
  if (details.frameId === 0) updateBadge(details.tabId, details.url);

  if (!prefsCache) {
    loadPrefs()
      .then(prefs => {
        if (prefs.enabled) preseed(details, prefs);
      })
      .catch(() => {});
    return;
  }

  if (!prefsCache.enabled) return;
  preseed(details, prefsCache);
});

api.tabs.onActivated.addListener(info => {
  Promise.resolve(api.tabs.get(info.tabId))
    .then(tab => {
      if (tab) updateBadge(tab.id, tab.url);
    })
    .catch(() => {});
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') updateBadge(tabId, tab.url);
});

api.tabs.onRemoved.addListener(tabId => {
  try {
    api.action.setBadgeText({ tabId, text: '' });
  } catch (e) {
    /* ignore */
  }
});

/* ------------------------------------------------------------ 消息接口 */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.method) return;

  if (msg.method === 'lts-prefs') {
    // 内容脚本的兜底查询：按该 frame 的 URL 解析
    const url = msg.url || sender.url;
    loadPrefs()
      .then(prefs => {
        const hit = prefs.enabled ? ltsResolveSite(sitesCache, url, prefs) : null;
        sendResponse(hit ? { timezone: hit.timezone, languages: hit.languages } : null);
      })
      // 没这个 catch 的话 sendResponse 永不调用，内容脚本会一直等一个不会来的配置
      .catch(e => {
        console.error('[LTS] lts-prefs 失败', e);
        sendResponse(null);
      });
    return true;
  }

  if (msg.method === 'lts-status') {
    (async () => {
      // worker 被回收过的话 diagnostics 是空的，从 session 存储里找回来
      if (!diagnostics.appliedAt) await restoreDiagnostics();
      const prefs = await loadPrefs();
      const url = msg.url || (sender.tab && sender.tab.url) || '';
      const hit = prefs.enabled ? ltsResolveSite(sitesCache, url, prefs) : null;
      sendResponse({
        prefs,
        url,
        match: hit ? {
          pattern: hit.site.pattern,
          raw: hit.site.raw,
          timezone: hit.timezone,
          languages: hit.languages,
          overridden: hit.overridden
        } : null,
        diagnostics,
        domain: ltsDomainOf(url)
      });
    })().catch(e => sendResponse({ error: (e && e.message) || String(e), domain: '' }));
    return true;
  }

  if (msg.method === 'lts-rerun') {
    apply()
      .then(diag => sendResponse(diag))
      .catch(e => sendResponse(Object.assign({}, diagnostics, { error: (e && e.message) || String(e) })));
    return true;
  }

  if (msg.method === 'lts-site-toggle') {
    (async () => {
      const prefs = await loadPrefs(true);
      const url = msg.url || (sender.tab && sender.tab.url) || '';
      const domain = ltsDomainOf(url);
      if (!domain) {
        sendResponse({ ok: false, error: '当前页面不是 http(s) 站点' });
        return;
      }

      // 只动「正好是本站点」的规则。
      // 以前是把所有能盖住这个 URL 的行全部删掉，于是在 example.com/shop 上点一下「停用本站点」
      // 会连带删掉 example.com 甚至 * 那一行，而且不可撤销。
      const target = ltsToMatchPattern(domain);
      const owned = [];
      const covering = [];
      prefs.sites.forEach((line, index) => {
        const parsed = ltsParseSite(line);
        if (!parsed || !parsed.regex) return;
        parsed.regex.lastIndex = 0;
        if (!parsed.regex.test(url)) return;
        if (parsed.pattern === target || (parsed.domains.length === 1 && parsed.domains[0] === domain)) {
          owned.push(index);
        } else {
          covering.push(parsed.raw);
        }
      });

      const sites = prefs.sites.slice();
      if (msg.enabled) {
        if (owned.length === 0 && covering.length === 0) {
          sites.push(domain);
        } else {
          // 已经有规则盖住这个站点了（可能是更宽的一条），不改列表
          const enabled = owned.length > 0 || covering.length > 0;
          sendResponse({
            ok: true, changed: false, siteEnabled: enabled, domain,
            covered: covering.length ? covering[0] : ''
          });
          return;
        }
      } else if (owned.length > 0) {
        for (const index of owned.reverse()) sites.splice(index, 1);
      } else {
        sendResponse({
          ok: true, changed: false, siteEnabled: false, domain,
          covered: covering.length ? covering[0] : ''
        });
        return;
      }

      await savePrefs({ sites });
      await apply();
      sendResponse({ ok: true, changed: true, siteEnabled: Boolean(msg.enabled), domain });
    })().catch(e => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }

  if (msg.method === 'lts-permission-check') {
    Promise.resolve(api.permissions.contains({ origins: ['<all_urls>'] }))
      .then(granted => sendResponse({ granted }))
      .catch(() => sendResponse({ granted: true }));
    return true;
  }
});

/* worker 每次唤醒都保证状态一致 */
updateBadgeColors();
loadPrefs(true).catch(() => {});
