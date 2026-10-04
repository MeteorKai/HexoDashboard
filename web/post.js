/* post.js —— 单篇文章的独立编辑页
 *
 * 从写作台点「新页面编辑」跳到这里：整页只有这一篇文章，左边写、右边看，
 * 顶栏一个「保存」、一个「保存并编译」。列表、编译日志、回收站、发布都留在
 * 写作台，这里不重复一遍 —— 独立页的价值就是"少即是专注"，不是把主界面搬过来。
 *
 * 与 server.js 的契约（和 app.js 完全相同，任何一处改了另一处必须跟着改）：
 *   1. 非 GET / HEAD 请求必须带 x-hexo-token；令牌从 /api/info 取，每个标签页各自一份
 *      （服务端每次启动都会重新生成，所以这里必须现取，不能从 localStorage 里捡）。
 *   2. 保存已存在的文章必须带 revision；服务端拿它比对磁盘上的当前内容，
 *      不一致就 409 拒绝 —— 防止两个标签页对着同一篇文章互相覆盖。
 *   3. changedFields 只列"真的改过"的字段。frontMatter 故意不传：
 *      server.js 里 `header = frontMatter === undefined ? parsed.header`，
 *      即直接拿磁盘上的原始 header 打补丁，文章里的注释和自定义字段才不会被抹掉；
 *      传了反而要自己维护一份可能过期的 header。
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  /* 与 app.js 共用同一套 key：两个页面看到的是"同一份未保存编辑"，
     在这儿写到一半关掉、回写作台打开同一篇，还能被提示恢复。 */
  const CACHE_PREFIX = 'hexo-tool-cache:';
  const TEXT_FIELDS = {
    title: 'f-title', date: 'f-date', categories: 'f-categories', tags: 'f-tags',
  };
  const POLL_MS = 700;      // 编译状态轮询间隔
  const POLL_MAX = 300;     // ≈ 3.5 分钟还不出结果就当失败，别把页面吊死

  const state = {
    token: '', info: null,
    name: '', draft: false, revision: '',
    loadedDate: '', snapshot: {},
    dirty: false, saving: false, busy: false,
    cacheTimer: null, postOut: null,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toList = (v) => (Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v));
  function nowStr() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /* ── 提示条 ───────────────────────────────────────────────────────────── */
  function toast(msg, kind) {
    const d = document.createElement('div');
    if (kind) d.className = kind;
    d.textContent = msg;
    $('toast').appendChild(d);
    while ($('toast').children.length > 4) $('toast').firstChild.remove();
    setTimeout(() => d.remove(), kind === 'err' ? 6000 : 3400);
  }

  /* ── API 客户端 ───────────────────────────────────────────────────────── */
  async function api(path, opts) {
    const o = Object.assign({}, opts);
    const method = (o.method || 'GET').toUpperCase();
    o.headers = Object.assign({}, o.headers);
    if (method !== 'GET' && method !== 'HEAD') o.headers['x-hexo-token'] = state.token;
    const r = await fetch(path, o);
    let data;
    try { data = await r.json(); } catch { data = { ok: false, error: '响应不是 JSON（HTTP ' + r.status + '）' }; }
    if (!r.ok || data.ok === false) {
      const err = new Error(data.error || ('HTTP ' + r.status));
      err.status = r.status;
      throw err;
    }
    return data;
  }
  const postJSON = (path, body) => api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  /* ── 状态区 ───────────────────────────────────────────────────────────── */
  function setState(text, cls) {
    const el = $('ppState');
    el.textContent = text;
    el.className = 'badge' + (cls ? ' ' + cls : '');
  }
  function setDirty(v) {
    state.dirty = v;
    setState(v ? '未保存' : '已保存', v ? 'warn' : 'ok');
  }

  /** 底部状态条。按钮用 DOM 拼，不走 innerHTML —— 里面的文案可能来自服务端错误信息。 */
  function showStatus(text, cls, actions) {
    const box = $('ppStatusText');
    box.textContent = '';
    box.className = cls || '';
    if (text) box.appendChild(document.createTextNode(text));
    for (const a of actions || []) {
      const b = document.createElement('button');
      b.className = 'sm';
      b.textContent = a.label;
      b.addEventListener('click', a.run);
      box.appendChild(b);
    }
    $('ppStatus').hidden = false;
  }
  function hideStatus() {
    $('ppStatus').hidden = true;
    $('ppOutLink').hidden = true;
    $('ppOutLink').removeAttribute('href');
  }
  function setOutLink(link) {
    const a = $('ppOutLink');
    if (!link) { a.hidden = true; return; }
    a.textContent = link.text;
    if (link.href) a.href = link.href; else a.removeAttribute('href');
    a.hidden = false;
  }

  /* ── 本地编辑缓存：保存被拒时保证写的东西不丢 ─────────────────────────── */
  const cacheKey = () => CACHE_PREFIX + (state.draft ? 'd:' : 'p:') + state.name;
  function cacheWrite() {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({
        at: Date.now(), fields: collect(), body: $('body').value,
        draft: $('f-draft').checked, name: $('f-name').value.trim(),
      }));
    } catch { /* 存储满 / 隐私模式：忽略，不影响主流程 */ }
  }
  function cacheSoon() {
    clearTimeout(state.cacheTimer);
    state.cacheTimer = setTimeout(cacheWrite, 700);
  }
  async function refreshTagSuggestions() {
    try { window.Editor.setTagSuggestions((await api('/api/posts')).posts || []); }
    catch { toast('读取已有标签失败，仍可手动输入新标签', 'warn'); }
  }
  const cacheRead = (key) => {
    try { return JSON.parse(localStorage.getItem(key || cacheKey()) || 'null'); } catch { return null; }
  };
  const cacheClear = (key) => { try { localStorage.removeItem(key || cacheKey()); } catch { /* 忽略 */ } };
  /** 缓存与刚读到的内容一样就没必要打扰用户 */
  function cacheDiffers(c) {
    if (!c || !c.fields) return false;
    const now = collect();
    for (const k of Object.keys(TEXT_FIELDS)) if ((c.fields[k] || '') !== (now[k] || '')) return true;
    return String(c.body || '') !== $('body').value;
  }

  /* ── 字段收集与改动追踪 ───────────────────────────────────────────────── */
  function collect() {
    const o = {};
    for (const [k, id] of Object.entries(TEXT_FIELDS)) o[k] = $(id).value.trim();
    o.mathjax = $('f-mathjax').checked;
    return o;
  }
  function changedFields() {
    const now = collect(), out = [];
    for (const k of Object.keys(TEXT_FIELDS)) {
      const a = now[k], b = state.snapshot[k] == null ? '' : String(state.snapshot[k]);
      if (a !== b) out.push(k);
    }
    if (now.mathjax !== !!state.snapshot.mathjax) out.push('mathjax');
    return out;
  }
  function updateStats() {
    const n = window.Editor.countWords($('body').value);
    $('wordCount').textContent = n ? `${n} 字` : '0 字';
  }
  function markDirty() {
    setDirty(true);
    cacheSoon();
  }

  /* ── 载入 ─────────────────────────────────────────────────────────────── */
  async function open(name, draft) {
    const d = await api(`/api/post?name=${encodeURIComponent(name)}&draft=${draft ? 1 : 0}`);
    state.name = d.name;
    state.draft = !!d.draft;
    state.revision = d.revision;
    const m = d.meta || {};
    state.loadedDate = m.date == null ? '' : String(m.date);

    $('f-title').value = m.title || '';
    $('f-name').value = d.name;
    $('f-date').value = state.loadedDate;
    window.Editor.setCategory(toList(m.categories));
    $('f-tags').value = toList(m.tags);
    $('f-mathjax').checked = !!m.mathjax;
    $('f-draft').checked = state.draft;
    $('body').value = String(d.body || '').replace(/^\n+/, '');

    state.snapshot = collect();
    setDirty(false);
    syncKind();
    syncTitle();
    syncUrl();
    window.Editor.render();
    updateStats();
    hideStatus();

    const c = cacheRead();
    if (c && cacheDiffers(c)) offerRestore(c);
  }

  function syncKind() {
    const k = $('ppKind');
    k.textContent = state.draft ? '草稿' : '已发布';
    k.className = 'badge ' + (state.draft ? 'warn' : 'ok');
  }
  function syncTitle() {
    const t = $('f-title').value.trim() || state.name || '未命名';
    document.title = (state.draft ? '草稿：' : '') + t + ' · Hexo 写作台';
  }
  /** 保存可能改了文件名 / 草稿状态，把地址栏跟着改掉，刷新后还落在同一篇上 */
  function syncUrl() {
    const q = `?name=${encodeURIComponent(state.name)}&draft=${state.draft ? 1 : 0}`;
    try { history.replaceState(null, '', '/post' + q); } catch { /* 忽略 */ }
  }

  /** 本地还留着一份没保存的编辑：摆两个按钮，不去弹 confirm 打断刚打开的页面 */
  function offerRestore(c) {
    const when = new Date(c.at);
    const p = (n) => String(n).padStart(2, '0');
    const at = `${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())}`;
    showStatus(`${at} 在本机留着一份没保存的编辑。`, 'warn', [
      {
        label: '恢复它',
        run: () => {
          window.Editor.setCategory(c.fields.categories || '');
          for (const [k, id] of Object.entries(TEXT_FIELDS)) if (c.fields[k] != null) $(id).value = c.fields[k];
          $('f-mathjax').checked = !!c.fields.mathjax;
          $('f-draft').checked = !!c.draft;
          if (c.name) $('f-name').value = c.name;
          $('body').value = c.body || '';
          markDirty();
          syncKind();
          syncTitle();
          window.Editor.render();
          updateStats();
          hideStatus();
          toast('已恢复本机编辑，记得保存', 'warn');
        },
      },
      {
        label: '丢弃',
        run: () => {
          cacheClear();
          hideStatus();
          toast('已丢弃本机缓存', 'ok');
        },
      },
    ]);
  }

  /* ── 载入失败：说清楚为什么，并给条退路 ───────────────────────────────── */
  function fail(title, msg) {
    $('postpage').hidden = true;
    $('ppFail').hidden = false;
    $('ppFailTitle').textContent = title;
    $('ppFailMsg').textContent = msg;
    document.title = title + ' · Hexo 写作台';
  }

  /* ── 保存 ─────────────────────────────────────────────────────────────── */
  async function save(silent) {
    if (state.saving) return false;
    const title = $('f-title').value.trim();
    if (!title) { toast('标题不能为空', 'err'); $('f-title').focus(); return false; }
    const f = collect();
    const payload = {
      title,
      name: $('f-name').value.trim() || title,
      date: f.date || state.loadedDate || nowStr(),
      categories: f.categories,
      tags: f.tags,
      mathjax: f.mathjax,
      draft: $('f-draft').checked,
      body: $('body').value,
      originalName: state.name,
      originalDraft: state.draft,
      revision: state.revision,
      changedFields: changedFields(),
    };
    state.saving = true;
    setState('保存中…', 'accent');
    let r;
    try {
      r = await postJSON('/api/post', payload);
    } catch (e) {
      state.saving = false;
      if (e.status === 409) {
        /* 服务端说的是"磁盘上那篇被别人改了"。此时本地这份不能丢，缓存已经写了。 */
        setDirty(true);
        toast(e.message + '（你现在的改动已存进本机缓存，刷新后可恢复对比）', 'err');
      } else if (e.status === 428) {
        setDirty(true);
        toast('这篇文章缺少版本信息，请刷新页面重新打开再保存（内容已在本机缓存）', 'err');
      } else {
        setDirty(true);
        toast(e.message, 'err');
      }
      throw e;
    }
    state.saving = false;
    state.name = r.name;
    state.draft = !!r.draft;
    state.revision = r.revision;
    $('f-name').value = r.name;
    $('f-draft').checked = state.draft;
    state.snapshot = collect();
    cacheClear();
    setDirty(false);
    syncKind();
    syncTitle();
    syncUrl();
    window.Editor.render();
    if (!silent) toast(state.draft ? `已存为草稿 → source/_drafts/${r.name}.md` : `已保存 → source/_posts/${r.name}.md`, 'ok');
    await refreshTagSuggestions();
    return true;
  }

  /* ── 编译 ─────────────────────────────────────────────────────────────── */
  async function compile() {
    if (state.busy) return;
    if (state.dirty || !$('f-name').value.trim()) {
      const ok = await save(true).catch(() => false);
      if (!ok) return;
    }
    state.busy = true;
    setBusy(true);
    hideStatus();
    setOutLink(null);
    showStatus('正在生成静态页面…（hexo clean && generate）', 'warn');
    try {
      const job = await postJSON('/api/run', { kind: 'build', clean: true });
      const status = await waitJob(job.id);
      if (status !== 'done') {
        showStatus(status === 'stopped' ? '编译被中止了。' : '编译失败，日志在写作台的编译窗口里。',
          status === 'stopped' ? 'warn' : 'err');
        return;
      }
      await afterBuild();
    } catch (e) {
      showStatus(e.message, 'err');
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  /** 轮询任务状态。不用 SSE：这里只要一个终态，轮询比长连接简单，也不会在关标签页时留下半开的流。 */
  async function waitJob(id) {
    for (let i = 0; i < POLL_MAX; i++) {
      await sleep(POLL_MS);
      const r = await api('/api/jobs');
      const j = (r.jobs || []).find((x) => x.id === id);
      if (!j || j.status !== 'running') return j ? j.status : 'failed';
      const sec = Math.round(((i + 1) * POLL_MS) / 1000);
      if (sec % 3 === 0) showStatus(`正在生成静态页面… ${sec}s`, 'warn');
    }
    return 'timeout';
  }

  /** 生成完了，得告诉用户"这篇落到哪个地址"，并在预览没起时能一指控起来 */
  async function afterBuild() {
    let out = null;
    try {
      out = await api(`/api/post-url?name=${encodeURIComponent(state.name)}&draft=${state.draft ? 1 : 0}`);
    } catch (e) {
      showStatus('编译完成，但算不出产物地址：' + e.message, 'warn');
      return;
    }
    state.postOut = out;
    if (!out.url) {
      showStatus('✅ 编译完成。' + (out.reason || '这篇文章没有生成产物。'), 'warn');
      return;
    }
    if (!out.exists) {
      const why = state.draft
        ? '它是草稿，Hexo 不会把草稿生成到 public（_config.yml 里 render_drafts: false）。'
        : 'public 下没有找到它，可能被 _config.yml 里的 skip_render 跳过了。';
      showStatus(`✅ 编译完成，但这篇没有产物：${why}`, 'warn');
      return;
    }
    const j = await api('/api/jobs').catch(() => null);
    const serving = !!(j && (j.jobs || []).some((x) => x.kind === 'serve' && x.status === 'running'));
    const port = (state.info && state.info.previewPort) || 4000;
    if (serving) {
      setOutLink({ text: '打开这篇文章 ↗', href: `http://127.0.0.1:${port}${encodeURI(out.url)}` });
      showStatus(`✅ 编译完成 → ${out.url}`, 'ok');
    } else {
      /* 站点资源都是 /css/… 这种根路径，直接开 public 里的 html 会掉样式，
         所以链接指向 hexo server，由 openPostOutput 负责先把它拉起来。 */
      setOutLink({ text: '▶ 启动预览并打开' });
      showStatus(`✅ 编译完成 → ${out.url}（本地预览没在跑）`, 'ok');
    }
  }

  async function openPostOutput() {
    const out = state.postOut;
    if (!out || !out.url) return;
    const port = (state.info && state.info.previewPort) || 4000;
    const target = `http://127.0.0.1:${port}${encodeURI(out.url)}`;
    const win = window.open('', '_blank');       // 必须在任何 await 之前同步开，否则会被拦
    toast('正在启动本地预览…', 'warn');
    try {
      await postJSON('/api/run', { kind: 'serve' });
    } catch (e) {
      toast(e.message, 'err');
      if (win) win.close();
      return;
    }
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const j = await api('/api/jobs').catch(() => null);
      if (j && (j.jobs || []).some((x) => x.kind === 'serve' && x.status === 'running')) { await sleep(900); break; }
    }
    if (win) win.location.href = target; else location.href = target;
  }

  function setBusy(on) {
    $('btnSave').disabled = on;
    $('btnCompile').disabled = on;
  }

  /* ── 主题 ─────────────────────────────────────────────────────────────── */
  function initTheme() {
    const KEY = window.__themeKey || 'hexo-tool-theme';
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
    const paint = (mode) => {
      const dark = mode ? mode === 'dark' : mq.matches;
      if (mode) root.setAttribute('data-theme', mode); else root.removeAttribute('data-theme');
      $('btnTheme').title = dark ? '当前：暖夜（点击切浅色纸感）' : '当前：浅色纸感（点击切暖夜）';
    };
    paint(read());
    mq.addEventListener('change', () => { if (!read()) paint(null); });
    $('btnTheme').addEventListener('click', () => {
      const next = (root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && mq.matches)) ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch { /* 忽略 */ }
      paint(next);
    });
  }

  /* ── 事件绑定 ─────────────────────────────────────────────────────────── */
  function bindUI() {
    $('btnSave').addEventListener('click', () => save(false).catch(() => {}));
    $('btnCompile').addEventListener('click', () => compile());
    $('ppOutLink').addEventListener('click', (e) => {
      if ($('ppOutLink').getAttribute('href')) return;   // 预览在跑，当普通链接跳
      e.preventDefault();
      openPostOutput();
    });
    $('btnFields').addEventListener('click', () => {
      const d = $('ppFields');
      d.open = !d.open;
      $('btnFields').setAttribute('aria-expanded', String(d.open));
    });
    $('ppFields').addEventListener('toggle', () => {
      $('btnFields').setAttribute('aria-expanded', String($('ppFields').open));
    });

    for (const id of Object.values(TEXT_FIELDS)) {
      $(id).addEventListener(id === 'f-categories' ? 'change' : 'input', () => { if (id === 'f-title') syncTitle(); markDirty(); });
    }
    $('f-mathjax').addEventListener('change', markDirty);
    $('f-draft').addEventListener('change', () => { syncKind(); syncTitle(); markDirty(); });
    $('body').addEventListener('input', () => { updateStats(); markDirty(); });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault();
        save(false).catch(() => {});
        return;
      }
      /* 属性抽屉开着时，Esc 收起来 —— 收起后正文区域变大，是"回到写作"的动作 */
      if (e.key === 'Escape' && $('ppFields').open) {
        $('ppFields').open = false;
        $('btnFields').setAttribute('aria-expanded', 'false');
      }
    });

    /* 写了没保存就关标签页，浏览器得问一句 */
    window.addEventListener('beforeunload', (e) => {
      if (!state.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /* ── 启动 ─────────────────────────────────────────────────────────────── */
  async function boot() {
    const q = new URLSearchParams(location.search);
    const name = q.get('name') || '';
    const draft = q.get('draft') === '1';
    if (!name) {
      fail('没有指定文章', '这个地址缺少 name 参数。请从写作台的文章列表里选一篇，点「↗ 新页面编辑」。');
      return;
    }
    try {
      const i = await api('/api/info');
      state.info = i;
      state.token = i.token || '';
    } catch (e) {
      fail('连不上写作台', e.message + '　写作台关掉之后这个页面就没用了，请重新启动它。');
      return;
    }
    try {
      await open(name, draft);
      await refreshTagSuggestions();
    } catch (e) {
      fail(e.status === 404 ? '这篇文章不在了' : '打不开这篇文章',
        e.status === 404 ? `没找到《${name}》。它可能已经被删到回收站，或者刚被改了文件名。` : e.message);
    }
  }

  window.Editor.init({
    getContext: () => ({ post: state.name, draft: state.draft }),
    onDirty: markDirty,
    onToast: toast,
    upload: async (blob, filename) => {
      if (state.info && state.info.postAssetFolder === false) {
        throw new Error('请先在博客 _config.yml 中启用 post_asset_folder: true');
      }
      if (!state.name) throw new Error('请先保存这篇文章，图片要存在文章的同名资源目录里');
      const q = `post=${encodeURIComponent(state.name)}&draft=${state.draft ? 1 : 0}&name=${encodeURIComponent(filename)}`;
      return api('/api/upload?' + q, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
    },
    /* PDF 导入：这一页只对着**一篇文章**，没有"新建"这回事，所以插到光标处 ——
     * 位置感和旁边的插图按钮一致，方便把 PDF 内容并进现有文章。
     * 转换在服务端做（/api/import-pdf），页面只管把文件字节发过去。 */
    importPdf: async (file) => {
      const buf = await file.arrayBuffer();
      /* 带上 post/draft：图片要存进**这篇文章自己的**同名资源目录。少了这两个参数，
         服务端只会按标题猜目录名，插进现有文章里就会指到不存在的路径上。 */
      const q = 'title=' + encodeURIComponent(file.name.replace(/\.pdf$/i, '')) +
        '&post=' + encodeURIComponent(state.name) + '&draft=' + (state.draft ? 1 : 0);
      const r = await api('/api/import-pdf?' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: buf,
      });
      window.Editor.insertText(r.markdown, false);
      const n = (r.assets && r.assets.count) || 0;
      const hint = n ? `已插到光标处，${n} 张图已存进本文资源目录，记得保存`
        : (r.assetFolder === false ? '已插到光标处（博客没开 post_asset_folder，图片不能存进文章目录）'
          : '已插到光标处，记得保存');
      return { stats: r.stats, hint };
    },
    /* 这一页没有设置弹窗，也没有列表弹窗，所以：博客目录照直说、选文件取第一个。
       导入本身不受影响 —— 图片照样进这篇文章的资源目录。 */
    blogDir: () => (state.info && state.info.blog) || '',
    onOpenBlogSettings: () => {
      if (window.opener) window.opener.focus();
      throw new Error('请回到写作台主页面，在右上角「设置」里改博客目录（这一页不支持改）');
    },
    chooseMd: (message, items) => window.confirm(message + '\n\n（这一页没有列表弹窗，' +
      `就导入第 1 个：${items[0][0]}）`) ? items[0][1] : null,
    /* Markdown 导入：这一页只对着**一篇文章**，所以和 PDF 一样插到光标处 ——
     * 这里导入的是"内容"，不是"一篇文章"（front-matter 的标题日期属于这篇文章，
     * 不能拿来覆盖它），所以只取正文。 */
    importMd: async (form, base) => {
      /* 带上 post/draft：图片要存进**这篇文章自己的**同名资源目录。 */
      const q = 'title=' + encodeURIComponent(base) +
        '&post=' + encodeURIComponent(state.name) + '&draft=' + (state.draft ? 1 : 0);
      const r = await api('/api/import-md?' + q, { method: 'POST', body: form });
      window.Editor.insertText(r.markdown, false);
      const n = (r.assets && r.assets.count) || 0;
      const miss = (r.missing && r.missing.length) || 0;
      const hint = n ? `${n} 张图已存进本文资源目录，记得保存`
        : (miss ? '已插到光标处；部分图片未找到（引用保持原样），请在「导入 MD」中补选正确的图片文件夹'
          : '已插到光标处，记得保存');
      return { stats: r.stats, hint, missingFiles: r.missing || [] };
    },
  });

  bindUI();
  initTheme();
  boot().catch((e) => fail('出错了', e.message));
})();
