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

async function applyContentScripts(prefs, sites) {
  const patterns = [];
  for (const site of sites) {
    if (site.pattern && patterns.indexOf(site.pattern) === -1) patterns.push(site.pattern);
  }

  try {
    await api.scripting.unregisterContentScripts({ ids: CS_IDS });
  } catch (e) {
    /* 没有已注册的脚本时会报错，忽略 */
  }

  if (!prefs.enabled || patterns.length === 0) {
    diagnostics.scripts = patterns.length === 0 ? '站点列表为空' : '总开关已关闭';
    return;
  }

  const base = {
    matches: patterns,
    allFrames: true,
    runAt: 'document_start'
  };

  // 顺序很重要：ISOLATED 先跑，把配置写进 DOM 端口，MAIN 再读取。
  // matchOriginAsFallback / persistAcrossSessions 在个别版本上可能不被接受，逐级降级重试。
  const variants = [
    Object.assign({ matchOriginAsFallback: true, persistAcrossSessions: true }, base),
    Object.assign({ matchOriginAsFallback: true }, base),
    Object.assign({}, base)
  ];

  let lastError = null;
  for (const variant of variants) {
    try {
      await api.scripting.registerContentScripts([
        Object.assign({ id: CS_ISOLATED, world: 'ISOLATED', js: ['inject/isolated.js'] }, variant),
        Object.assign({ id: CS_MAIN, world: 'MAIN', js: ['inject/main.js'] }, variant)
      ]);
      diagnostics.scripts = 'ok';
      return;
    } catch (e) {
      lastError = e;
      try {
        await api.scripting.unregisterContentScripts({ ids: CS_IDS });
      } catch (err) {
        /* ignore */
      }
    }
  }

  diagnostics.scripts = (lastError && lastError.message) || String(lastError);
  console.error('[LTS] 注册内容脚本失败', lastError);
}

/* --------------------------------------------------- Accept-Language 头 */

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
    for (const site of sites) {
      if (site.domains.length === 0) continue;
      const languages = site.languages.length ? site.languages : prefs.languages;
      if (languages.length === 0) continue;
      addRules.push({
        id: id++,
        priority: 1,
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
    }
  }

  try {
    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    diagnostics.headers = addRules.length ? 'ok' : '未生成规则';
  } catch (e) {
    diagnostics.headers = (e && e.message) || String(e);
    console.error('[LTS] 更新 DNR 规则失败', e);
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
    loadPrefs().then(prefs => {
      const hit = prefs.enabled ? ltsResolveSite(sitesCache, url, prefs) : null;
      sendResponse(hit ? { timezone: hit.timezone, languages: hit.languages } : null);
    });
    return true;
  }

  if (msg.method === 'lts-status') {
    loadPrefs().then(prefs => {
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
    });
    return true;
  }

  if (msg.method === 'lts-rerun') {
    apply().then(() => sendResponse(diagnostics));
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
      const sites = prefs.sites.slice();

      // 找出所有「能盖住这个 URL」的规则（启用时判断是否已有，停用时全部移除）
      const offenders = [];
      sites.forEach((line, index) => {
        const parsed = ltsParseSite(line);
        if (!parsed || !parsed.regex) return;
        parsed.regex.lastIndex = 0;
        if (parsed.regex.test(url)) offenders.push(index);
      });

      if (msg.enabled && offenders.length === 0) {
        sites.push(domain);
      } else if (!msg.enabled && offenders.length > 0) {
        for (const index of offenders.reverse()) sites.splice(index, 1);
      } else {
        // 状态已经是目标状态，什么都不用做
        sendResponse({ ok: true, changed: false, siteEnabled: Boolean(msg.enabled), domain });
        return;
      }

      await savePrefs({ sites });
      await apply();
      sendResponse({ ok: true, changed: true, siteEnabled: msg.enabled, domain });
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
