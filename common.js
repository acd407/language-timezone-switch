/*
 * 共享工具库：background / options / popup 都会加载。
 * 这里不能出现任何浏览器 API 调用，方便在普通页面与 worker 中复用。
 */
'use strict';

/* ---------------------------------------------------------------- 默认值 */

const LTS_DEFAULTS = {
  enabled: true,
  timezone: '',
  languages: [],
  sites: [],
  rewriteHeader: true
};

/* 站点列表里允许的 URL scheme */
const LTS_SCHEMES = ['*', 'http', 'https', 'file', 'ftp', 'ws', 'wss'];

/* ------------------------------------------------------------------ 语言 */

const LTS_LANG_RE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

/** "ja-JP, ja" / ['ja-JP','ja'] → ['ja-JP','ja']，非法项被丢弃 */
function ltsParseLanguages(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[,;\s]+/);
  const out = [];
  for (let item of raw) {
    item = String(item == null ? '' : item).trim();
    if (!item || !LTS_LANG_RE.test(item)) continue;
    if (out.some(x => x.toLowerCase() === item.toLowerCase())) continue;
    out.push(item);
  }
  return out;
}

/** 语言标签 → Accept-Language 头（自动生成 q 值） */
function ltsToAcceptLanguage(languages) {
  const list = ltsParseLanguages(languages);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  const digits = list.length > 10 ? 2 : 1;
  return list
    .map((lang, i) => {
      if (i === 0) return lang;
      const q = (list.length - i) / list.length;
      return lang + ';q=' + q.toFixed(digits);
    })
    .join(',');
}

/* ------------------------------------------------------------------ 时区 */

function ltsIsTimezone(tz) {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

/** 指定时区在某一时刻相对 UTC 的偏移（分钟，东为正；自动处理夏令时） */
function ltsTimezoneOffsetMinutes(timezone, date) {
  const d = date || new Date();
  try {
    const s = d.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
    const m = /GMT([+-])(\d{1,2}):(\d{2})/.exec(s);
    if (!m) return 0;
    const value = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === '-' ? -value : value;
  } catch (e) {
    return 0;
  }
}

function ltsFormatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return 'UTC' + sign + hh + ':' + mm;
}

/** 时区的长名（例如 Japan Standard Time），拿不到就返回空串 */
function ltsTimezoneName(timezone, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'long' })
      .formatToParts(date || new Date());
    const found = parts.find(p => p.type === 'timeZoneName');
    return found ? found.value : '';
  } catch (e) {
    return '';
  }
}

/** 可选时区列表 */
function ltsTimezones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch (e) {
    /* ignore */
  }
  return [
    'UTC', 'Etc/GMT', 'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin',
    'Europe/Paris', 'Europe/Moscow', 'Africa/Cairo', 'Asia/Dubai', 'Asia/Kolkata',
    'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
    'Australia/Sydney', 'Pacific/Auckland'
  ];
}

/* -------------------------------------------------------------- 站点解析 */

/**
 * 把用户写的站点转换成 match pattern。
 *   example.com            → *://*.example.com/*
 *   example.com/path       → *://*.example.com/path*
 *   https://a.example.com  → https://*.a.example.com/*
 *   *                      → *://* /*
 *   file:///tmp/x.html     → file:///tmp/x.html*
 */
function ltsToMatchPattern(input) {
  let s = String(input == null ? '' : input).trim().replace(/\s+/g, '');
  if (!s) return null;

  let scheme = '*';
  const m = /^([A-Za-z*]+):\/\//.exec(s);
  if (m) {
    scheme = m[1].toLowerCase();
    if (LTS_SCHEMES.indexOf(scheme) === -1) return null;
    s = s.slice(m[0].length);
  }

  if (scheme === 'file') {
    let path = s || '/';
    if (path.charAt(0) !== '/') path = '/' + path;
    if (path.indexOf('*') === -1) path += '*';
    return 'file://' + path;
  }

  let path = '/*';
  const slash = s.indexOf('/');
  if (slash !== -1) {
    path = s.slice(slash);
    s = s.slice(0, slash);
  }

  let host = s.toLowerCase().replace(/:\d+$/, '').replace(/^\.+/, '');
  if (!host) return null;

  // IP 地址前面不能加 *.（match pattern 不允许 *.1.2.3.4，会直接报错）
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  if (!isIp && host !== '*' && host.indexOf('*.') !== 0) host = '*.' + host;

  if (path === '' || path === '/') path = '/*';
  else if (path.indexOf('*') === -1) path += '*';

  return scheme + '://' + host + path;
}

/** match pattern → 用于在后台判断「当前标签页 URL 是否命中」的正则 */
function ltsPatternToRegExp(pattern) {
  const m = /^(\*|https?|wss?|ftp|file):\/\/(\*|\*\.[^/]+|[^/]*)(\/.*)$/.exec(pattern);
  if (!m) return null;

  const scheme = m[1];
  const host = m[2];
  const path = m[3];

  const escape = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const glob = s => escape(s).replace(/\*/g, '.*');

  const schemeRe = scheme === '*' ? 'https?' : escape(scheme);
  let hostRe = '';
  if (scheme !== 'file') {
    if (host === '*') hostRe = '[^/]+';
    else if (host.indexOf('*.') === 0) hostRe = '(?:[^/]+\\.)?' + escape(host.slice(2));
    else hostRe = escape(host);
  }

  try {
    return new RegExp('^' + schemeRe + '://' + hostRe + '(?::\\d+)?' + glob(path) + '$', 'i');
  } catch (e) {
    return null;
  }
}

/** match pattern 里的域名（给 declarativeNetRequest 用） */
function ltsPatternDomains(pattern) {
  const m = /^(\*|https?|wss?|ftp):\/\/(\*|\*\.[^/]+|[^/]+)\//.exec(pattern);
  if (!m) return [];
  const host = m[2];
  if (!host || host === '*') return [];
  return [host.indexOf('*.') === 0 ? host.slice(2) : host];
}

/**
 * 解析一行站点配置：
 *   example.com
 *   example.com | Asia/Tokyo | ja-JP,ja
 * 以 # 或 // 开头的行会被忽略。
 */
function ltsParseSite(raw) {
  const line = String(raw == null ? '' : raw).trim();
  if (!line || line.charAt(0) === '#' || line.indexOf('//') === 0) return null;

  const parts = line.split('|').map(p => p.trim());
  const sitePart = parts[0] || '';
  const tzPart = parts[1] || '';
  const langPart = parts[2] || '';

  const errors = [];
  const pattern = ltsToMatchPattern(sitePart);
  if (!pattern) {
    return {
      raw: line, pattern: '', regex: null, domains: [],
      timezone: '', languages: [], errors: ['站点格式无法解析']
    };
  }

  let timezone = '';
  if (tzPart) {
    if (ltsIsTimezone(tzPart)) timezone = tzPart;
    else errors.push('未知时区 "' + tzPart + '"');
  }

  const languages = ltsParseLanguages(langPart);
  if (langPart && languages.length === 0) errors.push('语言 "' + langPart + '" 不合法');

  return {
    raw: line,
    pattern,
    regex: ltsPatternToRegExp(pattern),
    domains: ltsPatternDomains(pattern),
    timezone,
    languages,
    errors
  };
}

/** 解析整个站点列表，丢弃注释行 */
function ltsCompileSites(lines) {
  const out = [];
  for (const line of lines || []) {
    const site = ltsParseSite(line);
    if (site) out.push(site);
  }
  return out;
}

/**
 * 某个 URL 应该使用什么配置；不命中返回 null。
 * 列表顺序即优先级。
 */
function ltsResolveSite(sites, url, prefs) {
  if (!url) return null;
  const defaults = ltsParseLanguages(prefs && prefs.languages);
  for (const site of sites || []) {
    if (!site.regex) continue;
    site.regex.lastIndex = 0;
    if (!site.regex.test(url)) continue;
    return {
      site,
      timezone: site.timezone || (prefs && prefs.timezone) || '',
      languages: site.languages.length ? site.languages : defaults,
      overridden: Boolean(site.timezone || site.languages.length)
    };
  }
  return null;
}

/** 当前 URL 的「站点域名」，用于「加入列表」按钮 */
function ltsDomainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}
