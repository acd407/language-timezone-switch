/*
 * MAIN world，document_start。
 * 作用：让页面的 JS 世界「以为」自己处在你配置的时区和语言下。
 *
 *   Date            → 本地 getter/toString/toLocale* 走目标时区（按具体时刻算偏移，含夏令时）
 *   Intl.*          → 未显式指定时区/语言时使用目标值
 *   navigator       → language / languages
 *
 * 配置通过 DOM 端口元素（由 isolated.js 写入）同步读取；之后可实时更新。
 */
{
  const PORT_ID = 'lts-prefs-4d7a1';

  const NativeDate = Date;
  const NativeDateTimeFormat = Intl.DateTimeFormat;

  /* ------------------------------------------------------------ 当前配置 */

  const prefs = { timezone: '', languages: [] };
  let prefsEpoch = 0;

  let port = document.getElementById(PORT_ID);

  if (!port) {
    // 极少数情况下 MAIN 可能先于 ISOLATED 执行，这里自建元素，isolated.js 会复用
    port = document.createElement('span');
    port.id = PORT_ID;
    port.setAttribute('aria-hidden', 'true');
    port.style.setProperty('display', 'none', 'important');
    const root = document.documentElement || document;
    try {
      root.appendChild(port);
    } catch (e) {
      // document_start 阶段 documentElement 可能还不存在：
      // 元素没进 DOM 的话 isolated.js 会另建一个，两边就永远对不上。
      // 等 DOM 就绪后再找一次真正的端口元素。
      try {
        document.addEventListener('DOMContentLoaded', adoptPort, { once: true });
      } catch (err) {
        /* ignore */
      }
    }
  }

  /** DOM 就绪后如果发现 isolated.js 建了另一个端口元素，就换用它 */
  function adoptPort() {
    const found = document.getElementById(PORT_ID);
    if (!found) return;
    if (found === port) return;
    port = found;
    bindPort();
    syncPrefs();
  }

  /* ---------------------------------------------------- 时区偏移计算工具 */

  const formatterCache = new Map();
  const offsetCache = new Map();

  const getFormatter = timezone => {
    let f = formatterCache.get(timezone);
    if (f !== undefined) return f;
    try {
      f = new NativeDateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        era: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (e) {
      f = null;
    }
    formatterCache.set(timezone, f);
    return f;
  };

  /** 目标时区在时刻 t（毫秒）相对 UTC 的偏移量（毫秒，东为正；自动处理夏令时） */
  const targetOffsetMs = (timezone, t) => {
    if (!timezone || !Number.isFinite(t)) return 0;

    const key = timezone + '|' + Math.floor(t / 60000);
    const cached = offsetCache.get(key);
    if (cached !== undefined) return cached;

    const f = getFormatter(timezone);
    if (!f) return 0;

    const parts = {};
    for (const part of f.formatToParts(new NativeDate(t))) parts[part.type] = part.value;

    let hour = Number(parts.hour);
    if (hour === 24) hour = 0;
    let year = Number(parts.year);
    if (parts.era && /^B/i.test(parts.era)) year = 1 - year;

    const probe = new NativeDate(0);
    probe.setUTCFullYear(year, Number(parts.month) - 1, Number(parts.day));
    probe.setUTCHours(hour, Number(parts.minute), Number(parts.second), 0);

    const value = probe.getTime() - Math.floor(t / 1000) * 1000;

    if (offsetCache.size > 4000) offsetCache.clear();
    offsetCache.set(key, value);
    return value;
  };

  /** 本机时区在时刻 t 的偏移（毫秒，东为正） */
  const nativeOffsetMs = t => -new NativeDate(t).getTimezoneOffset() * 60000;

  /** 本机时区的墙上时间（用 UTC 表示）→ 真实时刻 */
  const nativeWallToInstant = wallMs => {
    let t = wallMs - nativeOffsetMs(wallMs);
    const off2 = nativeOffsetMs(t);
    if (wallMs - off2 !== t) t = wallMs - off2;
    return t;
  };

  /** 「目标时区的墙上时间（用 UTC 表示）」→ 真实时刻 */
  const wallToInstant = wallMs => {
    const tz = prefs.timezone;
    if (!tz) return wallMs;
    const off = targetOffsetMs(tz, wallMs);
    let t = wallMs - off;
    const off2 = targetOffsetMs(tz, t);
    if (off2 !== off) t = wallMs - off2;
    return t;
  };

  /** 把某个 Date 实例移位成「借用本机 getter 就能显示目标时区」的等价时刻 */
  const shiftInstance = instance => {
    const t = NativeDate.prototype.getTime.call(instance);
    if (isNaN(t)) return new NativeDate(NaN);
    const tz = prefs.timezone;
    if (!tz) return new NativeDate(t);
    return new NativeDate(t + targetOffsetMs(tz, t) - nativeOffsetMs(t));
  };

  /** target 时区的长名（带缓存，toTimeString 会在热路径上反复要它） */
  const zoneNameCache = new Map();
  const zoneName = (timezone, t) => {
    let f = zoneNameCache.get(timezone);
    if (f === undefined) {
      try {
        f = new NativeDateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'long' });
      } catch (e) {
        f = null;
      }
      zoneNameCache.set(timezone, f);
    }
    if (!f) return '';
    try {
      const found = f.formatToParts(new NativeDate(t)).find(p => p.type === 'timeZoneName');
      return found ? found.value : '';
    } catch (e) {
      return '';
    }
  };

  /* -------------------------------------------------------- 参数语义判定 */

  const RE_ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;
  const RE_ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

  /* 非 ISO 格式（RFC 2822 / HTTP-date / Date#toString）里的时区标记。
     只认「时间后面跟 ±hh[:mm] 或 Z」以及常见时区缩写，
     避免把 2023-10-28 里的 -10 误判成偏移量。 */
  const RE_TIME_WITH_OFFSET = /\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*(?:[+-]\d{1,2}(?::?\d{2})?|\bZ\b)/;
  const RE_ZONE_NAME = /\b(?:GMT|UTC|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|AKST|AKDT|HST|CET|CEST|EET|EEST|WET|WEST|BST|IST|JST|KST|AEST|AEDT|ACST|ACDT|NZST|NZDT|MSK|SGT|HKT|AST|ADT|NST|NDT)\b/;

  /** 字符串里是否已写明绝对时区（写明就交给原生解析，不按本地时间重解释） */
  const hasExplicitZone = s =>
    RE_ISO_WITH_ZONE.test(s) || RE_ISO_DATE_ONLY.test(s) ||
    RE_TIME_WITH_OFFSET.test(s) || RE_ZONE_NAME.test(s);

  /**
   * 字符串参数：已带时区的 → 绝对时间，原样交给原生；
   * 其余（含无时区的 ISO 时间）→ 按目标时区的本地时间解释。
   * 之前只认 ISO 带时区写法，于是 "Sat, 28 Oct 2023 03:00:00 GMT"、
   * new Date().toUTCString() 这类 RFC 2822 / HTTP-date 会被再解释一次，整体偏掉一个时差。
   */
  const resolveString = str => {
    const s = str.trim();
    if (hasExplicitZone(s)) return [str];
    const native = new NativeDate(str);
    if (isNaN(native.getTime())) return [str];
    const wallMs = native.getTime() + nativeOffsetMs(native.getTime());
    return [wallToInstant(wallMs)];
  };

  /** 多参数（年,月,日,…）：按目标时区的本地时间解释 */
  const resolveComponents = args => {
    const native = new NativeDate(...args);
    if (isNaN(native.getTime())) return [NaN];
    const wallMs = native.getTime() + nativeOffsetMs(native.getTime());
    return [wallToInstant(wallMs)];
  };

  /* ------------------------------------------------------------ SpoofDate */

  class SpoofDate extends NativeDate {
    #view = null;
    #viewKey = '';

    constructor(...args) {
      if (!prefs.timezone || args.length === 0) {
        super(...args);
      } else if (args.length === 1) {
        const a = args[0];
        if (typeof a === 'number' || a instanceof NativeDate) super(a);
        else if (typeof a === 'string') super(...resolveString(a));
        else super(...args);
      } else {
        super(...resolveComponents(args));
      }
    }

    /**
     * 惰性计算的「移位视图」缓存。
     * 缓存键用的是「当前时刻 + 配置版本」而不是只有配置版本：
     * 否则 d.setTime()/setUTCHours() 这类走原生 setter 的修改不会让缓存失效，
     * 之后的 getHours()/getDate() 会返回改之前的值。
     */
    #shifted() {
      const key = prefsEpoch + '|' + NativeDate.prototype.getTime.call(this);
      if (this.#viewKey !== key) {
        this.#view = shiftInstance(this);
        this.#viewKey = key;
      }
      return this.#view;
    }

    getTimezoneOffset() {
      const t = NativeDate.prototype.getTime.call(this);
      if (isNaN(t) || !prefs.timezone) return NativeDate.prototype.getTimezoneOffset.call(this);
      return -Math.round(targetOffsetMs(prefs.timezone, t) / 60000);
    }

    /* ---- 本地时间 getter（时区相关） ---- */
    getDate() { return this.#shifted().getDate(); }
    getDay() { return this.#shifted().getDay(); }
    getFullYear() { return this.#shifted().getFullYear(); }
    getHours() { return this.#shifted().getHours(); }
    getMinutes() { return this.#shifted().getMinutes(); }
    getMonth() { return this.#shifted().getMonth(); }
    getSeconds() { return this.#shifted().getSeconds(); }
    getYear() { return this.#shifted().getYear(); }

    /* ---- 本地时间 setter（时区相关）：改的是「目标时区的墙上时间」---- */
    #setLocal(name, args) {
      const t = NativeDate.prototype.getTime.call(this);
      if (isNaN(t)) return NativeDate.prototype.setTime.call(this, NaN);

      // 把「墙上时间」冻结成一个 UTC 编码的 Date，用 setUTC* 改它：
      // UTC setter 不掺本机时区/夏令时，改完就是新的墙上时间。
      const wall = prefs.timezone
        ? t + targetOffsetMs(prefs.timezone, t)
        : t + nativeOffsetMs(t);
      const utcName = 'setUTC' + name.slice(3);
      const after = NativeDate.prototype[utcName].apply(new NativeDate(wall), args);
      this.#viewKey = '';
      if (isNaN(after)) return NativeDate.prototype.setTime.call(this, NaN);

      // 再换回真实时刻。不能像以前那样只把差值加到旧时刻上：
      // 跨夏令时切换时目标时区的偏移变了，差值会被重复计入。
      const next = prefs.timezone ? wallToInstant(after) : nativeWallToInstant(after);
      return NativeDate.prototype.setTime.call(this, next);
    }

    setDate(...args) { return this.#setLocal('setDate', args); }
    setFullYear(...args) { return this.#setLocal('setFullYear', args); }
    setHours(...args) { return this.#setLocal('setHours', args); }
    setMinutes(...args) { return this.#setLocal('setMinutes', args); }
    setMonth(...args) { return this.#setLocal('setMonth', args); }
    setSeconds(...args) { return this.#setLocal('setSeconds', args); }
    setYear(...args) {
      // 没有 setUTCYear，按规范自己换算：0-99 映射到 1900-1999，其余原样
      const raw = Number(args[0]);
      if (isNaN(raw)) return this.#setLocal('setFullYear', [NaN]);
      const year = raw >= 0 && raw <= 99 ? 1900 + raw : raw;
      return this.#setLocal('setFullYear', [year]);
    }

    /* ---- 字符串化 ---- */
    toDateString() {
      return NativeDate.prototype.toDateString.call(this.#shifted());
    }

    toTimeString() {
      const t = NativeDate.prototype.getTime.call(this);
      const tz = prefs.timezone;
      if (isNaN(t) || !tz) return NativeDate.prototype.toTimeString.call(this);

      const clock = NativeDate.prototype.toTimeString.call(this.#shifted()).split(' GMT')[0];
      const off = targetOffsetMs(tz, t);
      const sign = off < 0 ? '-' : '+';
      const abs = Math.abs(off);
      const hh = String(Math.floor(abs / 3600000)).padStart(2, '0');
      const mm = String(Math.floor((abs % 3600000) / 60000)).padStart(2, '0');

      const name = zoneName(tz, t);

      return clock + ' GMT' + sign + hh + mm + (name ? ' (' + name + ')' : '');
    }

    toString() {
      const t = NativeDate.prototype.getTime.call(this);
      if (isNaN(t) || !prefs.timezone) return NativeDate.prototype.toString.call(this);
      return this.toDateString() + ' ' + this.toTimeString();
    }

    /* ---- toLocale* ---- */
    toLocaleString(locales, options) {
      return NativeDate.prototype.toLocaleString.call(this, withLocale(locales), withTimeZone(options));
    }

    toLocaleDateString(locales, options) {
      return NativeDate.prototype.toLocaleDateString.call(this, withLocale(locales), withTimeZone(options));
    }

    toLocaleTimeString(locales, options) {
      return NativeDate.prototype.toLocaleTimeString.call(this, withLocale(locales), withTimeZone(options));
    }
  }

  /* ------------------------------------------------------- locale 默认值 */

  const withLocale = locales => {
    if (!prefs.languages.length) return locales;
    if (locales === undefined || locales === null) return prefs.languages[0];
    if (Array.isArray(locales) && locales.length === 0) return prefs.languages[0];
    return locales;
  };

  const withTimeZone = options => {
    if (!prefs.timezone) return options;
    // 原生这边对 null 会抛 TypeError，对非对象参数则是宽松处理；保持原样别自己造对象
    if (options === undefined) return { timeZone: prefs.timezone };
    if (options === null || typeof options !== 'object') return options;
    const next = Object.assign({}, options);
    if (!next.timeZone) next.timeZone = prefs.timezone;
    return next;
  };

  /* ------------------------------------------------------ Intl 构造器包装 */

  const patchIntl = (name, normalize) => {
    const Original = Intl[name];
    if (typeof Original !== 'function') return;

    const prepare = args => {
      const next = Array.prototype.slice.call(args);
      if (prefs.languages.length) next[0] = withLocale(next[0]);
      if (normalize) normalize(next);
      return next;
    };

    Intl[name] = new Proxy(Original, {
      apply(target, thisArg, args) {
        return Reflect.apply(target, undefined, prepare(args));
      },
      construct(target, args, newTarget) {
        return Reflect.construct(target, prepare(args), newTarget);
      }
    });
  };

  const dateTimeFormatDefaults = args => {
    // null 交给原生去抛（Object.assign({}, null) 会把它变成 {}，把错误吞掉）
    if (args[1] === null) return;
    args[1] = Object.assign({}, args[1]);
    if (!args[1].timeZone && prefs.timezone) args[1].timeZone = prefs.timezone;
  };

  patchIntl('DateTimeFormat', dateTimeFormatDefaults);
  for (const name of ['NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames', 'Segmenter']) {
    patchIntl(name);
  }

  /* ------------------------------------------------------- navigator 语言 */

  // 记录原生的 descriptor，语言被清空时可以回退（而不是留在上一次的值上）
  const navProto = typeof Navigator === 'function' ? Navigator.prototype : null;
  const navSaved = Object.create(null);

  const patchNavProp = (prop, getValue) => {
    const targets = navProto ? [navProto, navigator] : [navigator];
    for (const target of targets) {
      let descriptor = null;
      try {
        descriptor = Object.getOwnPropertyDescriptor(target, prop) || null;
      } catch (e) {
        descriptor = null;
      }
      try {
        Object.defineProperty(target, prop, { configurable: true, enumerable: true, get: () => getValue() });
      } catch (e) {
        continue;
      }
      if (!navSaved[prop]) navSaved[prop] = { target, descriptor };
      return true;
    }
    return false;
  };

  const restoreNavProp = prop => {
    const saved = navSaved[prop];
    if (!saved) return;
    try {
      if (saved.descriptor) Object.defineProperty(saved.target, prop, saved.descriptor);
      else delete saved.target[prop];
    } catch (e) {
      /* ignore */
    }
    delete navSaved[prop];
  };

  const patchNavigator = languages => {
    const list = languages.slice();
    const lang = list[0];

    if (!lang) {
      // 空语言 = 明确不改，把原生值还回去
      restoreNavProp('language');
      restoreNavProp('languages');
      return;
    }

    patchNavProp('language', () => lang);
    // 原生每次访问都返回一个新数组；返回同一个实例是可检测的指纹差异
    patchNavProp('languages', () => Object.freeze(list.slice()));
  };

  /* ------------------------------------------------------- Number/String */

  const patchToLocale = (proto, name) => {
    if (!proto || typeof proto[name] !== 'function') return;
    const original = proto[name];
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (locales, options) {
        return original.call(this, withLocale(locales), options);
      }
    });
  };

  patchToLocale(Number.prototype, 'toLocaleString');
  if (typeof BigInt === 'function') patchToLocale(BigInt.prototype, 'toLocaleString');

  // localeCompare 的第一个参数是被比较的字符串，locale 在第二位，不能复用上面的包装
  if (typeof String.prototype.localeCompare === 'function') {
    const originalLocaleCompare = String.prototype.localeCompare;
    Object.defineProperty(String.prototype, 'localeCompare', {
      configurable: true,
      writable: true,
      value: function (that, locales, options) {
        return originalLocaleCompare.call(this, that, withLocale(locales), options);
      }
    });
  }

  /* ------------------------------------------------------------- 安装补丁 */

  const DateProxy = new Proxy(SpoofDate, {
    // 规范：Date() 不带 new 时返回当前时间的字符串
    apply() {
      return new SpoofDate().toString();
    }
  });

  // Date.parse 要和 new Date(str) 给出一致的答案，
  // 否则 `Date.parse(s) !== new Date(s).getTime()`，很多校验/排序代码会莫名不对。
  const spoofParse = value => {
    const text = String(value);
    const parsed = new SpoofDate(text);
    return NativeDate.prototype.getTime.call(parsed);
  };

  // 让 `new Date().constructor === Date`、`Date.name`、`Date.length` 看起来和原生一致
  try {
    Object.defineProperty(SpoofDate.prototype, 'constructor', {
      configurable: true,
      writable: true,
      value: DateProxy
    });
    Object.defineProperty(SpoofDate, 'name', { configurable: true, value: 'Date' });
    Object.defineProperty(SpoofDate, 'length', { configurable: true, value: 7 });
    Object.defineProperty(spoofParse, 'name', { configurable: true, value: 'parse' });
    Object.defineProperty(spoofParse, 'length', { configurable: true, value: 1 });
    Object.defineProperty(SpoofDate, 'parse', { configurable: true, writable: true, value: spoofParse });
  } catch (e) {
    /* ignore */
  }

  try {
    Object.defineProperty(window, 'Date', {
      configurable: true,
      writable: true,
      value: DateProxy
    });
  } catch (e) {
    window.Date = DateProxy;
  }

  /* --------------------------------------------------------- 配置同步逻辑 */

  const syncPrefs = () => {
    const timezone = (port && port.dataset.timezone) || '';
    const rawLanguages = (port && port.dataset.languages) || '';
    const languages = rawLanguages ? rawLanguages.split(',').filter(Boolean) : [];

    if (timezone === prefs.timezone && languages.join(',') === prefs.languages.join(',')) return;

    prefs.timezone = timezone;
    prefs.languages = languages;
    prefsEpoch += 1;
    formatterCache.clear();
    offsetCache.clear();

    if (languages.length) patchNavigator(languages);
    else patchNavigator([]); // 清空语言 → 把原生 getter 还回去（不是留在上一次的值）

    try {
      window.dispatchEvent(new Event('languagechange'));
    } catch (e) {
      /* ignore */
    }
  };

  /** 端口元素就绪/更换后都走这里（同一个函数引用来监听，重复调用不会叠加） */
  function bindPort() {
    if (port) port.addEventListener('lts-prefs-change', syncPrefs);
  }

  bindPort();

  // 首次读取（isolated.js 在 document_start 里已先写过，所以这里是同步可得的）
  syncPrefs();
}
