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

/* 站点列表里允许的 URL scheme。
   只列内容脚本（match pattern）真正支持的四个：ws/wss/ftp 写进去 Chrome 会整条注册失败，
   而且没有标签页 URL 会是 ws:// / ftp://，属于纯死配置，直接拒绝更安全。 */
const LTS_SCHEMES = ['*', 'http', 'https', 'file'];

/* match pattern 允许的 host：ASCII 字母/数字/连字符组成的域名（国际化域名请写 punycode） */
const LTS_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

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
      // 从 0.9 递减（Chrome 自己发的是 en-US,en;q=0.9 这种形态）。
      // 之前用 (n-i)/n，两个语言时第二项只有 q=0.5，和主流写法差得太远。
      const q = Math.max(0.1, 1 - i / 10);
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
 *   example.com:8080       → *://*.example.com/*（port 里返回 8080）
 *   https://a.example.com  → https://*.a.example.com/*
 *   *                      → *://* /*
 *   file:///tmp/x.html     → file:///tmp/x.html*
 *
 * 返回 { pattern, port, error }。pattern 为 null 时 error 里是给人看的原因——
 * 后台是拿这个字符串直接调 scripting.registerContentScripts 的，
 * 一个非法 pattern 会让整批注册全部失败，所以必须在这里就把垃圾挡掉。
 *
 * 端口不会进 pattern：Chrome 的 match pattern 不接受端口（会报 Invalid port），
 * 所以注入无法按端口区分，只能把端口单独返回给调用方去做提示。
 */
function ltsBuildMatchPattern(input) {
  const compact = String(input == null ? '' : input).trim().replace(/\s+/g, '');
  if (!compact) return { pattern: null, port: '', error: '站点为空' };

  let scheme = '*';
  let rest = compact;
  const m = /^([A-Za-z*]+):\/\//.exec(compact);
  if (m) {
    scheme = m[1].toLowerCase();
    if (LTS_SCHEMES.indexOf(scheme) === -1) {
      return {
        pattern: null, port: '',
        error: '不支持的 scheme "' + m[1] + '://"（只支持 http、https、file）'
      };
    }
    rest = compact.slice(m[0].length);
  }

  if (rest.charAt(0) === '[') return { pattern: null, port: '', error: '暂不支持 IPv6 字面量' };

  if (scheme === 'file') {
    let path = rest || '/';
    if (path.charAt(0) !== '/') path = '/' + path;
    if (path.indexOf('*') === -1) path += '*';
    return { pattern: 'file://' + path, port: '', error: '' };
  }

  let path = '/*';
  const slash = rest.indexOf('/');
  if (slash !== -1) {
    path = rest.slice(slash);
    rest = rest.slice(0, slash);
  }

  let port = '';
  const colon = rest.indexOf(':');
  if (colon !== -1) {
    const maybePort = rest.slice(colon + 1);
    if (maybePort.indexOf('@') !== -1) {
      return { pattern: null, port: '', error: '不支持带账号密码的 URL（写裸域名即可）' };
    }
    if (!/^\d{1,5}$/.test(maybePort) || Number(maybePort) > 65535) {
      return { pattern: null, port: '', error: '端口不合法："' + maybePort + '"' };
    }
    port = String(Number(maybePort));
    rest = rest.slice(0, colon);
  }

  let host = rest.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!host) return { pattern: null, port, error: '缺少域名' };

  if (host !== '*') {
    const wildcard = host.indexOf('*.') === 0;
    const base = wildcard ? host.slice(2) : host;
    if (!base) return { pattern: null, port, error: '缺少域名' };
    if (base.indexOf('*') !== -1) return { pattern: null, port, error: '通配符只能写成 *.example.com' };

    // IP 地址前面不能加 *.（match pattern 不允许 *.1.2.3.4）
    const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(base);
    if (isIp) {
      if (wildcard) return { pattern: null, port, error: 'IP 地址不能加 "*." 通配' };
      host = base;
    } else if (!LTS_HOST_RE.test(base)) {
      return {
        pattern: null, port,
        error: '域名里有非法字符："' + base + '"（国际化域名请写 punycode）'
      };
    } else {
      host = '*.' + base;
    }
  }

  if (path === '' || path === '/') path = '/*';
  else if (path.indexOf('*') === -1) path += '*';

  return { pattern: scheme + '://' + host + path, port, error: '' };
}

/** 同上，但只要 pattern（解析失败返回 null） */
function ltsToMatchPattern(input) {
  return ltsBuildMatchPattern(input).pattern;
}

/**
 * match pattern → 用于在后台判断「当前标签页 URL 是否命中」的正则。
 * 注意：只有 scheme/host 做 ASCII 大小写折叠，path 保持区分大小写——
 * Chrome 的 match pattern 就是这么匹配的，之前统一加 /i 会让 /Admin 命中 /ADMIN，
 * 于是徽标说“已切换”而页面实际没被注入。
 */
function ltsPatternToRegExp(pattern) {
  const m = /^(\*|https?|wss?|ftp|file):\/\/(\*|\*\.[^/:]+|[^/:]*)(?::(\d+))?(\/.*)$/.exec(pattern);
  if (!m) return null;

  const scheme = m[1];
  const host = m[2];
  const port = m[3];
  const path = m[4];

  const escape = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const glob = s => escape(s).replace(/\*/g, '.*');
  const foldCase = s => s.replace(/[A-Za-z]/g, c => '[' + c.toUpperCase() + c.toLowerCase() + ']');

  const schemeRe = scheme === '*' ? foldCase('https?') : foldCase(escape(scheme));
  let hostRe = '';
  if (scheme !== 'file') {
    if (host === '*') hostRe = '[^/]+';
    else if (host.indexOf('*.') === 0) hostRe = '(?:[^/]+\\.)?' + foldCase(escape(host.slice(2)));
    else hostRe = foldCase(escape(host));
  }
  const portRe = port ? ':' + port : '(?::\\d+)?';

  try {
    return new RegExp('^' + schemeRe + '://' + hostRe + portRe + glob(path) + '$');
  } catch (e) {
    return null;
  }
}

/** match pattern 里的域名（给 declarativeNetRequest 用） */
function ltsPatternDomains(pattern) {
  const m = /^(\*|https?|wss?|ftp):\/\/(\*|\*\.[^/:]+|[^/:]+)(?::\d+)?\//.exec(pattern);
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
  const warnings = [];
  if (parts.length > 3) warnings.push('第 4 段起被忽略（每行最多：站点 | 时区 | 语言）');

  const built = ltsBuildMatchPattern(sitePart);
  if (!built.pattern) {
    errors.unshift(built.error || '站点格式无法解析');
    return {
      raw: line, pattern: '', regex: null, domains: [],
      timezone: '', languages: [], overridden: false, errors, warnings
    };
  }
  const pattern = built.pattern;
  if (built.port) {
    warnings.push('端口 ' + built.port + ' 会被忽略：浏览器不允许按端口注入内容脚本');
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
    overridden: Boolean(timezone || languages.length),
    errors,
    warnings
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
