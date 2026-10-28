/*
 * ISOLATED world，document_start。
 * 作用：把后台解析好的配置写进一个 DOM 端口元素，供 MAIN world 的 main.js 同步读取；
 *      并负责后续的实时更新（配置改动 / 后台广播）。
 */
{
  const PORT_ID = 'lts-prefs-4d7a1';

  const getPort = () => {
    let port = document.getElementById(PORT_ID);
    if (!port) {
      port = document.createElement('span');
      port.id = PORT_ID;
      port.setAttribute('aria-hidden', 'true');
      port.style.setProperty('display', 'none', 'important');
      const root = document.documentElement || document;
      root.appendChild(port);
    }
    return port;
  };

  const port = getPort();

  const write = prefs => {
    if (!prefs || typeof prefs !== 'object') return;
    const timezone = typeof prefs.timezone === 'string' ? prefs.timezone : '';
    const languages = Array.isArray(prefs.languages) ? prefs.languages.join(',') : '';
    if (port.dataset.timezone === timezone && port.dataset.languages === languages) return;
    port.dataset.timezone = timezone;
    port.dataset.languages = languages;
    port.dispatchEvent(new Event('lts-prefs-change'));
  };

  /* 1. 后台在 webNavigation.onCommitted 阶段同步塞进来的值 */
  let prefs = self.ltsPrefs;

  /* 2. 同源子框架可以直接继承父框架的值 */
  if (!prefs && self !== parent) {
    try {
      prefs = parent.ltsPrefs;
    } catch (e) {
      /* 跨域，忽略 */
    }
  }

  if (prefs) {
    write(prefs);
  } else {
    /* 3. 兜底：异步问后台（main.js 会先以「等同本机」的默认值启动，稍后再切换） */
    try {
      chrome.runtime.sendMessage({ method: 'lts-prefs' }, reply => {
        void chrome.runtime.lastError;
        if (reply) write(reply);
      });
    } catch (e) {
      /* ignore */
    }
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.method === 'lts-prefs' && msg.prefs) write(msg.prefs);
  });
}
