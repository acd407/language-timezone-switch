/*
 * 无浏览器冒烟测试：在 vm 沙箱里跑 common.js + inject/main.js，
 * 校验时区/语言的伪造逻辑（含夏令时、本地时间参数语义、实时更新）。
 *
 * 运行： TZ=Asia/Shanghai node test/smoke.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const PORT_ID = 'lts-prefs-4d7a1';

/* ------------------------------------------------------------------ 桩对象 */

function makeElement(id) {
  const element = {
    id,
    dataset: {},
    style: { setProperty() {} },
    listeners: new Map(),
    setAttribute() {},
    appendChild() {},
    addEventListener(type, fn) {
      if (!element.listeners.has(type)) element.listeners.set(type, []);
      element.listeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of element.listeners.get(event.type) || []) fn(event);
    }
  };
  return element;
}

// 每个沙箱都拿一套全新的 navigator 原型（否则补丁会跨上下文泄漏）
function makeNavigator() {
  class FakeNavigator {}
  Object.defineProperty(FakeNavigator.prototype, 'language', {
    configurable: true,
    get: () => 'en-US'
  });
  Object.defineProperty(FakeNavigator.prototype, 'languages', {
    configurable: true,
    get: () => ['en-US', 'en']
  });
  return { Navigator: FakeNavigator, navigator: new FakeNavigator() };
}

class FakeEvent {
  constructor(type) {
    this.type = type;
  }
}

const port = makeElement(PORT_ID);
port.dataset.timezone = 'Asia/Tokyo';
port.dataset.languages = 'ja-JP,ja,en';

const documentStub = {
  documentElement: makeElement('html'),
  createElement: tag => makeElement(tag),
  getElementById: id => (id === PORT_ID ? port : null)
};

const mainNavigator = makeNavigator();
const sandbox = {
  console,
  port,
  document: documentStub,
  navigator: mainNavigator.navigator,
  Navigator: mainNavigator.Navigator,
  Event: FakeEvent,
  setTimeout,
  URL
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);

/* ------------------------------------------------------------------ 加载 */

vm.runInContext(read('common.js'), sandbox, { filename: 'common.js' });
vm.runInContext(read('inject/main.js'), sandbox, { filename: 'inject/main.js' });

/* ------------------------------------------------------------------ 断言 */

let failed = 0;
let passed = 0;

function check(label, expression, expected) {
  let actual;
  try {
    actual = vm.runInContext(expression, sandbox);
  } catch (e) {
    actual = 'THREW: ' + e.message;
  }
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log('  ok   ' + label);
  } else {
    failed += 1;
    console.log('  FAIL ' + label + '\n         期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

function usePrefs(timezone, languages) {
  vm.runInContext(
    `(port.dataset.timezone = ${JSON.stringify(timezone)},
      port.dataset.languages = ${JSON.stringify(languages)},
      port.dispatchEvent(new Event('lts-prefs-change')), 1)`,
    sandbox
  );
}

console.log('\n[1] 沙箱本机 = Asia/Shanghai (UTC+8)，目标 = Asia/Tokyo (UTC+9)');

check('new Date(2023,9,28,12,0) 的本地小时 = 12', 'new Date(2023, 9, 28, 12, 0).getHours()', 12);
check('getTimezoneOffset() = -540', 'new Date(2023, 9, 28, 12, 0).getTimezoneOffset()', -540);
check('本地时间参数换算成正确时刻（12:00 JST = 03:00Z）',
  'new Date(2023, 9, 28, 12, 0).getTime() === Date.UTC(2023, 9, 28, 3, 0)', true);
check('绝对时刻的本地小时 = 12',
  'new Date(Date.UTC(2023, 9, 28, 3, 0)).getHours()', 12);
check('getDate/getMonth/getFullYear/getDay',
  '[new Date(Date.UTC(2023,9,28,3,0)).getDate(), new Date(Date.UTC(2023,9,28,3,0)).getMonth(), new Date(Date.UTC(2023,9,28,3,0)).getFullYear(), new Date(Date.UTC(2023,9,28,3,0)).getDay()]',
  [28, 9, 2023, 6]);
check('toString 形如 …… GMT+0900 (Japan Standard Time)',
  '/^Sat Oct 28 2023 12:00:00 GMT\\+0900 \\(Japan Standard Time\\)$/.test(String(new Date(Date.UTC(2023,9,28,3,0))))',
  true);
check('toTimeString 格式',
  '/^12:00:00 GMT\\+0900 \\(Japan Standard Time\\)$/.test(new Date(Date.UTC(2023,9,28,3,0)).toTimeString())',
  true);
check('toDateString 用目标时区的日期',
  'new Date(Date.UTC(2023, 9, 27, 20, 0)).toDateString()', 'Sat Oct 28 2023');
check('计时不受影响：getTime/valueOf',
  'new Date(Date.UTC(2023,9,28,3,0)).getTime() === Date.UTC(2023,9,28,3,0)', true);

console.log('\n[2] setter 语义');

check('setHours(0) 后小时为 0', '(d => (d.setHours(0), d.getHours()))(new Date(Date.UTC(2023,9,28,3,0)))', 0);
check('setHours(0) 后时刻减少 12 小时',
  '(d => (d.setHours(0), d.getTime()))(new Date(Date.UTC(2023,9,28,3,0)))', Date.UTC(2023, 9, 27, 15, 0));
check('setTime 不受时区影响',
  '(d => (d.setTime(0), d.getTime()))(new Date())', 0);
check('setTime 之后本地 getter 跟着更新（不再返回缓存值）',
  '(d => { d.getHours(); d.setTime(Date.UTC(2024,0,1,0,0)); return [d.getHours(), d.getDate()]; })(new Date(Date.UTC(2023,9,28,3,0)))',
  [9, 1]);
check('setUTCHours 之后本地 getter 跟着更新',
  '(d => { d.getHours(); d.setUTCHours(0,0,0,0); return d.getHours(); })(new Date(Date.UTC(2023,9,28,3,0)))',
  9);
check('setYear 保留 0-99 映射到 19xx 的语义',
  '(d => (d.setYear(99), d.getFullYear()))(new Date(Date.UTC(2023,9,28,3,0)))', 1999);
check('setMonth(0) 后月份为 0',
  '(d => (d.setMonth(0), d.getMonth()))(new Date(Date.UTC(2023,9,28,3,0)))', 0);

console.log('\n[3] 字符串参数语义');

check('带 Z 的 ISO 串按绝对时间解析',
  'new Date("2023-10-28T12:00:00Z").getHours()', 21);
check('纯日期按 UTC 解析（10-28T00:00Z → 28 日 09:00 JST）',
  '[new Date("2023-10-28").getDate(), new Date("2023-10-28").getHours()]', [28, 9]);
check('无时区的 ISO 时间按本地时间解析',
  'new Date("2023-10-28T12:00:00").getHours()', 12);
check('无时区的 ISO 时间换算成 03:00Z',
  'new Date("2023-10-28T12:00:00").getTime() === Date.UTC(2023, 9, 28, 3, 0)', true);
check('带 GMT 的 RFC 2822 串按绝对时间解析',
  'new Date("Sat, 28 Oct 2023 03:00:00 GMT").getTime() === Date.UTC(2023, 9, 28, 3, 0)', true);
check('带 UTC 的英文日期按绝对时间解析',
  'new Date("October 28, 2023 03:00:00 UTC").getTime() === Date.UTC(2023, 9, 28, 3, 0)', true);
check('toUTCString 往返不丢时刻',
  'new Date(new Date(Date.UTC(2023,9,28,3,0)).toUTCString()).getTime() === Date.UTC(2023,9,28,3,0)', true);
check('Date.parse 与 new Date(string) 给出一致结果',
  '["2023-10-28T12:00:00", "Sat, 28 Oct 2023 03:00:00 GMT", "2023-10-28", "October 28, 2023 03:00:00 UTC"].every(s => Date.parse(s) === new Date(s).getTime())',
  true);
check('Date.parse 的名字和长度像原生',
  '[Date.parse.name, Date.parse.length]', ['parse', 1]);

console.log('\n[4] Intl / navigator / locale');

check('Intl.DateTimeFormat 默认时区',
  'new Intl.DateTimeFormat().resolvedOptions().timeZone', 'Asia/Tokyo');
check('显式指定的时区不被覆盖',
  'new Intl.DateTimeFormat("en", {timeZone: "UTC"}).resolvedOptions().timeZone', 'UTC');
check('navigator.language', 'navigator.language', 'ja-JP');
check('navigator.languages', 'navigator.languages.join(",")', 'ja-JP,ja,en');
check('navigator.languages 已冻结', 'Object.isFrozen(navigator.languages)', true);
check('navigator.languages 每次返回新数组（与原生一致）',
  'navigator.languages !== navigator.languages', true);
check('Number#toLocaleString 默认用目标语言',
  '(1234.5).toLocaleString()', (1234.5).toLocaleString('ja-JP'));
check('Date#toLocaleString 显式语言仍是显式语言',
  'new Date(Date.UTC(2023,9,28,3,0)).toLocaleString("de-DE")',
  new Intl.DateTimeFormat('de-DE', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'medium' })
    .format(new Date(Date.UTC(2023, 9, 28, 3, 0)))
    .replace(/\s/g, ' ').replace(/\s/g, ' '));
check('Date#toLocaleString 默认语言 + 默认时区',
  '/28\\.10\\.2023/.test(new Date(Date.UTC(2023,9,28,3,0)).toLocaleString("de-DE"))', true);
check('localeCompare 保留原有参数顺序与第三个参数',
  "'ä'.localeCompare('a', 'de', {sensitivity: 'base'})", 'ä'.localeCompare('a', 'de', { sensitivity: 'base' }));
check('localeCompare 默认调用正常',
  "['apple'.localeCompare('banana') < 0, typeof 'a'.localeCompare('b')]", [true, 'number']);
check('Number#toLocaleString 显式语言仍是显式语言',
  "(1234.5).toLocaleString('de-DE')", (1234.5).toLocaleString('de-DE'));

console.log('\n[5] 其它时区：半小时偏移 + 夏令时（按时刻计算）');

usePrefs('Asia/Kolkata', 'hi-IN,en');
check('Kolkata 偏移 = -330', 'new Date().getTimezoneOffset()', -330);
check('Kolkata toString 含 GMT+0530', '/GMT\\+0530/.test(String(new Date()))', true);

usePrefs('America/New_York', 'en-US');
check('纽约 1 月 = 300（EST，UTC-5）', 'new Date("2023-01-15T12:00:00Z").getTimezoneOffset()', 300);
check('纽约 7 月 = 240（EDT，UTC-4）', 'new Date("2023-07-15T12:00:00Z").getTimezoneOffset()', 240);
check('纽约 1 月本地小时 = 7', 'new Date("2023-01-15T12:00:00Z").getHours()', 7);
check('纽约 7 月本地小时 = 8', 'new Date("2023-07-15T12:00:00Z").getHours()', 8);
check('跨夏令时的 setHours 落在正确时刻（03:00 EDT = 07:00Z）',
  '(d => { d.setHours(3, 0, 0, 0); return d.toISOString(); })(new Date(Date.UTC(2023,2,12,6,30)))',
  '2023-03-12T07:00:00.000Z');
check('跨夏令时切换的两个月日期不对调',
  '[new Date("2023-03-12T06:59:00Z").getHours(), new Date("2023-03-12T07:01:00Z").getHours()]', [1, 3]);

console.log('\n[6] 关掉伪造（留空）= 与原生完全一致');

usePrefs('', '');
check('无时区时 getTimezoneOffset 走原生', 'new Date().getTimezoneOffset()', new Date().getTimezoneOffset());
check('无时区时本地小时走原生',
  'new Date(2023, 9, 28, 12, 0).getHours()', 12);
check('无时区时 toString 走原生（与本机原生输出逐字一致）',
  'String(new Date(Date.UTC(2023,9,28,3,0)))', String(new Date(Date.UTC(2023, 9, 28, 3, 0))));
usePrefs('Asia/Tokyo', 'ko-KR');
check('先换成韩语', 'navigator.language', 'ko-KR');
usePrefs('', '');
check('清空语言后 navigator 回退到原生', 'navigator.language', 'en-US');
check('回退后 languages 也回到原生', 'navigator.languages.join(",")', 'en-US,en');

console.log('\n[7] 运行时切换配置（页面已打开时）');

usePrefs('Asia/Tokyo', 'ja-JP,ja');
check('切回东京后 getTimezoneOffset = -540', 'new Date().getTimezoneOffset()', -540);
check('切换后 navigator.language 立即更新', 'navigator.language', 'ja-JP');

console.log('\n[8] 兼容性与边界');

check('Date() 不带 new 返回字符串', 'typeof Date()', 'string');
check('new Date() instanceof Date', 'new Date() instanceof Date', true);
check('constructor 指向伪造的 Date', 'new Date().constructor === Date', true);
check('Object.prototype.toString 仍是 [object Date]', 'Object.prototype.toString.call(new Date())', '[object Date]');
check('Invalid Date 正常', 'String(new Date("nope"))', 'Invalid Date');
check('Date.now / Date.parse / Date.UTC 保留',
  '[typeof Date.now(), typeof Date.parse, typeof Date.UTC]', ['number', 'function', 'function']);
check('Date.name / Date.length 看起来原生', '[Date.name, Date.length]', ['Date', 7]);
check('年份 0-99 语义不变（1999）', 'new Date(99, 0, 1).getFullYear()', 1999);
check('数组里的 Date 也能被 JSON 序列化',
  'JSON.stringify([new Date(Date.UTC(2023,9,28,3,0))])', '["2023-10-28T03:00:00.000Z"]');

console.log('\n[9] common.js：站点解析');

check('裸域名 → 带子域的通配', 'ltsToMatchPattern("example.com")', '*://*.example.com/*');
check('带路径 → 前缀匹配', 'ltsToMatchPattern("example.com/foo")', '*://*.example.com/foo*');
check('显式 scheme 保留', 'ltsToMatchPattern("https://a.example.com")', 'https://*.a.example.com/*');
check('* → 全站', 'ltsToMatchPattern("*")', '*://*/*');
check('端口不进 pattern（Chrome 报 Invalid port）', 'ltsToMatchPattern("example.com:8080")', '*://*.example.com/*');
check('端口以警告形式告知，不静默丢弃',
  '(() => { const s = ltsParseSite("example.com:8080"); return [s.errors.length, s.warnings.length, s.warnings[0].indexOf("8080") !== -1]; })()',
  [0, 1, true]);
check('ws:// 被拒绝（内容脚本不支持这个 scheme）', 'ltsToMatchPattern("ws://example.com")', null);
check('ftp:// 被拒绝', 'ltsToMatchPattern("ftp://example.com")', null);
check('带账号密码的 URL 被拒绝', 'ltsToMatchPattern("http://user:pass@example.com")', null);
check('IPv6 字面量被拒绝', 'ltsToMatchPattern("[::1]")', null);
check('畸形端口被拒绝', 'ltsToMatchPattern("example.com:abc")', null);
check('非法 scheme 的原因写进 errors',
  '(() => { const s = ltsParseSite("ws://example.com"); return [s.pattern, s.errors.length]; })()',
  ['', 1]);
check('路径区分大小写（和 Chrome 的 match pattern 一致）',
  '[ltsPatternToRegExp(ltsToMatchPattern("example.com/Admin")).test("https://example.com/Admin/x"), ltsPatternToRegExp(ltsToMatchPattern("example.com/Admin")).test("https://example.com/ADMIN/x")]',
  [true, false]);
check('域名不区分大小写',
  'ltsPatternToRegExp(ltsToMatchPattern("example.com")).test("https://EXAMPLE.com/x")', true);
check('非法 scheme → null', 'ltsToMatchPattern("chrome://settings")', null);
check('match pattern 能命中子域',
  'ltsPatternToRegExp(ltsToMatchPattern("example.com")).test("https://a.b.example.com/x?y=1")', true);
check('match pattern 不命中相似域名',
  'ltsPatternToRegExp(ltsToMatchPattern("example.com")).test("https://notexample.com/")', false);
check('路径限制生效',
  'ltsPatternToRegExp(ltsToMatchPattern("example.com/foo")).test("https://example.com/bar")', false);
check('Accept-Language 生成',
  'ltsToAcceptLanguage(["ja-JP","ja","en"])', 'ja-JP,ja;q=0.9,en;q=0.8');
check('两个语言时第二个是 q=0.9（不是 0.5）',
  'ltsToAcceptLanguage(["ja-JP","ja"])', 'ja-JP,ja;q=0.9');
check('语言串解析（去重 + 过滤非法）',
  'ltsParseLanguages("ja-JP, ja, JA-jp, 中文, en")', ['ja-JP', 'ja', 'en']);
check('站点行解析（含覆盖）',
  '(() => { const s = ltsParseSite("example.com | Asia/Tokyo | ja-JP,ja"); return [s.pattern, s.timezone, s.languages, s.domains, s.overridden]; })()',
  ['*://*.example.com/*', 'Asia/Tokyo', ['ja-JP', 'ja'], ['example.com'], true]);
check('没有覆盖时 overridden = false',
  'ltsParseSite("example.com").overridden', false);
check('第 4 段起会被明确报出来',
  'ltsParseSite("example.com | UTC | ja | extra").warnings.length', 1);
check('注释行被忽略', 'ltsParseSite("# 这是注释")', null);
check('非法时区被标记',
  '(() => { const s = ltsParseSite("example.com | Mars/Olympus"); return [s.timezone, s.errors.length]; })()',
  ['', 1]);
check('按顺序取第一条命中的规则',
  '(() => { const sites = ltsCompileSites(["example.com/a", "example.com"]); const r = ltsResolveSite(sites, "https://example.com/a/b", {timezone:"UTC", languages:["en"]}); return r.site.pattern; })()',
  '*://*.example.com/a*');

console.log('\n[10] 没有端口元素时（isolated 未能先跑）= 完全原生，且不抛错');

{
  const bareNavigator = makeNavigator();
  const bare = {
    console,
    document: {
      documentElement: makeElement('html'),
      createElement: tag => makeElement(tag),
      getElementById: () => null
    },
    navigator: bareNavigator.navigator,
    Navigator: bareNavigator.Navigator,
    Event: FakeEvent,
    setTimeout,
    URL
  };
  bare.window = bare;
  bare.self = bare;
  vm.createContext(bare);
  vm.runInContext(read('common.js'), bare, { filename: 'common.js' });
  let threw = null;
  try {
    vm.runInContext(read('inject/main.js'), bare, { filename: 'inject/main.js' });
  } catch (e) {
    threw = e.message;
  }
  const state = vm.runInContext(
    'JSON.stringify({ lang: navigator.language, off: new Date().getTimezoneOffset() })',
    bare
  );
  if (threw) {
    failed += 1;
    console.log('  FAIL 加载 main.js 抛错：' + threw);
  } else {
    passed += 1;
    console.log('  ok   main.js 在缺少端口时正常加载');
  }
  const parsed = JSON.parse(state);
  if (parsed.lang === 'en-US' && parsed.off === new Date().getTimezoneOffset()) {
    passed += 1;
    console.log('  ok   缺少配置时保持原生行为');
  } else {
    failed += 1;
    console.log('  FAIL 缺少配置时行为异常：' + state);
  }
}

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
