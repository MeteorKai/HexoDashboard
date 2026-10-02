/* 独立只读预览，只接收打开本标签页的同源编辑页，不访问或保存博客。 */
'use strict';
(function () {
  const status = document.getElementById('previewStatus');
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !window.opener || e.source !== window.opener || !e.data) return;
    const data = e.data;
    if (data.type === 'hexo-preview-disconnected') {
      status.textContent = '编辑页已关闭或刷新，当前保留最后一次预览。请从编辑页重新打开预览。';
      return;
    }
    if (data.type !== 'hexo-preview-update' || typeof data.markdown !== 'string') return;
    const title = String(data.title || '未命名文章');
    document.getElementById('previewTitle').textContent = title;
    document.title = title + ' · 实时预览';
    if (data.theme === 'light' || data.theme === 'dark') document.documentElement.setAttribute('data-theme', data.theme);
    const preview = document.getElementById('preview');
    document.getElementById('previewWarn').textContent = window.Editor.renderPreview(data.markdown, preview, data.context || {});
    preview.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noreferrer'; });
    status.textContent = '实时同步 · 尚未保存的修改也会显示';
  });
  document.getElementById('btnClosePreview').addEventListener('click', () => window.close());
  if (window.opener) window.opener.postMessage({ type: 'hexo-preview-ready' }, location.origin);
})();
