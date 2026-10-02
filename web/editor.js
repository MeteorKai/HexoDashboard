/* editor.js —— 编辑器与预览模块
 * 只做"编辑区 ↔ 预览"这一件事，不碰文章列表、任务、对话框。
 * 通过 app.js 注入的 opts 拿上传能力和当前文章上下文，避免两个文件互相 require。
 *
 * 三个关键点，都跟服务端契约绑定：
 *   1. md 里存的是 Hexo 原生 {% asset_img %} 标签，marked 不认，预览前要还原成图片语法；
 *   2. 还原后的相对路径在预览页面里会解析成站点根，必须改写成 /media/p|d/<文章>/<图>；
 *   3. 预览是 v-html 级别的 HTML 注入，必须过 DOMPurify，否则粘贴带 <img onerror> 的
 *      内容就能在本地页面里执行脚本（vendor 里已经放了 DOMPurify，服务端也路由了 /purify.js）。
 */
'use strict';

window.Editor = (function () {
  const $ = (id) => document.getElementById(id);
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

  let opts = {
    getContext: () => ({ post: '', draft: false }),
    upload: null,           // (blob, filename) => Promise<{markdown, path, reused}>
    importPdf: null,        // (file) => Promise<{stats, hint}>，页面各自决定怎么落地
    onDirty: () => {},
    onToast: () => {},
  };
  let previewWindow = null;
  let publishedTags = [];
  let tagIndex = -1;

  /* 已有文章可能使用其他分类：仅供保留原值，不把打开文章变成修改分类。 */
  function setCategory(value) {
    const field = $('f-categories');
    field.querySelector('option[data-existing]')?.remove();
    if (value && ![...field.options].some(o => o.value === value)) {
      const option = new Option(value + '（原分类）', value);
      option.dataset.existing = 'true';
      field.appendChild(option);
    }
    field.value = value;
  }

  function closeTagSuggestions() {
    $('tagSuggestions').hidden = true;
    $('f-tags').setAttribute('aria-expanded', 'false');
    $('f-tags').removeAttribute('aria-activedescendant');
  }

  function refreshTagSuggestions(show) {
    const value = $('f-tags').value;
    const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf('，'));
    const prefix = value.slice(0, cut + 1);
    const selected = new Set(prefix.split(/[,，]/).map(t => t.trim()));
    const query = value.slice(cut + 1).trim().toLocaleLowerCase();
    const options = publishedTags.filter(t => !selected.has(t) && t.toLocaleLowerCase().includes(query)).map((t, i) => {
      const option = document.createElement('button');
      option.type = 'button'; option.tabIndex = -1; option.id = 'tag-option-' + i;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      option.dataset.tag = t; option.textContent = t;
      return option;
    });
    $('tagSuggestions').replaceChildren(...options);
    tagIndex = -1;
    closeTagSuggestions();
    if (show && options.length) {
      $('tagSuggestions').hidden = false;
      $('f-tags').setAttribute('aria-expanded', 'true');
    }
  }

  function chooseTag(tag) {
    const input = $('f-tags'), value = input.value;
    const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf('，'));
    input.value = (cut < 0 ? '' : value.slice(0, cut + 1) + ' ') + tag;
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeTagSuggestions();
  }

  function setTagSuggestions(posts) {
    const tags = posts.filter(p => !p.draft).flatMap(p => Array.isArray(p.tags) ? p.tags : [p.tags]);
    publishedTags = [...new Set(tags.filter(t => typeof t === 'string').map(t => t.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    refreshTagSuggestions(document.activeElement === $('f-tags'));
  }

  /* ── 字数统计：中日韩按字、拉丁按词，两者相加 ─────────────────────────── */
  function countWords(text) {
    const cjk = (text.match(CJK_RE) || []).length;
    const latin = (text.replace(CJK_RE, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’._-]*/g) || []).length;
    return cjk + latin;
  }

  /* ── {% asset_img 文件 alt %} → ![alt](文件) ────────────────────────────
   * 逐行处理并跳过围栏代码块：直接对全文做正则会把代码示例里的标签也一起换掉。 */
  function expandAssetTags(src) {
    const RE = /\{%[-]?\s*asset_img\s+("[^"]*"|'[^']*'|\S+)([\s\S]*?)%\}/g;
    let fence = null;
    return String(src).split(/\r?\n/).map((line) => {
      const f = /^\s*(```|~~~)/.exec(line);
      if (f) { fence = fence ? null : f[1]; return line; }   // 围栏行本身与块内内容都原样保留
      if (fence) return line;
      return line.replace(RE, (_m, rawFile, rest) => {
        const file = rawFile.replace(/^["']|["']$/g, '');
        const alt = String(rest || '').trim().replace(/^["']|["']$/g, '');
        return `![${alt}](${file})`;
      });
    }).join('\n');
  }

  /* ── 相对图片路径 → /media/p|d/<文章>/<图> ───────────────────────────── */
  function fixPreviewImages(el, ctx) {
    if (!ctx.post) return;
    const prefix = '/media/' + (ctx.draft ? 'd' : 'p') + '/' + encodeURIComponent(ctx.post) + '/';
    el.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:') || src[0] === '/') return;       // 绝对/内联不管
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return;                        // http(s): 等外链不管
      const clean = src.replace(/^\.\//, '');
      img.src = prefix + clean.split('/').map((s) => {
        try { return encodeURIComponent(decodeURIComponent(s)); } catch { return encodeURIComponent(s); }
      }).join('/');
      img.loading = 'lazy';
    });
  }

  /* ── 清洗：DOMPurify 缺失时降级为纯文本，绝不把未清洗的 HTML 塞进 DOM ── */
  function sanitize(html) {
    if (typeof window.DOMPurify === 'undefined') return null;
    return window.DOMPurify.sanitize(html, {
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
      ADD_ATTR: ['target', 'rel', 'loading'],
      /* input 要留着：GFM 任务列表就是 <input type="checkbox" disabled>，禁掉会看不见勾选框。
         form / button / iframe 这些能触发交互或导航的一律禁掉 —— 预览区只该是静态内容。 */
      FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'base', 'meta', 'link'],
      FORBID_ATTR: ['srcdoc'],
    });
  }

  /* ── 渲染预览 ────────────────────────────────────────────────────────── */
  function renderPreview(src, el, ctx) {
    if (typeof window.marked === 'undefined') {
      el.style.whiteSpace = 'pre-wrap';
      el.textContent = src;
      return 'marked 未加载，纯文本模式';
    }
    const html = window.marked.parse(expandAssetTags(src), { breaks: true, gfm: true });
    const clean = sanitize(html);
    if (clean === null) {
      el.style.whiteSpace = 'pre-wrap';
      el.textContent = src;
      return 'DOMPurify 未加载，已降级为纯文本';
    }
    el.style.whiteSpace = 'normal';
    el.innerHTML = clean;
    fixPreviewImages(el, ctx);
    return '';
  }

  /* 只向本编辑页打开的预览标签发送内存中的正文，不要求保存文章。 */
  function render() {
    if (!previewWindow || previewWindow.closed) return;
    const mode = document.documentElement.getAttribute('data-theme');
    previewWindow.postMessage({
      type: 'hexo-preview-update', markdown: $('body').value,
      title: $('f-title').value.trim() || '未命名文章', context: opts.getContext(),
      theme: mode || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    }, location.origin);
  }

  function openPreview() {
    if (!previewWindow || previewWindow.closed) previewWindow = window.open('/preview', '_blank');
    if (!previewWindow) {
      opts.onToast('预览标签页被浏览器拦下了，请允许本站打开弹出窗口后重试', 'err');
      return;
    }
    previewWindow.focus();
    render();
  }

  /* ── 把一段 markdown 放进编辑器 ────────────────────────────────────────
   * 默认插在光标处（PDF 导入在单篇页就是这个用法），replace 为真时整篇替换。
   * 和 uploadBlob 分开写是故意的：图片那条路要额外插 Hexo 的 asset_img 标签，
   * 混在一起会让两边的转义规则互相打架。 */
  function insertText(markdown, replace) {
    const ta = $('body');
    if (!ta) return;
    const text = String(markdown).replace(/\s+$/, '');
    if (replace) {
      ta.value = text + '\n';
      ta.selectionStart = ta.selectionEnd = 0;
    } else {
      const pos = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      const before = ta.value.slice(0, pos);
      const lead = before.trim() && !/\n\s*$/.test(before) ? '\n\n' : '';   // 别和上文粘成一段
      ta.value = before + lead + text + '\n' + ta.value.slice(pos);
      ta.selectionStart = ta.selectionEnd = pos + lead.length + text.length + 1;
    }
    ta.focus();
    render();
    opts.onDirty();
  }

  /* ── 导入 PDF ──────────────────────────────────────────────────────────
   * 解析在**服务端**做（/api/import-pdf，pdf.js 连 cmaps / standard_fonts 都在 vendor/），
   * 这里只负责选文件、把结果交给页面注入的 opts.importPdf 去落地 ——
   * 写作台把它开成一篇新文章，单篇编辑页把它插到光标处。
   * 155 页的 PDF 实测约 0.6 秒，但更大的会到几秒，所以按钮必须显示"解析中"，
   * 否则用户以为没反应会连点。 */
  async function importPdf(file) {
    if (!opts.importPdf) return;
    const btn = $('btnPdf');
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 解析中…'; }
    try {
      const r = await opts.importPdf(file);
      const s = (r && r.stats) || {};
      opts.onToast(`已从 PDF 提取 ${s.chars || 0} 字 · ${s.pages || 0} 页` +
        (s.codeBlocks ? ` · ${s.codeBlocks} 个代码块` : '') +
        (s.kangxi ? ` · 修正 ${s.kangxi} 个部首错字` : '') +
        (r && r.hint ? ` · ${r.hint}` : ''), 'ok');
    } catch (e) {
      opts.onToast((e && e.message) || String(e), 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }

  /* ── 上传：按钮 / 粘贴 / 拖拽 ────────────────────────────────────────── */
  async function uploadBlob(blob, filename) {
    if (!opts.upload) return;
    try {
      const r = await opts.upload(blob, filename);
      const ta = $('body');
      const pos = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      ta.value = ta.value.slice(0, pos) + '\n' + r.markdown + '\n' + ta.value.slice(pos);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos + r.markdown.length + 2;
      render();
      opts.onDirty();
      opts.onToast(r.reused ? '这张图内容相同，已直接复用：' + r.name : '图片已保存：' + r.name, 'ok');
    } catch (e) {
      opts.onToast(e.message, 'err');
    }
  }

  /** 开一个系统文件选择框。两个按钮（插图 / 导入 PDF）共用，免得各写一遍。 */
  function pickFile(accept, onPick) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => { if (inp.files[0]) onPick(inp.files[0]); };
    inp.click();
  }

  function init(options) {
    opts = Object.assign(opts, options || {});
    const body = $('body');

    body.addEventListener('input', () => { render(); });
    $('f-title').addEventListener('input', render);
    const tags = $('f-tags'), tagList = $('tagSuggestions');
    tags.addEventListener('input', () => refreshTagSuggestions(document.activeElement === tags));
    tags.addEventListener('focus', () => refreshTagSuggestions(true));
    tags.parentElement.addEventListener('focusout', e => { if (!tags.parentElement.contains(e.relatedTarget)) closeTagSuggestions(); });
    $('btnTags').addEventListener('click', () => {
      const show = tagList.hidden; tags.focus(); refreshTagSuggestions(show);
    });
    tagList.addEventListener('mousedown', e => e.preventDefault());
    tagList.addEventListener('click', e => {
      const option = e.target.closest('[role="option"]');
      if (option) chooseTag(option.dataset.tag);
    });
    tags.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeTagSuggestions(); e.stopPropagation(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (tagList.hidden) refreshTagSuggestions(true);
        const options = [...tagList.children];
        if (!options.length) return;
        tagIndex = tagIndex < 0 ? (e.key === 'ArrowDown' ? 0 : options.length - 1)
          : (tagIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options.forEach((o, i) => o.setAttribute('aria-selected', String(i === tagIndex)));
        tags.setAttribute('aria-activedescendant', options[tagIndex].id);
        options[tagIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && !tagList.hidden && tagIndex >= 0) {
        e.preventDefault(); chooseTag(tagList.children[tagIndex].dataset.tag);
      }
    });
    document.addEventListener('click', e => { if (!tags.parentElement.contains(e.target)) closeTagSuggestions(); });
    $('f-draft').addEventListener('change', () => queueMicrotask(render));
    $('btnPreview').addEventListener('click', openPreview);
    window.addEventListener('message', (e) => {
      if (e.origin === location.origin && e.source === previewWindow && e.data && e.data.type === 'hexo-preview-ready') render();
    });
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
    window.addEventListener('pagehide', () => {
      if (previewWindow && !previewWindow.closed) previewWindow.postMessage({ type: 'hexo-preview-disconnected' }, location.origin);
    });

    /* Tab 插缩进而不是跳焦点 —— 写 markdown 列表时靠它 */
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const s = body.selectionStart, t = body.selectionEnd;
      body.value = body.value.slice(0, s) + '  ' + body.value.slice(t);
      body.selectionStart = body.selectionEnd = s + 2;
      render();
    });

    $('btnUpload').addEventListener('click', () => pickFile('image/*', (f) => uploadBlob(f, f.name)));

    /* 按钮只在两个页面里存在，但不写死存在性判断的话，
       editor.js 复用给别人时会直接抛在 init 里，整个编辑器都起不来。 */
    const pdfBtn = $('btnPdf');
    if (pdfBtn) pdfBtn.addEventListener('click', () => pickFile('application/pdf,.pdf', importPdf));

    body.addEventListener('paste', (e) => {
      const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((i) => i.type.startsWith('image/'));
      if (!item) return;                       // 纯文本粘贴走默认行为
      e.preventDefault();
      const ext = (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      uploadBlob(item.getAsFile(), 'paste-' + Date.now() + '.' + ext);
    });

    let dragDepth = 0;
    body.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; body.classList.add('drop'); });
    body.addEventListener('dragover', (e) => e.preventDefault());
    body.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; body.classList.remove('drop'); } });
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      body.classList.remove('drop');
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (!files.length) opts.onToast('只支持图片文件', 'err');
      files.forEach((f) => uploadBlob(f, f.name));
    });
  }

  /* 关闭写作台时一并带走预览页：它是本页开的窗口，服务停了留着只会显示连接失败 */
  function closePreview() {
    try { if (previewWindow && !previewWindow.closed) previewWindow.close(); } catch { /* ignore */ }
    previewWindow = null;
  }
  return { init, render, renderPreview, countWords, expandAssetTags, insertText, setCategory, setTagSuggestions, closePreview };
})();
