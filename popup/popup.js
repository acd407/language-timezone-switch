'use strict';

const api = globalThis.browser || globalThis.chrome;

const el = id => document.getElementById(id);

let currentTab = null;
let currentMatch = null;

function sendMessage(msg) {
  return new Promise(resolve => {
    try {
      api.runtime.sendMessage(msg, reply => {
        void api.runtime.lastError;
        resolve(reply || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function render(status) {
  if (!status) {
    el('state').textContent = '拿不到后台状态，请重试。';
    return;
  }

  const { prefs, match, domain, url } = status;
  const isHttp = Boolean(domain);

  el('domain').textContent = domain || '（非普通网页）';
  el('enabled').checked = prefs.enabled !== false;

  if (!prefs.enabled) {
    el('dot').className = 'dot';
    el('state').textContent = '总开关已关闭';
    el('state').className = 'state';
  } else if (match) {
    el('dot').className = 'dot on';
    el('state').textContent = '本站已切换';
    el('state').className = 'state on';
  } else {
    el('dot').className = 'dot';
    el('state').textContent = '本站保持原样';
    el('state').className = 'state';
  }

  const kv = el('kv');
  if (match) {
    kv.hidden = false;
    el('tz').textContent = match.timezone || '不改';
    el('lang').textContent = match.languages.length ? match.languages.join(', ') : '不改';
    el('rule').textContent = match.pattern;
  } else {
    kv.hidden = true;
    el('tz').textContent = prefs.timezone || '不改';
    el('lang').textContent = prefs.languages.length ? prefs.languages.join(', ') : '不改';
    el('rule').textContent = '—';
  }

  const toggle = el('toggle');
  toggle.disabled = !isHttp || !prefs.enabled;
  if (!prefs.enabled) toggle.textContent = '总开关已关闭';
  else toggle.textContent = match ? '停用本站点' : '启用本站点';

  currentMatch = match;
  currentTab = { id: status.tabId, url };
}

async function refresh() {
  let tab = null;
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {
    /* ignore */
  }
  if (!tab) {
    el('state').textContent = '没有活动标签页。';
    return;
  }

  const status = await sendMessage({ method: 'lts-status', url: tab.url });
  if (status) status.tabId = tab.id;
  render(status);
}

async function toggleSite() {
  if (!currentTab || !currentTab.url) return;

  el('toggle').disabled = true;
  const result = await sendMessage({
    method: 'lts-site-toggle',
    enabled: !currentMatch,
    url: currentTab.url
  });

  if (!result || !result.ok) {
    el('state').textContent = '操作失败：' + ((result && result.error) || '未知错误');
    el('toggle').disabled = false;
    return;
  }

  if (!result.changed) {
    // 站点没有被增删（已经处于目标状态，或者被一条更宽的规则盖住）
    el('toggle').disabled = false;
    el('state').textContent = result.covered
      ? '本站点由已有的规则「' + result.covered + '」控制，请到设置页修改'
      : '本站点状态没有变化';
    return;
  }

  // 站点列表变了，必须重新载入页面才能生效（document_start 注入）
  try {
    await api.tabs.reload(currentTab.id);
  } catch (e) {
    /* ignore */
  }
  window.close();
}

el('toggle').addEventListener('click', toggleSite);

el('reload').addEventListener('click', async () => {
  if (!currentTab) return;
  try {
    await api.tabs.reload(currentTab.id);
  } catch (e) {
    /* ignore */
  }
  window.close();
});

el('options').addEventListener('click', () => {
  api.runtime.openOptionsPage();
  window.close();
});

el('enabled').addEventListener('change', async e => {
  await api.storage.local.set({ enabled: e.target.checked });
  await sendMessage({ method: 'lts-rerun' });
  if (currentTab) {
    try {
      await api.tabs.reload(currentTab.id);
    } catch (err) {
      /* ignore */
    }
  }
  refresh();
});

refresh().catch(e => {
  el('state').textContent = '初始化失败：' + ((e && e.message) || e);
});
