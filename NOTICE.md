# NOTICE

本扩展是全新实现，不含上游代码，但设计上明显受益于 `reference/` 下的两个项目：

## spoof-timezone (MPL-2.0)

- <https://github.com/agarwalrounak/spoof-timezone>
- 采用的想法：MAIN world 内 patch `Date` / `Intl.DateTimeFormat`；
  用「DOM 元素 + dataset」作为 ISOLATED → MAIN 的配置通道（跨 world 传值没有直接 API）；
  `webNavigation.onCommitted` + `executeScript({injectImmediately})` 做 document_start 预注入；
  用 `toLocaleString(..., {timeZoneName: 'longOffset'})` 推导时区偏移。
- 明确不同的实现：偏移按时刻现算（DST 正确）、`Date` 实例不登记到数组、`Date()` 符合规范、
  `Date.name`/`length`/`constructor` 与原生一致。

## languageswitch (GPL-3.0)

- <https://github.com/M-Reimer/languageswitch>
- 采用的想法：`Accept-Language` 头按权重生成 `q` 值；切换语言后广播给已打开的标签页。
- 没有复制其任何代码。它使用 Firefox 专有的 `cloneInto` / `exportFunction` / `wrappedJSObject`，
  本项目改用 MAIN world 内容脚本，以同时兼容 Chromium。

## 许可

本仓库以 MPL-2.0 发布（见 `LICENSE`）。如果你要合并上游 `spoof-timezone` 的源文件，
那些文件必须继续保持 MPL-2.0；`languageswitch` 是 GPL-3.0，合并其代码会让整个项目变成 GPL-3.0。
