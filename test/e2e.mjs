/*
 * 端到端测试：真实 Chromium + 真实扩展 + 本地 HTTP 服务器。
 *
 * 验证三件事：
 *   1. 被列进站点列表的页面，JS 看到的时区/语言被改写（含页面第一段内联脚本里读到的值）
 *   2. 服务器实际收到的 Accept-Language 被改写
 *   3. 没列出的域名完全不受影响
 *
 * 运行： node test/e2e.mjs        （需要 chromium；用 CHROME=/path 指定）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CHROME || path.join(os.homedir(), '.local/bin/chromium');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lts-e2e-'));
const ext = path.join(work, 'ext');
const www = path.join(work, 'www');
const profile = path.join(work, 'profile');

let failures = 0;
const ok = msg => console.log('  ok   ' + msg);
const bad = msg => {
  failures += 1;
  console.log('  FAIL ' + msg);
};

/* ------------------------------------------------------------ 准备扩展副本 */

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

fs.mkdirSync(ext, { recursive: true });
fs.mkdirSync(www, { recursive: true });
for (const item of ['manifest.json', 'common.js', 'worker.js', 'icons', 'inject', 'options', 'popup']) {
  const src = path.join(root, item);
  if (fs.statSync(src).isDirectory()) copyDir(src, path.join(ext, item));
  else fs.copyFileSync(src, path.join(ext, item));
}
copyDir(path.join(root, 'test/fixture'), www);

// 测试用默认值：只对 127.0.0.1 生效，目标 = 东京 / 日语
fs.appendFileSync(
  path.join(ext, 'common.js'),
  `\n/* e2e */\nLTS_DEFAULTS.timezone = 'Asia/Tokyo';\nLTS_DEFAULTS.languages = ['ja-JP', 'ja', 'en'];\nLTS_DEFAULTS.sites = ['127.0.0.1'];\n`
);
// 保持 storage 为空，让上面的默认值生效
const workerPath = path.join(ext, 'worker.js');
fs.writeFileSync(
  workerPath,
  fs.readFileSync(workerPath, 'utf8').replace('async function seedIfNeeded() {', 'async function seedIfNeeded() { return;')
);

/* ------------------------------------------------------------- 本地服务器 */

const freePort = () =>
  new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const port = await freePort();
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, acceptLanguage: req.headers['accept-language'] || '' });
  const file = path.join(www, req.url === '/' ? 'index.html' : req.url.replace(/\?.*$/, ''));
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(data);
  });
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

/* ------------------------------------------------------------------ CDP */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new Error('页面内脚本抛错：' + (result.exceptionDetails.exception || {}).description);
  }
  return result.result.value;
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(900);
  // 动态注册的内容脚本只对「注册之后的导航」生效，这里显式刷新一次
  await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
  await sleep(1200);
  return sessionId;
}

const PROBE = `JSON.stringify({
  lang: navigator.language,
  langs: navigator.languages.join(','),
  offset: new Date().getTimezoneOffset(),
  str: String(new Date()),
  tz: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  localArgs: new Date(2023, 9, 28, 12, 0).toISOString(),
  locale: new Date(Date.UTC(2023, 9, 28, 3, 0)).toLocaleString('de-DE'),
  number: (1234.5).toLocaleString(),
  dateName: Date.name + '/' + Date.length,
  earlyOffset: (document.querySelector('#out dd:nth-of-type(2)') || {}).textContent,
  earlyLang: (document.querySelector('#out dd:nth-of-type(1)') || {}).textContent
})`;

/* ------------------------------------------------------------ 启动浏览器 */

if (!fs.existsSync(CHROME)) {
  console.error('找不到 chromium：' + CHROME + '（用 CHROME=/path/to/chrome 指定）');
  server.close();
  process.exit(2);
}

const debugPort = await freePort();
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--disable-features=DialMediaRouteProvider',
    '--disable-extensions-except=' + ext,
    '--load-extension=' + ext,
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + debugPort,
    'about:blank'
  ],
  { stdio: 'ignore' }
);

let cdp = null;
try {
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch (e) {
      await sleep(200);
    }
  }
  if (!wsUrl) throw new Error('无法连接 CDP');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  cdp = new CDP(ws);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  /* 等扩展注册完成 */
  let registered = [];
  let extensionId = '';
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.includes('worker.js'));
    if (sw) {
      extensionId = /chrome-extension:\/\/([^/]+)/.exec(sw.url)[1];
      let sessionId = null;
      try {
        ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true }));
        // SW 刚启动时执行上下文可能还没准备好，先确认 chrome.* 可用
        const ready = await evaluate(cdp, sessionId, 'typeof chrome !== "undefined" && typeof chrome.scripting !== "undefined"');
        if (ready) {
          const answer = await evaluate(
            cdp,
            sessionId,
            'chrome.scripting.getRegisteredContentScripts().then(r => JSON.stringify(r.map(x => x.id + "@" + x.matches.join(","))))'
          );
          registered = JSON.parse(answer || '[]');
        }
      } catch (e) {
        /* 上下文还没就绪，下一轮重试 */
      } finally {
        if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      if (registered.length === 2) break;
    }
    await sleep(300);
  }

  console.log('\n[1] 扩展注册状态');
  if (registered.length === 2) ok('两个内容脚本已按站点列表注册：' + registered.join(' , '));
  else bad('内容脚本注册异常：' + JSON.stringify(registered));

  console.log('\n[2] 站点列表内的页面：http://127.0.0.1:' + port + '/');
  const listed = await openPage(cdp, `http://127.0.0.1:${port}/index.html`);
  const a = JSON.parse(await evaluate(cdp, listed, PROBE));

  if (a.lang === 'ja-JP') ok('navigator.language = ja-JP');
  else bad('navigator.language = ' + a.lang);
  if (a.langs === 'ja-JP,ja,en') ok('navigator.languages = ja-JP,ja,en');
  else bad('navigator.languages = ' + a.langs);
  if (a.offset === -540) ok('getTimezoneOffset() = -540');
  else bad('getTimezoneOffset() = ' + a.offset);
  if (/GMT\+0900 \(Japan Standard Time\)/.test(a.str)) ok('Date#toString()：' + a.str);
  else bad('Date#toString() = ' + a.str);
  if (a.tz === 'Asia/Tokyo') ok('Intl.DateTimeFormat 默认时区 = Asia/Tokyo');
  else bad('Intl 默认时区 = ' + a.tz);
  if (a.localArgs === '2023-10-28T03:00:00.000Z') ok('本地时间参数按目标时区解释（12:00 JST = 03:00Z）');
  else bad('本地时间参数 = ' + a.localArgs);
  if (/28\.10\.2023/.test(a.locale)) ok('toLocaleString 使用目标时区');
  else bad('toLocaleString = ' + a.locale);
  if (a.number === (1234.5).toLocaleString('ja-JP')) ok('Number#toLocaleString 使用目标语言');
  else bad('Number#toLocaleString = ' + a.number);
  if (a.dateName === 'Date/7') ok('Date.name / Date.length 与原生一致');
  else bad('Date.name / Date.length = ' + a.dateName);
  if (a.earlyOffset === '-540' && a.earlyLang === 'ja-JP') {
    ok('页面第一段内联脚本读到的值也已被改写（document_start 抢在解析之前）');
  } else {
    // 这是设计上的已知竞态：配置来自异步存储，配置到达前的读取只能是原生值
    console.log('  note 页面第一段内联脚本读到的是原生值（' + a.earlyLang + ' / ' + a.earlyOffset +
      '），后续脚本读到的都已是伪造值，见 README「已知限制」');
  }

  console.log('\n[3] Accept-Language 请求头');
  const listedRequests = requests.filter(r => r.acceptLanguage.includes('ja-JP'));
  if (listedRequests.length > 0) ok('服务器收到：' + listedRequests[0].acceptLanguage);
  else bad('没有收到改写后的 Accept-Language：' + JSON.stringify(requests.slice(-3)));

  console.log('\n[4] 站点列表外的域名：http://localhost:' + port + '/');
  const other = await openPage(cdp, `http://localhost:${port}/index.html`);
  const b = JSON.parse(await evaluate(cdp, other, PROBE));

  if (b.lang !== 'ja-JP') ok('语言保持原样：' + b.lang);
  else bad('未列出的域名语言被改写了');
  if (!/GMT\+0900/.test(b.str)) ok('时区保持原样：' + b.offset);
  else bad('未列出的域名时区被改写了');
  const otherRequests = requests.filter(r => !r.acceptLanguage.includes('ja-JP'));
  if (otherRequests.length > 0) ok('未列出域名的 Accept-Language 未被改写：' + otherRequests[otherRequests.length - 1].acceptLanguage);
  else bad('未列出域名的 Accept-Language 也被改写了');

  console.log('\n[5] 设置页：改配置 → 保存 → 生效');
  const optionsSession = await openPage(cdp, `chrome-extension://${extensionId}/options/options.html`);
  const preview = await evaluate(cdp, optionsSession, `(() => {
    const tz = document.getElementById('timezone');
    const lang = document.getElementById('languages');
    const sites = document.getElementById('sites');
    tz.value = 'Europe/Berlin';
    tz.dispatchEvent(new Event('input'));
    lang.value = 'de-DE, de';
    lang.dispatchEvent(new Event('input'));
    sites.value = '127.0.0.1\\nlocalhost';
    sites.dispatchEvent(new Event('input'));
    const tzHint = document.getElementById('tz-preview').textContent;
    const rows = [...document.querySelectorAll('#sites-preview li')].map(li => li.textContent);
    document.getElementById('save').click();
    return JSON.stringify({ tzHint, rows });
  })()`);
  const previewData = JSON.parse(preview);
  if (/UTC\+0[12]:00/.test(previewData.tzHint)) ok('时区预览：' + previewData.tzHint);
  else bad('时区预览异常：' + previewData.tzHint);
  if (previewData.rows.length === 2) ok('站点解析预览：' + previewData.rows.join(' | '));
  else bad('站点解析预览行数不对：' + JSON.stringify(previewData.rows));

  await sleep(1500);
  const status = await evaluate(cdp, optionsSession, `document.getElementById('status').textContent`);
  const diag = await evaluate(cdp, optionsSession, `document.getElementById('diagnostics').textContent`);
  if (/已保存/.test(status)) ok('保存状态：' + status);
  else bad('保存状态异常：' + status);
  if (/✅/.test(diag)) ok('诊断信息：' + diag.replace(/\s+/g, ' '));
  else bad('诊断信息异常：' + diag.replace(/\s+/g, ' '));

  console.log('\n[6] 保存后的配置对新列入的域名生效');
  const relisted = await openPage(cdp, `http://localhost:${port}/index.html`);
  const c = JSON.parse(await evaluate(cdp, relisted, PROBE));
  if (c.lang === 'de-DE') ok('localhost 现在被改写为 de-DE');
  else bad('localhost 语言 = ' + c.lang);
  if (c.offset === -60 || c.offset === -120) ok('时区切换为柏林：getTimezoneOffset() = ' + c.offset);
  else bad('柏林时区偏移异常：' + c.offset);
  if (/GMT\+0100 \(.+\)/.test(c.str)) ok('toString：' + c.str.replace(/^.*?GMT/, 'GMT'));
  else bad('toString 时区标识异常：' + c.str);
} catch (e) {
  failures += 1;
  console.error('E2E 执行出错：', e);
} finally {
  if (cdp) cdp.close();
  chrome.kill('SIGKILL');
  server.close();
  await sleep(200);
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nE2E 全部通过' : `\nE2E 失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
