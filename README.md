# Site Language & Timezone Switch

按**站点**切换网页的时区和语言，其它网站完全不受影响。

改一个网站的时区/语言，通常得动整个浏览器或系统设置。这个扩展把范围收窄到
「你列出来的那些域名」：打开列表里的网站时，页面的 JS 会以为自己在另一个时区、另一种语言；
列表外的网站一切照旧。

```
站点列表                     页面看到的世界
─────────────────────────    ────────────────────────────────
google.com      → Asia/Tokyo  navigator.language  = ja-JP
amazon.co.jp    → ja-JP       new Date()          = GMT+0900 (Japan Standard Time)
example.com     → 保持原样     Accept-Language      = ja-JP,ja;q=0.7,en;q=0.3
```

## 功能

- **站点列表**：每行一个站点，支持通配子域、路径、以及行内覆盖时区/语言。
- **时区**：`Date` / `Intl` 全链路——`getTimezoneOffset()`、`getHours()`、`toString()`、
  `toLocaleString()`、`Intl.DateTimeFormat().resolvedOptions()` 全部返回目标时区。
  偏移按**具体时刻**计算，夏令时正确（不是"存配置那一刻"的固定偏移）。
- **语言**：`navigator.language` / `navigator.languages`、`Accept-Language` 请求头
  （服务端渲染的站点靠它）、以及 `Intl` / `toLocaleString` 的默认 locale。
- **实时生效**：改目标时区/语言会立刻推送到已打开的页面；只有增删站点需要刷新。
- **工具栏徽标 + 弹窗**：一键把当前站点加入/移出列表。

## 安装

| 浏览器 | 最低版本 | 方式 |
| --- | --- | --- |
| Firefox | 128（需要 MAIN world 内容脚本） | `about:debugging` → 临时载入 → 选 `manifest.json` |
| Chrome / Edge | 111 | `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 |

安装后浏览器会要求「访问所有网站」的权限——必须给，因为内容脚本和请求头规则要按站点动态注册。
Firefox 里如果在 `about:addons` 的「权限和数据」里关掉了这个权限，扩展页会提示你重新授权。

## 使用

1. 点扩展图标 → **设置**。
2. 填**默认目标**：
   - 时区：`Asia/Tokyo`（留空 = 不改时区）
   - 语言：`ja-JP, ja, en`（留空 = 不改语言；第一个是 `navigator.language`，整串会生成 `Accept-Language`）
3. 填**生效的网站**，每行一个：

   ```
   # 整站（自动包含所有子域）
   google.com

   # 只匹配某个路径
   example.com/shop

   # 行内覆盖默认值：站点 | 时区 | 语言
   amazon.co.jp | Asia/Tokyo | ja-JP,ja
   bbc.co.uk   | Europe/London | en-GB,en
   ```

   也接受 `https://example.com` 这种带 scheme 的写法，以及裸 IP、`file://` 路径。
4. 点**保存**，然后刷新已打开的目标页面。
5. 之后打开列表里的站点，徽标显示 `ON` 即表示已生效。

**验证方式**：把 `webbrowsertools.com` 加进列表，打开 <https://webbrowsertools.com/timezone/>
对比时区；或把本仓库的 `test/fixture/index.html` 用 `python3 -m http.server` 起在本地再访问它。

## 工作原理

三层，从下往上：

1. **`inject/main.js`（MAIN world，`document_start`）** —— 在页面自己的 JS 世界里替换
   `Date`、`Intl.*`、`navigator.language(s)`、`Number#toLocaleString` 等。
   时区偏移用 `Intl.DateTimeFormat` + `formatToParts` 按时刻现算，所以夏令时、半小时时区、
   历史偏移都能对上。
2. **`inject/isolated.js`（ISOLATED world，`document_start`）** —— 把后台解析好的配置写进一个
   DOM 端口元素（`<span id="lts-prefs-…">` 的 `dataset`），main.js 同步读取。浏览器不给扩展跨
   world 传值的通道，这是最便宜的桥。
3. **`worker.js`** —— 读配置、按站点动态 `scripting.registerContentScripts`（所以**只**在列表里
   的站点注入）、生成 `declarativeNetRequest` 规则改写 `Accept-Language`、维护徽标。

配置的到达时序（关键点）：

```
导航提交 → worker 用 executeScript(injectImmediately) 把配置塞进 isolated world 的全局
        → isolated.js 同步写进 DOM 端口   (document_start)
        → main.js 同步读取，安装补丁      (document_start，仍在页面任何脚本之前)
        → 页面自己的脚本开始执行
```

所以正常路径上页面从第一行代码起看到的就是伪装值；只有极少数情况下（见「已知限制」）会漏一拍。

## 相对 `reference/` 两个项目的改进

`reference/spoof-timezone`（MPL-2.0）和 `reference/languageswitch`（GPL-3.0）是这个项目的技术来源，
但实现上有几处刻意的修正：

| 项目 | spoof-timezone / languageswitch | 本扩展 |
| --- | --- | --- |
| 夏令时 | `getTimezoneOffset()` 返回保存配置时算好的固定值 | 按每个时刻现算，DST 正确 |
| 内存 | spoof-timezone 为每个 `Date` 实例压一个闭包进数组，页面活得越久涨得越多 | 用 epoch 标记做惰性失效，不登记实例 |
| `Date()` | 不带 `new` 时返回对象（可被检测） | 按规范返回字符串 |
| 指纹 | `Date.name === 'SpoofDate'`、`Date.length === 0` | `Date.name === 'Date'`、`length === 7`、`constructor` 指回自己 |
| 语言范围 | languageswitch 只改 `navigator`，且全局 | 改 `navigator` + `Intl` 默认 locale + `Accept-Language`，按站点 |
| 跨浏览器 | languageswitch 用 Firefox 专有的 `exportFunction`/`cloneInto` | 统一走 MAIN world 内容脚本 |
| 粒度 | 全局或整站黑白名单 | 站点列表 + 行内覆盖时区/语言 |

## 已知限制

- **极早期的读取可能漏一拍**：配置来自异步存储，如果页面第一段内联脚本在配置到达之前就调用了
  `new Date()` / `navigator.language`，那一次拿到的是原生值；之后的读取都会是伪装值。
  刷新一次即稳定。这是所有"注入式"伪装方案的共同上限（spoof-timezone 同样如此）。
- **Worker 里读不到**：`new Worker()` 里的 `navigator.language` 仍是真实值（内容脚本不注入 worker）。
- **JS 层伪装本质可检测**：`Function.prototype.toString` 检查、属性描述符检查、`Date.toString()`
  与 `Intl` 的细微矛盾都可能露馅。这个项目是"让网站以为你在别处"，不是反检测工具。
- **`Accept-Language` 按域名生效**：DNR 条件用 `requestDomains`（含子域），路径级的站点规则只会
  收窄"注入范围"，不会收窄请求头。因为请求头是站点级决定渲染语言的，路径级改写会互相打架。
- **只管 HTTP(S) 文档与页面 JS**：不会改变 CSS/字体/图片、`User-Agent`、`Sec-CH-*` 等其它信号。
- **无 tab 归属的请求**：service worker / preload 发出的请求不属于任何标签页，规则按域名照常匹配。
- **扩展更新后**需要重新加载目标页面。

## 开发

```bash
make build      # 生成 dist/site-language-timezone-switch-<version>.{zip,xpi}
make test       # 69 项：时区/语言伪造逻辑 + 站点解析（vm 沙箱）
make e2e        # 真机 E2E：Chromium 加载扩展 + 本地服务器
make check      # 语法检查 + 冒烟测试 + 打包自检
make icons      # 重新生成图标
```

`make build` 只打包运行期必需的文件（`test/`、`tools/`、`reference/`、`.pi/` 一律不进包），
固定时间戳 + 排序，同样的源码永远产出同样的字节；`.zip` 上传 Chrome Web Store，
`.xpi` 上传 AMO（两者内容完全相同，只是扩展名不同）。

- `test/smoke.test.mjs` 不需要浏览器，覆盖 DST、半小时时区、本地时间参数语义、
  `Date()` 规范行为、站点列表解析等。
- `test/e2e.mjs` 用 CDP 驱动真实 Chromium：验证「列表内被改写 / 列表外不受影响 /
  服务器收到改写后的 Accept-Language」，并实际操作一遍设置页完成"改配置 → 保存 → 新域名生效"。

## 文件结构

```
manifest.json          MV3；Chrome 用 service_worker，Firefox 用 background.scripts
common.js              共享工具（站点解析、语言标签、时区偏移），三端复用
worker.js              后台：注册内容脚本 / 生成 DNR 规则 / 徽标 / 消息接口
inject/isolated.js     ISOLATED world：配置 → DOM 端口
inject/main.js         MAIN world：Date / Intl / navigator 补丁
options/               设置页
popup/                 工具栏弹窗
test/                  冒烟测试、E2E、fixture 页面
tools/make-icons.py    图标生成
tools/pack.py          打包（.zip / .xpi，可复现）
Makefile              build / test / e2e / check / icons / clean
```

## 许可

MPL-2.0（见 `LICENSE`）。技术上派生自 [spoof-timezone](https://github.com/agarwalrounak/spoof-timezone)
（MPL-2.0）与 [languageswitch](https://github.com/M-Reimer/languageswitch)（GPL-3.0，
**没有**复制其代码，只参考了思路）。详见 `NOTICE.md`。
