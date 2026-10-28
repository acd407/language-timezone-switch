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

  const port = (() => {
    let p = document.getElementById(PORT_ID);
    if (!p) {
      // 极少数情况下 MAIN 可能先于 ISOLATED 执行，这里自建元素，isolated.js 会复用
      p = document.createElement('span');
      p.id = PORT_ID;
      p.setAttribute('aria-hidden', 'true');
      p.style.setProperty('display', 'none', 'important');
      const root = document.documentElement || document;
      try {
        root.appendChild(p);
      } catch (e) {
        /* ignore */
      }
    }
    return p;
  })();

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

  /* -------------------------------------------------------- 参数语义判定 */

  const RE_ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;
  const RE_ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

  /** 字符串参数：绝对时间 → 原样；其余（含无时区的 ISO 时间）按本地时间解释 */
  const resolveString = str => {
    const s = str.trim();
    if (RE_ISO_WITH_ZONE.test(s) || RE_ISO_DATE_ONLY.test(s)) return [str];
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
    #view;
    #epoch = -1;

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

    /** 惰性计算的「移位视图」，配置变化时自动失效（不需要跟踪每个实例） */
    #shifted() {
      if (this.#epoch !== prefsEpoch) {
        this.#view = shiftInstance(this);
        this.#epoch = prefsEpoch;
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

    /* ---- 本地时间 setter（时区相关），按「墙上时间差值」换算回真实时刻 ---- */
    #setLocal(name, args) {
      const view = this.#shifted();
      const before = NativeDate.prototype.getTime.call(view);
      const after = NativeDate.prototype[name].apply(view, args);
      this.#epoch = -1;
      if (isNaN(after)) return NativeDate.prototype.setTime.call(this, NaN);
      const own = NativeDate.prototype.getTime.call(this);
      return NativeDate.prototype.setTime.call(this, own + (after - before));
    }

    setDate(...args) { return this.#setLocal('setDate', args); }
    setFullYear(...args) { return this.#setLocal('setFullYear', args); }
    setHours(...args) { return this.#setLocal('setHours', args); }
    setMinutes(...args) { return this.#setLocal('setMinutes', args); }
    setMonth(...args) { return this.#setLocal('setMonth', args); }
    setSeconds(...args) { return this.#setLocal('setSeconds', args); }
    setYear(...args) { return this.#setLocal('setYear', args); }

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

      const name = (() => {
        try {
          const parts = new NativeDateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' })
            .formatToParts(new NativeDate(t));
          const found = parts.find(p => p.type === 'timeZoneName');
          return found ? found.value : '';
        } catch (e) {
          return '';
        }
      })();

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

  const patchNavProp = (prop, value) => {
    const targets = navProto ? [navProto, navigator] : [navigator];
    for (const target of targets) {
      let descriptor = null;
      try {
        descriptor = Object.getOwnPropertyDescriptor(target, prop) || null;
      } catch (e) {
        descriptor = null;
      }
      try {
        Object.defineProperty(target, prop, { configurable: true, enumerable: true, get: () => value });
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

    patchNavProp('language', lang);
    patchNavProp('languages', Object.freeze(list.slice()));
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

  // 让 `new Date().constructor === Date`、`Date.name`、`Date.length` 看起来和原生一致
  try {
    Object.defineProperty(SpoofDate.prototype, 'constructor', {
      configurable: true,
      writable: true,
      value: DateProxy
    });
    Object.defineProperty(SpoofDate, 'name', { configurable: true, value: 'Date' });
    Object.defineProperty(SpoofDate, 'length', { configurable: true, value: 7 });
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

  if (port) {
    port.addEventListener('lts-prefs-change', syncPrefs);
  }

  // 首次读取（isolated.js 在 document_start 里已先写过，所以这里是同步可得的）
  syncPrefs();
}
