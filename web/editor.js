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
   * 逐行处理并跳过围栏代码块：直接对全文做正则会把代码示例里的标签也一起换掉。
   *
   * 围栏的配对规则必须**和 marked 完全一致**，否则这里的"在不在代码块里"会和
   * 真正渲染时的判断错开，出现两种相反的毛病：
   *   · 把代码块里的 asset_img 当正文展开（漏判"还在块内"）；
   *   · 把正文里的 asset_img 当代码块内容不展开（误判"还在块内"）。
   *
   * 实测踩到的那个坑（问题就出在下面这行配对逻辑上）：
   *   写成 `fence = fence ? null : f[1]` —— 只看"是不是围栏行"，不看**类型**。
   *   于是 ` ``` ` 开启、`~~~` 闭合时，这一行被当成合法的闭合，fence 提前清空；
   *   可 marked（CommonMark 规范）要求**闭合围栏与开启围栏同类型、且不短于开启长度**，
   *   它不认 `~~~` 能闭 ` ``` `，于是继续往下吃到下一个 ` ``` ` —— 两个代码块
   *   就合并成了一个（实测：4 个围栏行只渲染出 1 个 `<pre>`，中间那行 `~~~` 还
   *   原样留在了代码内容里）。
   *
   * 所以这里改成"按开启时的类型与长度来配对"：只有同行类型、且长度 >= 开启长度的
   * 围栏才算闭合。这也顺带修好了 ` ``` ` / `~~~~` 这种长度不同的写法。 */
  function expandAssetTags(src) {
    const RE = /\{%[-]?\s*asset_img\s+("[^"]*"|'[^']*'|\S+)([\s\S]*?)%\}/g;
    let fence = null;                       // { ch, len } —— 开启中的围栏；null 表示不在代码块里
    return String(src).split(/\r?\n/).map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        const marker = f[1];
        /* 反引号围栏的行内不能含有反引号（CommonMark 规定），这种行不是围栏。
           不排掉的话，正文里偶尔出现的 ``` 会被误当成围栏，后面的正文全被跳过。 */
        if (!(marker[0] === '`' && line.includes('`', f.index + marker.length))) {
          if (!fence) fence = { ch: marker[0], len: marker.length };
          else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;
          return line;                     // 围栏行本身一定原样保留
        }
      }
      if (fence) return line;              // 块内内容原样保留
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

  /* ── 围栏自愈：把"闭不上的代码块"修好 ─────────────────────────────────
   * 场景（用户实测报上来的）：从 PDF / 网页复制两段代码，围栏符号混用 ——
   *    ```go … ~~~        ← 想用 ~~~ 闭合，但 CommonMark 不认
   *    ```js … ```
   * marked 会把第一个 ` ``` ` 一直吃到下一个 ` ``` `，两个代码块**合并成一个**，
   * 中间那行 `~~~` 还留在代码内容里。用户看到的就是"两个代码块被合并了"。
   *
   * 为什么不去改 marked：那是 vendor 里的第三方库，改了就再也升不了级；
   * 而且合并本身**符合规范**，是我们（写作台）该在写之前就把语法规整好。
   *
   * 做法：扫一遍，按"开启→最近的一个**同类型**围栏算闭合"配对；
   *   · 若全都配上了 → 一个字符都不动（正常的 md 绝不能被改）；
   *   · 若留下**未闭合**的开启围栏（奇数个），说明这份 md 有问题（多为粘贴来的），
   *     就把**所有**围栏统一成同一类型与同一长度（取出现次数最多的那个），
   *     让每个开启都能配上一个闭合。
   * 只在"确实有未闭合"时才动手，这是关键 —— 否则会把 `~~~` 和 ` ``` ` 各自
   * 独立成块的合法写法毁掉。 */
  function normalizeFences(src) {
    const lines = String(src).split(/\r?\n/);
    const spots = [];                       // { i, marker }
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
      if (!m) continue;
      // 反引号围栏的同行不能含反引号（CommonMark），这种行不是围栏
      if (m[2][0] === '`' && m[3].includes('`')) continue;
      spots.push({ i, indent: m[1], marker: m[2], info: m[3] });
    }
    if (!spots.length) return String(src);

    /* 按 CommonMark 配对：同类、且闭合不短于开启。配不上的那个就是"没闭合"。 */
    let open = null;
    const paired = new Set();
    for (const s of spots) {
      if (!open) { open = s; continue; }
      if (s.marker[0] === open.marker[0] && s.marker.length >= open.marker.length) {
        paired.add(open.i); paired.add(s.i);
        open = null;
      }
    }
    if (!open) return String(src);          // 全部配对成功：一个字都不动

    /* 有未闭合的 → 统一化。选"出现次数最多、并列时最长"的那种围栏。
       长一点更安全：`~~~` 永远不会和内容里的反引号打架。 */
    const tally = new Map();
    for (const s of spots) {
      const key = s.marker[0].repeat(Math.min(s.marker.length, 4));
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    let best = '```';
    for (const [k, n] of tally) {
      const bn = tally.get(best) || 0;
      if (n > bn || (n === bn && k.length > best.length)) best = k;
    }
    for (const s of spots) lines[s.i] = s.indent + best + s.info;
    return lines.join('\n');
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
    /* 顺序不能反：先规整围栏（把闭不上的代码块修好），再展开 asset_img 标签。
       反过来的话，`expandAssetTags` 会按**修好之前**的围栏判断"哪段在代码块里"，
       而它和 marked 的配对规则现在是一致的 —— 但两处判断的对象必须是同一份文本，
       否则还是会错开一行。 */
    const html = window.marked.parse(expandAssetTags(normalizeFences(src)), { breaks: true, gfm: true });
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

  /* ── 把算好的文本写回 textarea ─────────────────────────────────────────
   * 只替换"真正变了的那一段"：先用公共前缀/后缀夹出差异区间，再走
   * execCommand('insertText')。这么做唯一的目的就是保住撤销栈 ——
   * 快捷键改的是整行，一次误触要能 Ctrl+Z 撤回来。 */
  function writeBack(ta, next, start, end) {
    const prev = ta.value;
    if (prev === next) { ta.setSelectionRange(start, end); return; }
    let head = 0;
    const max = Math.min(prev.length, next.length);
    while (head < max && prev[head] === next[head]) head++;
    let tail = 0;
    const room = max - head;
    while (tail < room && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    const from = head;
    const to = prev.length - tail;
    const insert = next.slice(from, next.length - tail);

    ta.focus();
    ta.setSelectionRange(from, to);
    let ok = false;
    try {
      /* 空串不能用 insertText（浏览器当空操作），纯删除走 delete */
      ok = insert ? document.execCommand('insertText', false, insert) : document.execCommand('delete');
    } catch { ok = false; }
    if (!ok || ta.value !== next) ta.value = next;   // 不支持就硬写：撤销栈没了，但功能还在
    ta.setSelectionRange(start, end);
  }

  /** Tab / Shift+Tab 该整行缩进，还是只在光标处加减空格。 */
  function blockIndentWanted(ta, s, t) {
    /* 多行选区，或者选区从行首开始 → 整行 */
    if (t > s) return ta.value.slice(s, t).includes('\n') || s === 0 || ta.value[s - 1] === '\n';
    const { from, to } = MdKeys.lineRange(ta.value, s, t);
    if (!ta.value.slice(from, s).trim()) return true;              // 光标还在行首空白里
    return /^[ \t]*(?:[-*+][ \t]|[-*+][ \t]+\[[ xX]\]|\d+\.[ \t]|>[ \t]?)/.test(ta.value.slice(from, to));
  }

  /* ── 快捷键速查面板 ────────────────────────────────────────────────────
   * 内容直接来自 MdKeys.SHORTCUTS —— 键位表和界面只有一份，不会写着写着对不上。
   * 面板只在主写作台存在（post.html 没有这个按钮），所以每处都要判空。 */
  function toggleKeys(show) {
    const modal = $('keysModal');
    if (!modal) return;
    if (!modal.querySelector('.krow')) {
      const list = $('keysList');
      const extra = [
        { keys: 'Enter', label: '列表 / 引用自动续行（空列表项上按则退出列表）' },
        { keys: 'Ctrl S', label: '保存' },
      ];
      list.innerHTML = MdKeys.SHORTCUTS.concat(extra).map((s) => (
        '<div class="krow"><kbd>' + s.keys.replace(/</g, '&lt;') + '</kbd>'
        + '<span>' + s.label.replace(/</g, '&lt;') + '</span></div>'
      )).join('');
    }
    modal.classList.toggle('show', show == null ? !modal.classList.contains('show') : show);
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

    /* ── Markdown 编辑快捷键 ──────────────────────────────────────────────
     * 键位表 + 纯逻辑都在 mdkeys.js，这里只负责"认键 → 算新文本 → 写回去"。
     *
     * 写回**不能直接 `ta.value = ...`**：那会清空浏览器自带的撤销栈，
     * 按完 Ctrl+1 再按 Ctrl+Z 就回不去了。writeBack() 改成只替换真正变了的那一段、
     * 并且走 execCommand('insertText') —— 它和用户手敲是同一条通道，
     * 撤销栈和 input 事件都在。只有浏览器不支持时才退回硬写。
     *
     * 每条快捷键都命中"整行/整块"语义：光标停在一行中间按 Ctrl+1，
     * 整行都变标题，而不是只给光标后面加 #。 */
    body.addEventListener('keydown', (e) => {
      /* 输入法正在组合（中文候选框开着）：这些按键是给输入法的，抢了会打不出字。
         keyCode 229 是老浏览器的同一信号。 */
      if (e.isComposing || e.keyCode === 229 || !window.MdKeys) return;
      const s = body.selectionStart, t = body.selectionEnd;

      /* 回车：列表 / 引用自动续行；在空列表项上按回车则退出列表 */
      if (e.key === 'Enter' && s === t && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const cont = MdKeys.continueOnEnter(body.value, s);
        if (!cont) return;
        e.preventDefault();
        if (cont.endList) {
          /* 这一行只剩标记了，用户的意思是"列表写完了" —— 把标记删掉留下空行 */
          writeBack(body, body.value.slice(0, cont.from) + body.value.slice(cont.to), cont.from, cont.from);
        } else {
          const at = s + cont.insert.length;
          writeBack(body, body.value.slice(0, s) + cont.insert + body.value.slice(s), at, at);
        }
        render();
        opts.onDirty();
        return;
      }

      const action = MdKeys.match(e);
      if (!action) return;

      /* Tab 的两副面孔：列表项、引用行、行首、多行选区 → 整行缩进；
         普通段落中间 → 只插两个空格。不这么分，在正文句子中间按 Tab
         会把整行顶出去，写东西时很别扭。 */
      if ((action === 'indent' || action === 'outdent') && !blockIndentWanted(body, s, t)) {
        e.preventDefault();
        if (action === 'indent') {
          writeBack(body, body.value.slice(0, s) + '  ' + body.value.slice(t), s + 2, s + 2);
        } else {
          const cut = (/ {1,2}$/.exec(body.value.slice(Math.max(0, s - 2), s)) || [''])[0].length;
          if (!cut) return;                          // 光标前没空格，反缩进无事可做
          writeBack(body, body.value.slice(0, s - cut) + body.value.slice(t), s - cut, s - cut);
        }
        render();
        opts.onDirty();
        return;
      }

      const res = MdKeys.apply(action, body.value, s, t);
      if (!res) return;
      e.preventDefault();
      writeBack(body, res.text, res.start, res.end);
      render();
      opts.onDirty();
    });

    /* Ctrl+/ 开合速查面板。挂在 document 上：光标不在正文里（比如刚点过文章列表）也能开。 */
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Slash' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (!$('keysModal')) return;
      e.preventDefault();
      toggleKeys();
    });
    if ($('btnKeys')) $('btnKeys').addEventListener('click', () => toggleKeys());
    if ($('btnCloseKeys')) $('btnCloseKeys').addEventListener('click', () => toggleKeys(false));
    if ($('keysModal')) $('keysModal').addEventListener('click', (e) => { if (e.target.id === 'keysModal') toggleKeys(false); });

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
  return { init, render, renderPreview, countWords, expandAssetTags, normalizeFences, insertText, setCategory, setTagSuggestions, closePreview };
})();
