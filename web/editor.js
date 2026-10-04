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
    importMd: null,         // (formData, baseName) => Promise<{stats, hint}>，同上
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

  /* ── 导入 Markdown ──────────────────────────────────────────────────────
   * 和 PDF 那条路并列：选文件 → 交给页面注入的 opts.importMd 去落地。
   *
   * 为什么必须"md 和图片一起选"，不能只选一个 .md：
   *   浏览器只给字节，不给"这个文件旁边的目录"。md 里的 `![x](assets/a.png)`
   *   只是一串相对路径，服务端手上没有那串路径对应的字节，就只能把引用原样留下 ——
   *   生成出来是一条死链，而且死得很安静（页面上只是个裂图，没有任何报错）。
   *   所以导入口子做成**多选**：md + 图片一起进。
   *
   * 图片在子目录里（Typora 导出的 `xxx.assets/`）时，多选是够不着的 ——
   * Windows 的文件框只能在一个目录里多选。所以另有「导入 MD 目录」：
   * 整目录带 **相对路径** 进来（webkitRelativePath），服务端按相对路径去对号。 */
  const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;
  const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|tiff?)$/i;
  const MD_TOTAL_MAX = 60 * 1024 * 1024;      // 一次导入的总体积（md 很小，主要是图）
  const MD_FILE_MAX = 300;                    // 一次最多带多少张图

  /* md 里"本地图片引用"的**粗略**计数。只用来在导入**之前**提醒用户把图片一起选上，
     所以宁可数多了也不能数漏了 —— 精确判定是服务端的事（那边漏一张才是真漏一张）。 */
  const REMOTE_RE = /^(?:https?:)?\/\//i;
  /* "这张图**不需要**你另外选文件"的三种写法：
       · data: 内嵌 base64 —— 字节本来就在 md 里；
       · 本机绝对路径（file:///C:/… 或 C:\…）—— 服务端能自己读；
       · 外链 —— 本来就不复制。
     这三种都不该触发"你没选图片"的提醒，否则一份自包含的 md 也会被拦下来。 */
  function needsNoFile(t) {
    const s = String(t || '').trim().replace(/^<|>$/g, '');
    return !s || REMOTE_RE.test(s) || /^data:/i.test(s)
      || /^(?:file:\/\/\/?)?[A-Za-z]:[\\/]/i.test(s) || /^file:\/\//i.test(s);
  }
  function imageRefText(text) {
    let fence = null;
    return String(text || '').split(/\r?\n/).map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f && !(f[1][0] === '`' && line.includes('`', f.index + f[1].length))) {
        if (!fence) fence = { ch: f[1][0], len: f[1].length };
        else if (f[1][0] === fence.ch && f[1].length >= fence.len) fence = null;
        return '';
      }
      return fence ? '' : line.replace(/(`+)[\s\S]*?\1(?!`)/g, '');
    }).join('\n');
  }
  function imageBase(target) {
    let t = String(target || '').trim().replace(/^<|>$/g, '').replace(/[?#].*$/, '');
    try { t = decodeURIComponent(t); } catch { /* 普通文件名 */ }
    return t.replace(/\\/g, '/').split('/').pop().toLowerCase();
  }
  function countLocalImageRefs(text, mode, onTarget) {
    const s = imageRefText(text);
    let n = 0;
    /* 引用式定义表要先建：`![alt][id]` / `![id]` 里的 id 只是个名字，
       地址在 `[id]: assets/a.png` 那一行。**不建表就数不出来** ——
       实测漏掉的后果是"只选 md 时一句话都不说"，服务端那边也照旧报缺图，
       用户事前毫不知情（正是这轮要消灭的那类静默失败）。 */
    const defs = new Map();
    for (const m of s.matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)/gim)) {
      const id = String(m[1]).trim().toLowerCase();
      if (!defs.has(id)) defs.set(id, m[2]);            // 首条定义生效，和 marked 一致
    }
    const add = (t) => {
      const target = String(t || '').trim().replace(/^<|>$/g, '');
      if (target && onTarget && !REMOTE_RE.test(target) && !/^data:/i.test(target)) onTarget(target);
      if (!needsNoFile(t)) n++;
    };
    for (const m of s.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|(?:\\.|[^()\n]|\([^()\n]*\))+?)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) add(m[1]); // ① 行内式
    /* ② 引用式 ![alt][id] —— 必须排在折叠式前面，否则 `![alt][id]` 会被当成折叠式
       `![alt]` 而漏掉（marked 也是先认这种） */
    for (const m of s.matchAll(/!\[[^\]]*\]\[([^\]\n]*)\]/g)) {
      add(defs.get(String(m[1] || '').trim().toLowerCase()) || '');
    }
    /* ③ 折叠式 ![id]：id 就是定义名，但**上面那条已经吃掉 `![x][y]`**，
       所以这里只可能匹配到没有第二对方括号的那种。 */
    for (const m of s.matchAll(/!\[([^\]\n]+)\]/g)) add(defs.get(String(m[1]).trim().toLowerCase()) || '');
    if (mode !== 'markdown') {
      for (const m of s.matchAll(/!\[\[([^|\]]+)(?:\|[^\]]*)?\]\]/g)) {
        if (IMG_EXT_RE.test(imageBase(m[1]))) add(m[1]);    // 笔记 / PDF 嵌入不是图片
      }
    }
    for (const m of s.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      add(m[1] || m[2] || m[3] || '');
    }
    for (const m of s.matchAll(/\{%[-]?\s*asset_img\s+("[^"]*"|'[^']*'|\S+)/g)) add(m[1].replace(/^["']|["']$/g, ''));
    return n;
  }

  /** FileList → FormData。md 单独占一个字段，图片以 `f:<相对路径>` 为字段名，
   *  这样子目录里的图也能对上号（文件名相同但目录不同也不会互相顶掉）。
   *
   *  为什么是 async：要先读一遍 md 才知道"里面到底有没有本地图片引用" ——
   *  没选图片就导入的话，服务端手上没有字节，那些引用只能原样留着（发布后全是裂图），
   *  而页面上只是"导入成功"，用户事后很难发现。**在动手之前说清楚**比事后补救强。 */
  async function buildImportForm(files, extra) {
    const o = extra || {};
    const list = [...(files || [])];
    /* 一个文件夹里往往躺着好几篇笔记（选的是文件夹时更是如此）。
       不能随手捡第一个 —— 必须问用户，否则"导错了篇"比"没导成"更难发现。 */
    const candidates = o.md ? [o.md] : list.filter((f) => MD_EXT_RE.test(f.name));
    if (!candidates.length) throw new Error('没有找到 .md / .markdown 文件');
    let md = candidates[0];
    if (candidates.length > 1) {
      /* 带上相对路径：正文里引用 `assets/a.png` 的是哪一篇，看路径一眼就知道 */
      const named = candidates.slice(0, 20).map((f, i) =>
        `　${i + 1}. ${String(f.webkitRelativePath || f.name)}`).join('\n');
      const pick = await opts.chooseMd(
        `这个文件夹里有 ${candidates.length} 个 Markdown 文件，要导入哪一篇？\n\n${named}` +
        (candidates.length > 20 ? `\n　… 还有 ${candidates.length - 20} 个` : ''),
        candidates.map((f) => [String(f.webkitRelativePath || f.name), f]),
      );
      if (!pick) throw new Error('已取消导入');
      md = pick;
    }
    const relOf = (f) => String(f.webkitRelativePath || f.name || '').replace(/\\/g, '/');
    const mdText = await md.text().catch(() => '');
    if (!mdText.trim()) throw new Error('这个 Markdown 文件是空的');
    if (o.mode === 'markdown' && /!\[\[([^|\]]+)(?:\|[^\]]*)?\]\]/g.test(imageRefText(mdText))) {
      throw new Error('文档含有 ![[…]] 嵌入语法，请选择「Obsidian 笔记」模式');
    }
    const referenced = new Set();
    const refs = countLocalImageRefs(mdText, o.mode, (t) => referenced.add(imageBase(t)));
    /* 补选的是图片目录，不再让其中的其他 Markdown 抢走已选文章。
       如果目录中恰好包含这篇文档，用它的相对路径作为解析基准。 */
    const sameMd = list.filter((f) => f !== md && f.name === md.name && f.size === md.size);
    let mdRel = relOf(md);
    if (sameMd.length === 1 && await sameMd[0].text() === mdText) mdRel = relOf(sameMd[0]);
    const form = new FormData();
    form.append('mdrel', mdRel);
    form.append('mdmode', o.mode || 'auto');
    /* 用读出来的文本建 Blob 而不是再挂一次 File：md 只读一遍，
       避免"判断引用数"和"真正上传"读到不一致的内容。 */
    form.append('md', new Blob([mdText], { type: 'text/markdown' }), md.name);
    let n = 0, total = md.size;
    if (total > MD_TOTAL_MAX) throw new Error(`Markdown 文件超过 ${Math.round(MD_TOTAL_MAX / 1048576)}MB`);
    for (const f of list) {
      if (f === md) continue;
      if (!IMG_EXT_RE.test(f.name)) continue;
      if (!referenced.has(f.name.toLowerCase())) continue;
      total += f.size;
      if (total > MD_TOTAL_MAX) throw new Error(`这一批文件超过 ${Math.round(MD_TOTAL_MAX / 1048576)}MB，请分批导入`);
      if (++n > MD_FILE_MAX) throw new Error(`一次最多带 ${MD_FILE_MAX} 张图`);
      /* 第三个参数只留文件名：相对路径已经写在字段名里了，
         塞进 filename 会被浏览器按路径处理，反而丢掉目录信息。 */
      form.append('f:' + relOf(f), f, f.name.split(/[\\/]/).pop());
    }
    return { form, name: md.name.replace(MD_EXT_RE, ''), images: n, refs };
  }

  function showMdImport() {
    $('mdImportError').hidden = true;
    $('mdImportModal').classList.add('show');
    updateMdImportHint();
    $('mdImportMode').focus();
  }
  function closeMdImport() {
    if ($('btnConfirmMdImport').disabled) return;
    $('mdImportModal').classList.remove('show');
    $('btnMd').focus();
  }
  function updateMdImportHint() {
    $('mdImportHint').textContent = $('mdImportMode').value === 'obsidian'
      ? '识别 ![[图片.png]]、![[图片.png|宽度]]，也兼容普通图片语法。请选择文档及其图片文件夹。'
      : '识别 ![说明](图片路径)、引用式图片和 HTML 图片。本机绝对路径与内嵌 base64 图片自动读取；相对路径图片需补选图片文件夹。';
  }
  async function submitMdImport() {
    const error = $('mdImportError');
    error.hidden = true;
    const md = $('mdImportFile').files[0];
    const mode = $('mdImportMode').value;
    const list = [...$('mdImportImages').files];
    const submit = $('btnConfirmMdImport');
    try {
      if (!md || !MD_EXT_RE.test(md.name)) throw new Error('请先选择一个 Markdown 文档');
      submit.disabled = true;
      const built = await buildImportForm([md, ...list], { md, mode });
      if (built.refs > 0 && built.images === 0) {
        throw new Error('文档引用了相对路径图片，请选择图片所在的文件夹（Obsidian 通常是 assets），再点击导入');
      }
      const imported = await importMarkdown(null, { built, noAutoDir: true });
      if (imported) {
        $('mdImportModal').classList.remove('show');
        $('mdImportFile').value = '';
        $('mdImportImages').value = '';
        $('body').focus();
      }
    } catch (e) {
      error.textContent = (e && e.message) || String(e);
      error.hidden = false;
    } finally { submit.disabled = false; }
  }

  async function importMarkdown(files, extra) {
    if (!opts.importMd) return;
    const btn = $('btnMd');
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 导入中…'; }
    try {
      /* 选完之后先看一眼这个目录是不是像个博客：是的话顺手问一句要不要切过去。
         问在导入**之前** —— 因为博客目录不同，图片该落到哪、目录名怎么算都不一样。 */
      const dirPath = extra && extra.dirPath;
      if (dirPath && looksLikeBlog(files) && String(dirPath).replace(/[\\/]+$/, '') !== String(opts.blogDir || '').replace(/[\\/]+$/, '')) {
        if (window.confirm(
          '你选中的这个文件夹看起来是一个 Hexo 博客目录：\n' + dirPath + '\n\n' +
          '（里面有 _config.yml 和 source/）\n\n' +
          '写作台现在指向的是：\n' + (opts.blogDir || '（还没设置）') + '\n\n' +
          '点「确定」→ 打开设置把这个目录填进去（还要你点一下「保存设置」才会生效）；\n' +
          '点「取消」→ 照旧导入，文章还是进原来那个博客。')) {
          opts.onOpenBlogSettings(dirPath);
          return;
        }
      }
      const built = (extra && extra.built) || await buildImportForm(files);
      /* 一份带图的 md 却一张图都没选进来 —— 这是最容易踩的一个坑：
         浏览器只给字节、不给"图片在哪个目录"，服务端没有字节可复制。
         文件选择框一次只能在一个目录里多选，图片在 assets/ 这类子目录里时够不着 ——
         用户以为选了，其实只选了 md。
         以前这里先弹一道确认框、点「确定」再开选择框，实测有个致命细节：
         showDirectoryPicker 必须在**用户操作的几秒内**调用，等用户读完确认框点确定，
         激活早过期了，调用被浏览器拒绝，而拒绝又被吞成"用户取消" ——
         点了确定什么都没发生（用户截图抓到的就是这一幕）。
         所以现在**不问了，直接开**：文件刚选完、激活还热着，成功率最高；
         真开不出来才降级到确认框。 */
      if (!(extra && extra.noAutoDir) && built.refs > 0 && built.images === 0) {
        /* 走到这里说明 md 里的图是**外部文件引用**（内嵌 base64 与本机路径不会到这儿，
           countLocalImageRefs 已经把它们排除 —— 那两种一个 md 就够、早就成功了）。 */
        opts.onToast(
          `这篇 md 引用了 ${built.refs} 张没有一起选进来的图片 —— 正在打开文件夹选择框，` +
          '请选中装着 md 的那一层（图片在其旁边的子文件夹里也没关系，会一起带进来）。\n' +
          '取消 = 只导入文字，那些图片会是裂图。', 'warn');
        const st = await openImportPicker({ directory: true });
        if (st === 'picked') return;
        if (st === 'fail') {
          const go = window.confirm(
            `这份 Markdown 里有 ${built.refs} 处图片引用指向 md 旁边的文件（比如 assets/ 子文件夹），` +
            '但你没有选中任何图片文件 —— 文件选择框一次只能在一个文件夹里多选，够不着。\n\n' +
            '点「确定」→ 再开一个文件夹选择框：选**装着 md 的那一层**。\n' +
            '点「取消」→ 只导入文字，那些图片会是裂图。');
          if (go) {
            /* 直接用 input 那条路：能走到这儿说明 showDirectoryPicker 刚被拒过
               （用户激活没了），再调它还是被拒 —— input.click() 不挑时机。 */
            pickFile('', (fs2) => { importMarkdown(fs2, { noAutoDir: true }); }, { directory: true });
            return;
          }
        }
        /* cancel（用户主动取消文件夹选择框）→ 落到下面照旧导入，图会缺、提示里会点名 */
      }
      const r = await opts.importMd(built.form, built.name);
      const s = (r && r.stats) || {};
      const missList = (r && r.missingFiles) || [];
      const missName = missList.length ? `（${missList.slice(0, 3).join('、')}${missList.length > 3 ? ' 等' : ''}）` : '';
      const msg = `已导入 ${s.chars || 0} 字` +
        (s.images ? ` · ${s.images} 张图已复制进文章资源目录` : '') +
        (s.embedded ? `（其中 ${s.embedded} 张是从 md 里内嵌的 base64 抽出来的）` : '') +
        (s.localPath ? `（其中 ${s.localPath} 张是照 md 里写的本机路径读出来的）` : '') +
        (s.missing ? ` · ${s.missing} 张图没找到${missName}` : '') +
        (s.ambiguous ? ` · ${s.ambiguous} 处同名图片无法确定，请选择包含文档和图片的共同目录` : '') +
        (s.remote ? ` · ${s.remote} 个外链保留原样` : '') +
        (r && r.hint ? ` · ${r.hint}` : '');
      /* 缺图不是"报错"，是"没做全"：用提醒色，别让用户以为整篇失败了 */
      opts.onToast(msg, (s.missing || s.skipped) ? 'warn' : 'ok');
      return true;
    } catch (e) {
      opts.onToast((e && e.message) || String(e), 'err');
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
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

  /** 开一个系统文件选择框。插图 / 导入 PDF / 导入 MD 共用，免得各写一遍。
   *  opts.multiple —— 多选（导入 MD 要 md 和图片一起选）；
   *  opts.directory —— 选整个目录（图片在子目录时用，浏览器会给相对路径）。
   *  两个开关互斥：webkitdirectory 下浏览器只让选目录，multiple 没有意义。 */
  let pendingPicker = null;
  function pickFile(accept, onPick, opts) {
    if (pendingPicker) { try { pendingPicker.remove(); } catch { /* 已经没了 */ } pendingPicker = null; }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept || '';
    if (opts && opts.multiple) inp.multiple = true;
    if (opts && opts.directory) inp.webkitdirectory = true;
    /* 必须挂进 DOM 再 click()：Chrome 对游离的 input 网开一面，Firefox / Safari 不弹框。
       挂成不可见的，用完（或用户取消）就摘掉 —— 不摘会在页面上越堆越多。 */
    inp.style.display = 'none';
    document.body.appendChild(inp);
    pendingPicker = inp;
    const drop = () => {
      try { inp.remove(); } catch { /* 已经没了 */ }
      if (pendingPicker === inp) pendingPicker = null;
    };
    inp.addEventListener('cancel', drop);
    inp.onchange = () => {
      const files = inp.files;
      drop();
      if (files && files.length) onPick(files);
    };
    inp.click();
  }

  /** 导入 MD 的两个口子都走这里（按钮、以及"只选了 md"之后自动补开的那一次）。
   *  返回 Promise<'picked' | 'cancel' | 'fail'>：
   *    picked —— 用户真的选了文件夹，导入已在跑；
   *    cancel —— 选择框开出来了，但用户取消（这是用户的决定，不是失败）；
   *    fail   —— **框根本没开出来**。典型场景：showDirectoryPicker 要求"用户操作后
   *              的几秒内"调用，激活一过期就被浏览器拒绝。以前这里把一切失败都
   *              `.catch(() => {})` 成"用户取消"，结果用户在确认框点了「确定」、
   *              选择框却永远不弹，面前一片死寂（用户截图抓到的就是这个）。
   *  所以失败必须报出来，让调用方决定怎么补救。 */
  function openImportPicker(opts2) {
    const o = opts2 || {};
    /* 选目录优先用 showDirectoryPicker：它能把**真实文件夹路径**也拿到
       （webkitdirectory 那条路只有相对路径）。多出来的这条信息很有用 ——
       图片在子目录里的用户，八成是把 md 放在一个**不是博客目录**的地方，
       这时候刚好可以顺手问他"要不要把写作台切到这个目录"。 */
    if (o.directory && window.showDirectoryPicker) {
      return window.showDirectoryPicker({ id: 'hexo-import-md', mode: 'read' }).then(async (dir) => {
        const files = await collectDirFiles(dir);
        if (!files.length) return 'cancel';
        /* noAutoDir：用户已经选过一次文件夹了，这篇 md 里要是还有够不着的图，
           再自动弹一次只会变成弹框循环 —— 落到"缺图提醒"就好。 */
        await importMarkdown(files, { dirPath: dir.path || '', handle: dir, noAutoDir: true });
        return 'picked';
      }).catch((e) => (e && e.name === 'AbortError') ? 'cancel' : 'fail');
    }
    return new Promise((resolve) => {
      /* webkitdirectory 那条路上没有"开不出来"这种失败（input.click() 不挑时机），
         用户取消会走 cancel 事件，onPick 不触发 —— 这里只能等 onPick。 */
      pickFile(o.accept || '', (files) => {
        /* 关键：把"实际导入"的 Promise 链成 'picked' 再 resolve，
           否则外层 await 拿到的是内层 Promise 本身、而不是 'picked'，
           两个状态判断都落空 → 外层会再把自己那份"只有 md"的表单提交一次，
           把内层已经转换好的正文覆盖掉（这是个会静默裂图的回归）。 */
        resolve(importMarkdown(files, { noAutoDir: !!o.directory }).then(() => 'picked'));
      }, o);
    });
  }

  /** 这个目录看起来是个 Hexo 博客吗？判据从宽：有 _config.yml 就够了 ——
   *  这里只是"要不要问一句"，问错了顶多多一句提示，不会动任何配置。 */
  function looksLikeBlog(files) {
    let cfg = false, src = false;
    for (const f of files || []) {
      const rel = String(f.webkitRelativePath || f.name);
      const base = rel.split('/').pop().toLowerCase();
      if (base === '_config.yml' && !rel.includes('/')) cfg = true;
      if (/^source\//i.test(rel)) src = true;
    }
    return cfg || src;
  }

  /** 递归读一个目录句柄 → File[]（每个 File 手工挂上 webkitRelativePath，
   *  后面的解析逻辑与"整目录导入"完全共用，不需要两条分支）。 */
  async function collectDirFiles(dirHandle, prefix) {
    const out = [];
    for await (const entry of dirHandle.values()) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.kind === 'directory') out.push(...await collectDirFiles(entry, rel));
      else {
        const f = await entry.getFile();
        try { Object.defineProperty(f, 'webkitRelativePath', { value: rel, configurable: true }); }
        catch { /* 某些浏览器不让改，那就退回文件名匹配 */ }
        out.push(f);
      }
    }
    /* 体积太大时按文件名排稳定顺序（遍历顺序各家浏览器不一样） */
    return out.sort((a, b) => String(a.webkitRelativePath).localeCompare(String(b.webkitRelativePath)));
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

    /* 同一个入口，显式选择语法；文档与图片目录分开选，避免二次挑选文章。 */
    const mdBtn = $('btnMd');
    if (mdBtn) {
      mdBtn.addEventListener('click', showMdImport);
      $('mdImportMode').addEventListener('change', updateMdImportHint);
      $('btnConfirmMdImport').addEventListener('click', submitMdImport);
      $('btnCancelMdImport').addEventListener('click', closeMdImport);
      $('mdImportModal').addEventListener('click', (e) => { if (e.target === $('mdImportModal')) closeMdImport(); });
      $('mdImportModal').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMdImport(); }
        if (e.key === 'Tab') {
          const fields = [...$('mdImportModal').querySelectorAll('input, select, button')].filter((f) => !f.disabled);
          const first = fields[0], last = fields[fields.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });
    }

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
      const all = [...e.dataTransfer.files];
      /* 拖进来一个 .md：走导入（页面会先问一句要不要替换编辑区）。 */
      if (all.some((f) => MD_EXT_RE.test(f.name))) { importMarkdown(all); return; }
      const files = all.filter((f) => f.type.startsWith('image/'));
      if (!files.length) opts.onToast('只支持图片或 Markdown 文件', 'err');
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
