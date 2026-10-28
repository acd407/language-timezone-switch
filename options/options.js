'use strict';

const api = globalThis.browser || globalThis.chrome;

const el = id => document.getElementById(id);
const tzInput = el('timezone');
const langInput = el('languages');
const sitesInput = el('sites');
const enabledInput = el('enabled');
const rewriteInput = el('rewriteHeader');
const statusEl = el('status');
const diagEl = el('diagnostics');

let saving = false;

/* ------------------------------------------------------------------ 读写 */

async function readPrefs() {
  const stored = await api.storage.local.get(null);
  const prefs = Object.assign({}, LTS_DEFAULTS, stored);
  prefs.languages = ltsParseLanguages(prefs.languages);
  prefs.sites = Array.isArray(prefs.sites) ? prefs.sites : [];
  return prefs;
}

function siteLines() {
  return sitesInput.value.split('\n').map(line => line.trim()).filter(Boolean);
}

function currentForm() {
  return {
    enabled: enabledInput.checked,
    timezone: tzInput.value.trim(),
    languages: ltsParseLanguages(langInput.value),
    sites: siteLines(),
    rewriteHeader: rewriteInput.checked
  };
}

async function save(reason) {
  if (saving) return;
  const form = currentForm();

  if (form.timezone && !ltsIsTimezone(form.timezone)) {
    setStatus('时区无效：' + form.timezone, 'bad');
    tzInput.focus();
    return;
  }

  saving = true;
  setStatus('保存中…');

  try {
    await api.storage.local.set(form);
    const diagnostics = await sendMessage({ method: 'lts-rerun' });
    renderDiagnostics(diagnostics);
    setStatus(reason || '已保存，配置已应用', 'good');
  } catch (e) {
    setStatus('保存失败：' + ((e && e.message) || e), 'bad');
  } finally {
    saving = false;
  }
}

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

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind || '';
}

/* ------------------------------------------------------------------ 渲染 */

function fillTimezones() {
  const list = el('tz-list');
  const fragment = document.createDocumentFragment();
  for (const tz of ltsTimezones()) {
    const option = document.createElement('option');
    option.value = tz;
    fragment.appendChild(option);
  }
  list.appendChild(fragment);
}

function renderTimezonePreview() {
  const tz = tzInput.value.trim();
  const preview = el('tz-preview');

  if (!tz) {
    preview.textContent = '留空表示不改页面时区。';
    preview.className = 'hint';
    return;
  }
  if (!ltsIsTimezone(tz)) {
    preview.textContent = '无法识别的时区名。';
    preview.className = 'hint bad';
    return;
  }

  const now = new Date();
  const minutes = ltsTimezoneOffsetMinutes(tz, now);
  const name = ltsTimezoneName(tz, now);
  const sample = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz, dateStyle: 'medium', timeStyle: 'medium'
  }).format(now);

  preview.textContent = '当前 ' + ltsFormatOffset(minutes) + (name ? '（' + name + '）' : '') + '，例如：' + sample;
  preview.className = 'hint good';
}

function renderLanguagesPreview() {
  const languages = ltsParseLanguages(langInput.value);
  const preview = el('lang-preview');

  if (languages.length === 0) {
    const typed = langInput.value.trim();
    preview.textContent = typed
      ? '这些语言标签都不合法（应当是 ja-JP、en 这样的形式）。'
      : '留空表示不改页面语言。';
    preview.className = typed ? 'hint bad' : 'hint';
    return;
  }

  preview.textContent = 'navigator.language = ' + languages[0] +
    ' · Accept-Language: ' + ltsToAcceptLanguage(languages);
  preview.className = 'hint good';
}

function renderSitesPreview() {
  const list = el('sites-preview');
  list.textContent = '';

  const prefs = currentForm();
  const sites = ltsCompileSites(prefs.sites);

  if (sites.length === 0) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = '还没有配置站点，扩展目前不会改变任何页面。';
    list.appendChild(li);
    return;
  }

  for (const site of sites) {
    const li = document.createElement('li');

    const pattern = document.createElement('span');
    pattern.className = 'pat';
    pattern.textContent = site.pattern;
    li.appendChild(pattern);

    const timezone = site.timezone || prefs.timezone;
    const languages = site.languages.length ? site.languages : prefs.languages;

    if (timezone) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '🕒 ' + timezone;
      li.appendChild(tag);
    }
    if (languages.length) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '🌐 ' + languages.join(',');
      li.appendChild(tag);
    }
    if (site.overridden) {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = '（本行覆盖默认值）';
      li.appendChild(note);
    }
    for (const error of site.errors) {
      const note = document.createElement('span');
      note.className = 'note bad';
      note.textContent = '⚠ ' + error;
      li.appendChild(note);
    }

    list.appendChild(li);
  }
}

function renderEnabledLabel() {
  el('enabled-label').textContent = enabledInput.checked ? '已启用' : '已停用';
}

function renderDiagnostics(diagnostics) {
  if (!diagnostics) {
    diagEl.textContent = '拿不到后台状态（后台可能刚被回收，稍后重试）。';
    return;
  }
  const scripts = diagnostics.scripts === 'ok' ? '✅ 已注册' : '⚠ ' + diagnostics.scripts;
  const headers = diagnostics.headers === 'ok' ? '✅ 已生效' : '⚠ ' + diagnostics.headers;
  const when = diagnostics.appliedAt ? new Date(diagnostics.appliedAt).toLocaleString() : '—';

  diagEl.textContent =
    '页面注入：' + scripts + '\n' +
    'Accept-Language 改写：' + headers + '\n' +
    '最近应用：' + when;
}

async function renderPermission() {
  const result = await sendMessage({ method: 'lts-permission-check' });
  if (!result || result.granted) return;

  const box = document.createElement('p');
  box.className = 'hint bad';
  box.textContent = '⚠ 扩展还没有「访问所有网站」的权限，内容脚本无法注入。';

  const button = document.createElement('button');
  button.textContent = '授予权限';
  button.style.marginTop = '8px';
  button.addEventListener('click', async () => {
    try {
      const granted = await api.permissions.request({ origins: ['<all_urls>'] });
      if (granted) {
        button.remove();
        box.className = 'hint good';
        box.textContent = '已授予权限，刷新目标网站即可生效。';
      }
    } catch (e) {
      setStatus('授权失败：' + ((e && e.message) || e), 'bad');
    }
  });

  diagEl.parentNode.appendChild(box);
  diagEl.parentNode.appendChild(button);
}

/* ---------------------------------------------------------------- 初始化 */

async function init() {
  fillTimezones();

  const prefs = await readPrefs();
  enabledInput.checked = prefs.enabled !== false;
  rewriteInput.checked = prefs.rewriteHeader !== false;
  tzInput.value = prefs.timezone || '';
  langInput.value = prefs.languages.join(', ');
  sitesInput.value = prefs.sites.join('\n');

  renderEnabledLabel();
  renderTimezonePreview();
  renderLanguagesPreview();
  renderSitesPreview();

  const status = await sendMessage({ method: 'lts-status' });
  if (status) renderDiagnostics(status.diagnostics);
  renderPermission();
}

/* ------------------------------------------------------------------ 事件 */

enabledInput.addEventListener('change', () => {
  renderEnabledLabel();
  save(enabledInput.checked ? '已启用' : '已停用');
});

rewriteInput.addEventListener('change', () => save());

tzInput.addEventListener('input', renderTimezonePreview);
langInput.addEventListener('input', renderLanguagesPreview);
sitesInput.addEventListener('input', renderSitesPreview);

el('save').addEventListener('click', () => save());

el('reset').addEventListener('click', async e => {
  if (e.detail === 1 && !confirmReset.armed) {
    confirmReset.arm();
    return;
  }
  await api.storage.local.clear();
  await init();
  await save('已恢复默认');
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

/* 恢复默认需要点两次，避免误触 */
const confirmReset = {
  armed: false,
  timer: 0,
  arm() {
    this.armed = true;
    setStatus('再次点击「恢复默认」确认清空所有设置');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.armed = false;
      setStatus('');
    }, 4000);
  }
};

init().catch(e => setStatus('初始化失败：' + ((e && e.message) || e), 'bad'));
