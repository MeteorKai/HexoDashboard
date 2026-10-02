/* theme.js —— 主题引导
 * 必须在 <head> 里同步执行：等 app.js 跑到再设 data-theme，首帧会闪一下浅色。
 * 服务端 CSP 是 script-src 'self'，不允许内联脚本，所以单独放一个极小的文件。
 * 未显式选择过时不留 data-theme，让 CSS 里的 prefers-color-scheme 生效。 */
(function () {
  var KEY = 'hexo-tool-theme';
  window.__themeKey = KEY;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (e) {
    /* 隐私模式 / 禁用存储：忽略，跟随系统即可 */
  }
})();
