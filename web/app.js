/* app.js —— 应用外壳
 * 负责：API 客户端（令牌 / 版本）、文章列表与检索、编辑与保存、回收站、
 *       历史版本、图片管理、任务与日志、设置、主题、关闭服务。
 * 编辑器与预览的渲染细节在 editor.js 里，本文件只调用 window.Editor。
 *
 * 与服务端契约（server.js）绑定的三个硬性要求，漏掉任何一个功能都会坏：
 *   1. 所有非 GET 请求必须带 x-hexo-token，令牌从 /api/info 拿；
 *   2. 保存已存在的文章必须带 revision（否则 428），且服务端会用它拒绝覆盖外部改动（409）；
 *   3. front-matter 只提交"显式改动的字段"（changedFields）+ 原始 header（frontMatter），
 *      这样文章里的自定义字段和注释才不会被重建时抹掉。
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  /* ── 状态 ─────────────────────────────────────────────────────────────── */
  const state = {
    token: '', info: null, settings: null, config: null,
    posts: [], postsAll: 0,
    current: null,            // 当前打开的文章名（null = 新建）
    originalName: '', savedName: '', draft: false,
    revision: '', frontMatter: '', snapshot: {},
    dirty: false, view: 'all', search: '',
    jobId: null, es: null, serving: false,
    buildAt: 0, buildFocus: null, postOut: null,
    histPick: null, cacheTimer: null, searchTimer: null,
  };
  const selected = new Set();
  const keyOf = (p) => (p.draft ? 'd:' : 'p:') + p.name;
  const CACHE_PREFIX = 'hexo-tool-cache:';
  const NEW_CACHE = CACHE_PREFIX + 'new';
  const CONSOLE_H_KEY = 'hexo-tool-console-h';
  const CONSOLE_MIN = 140;                       // 再矮就看不到日志了

  /* ── 小工具 ───────────────────────────────────────────────────────────── */
  function toast(msg, kind) {
    const d = document.createElement('div');
    if (kind) d.className = kind;
    d.textContent = msg;
    $('toast').appendChild(d);
    while ($('toast').children.length > 5) $('toast').firstChild.remove();
    setTimeout(() => d.remove(), kind === 'err' ? 6000 : 3400);
  }
  function fmtSize(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function nowStr() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  const toList = (v) => (Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v));
  const mediaUrl = (post, draft, file) =>
    '/media/' + (draft ? 'd' : 'p') + '/' + encodeURIComponent(post) + '/' + encodeURIComponent(file);

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
      err.data = data;
      throw err;
    }
    return data;
  }
  const postJSON = (path, body, method) => api(path, {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  /* ── 主题 ─────────────────────────────────────────────────────────────── */
  function initTheme() {
    const KEY = window.__themeKey || 'hexo-tool-theme';
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
    const paint = (mode) => {
      const dark = mode ? mode === 'dark' : mq.matches;
      if (mode) root.setAttribute('data-theme', mode); else root.removeAttribute('data-theme');
      const b = $('btnTheme');
      b.textContent = dark ? '☾' : '☀';
      b.title = dark ? '当前：暖夜（点击切浅色纸感）' : '当前：浅色纸感（点击切暖夜）';
    };
    paint(read());
    mq.addEventListener('change', () => { if (!read()) paint(null); });
    $('btnTheme').addEventListener('click', () => {
      const next = (root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && mq.matches)) ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch { /* 忽略 */ }
      paint(next);
    });
  }

  /* ── 加载态 ───────────────────────────────────────────────────────────── */
  const busy = (on) => $('editLoading').classList.toggle('show', !!on);

  /* ── 站点信息 ─────────────────────────────────────────────────────────── */
  async function loadInfo() {
    const i = await api('/api/info');
    state.info = i;
    state.token = i.token || '';
    const ready = !!i.blog;
    for (const id of ['btnNew', 'btnSave', 'btnPublish', 'btnUpload', 'btnPdf', 'btnPreview', 'btnAssets', 'btnHistory', 'btnOpenTab', 'btnTags', 'btnServe', 'btnTrash', 'search', 'selAll']) $(id).disabled = !ready;
    document.querySelectorAll('.panel--editor input, .panel--editor select, .panel--editor textarea').forEach(el => { el.disabled = !ready; });
    $('blogPath').textContent = i.blog || '未设置博客目录';
    $('blogPath').title = i.blog || '请在设置中选择博客目录';
    if (!ready) {
      $('deployInfo').textContent = '';
      $('draftNote').textContent = '请先在右上角「设置」中填写 Hexo 博客目录。';
      return;
    }
    const d = i.deploy;
    const parts = [];
    if (d && d.repo) parts.push(`${d.type || 'git'} · ${d.repo}${d.branch ? ' (' + d.branch + ')' : ''}`);
    else if (d && d.type) parts.push(d.type);
    else parts.push('⚠ _config.yml 里没有配置 deploy');
    const dep = i.lastDeploy;
    if (dep && dep.at) parts.push('上次部署 ' + fmtTime(dep.at));
    $('deployInfo').textContent = parts.join('  ·  ');
    $('deployInfo').title = parts.join('\n');

    const note = $('draftNote');
    if (i.renderDrafts) {
      note.className = 'note warn';
      note.textContent = '⚠ _config.yml 里 render_drafts: true —— 草稿会被一起生成并推送到站点，建议改回 false。';
    } else {
      note.className = 'note';
      note.textContent = '草稿只存在本地 source/_drafts，生成与发布都不会包含它；本地预览可以看到。';
    }
    if (i.postAssetFolder === false) {
      toast('_config.yml 里没启用 post_asset_folder: true，插图和 asset_img 都会失败', 'warn');
    }
  }

  /* ── 文章列表 ─────────────────────────────────────────────────────────── */
  async function loadPosts() {
    const q = state.search.trim();
    /* 搜索走后端（listPosts 会同时匹配标题、文件名和正文），所以"命中数"和
       "总计数"是两个口径：有搜索词时只更新命中数，筛选栏的计数保持全域口径，
       免得数字随着搜索来回跳。 */
    const r = await api('/api/posts' + (q ? '?q=' + encodeURIComponent(q) : ''));
    state.posts = r.posts || [];
    if (!q) {
      const drafts = state.posts.filter((p) => p.draft).length;
      state.postsAll = state.posts.length;
      $('cntAll').textContent = state.posts.length;
      $('cntPub').textContent = state.posts.length - drafts;
      $('cntDraft').textContent = drafts;
    }
    for (const k of [...selected]) if (!state.posts.some((p) => keyOf(p) === k)) selected.delete(k);
    renderList();
    refreshTrashCount();
    window.Editor.setTagSuggestions(q ? (await api('/api/posts')).posts || [] : state.posts);
  }

  function visiblePosts() {
    return state.posts.filter((p) => {
      if (state.view === 'draft' && !p.draft) return false;
      if (state.view === 'pub' && p.draft) return false;
      return true;
    });
  }

  function renderList() {
    const ul = $('postlist');
    const vis = visiblePosts();
    ul.textContent = '';
    $('listCount').textContent = state.search.trim()
      ? `命中 ${vis.length}`
      : String(vis.length);
    if (!vis.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.style.display = 'block';
      li.textContent = state.search.trim() ? '没有匹配的文章' : (state.view === 'draft' ? '还没有草稿' : '还没有文章');
      ul.appendChild(li);
      syncSelUI();
      return;
    }
    for (const p of vis) {
      const k = keyOf(p);
      const li = document.createElement('li');
      if (p.name === state.current && !!p.draft === !!state.draft) li.classList.add('active');

      const pick = document.createElement('label');
      pick.className = 'pick';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(k);
      cb.setAttribute('aria-label', '选择 ' + p.title);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { cb.checked ? selected.add(k) : selected.delete(k); syncSelUI(); });
      pick.appendChild(cb);

      const main = document.createElement('div');
      main.className = 'main';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = p.title;
      if (p.draft) {
        const tag = document.createElement('span');
        tag.className = 'tag-draft';
        tag.textContent = '草稿';
        t.appendChild(tag);
      }
      const d = document.createElement('span');
      d.className = 'd';
      d.textContent = (p.draft ? '_drafts/' : '') + p.name;
      d.title = p.name + '  ·  ' + (p.date || '');
      main.append(t, d);

      li.append(pick, main);
      li.addEventListener('click', () => openPost(p.name, p.draft).catch((e) => toast(e.message, 'err')));
      li.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtxMenu(e, p); });
      ul.appendChild(li);
    }
    syncSelUI();
  }

  function syncSelUI() {
    const vis = visiblePosts();
    const btn = $('btnDelSel');
    btn.disabled = selected.size === 0;
    btn.textContent = selected.size ? `删除选中 (${selected.size})` : '删除选中';
    const all = vis.length > 0 && vis.every((p) => selected.has(keyOf(p)));
    $('selAll').checked = all;
    $('selAll').indeterminate = !all && vis.some((p) => selected.has(keyOf(p)));
  }

  /* ── 右键菜单 ─────────────────────────────────────────────────────────── */
  function closeCtxMenu() { $('ctxmenu').classList.remove('show'); }
  function openCtxMenu(e, p) {
    const m = $('ctxmenu');
    m.textContent = '';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { closeCtxMenu(); fn(); });
      m.appendChild(b);
    };
    mk('打开', () => openPost(p.name, p.draft).catch((err) => toast(err.message, 'err')));
    mk(p.draft ? '🚀 发表到 _posts' : '📝 转为草稿', () => togglePublish(p));
    mk('🕘 查看历史版本', () => openHistoryFor(p));
    const hr = document.createElement('hr');
    m.appendChild(hr);
    mk('移入回收站', () => trashOne(p));
    m.classList.add('show');
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - r.height - 8)) + 'px';
  }
  document.addEventListener('click', (e) => { if (!$('ctxmenu').contains(e.target)) closeCtxMenu(); });
  window.addEventListener('blur', closeCtxMenu);
  window.addEventListener('resize', closeCtxMenu);

  /* ── 编辑器：字段快照与改动追踪 ───────────────────────────────────────── */
  const TEXT_FIELDS = { title: 'f-title', date: 'f-date', categories: 'f-categories', tags: 'f-tags' };

  function collect() {
    const o = {};
    for (const [k, id] of Object.entries(TEXT_FIELDS)) o[k] = $(id).value.trim();
    o.mathjax = $('f-mathjax').checked;
    return o;
  }
  function markDirty() {
    state.dirty = true;
    const t = $('editorTitle');
    if (!t.textContent.endsWith(' •')) t.textContent += ' •';
    cacheSoon();
  }
  function clearDirty() {
    state.dirty = false;
    $('editorTitle').textContent = $('editorTitle').textContent.replace(/ •$/, '');
  }
  function refreshFieldSummary() {
    const bits = [];
    const c = $('f-categories').value.trim();
    const tg = $('f-tags').value.trim();
    if (c) bits.push('分类 ' + c.split(/[,，]/).filter(Boolean).length);
    if (tg) bits.push('标签 ' + tg.split(/[,，]/).filter(Boolean).length);
    if ($('f-mathjax').checked) bits.push('公式');
    if ($('f-draft').checked) bits.push('草稿');
    $('fieldsSummary').textContent = bits.length ? '· ' + bits.join(' · ') : '';
  }

  /* ── 本地编辑缓存：服务端拒绝写入时保证编辑不丢 ───────────────────────── */
  function cacheKey() {
    if (state.current === null) return NEW_CACHE;
    return CACHE_PREFIX + (state.draft ? 'd:' : 'p:') + state.current;
  }
  function cacheWrite() {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({
        at: Date.now(), fields: collect(), body: $('body').value,
        draft: $('f-draft').checked, name: $('f-name').value.trim(),
        revision: state.revision, frontMatter: state.frontMatter,
      }));
    } catch { /* 存储满或隐私模式：忽略，不影响主流程 */ }
  }
  function cacheSoon() {
    clearTimeout(state.cacheTimer);
    state.cacheTimer = setTimeout(cacheWrite, 700);
  }
  function cacheFlush() {
    clearTimeout(state.cacheTimer);
    if (state.dirty) cacheWrite();
  }
  function cacheRead(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }
  function cacheClear(key) {
    try { localStorage.removeItem(key || cacheKey()); } catch { /* 忽略 */ }
  }
  /** 缓存与服务器内容一致就没必要打扰用户，只有真的差着才提示 */
  function cacheDiffers(c) {
    if (!c || !c.fields) return false;
    const now = collect();
    for (const k of Object.keys(TEXT_FIELDS)) if ((c.fields[k] || '') !== (now[k] || '')) return true;
    return String(c.body || '') !== $('body').value;
  }
  function applyCache(c) {
    window.Editor.setCategory(c.fields.categories || '');
    for (const [k, id] of Object.entries(TEXT_FIELDS)) if (c.fields[k] != null) $(id).value = c.fields[k];
    $('f-mathjax').checked = !!c.fields.mathjax;
    $('f-draft').checked = !!c.draft;
    $('f-name').value = c.name || $('f-name').value;
    $('body').value = c.body || '';
    markDirty();
    window.Editor.render();
    updateStats();
    refreshFieldSummary();
  }

  /* ── 打开 / 新建 ──────────────────────────────────────────────────────── */
  async function openPost(name, draft) {
    busy(true);
    try {
      const d = await api(`/api/post?name=${encodeURIComponent(name)}&draft=${draft ? 1 : 0}`);
      cacheFlush();
      state.current = d.name;
      state.originalName = d.name;
      state.savedName = d.name;
      state.draft = !!d.draft;
      state.revision = d.revision;
      state.frontMatter = d.frontMatter;
      const m = d.meta || {};
      $('editorTitle').textContent = (state.draft ? '草稿：' : '编辑：') + (m.title || name);
      $('f-title').value = m.title || '';
      $('f-name').value = d.name;
      $('f-date').value = m.date == null ? '' : String(m.date);
      window.Editor.setCategory(toList(m.categories));
      $('f-tags').value = toList(m.tags);
      $('f-mathjax').checked = !!m.mathjax;
      $('f-draft').checked = state.draft;
      $('body').value = String(d.body || '').replace(/^\n+/, '');
      state.snapshot = collect();
      clearDirty();
      refreshFieldSummary();
      syncPublishBtn();
      window.Editor.render();
      updateStats();
      renderList();
      const c = cacheRead(cacheKey());
      if (cacheDiffers(c) && confirm(`《${m.title || name}》有一份本地未保存的编辑（${fmtTime(new Date(c.at).toISOString())}）。\n\n恢复它吗？\n选“取消”将丢弃这份本地缓存。`)) {
        applyCache(c);
        toast('已恢复本地编辑，记得保存', 'warn');
      } else if (c) {
        cacheClear();
      }
    } finally {
      busy(false);
    }
  }

  function newPost(restore = true) {
    cacheFlush();
    state.current = null;
    state.originalName = '';
    state.savedName = '';
    state.draft = false;
    state.revision = '';
    state.frontMatter = '';
    $('editorTitle').textContent = '新建文章';
    for (const id of Object.values(TEXT_FIELDS)) $(id).value = '';
    window.Editor.setCategory('');
    $('f-name').value = '';
    $('body').value = '';
    $('f-date').value = nowStr();
    $('f-mathjax').checked = false;
    $('f-draft').checked = false;
    state.snapshot = collect();
    clearDirty();
    refreshFieldSummary();
    syncPublishBtn();
    window.Editor.render();
    updateStats();
    renderList();
    const c = restore && cacheRead(NEW_CACHE);
    if (c && c.fields) {
      applyCache(c);
      toast('已恢复未保存的新文章', 'warn');
    }
    $('f-title').focus();
  }

  function syncPublishBtn() {
    const btn = $('btnPublish');
    if (state.current === null) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = state.draft ? '发表文章' : '转为草稿';
    btn.title = state.draft
      ? '搬到 source/_posts，下次生成/发布就会包含它'
      : '搬回 source/_drafts，只留本地，不会被发布';
  }

  function updateStats() {
    const n = window.Editor.countWords($('body').value);
    $('wordCount').textContent = n ? `${n} 字 · 约 ${Math.max(1, Math.round(n / 400))} 分钟` : '0 字';
  }

  /* ── 保存 ─────────────────────────────────────────────────────────────── */
  function changedFields() {
    const now = collect();
    const out = [];
    for (const k of Object.keys(TEXT_FIELDS)) {
      const a = now[k], b = state.snapshot[k] == null ? '' : String(state.snapshot[k]);
      if (a !== b) out.push(k);
    }
    if (now.mathjax !== !!state.snapshot.mathjax) out.push('mathjax');
    return out;
  }

  async function savePost(silent) {
    const title = $('f-title').value.trim();
    if (!title) { toast('标题不能为空', 'err'); $('f-title').focus(); return null; }
    const isNew = state.current === null;
    const oldCacheKey = cacheKey();
    const fields = collect();
    const payload = {
      title,
      name: $('f-name').value.trim() || title,
      date: fields.date || nowStr(),
      categories: fields.categories,
      tags: fields.tags,
      mathjax: fields.mathjax,
      draft: $('f-draft').checked,
      body: $('body').value,
      originalName: state.originalName,
      originalDraft: state.draft,
    };
    if (!isNew) {
      payload.revision = state.revision;
      payload.changedFields = changedFields();
      payload.frontMatter = state.frontMatter;
    }
    let r;
    try {
      r = await postJSON('/api/post', payload);
    } catch (e) {
      if (e.status === 428) {
        toast('这篇文章缺少版本信息，请刷新列表后重新打开再保存（编辑内容已在本机缓存）', 'err');
      } else if (e.status === 409) {
        const extra = /外部被修改/.test(e.message)
          ? '（已把你当前编辑内容存到本机缓存，重新打开后可恢复对比）'
          : /同名文章/.test(e.message)
            ? '（改一下上面的「文件名」再保存）'
            : '';
        toast(e.message + extra, 'err');
      } else {
        toast(e.message, 'err');
      }
      throw e;
    }
    state.current = r.name;
    state.originalName = r.name;
    state.savedName = r.name;
    state.draft = !!r.draft;
    state.revision = r.revision;
    state.frontMatter = r.frontMatter;
    $('f-name').value = r.name;
    $('f-draft').checked = state.draft;
    state.snapshot = collect();
    $('editorTitle').textContent = (state.draft ? '草稿：' : '编辑：') + title;
    clearDirty();
    clearTimeout(state.cacheTimer);
    cacheClear(oldCacheKey);
    cacheClear();
    refreshFieldSummary();
    syncPublishBtn();
    if (!silent) {
      toast(state.draft ? `已存为草稿 → source/_drafts/${r.name}.md（不会被发布）` : `已保存 → source/_posts/${r.name}.md`, 'ok');
    }
    window.Editor.render();
    await loadPosts();
    return r.name;
  }

  /* ── 发表 / 转回草稿 ──────────────────────────────────────────────────── */
  async function togglePublish(p) {
    const publish = !!p.draft;
    if (!confirm(`《${p.title}》\n\n${publish ? '发表后会出现在 _posts，下次生成/发布就会包含它。' : '转为草稿后只留在本地，不会被生成和发布。'}\n\n继续？`)) return;
    try {
      await postJSON('/api/publish', { name: p.name, draft: !!p.draft, publish, revision: p.revision });
      toast(`已${publish ? '发表' : '转为草稿'}《${p.title}》`, 'ok');
      if (state.current === p.name && !!state.draft === !!p.draft) await openPost(p.name, !publish);
    } catch (e) {
      toast(e.message, 'err');
    }
    await loadPosts();
  }

  /* ── 回收站 ───────────────────────────────────────────────────────────── */
  async function refreshTrashCount() {
    try {
      const r = await api('/api/trash');
      $('trashCount').textContent = r.items.length ? ` ${r.items.length}` : '';
    } catch { /* 取不到就不显示 */ }
  }
  async function openTrash() {
    $('trashModal').classList.add('show');
    await renderTrash();
  }
  async function renderTrash() {
    const box = $('trashList');
    const r = await api('/api/trash');
    box.textContent = '';
    $('trashHint').textContent = r.items.length ? `${r.items.length} 项` : '空';
    $('btnEmptyTrash').disabled = !r.items.length;
    if (!r.items.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '回收站是空的。删除的文章会先放到这里，可以恢复。';
      box.appendChild(e);
      return;
    }
    for (const it of r.items) {
      const row = document.createElement('div');
      row.className = 'titem';
      const info = document.createElement('div');
      info.className = 'info';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = it.title || it.name;
      const d = document.createElement('div');
      d.className = 'd';
      d.textContent = `${it.source}/${it.name}.md · ${it.assetCount || 0} 张图 · ${fmtSize(it.size)} · 删除于 ${it.deletedAt || ''}`;
      info.append(t, d);

      const b1 = document.createElement('button');
      b1.className = 'sm';
      b1.textContent = '恢复';
      b1.addEventListener('click', async () => {
        try {
          await postJSON('/api/trash/restore', { id: it.id });
          toast(`已恢复《${it.title || it.name}》`, 'ok');
          await renderTrash();
          await loadPosts();
        } catch (e) { toast(e.message, 'err'); }
      });
      const b2 = document.createElement('button');
      b2.className = 'ghost danger sm';
      b2.textContent = '彻底删除';
      b2.addEventListener('click', async () => {
        if (!confirm(`彻底删除《${it.title || it.name}》？此操作不可恢复。`)) return;
        try {
          await postJSON('/api/trash/delete', { id: it.id });
          toast('已彻底删除', 'ok');
          await renderTrash();
          await refreshTrashCount();
        } catch (e) { toast(e.message, 'err'); }
      });
      row.append(info, b1, b2);
      box.appendChild(row);
    }
  }

  async function trashOne(p) {
    if (!confirm(`把《${p.title}》移入回收站？\n\nmd 和同名资源目录会一起移走，之后可以从回收站恢复。`)) return;
    try {
      await api(`/api/post?name=${encodeURIComponent(p.name)}&draft=${p.draft ? 1 : 0}&revision=${encodeURIComponent(p.revision)}`, { method: 'DELETE' });
      if (state.current === p.name && !!state.draft === !!p.draft) newPost();
      toast('已移入回收站', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    await loadPosts();
  }

  async function deleteSelected() {
    const items = state.posts.filter((p) => selected.has(keyOf(p)))
      .map((p) => ({ name: p.name, draft: !!p.draft, revision: p.revision }));
    if (!items.length) return;
    const preview = items.slice(0, 6).map((i) => '· ' + i.name).join('\n') + (items.length > 6 ? `\n… 等共 ${items.length} 篇` : '');
    if (!confirm(`把以下 ${items.length} 篇文章移入回收站？\n\n${preview}\n\n之后可从回收站恢复。`)) return;
    try {
      const r = await postJSON('/api/posts/delete', { items });
      if (r.failed && r.failed.length) toast(`已移入 ${r.deleted} 篇，${r.failed.length} 篇失败：${r.failed[0].error}`, 'err');
      else toast(`已移入回收站 ${r.deleted} 篇`, 'ok');
      selected.clear();
    } catch (e) { toast(e.message, 'err'); }
    await loadPosts();
  }

  /* ── 历史版本 ─────────────────────────────────────────────────────────── */
  async function openHistoryFor(p) {
    if (!p) {
      if (state.current === null) { toast('先打开一篇文章', 'err'); return; }
      p = { name: state.current, draft: state.draft };
    }
    $('histModal').classList.add('show');
    $('histPreview').textContent = '';
    $('btnHistLoad').disabled = true;
    state.histPick = null;
    const box = $('histList');
    box.textContent = '';
    try {
      const r = await api(`/api/history?name=${encodeURIComponent(p.name)}&draft=${p.draft ? 1 : 0}`);
      $('histHint').textContent = r.items.length ? `${r.items.length} 个版本` : '暂无记录';
      if (!r.items.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = '还没有历史版本。每次保存前，写作台都会把旧内容备份一份。';
        box.appendChild(e);
        return;
      }
      for (const it of r.items) {
        const row = document.createElement('div');
        row.className = 'titem';
        const info = document.createElement('div');
        info.className = 'info';
        const t = document.createElement('div');
        t.className = 't';
        t.textContent = fmtTime(it.createdAt);
        const d = document.createElement('div');
        d.className = 'd';
        d.textContent = `${fmtSize(it.size)} · ${it.id}`;
        info.append(t, d);
        const view = document.createElement('button');
        view.className = 'sm';
        view.textContent = '查看';
        view.addEventListener('click', async () => {
          try {
            const v = await api(`/api/history/version?name=${encodeURIComponent(p.name)}&draft=${p.draft ? 1 : 0}&id=${encodeURIComponent(it.id)}`);
            $('histPreview').textContent = (v.frontMatter ? '---\n' + v.frontMatter + '\n---\n\n' : '') + (v.body || '');
            state.histPick = v;
            $('btnHistLoad').disabled = false;
            box.querySelectorAll('.titem').forEach((el) => el.classList.remove('active'));
            row.classList.add('active');
          } catch (e) { toast(e.message, 'err'); }
        });
        row.append(info, view);
        box.appendChild(row);
      }
    } catch (e) {
      $('histHint').textContent = '读取失败';
      toast(e.message, 'err');
    }
  }

  $('btnHistLoad').addEventListener('click', async () => {
    if (!state.histPick) return;
    if (state.dirty && !confirm('当前编辑还没保存，载入历史版本会覆盖编辑区内容。继续？')) return;
    const p = state.histPick;
    $('body').value = String(p.body || '').replace(/^\n+/, '');
    if (p.meta) {
      $('f-title').value = p.meta.title || $('f-title').value;
      $('f-date').value = p.meta.date == null ? $('f-date').value : String(p.meta.date);
      window.Editor.setCategory(toList(p.meta.categories));
      $('f-tags').value = toList(p.meta.tags);
    }
    markDirty();
    refreshFieldSummary();
    window.Editor.render();
    updateStats();
    $('histModal').classList.remove('show');
    toast('历史版本已载入编辑区，确认后点保存即可回滚', 'warn');
  });

  /* ── 图片管理 ─────────────────────────────────────────────────────────── */
  async function openAssets() {
    if (state.current === null) { toast('先打开或保存一篇文章', 'err'); return; }
    $('assetsModal').classList.add('show');
    await renderAssets();
  }
  async function renderAssets() {
    const box = $('assetsList'), arch = $('assetsArchived');
    box.textContent = '';
    arch.textContent = '';
    const name = state.current, draft = state.draft;
    try {
      const r = await api(`/api/assets?name=${encodeURIComponent(name)}&draft=${draft ? 1 : 0}`);
      $('assetsHint').textContent = `${r.items.length} 张 · 已删 ${r.archived.length} 张`;
      if (!r.items.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = '这篇文章还没有图片。用编辑区的「插图」按钮，或直接 Ctrl+V 粘贴截图。';
        box.appendChild(e);
      }
      for (const it of r.items) {
        const card = document.createElement('div');
        card.className = 'card';
        const img = document.createElement('img');
        img.src = mediaUrl(name, draft, it.name);
        img.alt = it.name;
        img.loading = 'lazy';
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = it.name;
        nm.title = it.name + ' · ' + fmtSize(it.size);
        const row = document.createElement('div');
        row.className = 'row';
        const badge = document.createElement('span');
        badge.className = 'badge' + (it.referenced ? ' accent' : '');
        badge.textContent = it.referenced ? '正文引用中' : '未引用';
        row.appendChild(badge);
        const del = document.createElement('button');
        del.className = 'danger sm';
        del.textContent = '删除';
        del.disabled = it.referenced;
        del.title = it.referenced ? '正文或封面还在引用它，先从正文里移除再保存' : '把它移到历史里，可以恢复';
        del.addEventListener('click', async () => {
          if (!confirm(`删除图片 ${it.name}？\n\n会移到该文章的历史里，之后可以恢复。`)) return;
          try {
            await api(`/api/assets?name=${encodeURIComponent(name)}&draft=${draft ? 1 : 0}&asset=${encodeURIComponent(it.name)}`, { method: 'DELETE' });
            toast('图片已删除（可在下方恢复）', 'ok');
            await renderAssets();
            window.Editor.render();
          } catch (e) { toast(e.message, 'err'); }
        });
        row.appendChild(del);
        card.append(img, nm, row);
        box.appendChild(card);
      }

      $('archivedTitle').hidden = !r.archived.length;
      for (const it of r.archived) {
        const card = document.createElement('div');
        card.className = 'card';
        const img = document.createElement('img');
        img.src = mediaUrl(name, draft, it.filename);
        img.alt = it.filename;
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = it.filename;
        nm.title = '删除于 ' + fmtTime(it.createdAt);
        const row = document.createElement('div');
        row.className = 'row';
        const back = document.createElement('button');
        back.className = 'sm';
        back.textContent = '恢复';
        back.addEventListener('click', async () => {
          try {
            await postJSON('/api/assets/restore', { name, draft, id: it.id });
            toast('图片已恢复', 'ok');
            await renderAssets();
            window.Editor.render();
          } catch (e) { toast(e.message, 'err'); }
        });
        row.appendChild(back);
        card.append(img, nm, row);
        arch.appendChild(card);
      }
    } catch (e) {
      $('assetsHint').textContent = '读取失败';
      toast(e.message, 'err');
    }
  }

  /* ── 任务与日志 ───────────────────────────────────────────────────────── */
  function logLine(text, cls) {
    const log = $('log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    const d = document.createElement('div');
    d.className = 'l-' + (cls || 'out');
    d.textContent = text;
    log.appendChild(d);
    while (log.children.length > 3000) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function clearLog() { $('log').textContent = ''; }

  function setRunning(on, label) {
    const ready = !!(state.info && state.info.blog);
    $('btnBuild').disabled = on || !ready;
    $('btnDeploy').disabled = on || !ready;
    $('btnClean').disabled = on || !ready;
    $('btnCompilePost').disabled = on || !ready;
    $('btnStop').disabled = !on || !ready;
    $('status').textContent = label || (on ? '运行中…' : '空闲');
    $('status').className = 'badge' + (on ? ' accent' : '');
  }
  function setServing(on, port) {
    state.serving = on;
    $('btnServe').textContent = on ? '■ 停止预览' : '本地预览';
    $('btnServe').classList.toggle('primary', on);
    const a = $('serveLink');
    if (on) {
      a.href = `http://127.0.0.1:${port || 4000}/`;
      a.textContent = `↗ :${port || 4000}`;
      a.hidden = false;
    } else {
      a.hidden = true;
      a.textContent = '';
      a.removeAttribute('href');
    }
  }
  function attachLog(id, long, port, after, hooks) {
    const onEnd = hooks && hooks.onEnd;
    if (state.es) state.es.close();
    const es = new EventSource('/api/logs?id=' + encodeURIComponent(id) + (after ? '&after=' + after : ''));
    state.es = es;
    let retries = 0;
    es.onopen = () => { retries = 0; };
    es.onmessage = (ev) => {
      let e;
      try { e = JSON.parse(ev.data); } catch { return; }
      if (e.type === 'end') {
        es.close();
        state.es = null;
        const done = e.text === 'done';
        if (long && state.serving && !done) setServing(false);
        setRunning(false, done ? '✅ 成功' : (e.text === 'stopped' ? '⏹ 已中止' : '❌ 失败'));
        $('jobTitle').textContent = '';
        toast(done ? '任务完成' : (e.text === 'stopped' ? '已中止' : '任务未成功'), done ? 'ok' : 'err');
        loadInfo().catch(() => {});
        if (onEnd) onEnd(e.text);
        return;
      }
      logLine(e.text, e.type);
    };
    /* 不立刻 close：SSE 断线会自动重连并带上 Last-Event-ID，长任务（hexo d 可能跑一分钟）
       中间抖一下不该把日志流掐断。连续失败多次才判定断开。 */
    es.onerror = () => {
      if (++retries <= 5) return;
      es.close();
      state.es = null;
      if (long) setServing(false);
      setRunning(false, '日志连接断开');
      if (onEnd) onEnd('failed');            // 别让编译窗口停在"进行中"
    };
  }

  async function runTask(kind, opts) {
    const o = opts || {};
    if (o.confirmText && !confirm(o.confirmText)) return;
    if (state.dirty && $('f-title').value.trim()) {
      try {
        const n = await savePost(true);
        if (n) logLine('[自动保存] ' + n + '.md', 'info');
      } catch { return; }                       // 保存失败就别继续跑生成/发布
    }
    let r;
    try {
      clearLog();
      hideBuildBar();
      r = await postJSON('/api/run', Object.assign({ kind, port: (state.info && state.info.previewPort) || 4000 }, o.body));
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    state.jobId = r.id;
    $('jobTitle').textContent = r.title;
    setRunning(true, r.title + ' 运行中…');
    if (r.long) setServing(true, r.port);
    attachLog(r.id, r.long, r.port);
  }

  /* ── 编译 ─────────────────────────────────────────────────────────────── */
  /* 「编译」就是 hexo clean && hexo generate。跟普通"跑个命令"的区别在于两端：
     跑之前先把当前文章存盘（不然编的还是旧内容），跑完再把这篇文章生成到哪了
     翻出来给个直达链接 —— 光看到日志滚完、不知道产物在哪，等于白编。 */
  async function compile(focusPost) {
    if (state.es) { toast('已有任务在运行，先中止或等它结束', 'err'); return; }
    let autosaved = '';
    if (state.dirty && $('f-title').value.trim()) {
      try { autosaved = (await savePost(true)) || ''; }
      catch { return; }                          // 存盘失败就编译，等于编了个旧版本
    }
    const name = state.savedName || state.current;
    if (focusPost && !name) logLine('[编译] 当前没有打开任何文章，按整站编译处理', 'info');
    state.buildFocus = (focusPost && name) ? { name, draft: state.draft } : null;
    state.postOut = null;
    state.buildAt = Date.now();
    hideBuildBar();
    /* 「窗口大一点」：真的开始编译时就把编译窗口铺开，日志一屏能看几十行 */
    if (!isConsoleMax()) setConsoleMax(true);
    let r;
    try {
      clearLog();
      if (autosaved) logLine('[自动保存] ' + autosaved + '.md', 'info');
      r = await postJSON('/api/run', { kind: 'build', clean: true });
    } catch (e) { toast(e.message, 'err'); return; }
    state.jobId = r.id;
    $('jobTitle').textContent = r.title;
    setRunning(true, r.title + ' 运行中…');
    logLine('[编译] 目标：' + (state.buildFocus ? `仅关注《${name}》这一篇的产物，整站一起重新生成` : '整站'), 'info');
    attachLog(r.id, false, null, null, { onEnd: onCompileEnd });
  }

  /* hexo 自己会在结尾打一行 `INFO  123 files generated in 1.23 s`，
     直接把它抠出来显示，比我们再数一遍 public/ 更可信（也更快）。
     注意日志区是一堆 <div>，textContent 会把它们**无分隔符地粘成一行**，
     于是 `[^\n]+` 会一路吃到后面的日志里去 —— 必须先按行拼回来。 */
  function parseGenerated() {
    const text = [...$('log').children].map((d) => d.textContent).join('\n');
    const m = /(\d+)\s+files generated in\s+([\d.]+\s*m?s)/i.exec(text);
    return m ? { files: Number(m[1]), hexo: m[2].trim() } : null;
  }

  function hideBuildBar() {
    $('buildBar').hidden = true;
    $('buildStat').textContent = '';
    const a = $('postOutLink');
    a.hidden = true;
    a.removeAttribute('href');
    a.textContent = '';
  }

  function showBuildBar(parts, cls) {
    const box = $('buildStat');
    box.textContent = '';
    const head = document.createElement('span');
    head.className = cls;
    head.textContent = parts.shift();
    box.appendChild(head);
    if (parts.length) box.appendChild(document.createTextNode(' · ' + parts.join(' · ')));
    $('buildBar').hidden = false;
  }

  async function onCompileEnd(status) {
    const done = status === 'done';
    const secs = state.buildAt ? ((Date.now() - state.buildAt) / 1000).toFixed(1) : '';
    const gen = parseGenerated();
    const parts = [done ? '✅ 编译完成' : (status === 'stopped' ? '⏹ 已中止' : '❌ 编译失败')];
    if (secs) parts.push(`用时 ${secs}s`);
    if (gen) parts.push(`生成 ${gen.files} 个文件（hexo 自报 ${gen.hexo}）`);
    showBuildBar(parts, done ? 'ok' : (status === 'stopped' ? 'warn' : 'err'));

    const link = $('postOutLink');
    const focus = state.buildFocus;
    if (!done || !focus) return;                 // 整站编译 / 没打开文章，就到此为止

    let out;
    try {
      out = await api('/api/post-url?name=' + encodeURIComponent(focus.name) + '&draft=' + (focus.draft ? 1 : 0));
    } catch (e) {
      logLine('[产物] 查询失败：' + e.message, 'err');
      return;
    }
    state.postOut = out;
    if (!out.ok) { logLine('[产物] ' + out.reason, 'err'); return; }
    logLine('[产物] 《' + out.title + '》→ ' + out.url, 'info');
    if (!out.exists) {
      logLine(out.draft
        ? '[产物] 这是草稿：_drafts 里的文章不会被 generate 生成（render_drafts=false），所以 public 里没有它。想看效果请用「本地预览」。'
        : '[产物] public 里没有这个页面 —— 检查一下文章是否被跳过，或者 permalink 与预期不符。', 'err');
      return;
    }
    link.title = out.url;
    const port = (state.info && state.info.previewPort) || 4000;
    if (state.serving) {
      /* 预览已经在跑：它就是一条普通链接，直接跳到这篇文章那一页 */
      link.href = `http://127.0.0.1:${port}${encodeURI(out.url)}`;
      link.textContent = '打开这篇文章 ↗';
    } else {
      /* 没在跑：点了再拉起来（见 openPostOutput），所以这里不能有 href，
         否则浏览器会先按空地址跳一下再走我们的逻辑。 */
      link.removeAttribute('href');
      link.textContent = '▶ 启动预览并打开';
    }
    link.hidden = false;
  }

  /* 产物链接永远指向 hexo server 的地址，而不是 public/ 下的 html 文件：
     站点里所有资源都是 /css/… 这种根路径，file:// 打开必然掉样式。 */
  async function openPostOutput() {
    const out = state.postOut;
    if (!out || !out.exists) return;
    const port = (state.info && state.info.previewPort) || 4000;
    const target = `http://127.0.0.1:${port}${out.url}`;
    if (state.serving) { trackWindow(window.open(target, '_blank')); return; }
    /* 必须"同步"开这个空标签：await 之后浏览器就不认这是用户手势了，window.open 会被拦 */
    const win = trackWindow(window.open('', '_blank'));
    toast('正在启动本地预览…', 'warn');
    try { await runTask('serve'); } catch (e) { toast(e.message, 'err'); return; }
    const up = await waitForLog(/Hexo is running at/i, 25000);
    if (win) win.location.href = up ? target : `http://127.0.0.1:${port}/`;
    if (!up) toast('预览起得有点慢，先给你打开首页，稍后刷新即可', 'warn');
  }

  function waitForLog(re, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (re.test($('log').textContent)) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  /* ── 在新标签页里单独编辑这一篇 ────────────────────────────────────────
     独立页（post.html）读的还是同一套 /api/*，所以这里只要把地址拼对就行。 */
  async function openPostTab() {
    if (state.current === null) {
      toast('先把这篇新文章保存下来，新标签页才找得到它', 'err');
      return;
    }
    /* window.open 必须落在用户手势的同一个任务里：先同步开一个空白页，await 之后再填地址。
       否则浏览器判定"不是用户触发的"，直接拦掉。 */
    const win = trackWindow(window.open('', '_blank'));
    try {
      /* 有未保存的改动就先存：不然新页面读到的是磁盘上的旧内容，看着像刚写的字没了 */
      if (state.dirty) await savePost(true);
    } catch {
      if (win) win.close();            // savePost 已经提示过原因，这里只负责别留一个白页
      return;
    }
    const name = state.savedName || state.current;
    const url = `/post?name=${encodeURIComponent(name)}&draft=${state.draft ? 1 : 0}`;
    if (win) win.location.href = url;
    else toast('新标签页被浏览器拦下了：允许本站打开弹出窗口后再试一次', 'warn');
  }

  /* ── 关闭写作台：服务退出之后，页面自己也退场 ─────────────────────────────
     脚本打开的窗口可通过 window.close() 一并关闭，让「关闭服务」干净收尾。
     普通浏览器标签页不允许脚本关闭（浏览器会拦掉），那种情况下留一个整页提示，
     免得页面还在后台不停重试请求、刷一屏连接失败。 */
  const openedWindows = [];
  function trackWindow(win) { if (win) openedWindows.push(win); return win; }

  function closeCompanionWindows() {
    /* 预览页、独立编辑页都是本页开的：服务都停了，留着它们只会显示连接失败 */
    for (const w of openedWindows) { try { if (w && !w.closed) w.close(); } catch { /* 已被关掉或跨域，忽略 */ } }
    openedWindows.length = 0;
    try { if (window.Editor && window.Editor.closePreview) window.Editor.closePreview(); } catch { /* 编辑器没加载就算了 */ }
  }

  function showClosedOverlay(pid, blocked) {
    const old = document.getElementById('closed-overlay');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'closed-overlay';
    box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--paper,#F2F5F0);color:var(--text,#293C34);font:15px/1.7 var(--font-sans,sans-serif);text-align:center;padding:24px;';
    const h = document.createElement('div');
    h.textContent = '写作台已关闭';
    h.style.cssText = 'font-size:22px;font-weight:600;';
    const p = document.createElement('div');
    p.textContent = blocked
      ? `写作台已停止（PID ${pid}）。浏览器不允许脚本关掉这个标签页，请手动关闭它。`
      : `写作台已停止（PID ${pid}）。想继续写作，重新双击桌面上的「Hexo 写作台」即可。`;
    p.style.cssText = 'opacity:.75;max-width:32em;';
    box.appendChild(h);
    box.appendChild(p);
    if (blocked) {
      const b = document.createElement('button');
      b.textContent = '再试一次关闭';
      b.style.cssText = 'padding:8px 18px;border:1px solid var(--line-strong,#788E7D);border-radius:var(--r-sm,9px);background:transparent;color:inherit;cursor:pointer;font:inherit;';
      b.addEventListener('click', () => { try { window.close(); } catch { /* ignore */ } });
      box.appendChild(b);
    }
    document.body.appendChild(box);
  }

  function finishShutdown(pid) {
    state.closing = true;                  // 让 beforeunload 别再弹一次"确定要离开吗"
    if (state.es) { state.es.close(); state.es = null; }
    if (state.cacheTimer) { clearTimeout(state.cacheTimer); state.cacheTimer = null; }
    if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
    closeCompanionWindows();
    showClosedOverlay(pid, false);
    try { window.close(); } catch { /* 被浏览器拦掉是正常情况，下面有兜底 */ }
    /* 900ms 后窗口还活着，说明 close 被拒（普通标签页）—— 换成整页提示 */
    setTimeout(() => { if (!window.closed) showClosedOverlay(pid, true); }, 900);
  }

  /* ── 编译窗口：拖高 / 放大 ─────────────────────────────────────────────── */
  let consoleH = 0;

  function setConsoleHeight(px, persist) {
    /* 上限按"拖到顶也要给编辑区留够"反推：留 320px 时编辑区恒定拿到约 214px，
       正好放得下 标题栏 + 按钮行 + 一段正文（见 styles.css 里 .fields / #body 的伸缩规则） */
    const max = Math.max(CONSOLE_MIN, window.innerHeight - 320);
    consoleH = Math.min(Math.max(Math.round(px), CONSOLE_MIN), max);
    document.documentElement.style.setProperty('--console-h', consoleH + 'px');
    if (persist) { try { localStorage.setItem(CONSOLE_H_KEY, String(consoleH)); } catch { /* 隐私模式 */ } }
    return consoleH;
  }

  const isConsoleMax = () => document.querySelector('.app').classList.contains('console-max');

  function setConsoleMax(on) {
    document.querySelector('.app').classList.toggle('console-max', on);
    const b = $('btnConsoleMax');
    b.textContent = on ? '⤡' : '⤢';
    b.title = on ? '还原编译窗口（Esc）' : '放大编译窗口';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function initConsoleResize() {
    if (isConsoleMax()) setConsoleMax(false);    // 刷新后不要停在放大态，免得以为文章没了
    const grip = $('consoleGrip');
    const panel = $('consolePanel');
    let startY = 0, startH = 0, dragging = false;
    consoleH = Math.round(panel.getBoundingClientRect().height) || 0;
    try {
      const saved = parseInt(localStorage.getItem(CONSOLE_H_KEY) || '', 10);
      if (saved > 0) setConsoleHeight(saved, false);
    } catch { /* 忽略 */ }

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      setConsoleHeight(consoleH, true);          // 松手才落盘，拖动过程中不写 localStorage
    };
    grip.addEventListener('pointerdown', (e) => {
      if (isConsoleMax()) return;
      dragging = true;
      startY = e.clientY;
      startH = panel.getBoundingClientRect().height;
      document.body.classList.add('resizing');
      try { grip.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (dragging) setConsoleHeight(startH + (startY - e.clientY), false);
    });
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
    /* 分隔条也吃键盘：Tab 能聚焦、↑↓ 微调、Shift 加速、Home 直接拉满 */
    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      if (e.key === 'ArrowUp') setConsoleHeight(consoleH + step, true);
      else if (e.key === 'ArrowDown') setConsoleHeight(consoleH - step, true);
      else if (e.key === 'Home') setConsoleHeight(1e6, true);   // 拉满（由 setConsoleHeight 夹到上限）
      else return;
      e.preventDefault();
    });
    window.addEventListener('resize', () => setConsoleHeight(consoleH, false));
  }

  /* 页面刷新 / 重新打开时，把还在跑的任务接回来，别让状态显示成"空闲" */
  async function restoreJobs() {
    try {
      const r = await api('/api/jobs');
      const running = (r.jobs || []).find((j) => j.status === 'running');
      if (!running) return;
      state.jobId = running.id;
      $('jobTitle').textContent = running.title;
      setRunning(true, running.title + ' 运行中…');
      if (running.long) setServing(true, running.port);
      logLine(`[恢复] 检测到仍在运行的任务：${running.title}`, 'info');
      if (running.kind === 'build') {
        state.buildAt = running.startedAt || Date.now();
        attachLog(running.id, running.long, running.port, null, { onEnd: onCompileEnd });
      } else {
        attachLog(running.id, running.long, running.port);
      }
    } catch { /* 拉不到就算了 */ }
  }

  /* ── 设置 ─────────────────────────────────────────────────────────────── */
  let configRequest = 0, configBusy = false;
  const configDirty = () => !!state.config && $('s-config-content').value !== state.config.content;
  const discardConfig = () => !configDirty() || confirm('博客配置有未保存的修改，确定放弃吗？');

  function syncConfigControls() {
    const enabled = !configBusy && state.settings && state.settings.blog && $('s-blog').value.trim() === state.settings.blog;
    $('s-config-file').disabled = !enabled;
    $('btnReloadConfig').disabled = !enabled || !$('s-config-file').value;
    $('s-config-content').disabled = !enabled || !state.config;
    $('btnSaveConfig').disabled = !enabled || !configDirty();
    $('btnSaveSettings').disabled = configBusy;
  }
  function closeSettings() {
    if (!discardConfig()) return;
    configRequest++;
    state.config = null;
    configBusy = false;
    syncConfigControls();
    $('settingsModal').classList.remove('show');
  }
  async function loadConfig(name) {
    const request = ++configRequest;
    configBusy = true;
    state.config = null;
    $('s-config-content').value = '';
    $('configNote').textContent = '正在读取配置…';
    syncConfigControls();
    try {
      const r = await api('/api/config?name=' + encodeURIComponent(name));
      if (request !== configRequest) return;
      $('s-config-content').value = r.content;
      state.config = { ...r, content: $('s-config-content').value };
      $('configNote').textContent = '编辑当前博客的 ' + r.name + '。保存前校验 YAML，并备份原文件；更改后请重新生成，或重启本地预览。';
    } catch (e) {
      if (request === configRequest) $('configNote').textContent = '读取失败：' + e.message;
    } finally {
      if (request === configRequest) { configBusy = false; syncConfigControls(); }
    }
  }
  async function loadConfigFiles() {
    const request = ++configRequest;
    configBusy = true;
    state.config = null;
    $('s-config-file').replaceChildren();
    $('s-config-content').value = '';
    syncConfigControls();
    try {
      const r = await api('/api/configs');
      if (request !== configRequest) return;
      for (const file of r.files) $('s-config-file').add(new Option(file, file));
      if (r.files.length) await loadConfig(r.files[0]);
      else $('configNote').textContent = '没有可编辑的 config / _config 系列 YAML 文件。';
    } catch (e) {
      if (request === configRequest) $('configNote').textContent = '读取失败：' + e.message;
    } finally {
      if (request === configRequest) { configBusy = false; syncConfigControls(); }
    }
  }
  async function openSettings() {
    const request = ++configRequest;
    $('settingsModal').classList.add('show');
    $('settingsNote').textContent = '正在读取…';
    try {
      const s = await api('/api/settings');
      if (request !== configRequest) return;
      state.settings = s;
      $('s-blog').value = s.blog || '';
      $('s-preview').value = s.previewPort || 4000;
      $('s-tool').value = s.toolPort || s.currentPort || 4321;
      $('settingsNote').textContent = s.blog
        ? `当前写作台端口：${s.currentPort}。修改端口需要重启；修改博客目录会立即切换。下方可编辑当前博客的配置文件。`
        : '首次使用：填写包含 _config.yml 和 source/_posts 的博客目录，保存后即可开始写作。';
      $('configEditor').hidden = !s.blog;
      if (s.blog) await loadConfigFiles();
    } catch (e) {
      $('settingsNote').textContent = '读取失败：' + e.message;
    }
  }

  /* ── 启动 ─────────────────────────────────────────────────────────────── */
  function bindUI() {
    /* 列表 */
    $('btnNew').addEventListener('click', () => newPost());
    $('selAll').addEventListener('change', () => {
      const vis = visiblePosts();
      if ($('selAll').checked) vis.forEach((p) => selected.add(keyOf(p)));
      else vis.forEach((p) => selected.delete(keyOf(p)));
      renderList();
    });
    $('btnDelSel').addEventListener('click', deleteSelected);
    $('search').addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.search = $('search').value;
        loadPosts().catch((e) => toast(e.message, 'err'));
      }, 250);
    });
    document.querySelectorAll('.fbtn').forEach((b) => {
      b.addEventListener('click', () => {
        state.view = b.dataset.view;
        document.querySelectorAll('.fbtn').forEach((x) => x.classList.toggle('active', x === b));
        renderList();
      });
    });

    /* 编辑 */
    $('btnSave').addEventListener('click', () => savePost(false).catch(() => {}));
    $('btnPublish').addEventListener('click', async () => {
      if (state.current === null) return;
      const toDraft = !state.draft;
      if (!confirm(toDraft
        ? '转为草稿：这篇文章会被搬回 source/_drafts，只留本地，不会被生成和发布。'
        : '发表：这篇文章会搬到 source/_posts，下次生成/发布就会被包含。')) return;
      $('f-draft').checked = toDraft;
      try {
        await savePost(true);
        toast(toDraft ? '已转为草稿' : '已发表', 'ok');
      } catch { /* savePost 已经提示过了 */ }
    });
    $('f-draft').addEventListener('change', () => {
      if (state.current !== null) {
        state.draft = $('f-draft').checked;
        $('editorTitle').textContent = (state.draft ? '草稿：' : '编辑：') + ($('f-title').value.trim() || state.current);
        syncPublishBtn();
      }
      refreshFieldSummary();
      markDirty();
    });
    $('f-mathjax').addEventListener('change', () => { refreshFieldSummary(); markDirty(); });
    $('btnHistory').addEventListener('click', () => openHistoryFor(null));
    $('btnAssets').addEventListener('click', () => openAssets());

    for (const id of Object.values(TEXT_FIELDS)) {
      $(id).addEventListener(id === 'f-categories' ? 'change' : 'input', () => { refreshFieldSummary(); markDirty(); });
    }
    $('f-name').addEventListener('input', markDirty);
    /* 正文的预览渲染由 editor.js 负责，这里只管脏标记与字数 */
    $('body').addEventListener('input', () => { updateStats(); markDirty(); });

    /* 回收站 / 历史 / 图片 / 设置 的关闭：按钮 + 点遮罩 + Esc 三条路都要能关 */
    $('btnCloseTrash').addEventListener('click', () => $('trashModal').classList.remove('show'));
    $('btnCloseHist').addEventListener('click', () => $('histModal').classList.remove('show'));
    $('btnCloseAssets').addEventListener('click', () => $('assetsModal').classList.remove('show'));
    $('btnCloseSettings').addEventListener('click', closeSettings);
    for (const id of ['trashModal', 'histModal', 'assetsModal', 'settingsModal']) {
      $(id).addEventListener('click', (e) => { if (e.target === $(id)) { if (id === 'settingsModal') closeSettings(); else $(id).classList.remove('show'); } });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      let hadModal = false;
      for (const id of ['trashModal', 'histModal', 'assetsModal', 'settingsModal']) {
        if ($(id).classList.contains('show')) { if (id === 'settingsModal') closeSettings(); else $(id).classList.remove('show'); hadModal = true; }
      }
      closeCtxMenu();
      /* 没有弹窗可关时，Esc 用来还原被放大的编译窗口 */
      if (!hadModal && isConsoleMax()) setConsoleMax(false);
    });

    $('btnTrash').addEventListener('click', () => openTrash().catch((e) => toast(e.message, 'err')));
    $('btnEmptyTrash').addEventListener('click', async () => {
      if (!confirm('清空回收站？里面的文章将被彻底删除，不可恢复。')) return;
      try {
        const r = await postJSON('/api/trash/empty', {});
        toast(`已清空 ${r.count} 项`, 'ok');
        await renderTrash();
        await loadPosts();
      } catch (e) { toast(e.message, 'err'); }
    });

    /* 编译 */
    $('btnBuild').addEventListener('click', () => compile(false).catch(() => {}));
    $('btnCompilePost').addEventListener('click', () => compile(true).catch(() => {}));
    /* 两个入口同一件事：编辑区工具栏（随时用）和编译摘要条（刚编译完最想改的时候） */
    $('btnOpenTab').addEventListener('click', () => openPostTab().catch(() => {}));
    $('btnEditTab').addEventListener('click', () => openPostTab().catch(() => {}));
    $('postOutLink').addEventListener('click', (e) => {
      if (state.serving) return;                 // 预览在跑，让它当普通链接跳
      e.preventDefault();
      openPostOutput().catch(() => {});
    });
    $('btnLogClear').addEventListener('click', () => { clearLog(); hideBuildBar(); });
    $('btnConsoleMax').addEventListener('click', () => setConsoleMax(!isConsoleMax()));
    $('btnClean').addEventListener('click', () => runTask('clean', { confirmText: '清理会删除 hexo 缓存与 public 目录，下次生成会全量重建。继续？' }));
    $('btnDeploy').addEventListener('click', () => {
      const i = state.info;
      const d = i && i.deploy;
      const target = d && d.repo ? `${d.repo}${d.branch ? ' (' + d.branch + ')' : ''}` : '(未配置 deploy)';
      const drafts = i ? i.counts.drafts : 0;
      const tail = drafts ? `\n另有 ${drafts} 篇草稿，不会被发布。` : '';
      const warn = i && i.renderDrafts ? '\n\n⚠ render_drafts: true，草稿会被一起推上去！' : '';
      return runTask('deploy', {
        confirmText: `将执行 hexo clean && hexo g && hexo d\n推送到：${target}${tail}${warn}\n\n继续？`,
        body: { clean: true, allowDrafts: !!(i && i.renderDrafts) },
      });
    });
    $('btnServe').addEventListener('click', async () => {
      if (state.serving) {
        if (!state.jobId) { setServing(false); return; }
        try {
          await postJSON('/api/stop', { id: state.jobId });
          setServing(false);
          toast('已停止本地预览', 'ok');
        } catch (e) { toast(e.message, 'err'); }
        return;
      }
      await runTask('serve');
    });
    $('btnStop').addEventListener('click', async () => {
      if (!state.jobId) return;
      try {
        await postJSON('/api/stop', { id: state.jobId });
        if (state.serving) setServing(false);
        toast('已发送中止信号', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    /* 设置 */
    $('btnSettings').addEventListener('click', () => openSettings().catch((e) => toast(e.message, 'err')));
    $('s-config-content').addEventListener('input', syncConfigControls);
    $('s-blog').addEventListener('input', () => {
      syncConfigControls();
      if (state.settings && $('s-blog').value.trim() !== state.settings.blog) $('configNote').textContent = '请先保存新的博客目录，再编辑它的配置文件。';
    });
    $('s-config-file').addEventListener('change', () => {
      if (!discardConfig()) { $('s-config-file').value = state.config.name; return; }
      loadConfig($('s-config-file').value);
    });
    $('btnReloadConfig').addEventListener('click', () => { if (discardConfig()) loadConfig($('s-config-file').value); });
    $('btnSaveConfig').addEventListener('click', async () => {
      if (!state.config || configBusy) return;
      const request = ++configRequest;
      configBusy = true;
      syncConfigControls();
      try {
        const r = await postJSON('/api/config', { blog: state.config.blog, name: state.config.name, revision: state.config.revision, content: $('s-config-content').value });
        if (request !== configRequest) return;
        $('s-config-content').value = r.content;
        state.config = { ...r, content: $('s-config-content').value };
        $('configNote').textContent = '已保存；原文件备份：' + r.backup + '。请重新生成，或重启本地预览。';
        await loadInfo();
        toast('博客配置已保存并备份', 'ok');
      } catch (e) {
        if (request !== configRequest) return;
        $('configNote').textContent = '保存失败：' + e.message;
        toast(e.message, 'err');
      } finally { if (request === configRequest) { configBusy = false; syncConfigControls(); } }
    });
    $('btnSaveSettings').addEventListener('click', async () => {
      const previousBlog = state.info && state.info.blog;
      const switching = $('s-blog').value.trim() !== previousBlog;
      if (switching && state.dirty && !confirm('切换博客前有未保存的文章。内容会保留在本机恢复缓存，确定切换吗？')) return;
      if (!discardConfig()) return;
      const btn = $('btnSaveSettings');
      btn.disabled = true;
      try {
        if (switching) cacheFlush();
        const r = await postJSON('/api/settings', {
          blog: $('s-blog').value.trim(),
          previewPort: Number($('s-preview').value),
          toolPort: Number($('s-tool').value),
        });
        toast(r.restartRequired ? '设置已保存。写作台端口改动需要重启后才生效' : '设置已保存', 'ok');
        state.config = null;
        closeSettings();
        await loadInfo();
        if (previousBlog !== r.blog) { selected.clear(); state.search = ''; $('search').value = ''; newPost(false); }
        await loadPosts();
        setRunning(false, '空闲');
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    /* 关闭写作台：两段确认，避免误点 */
    let armed = false, timer = null;
    const disarm = () => { armed = false; $('btnShutdown').classList.remove('armed'); $('btnShutdown').textContent = '关闭服务'; };
    $('btnShutdown').addEventListener('click', async () => {
      const btn = $('btnShutdown');
      if (!armed) {
        armed = true;
        btn.classList.add('armed');
        btn.textContent = '再点一次确认';
        toast('再点一次即关闭写作台服务（本地预览也会一起停）', 'warn');
        clearTimeout(timer);
        timer = setTimeout(disarm, 4000);
        return;
      }
      clearTimeout(timer);
      disarm();
      if (state.dirty && $('f-title').value.trim() && !confirm('有未保存的改动，仍要关闭吗？\n（内容已存在本机缓存，下次打开这篇文章时会提示恢复）')) return;
      btn.disabled = true;
      try {
        const r = await postJSON('/api/shutdown', {});
        setRunning(true, '已关闭');
        $('btnServe').disabled = true;
        $('btnStop').disabled = true;
        finishShutdown(r.pid);   // 服务退了之后，窗口也跟着退（见 finishShutdown 的说明）
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '关闭服务';
        toast(e.message, 'err');
      }
    });

    /* 快捷键与离开提醒 */
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if ($('settingsModal').classList.contains('show')) {
          if (e.target === $('s-config-content')) $('btnSaveConfig').click();
          return;
        }
        savePost(false).catch(() => {});
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.closing) return;        // 主动关闭：别再拦一道"确定要离开吗"
      cacheFlush();
      if (configDirty() || (state.dirty && $('f-title').value.trim())) { e.preventDefault(); e.returnValue = ''; }
    });
    /* 页面隐藏时立刻落一次缓存，别等防抖 */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.dirty) cacheFlush();
    });

    initConsoleResize();
  }

  async function boot() {
    initTheme();
    bindUI();

    window.Editor.init({
      getContext: () => ({ post: state.savedName || state.current || '', draft: state.draft }),
      onDirty: markDirty,
      onToast: toast,
      upload: async (blob, filename) => {
        if (state.info && state.info.postAssetFolder === false) {
          throw new Error('请先在博客 _config.yml 中启用 post_asset_folder: true');
        }
        if (!state.savedName) {
          const n = await savePost(true);
          if (!n) throw new Error('请先填写标题，图片要存在文章的同名资源目录里');
        }
        const q = `post=${encodeURIComponent(state.savedName)}&draft=${state.draft ? 1 : 0}&name=${encodeURIComponent(filename)}`;
        return api('/api/upload?' + q, {
          method: 'PUT',
          headers: { 'Content-Type': blob.type || 'application/octet-stream' },
          body: blob,
        });
      },
      /* PDF 导入 = 把一份 PDF 直接变成一篇新文章的正文。
       * 解析在服务端（/api/import-pdf），拿回来的就是现成的 markdown。
       * 它会**覆盖整个编辑区**，所以编辑区里已经有东西时先问一句；
       * 默认勾上"存为草稿" —— PDF 抽出来的文字几乎不可能直接能发，
       * 落成草稿既不会误发布，又能让列表里一眼看见。
       *
       * 标题**就用文件名**：版面里"哪一行算标题"只能靠字号猜，长标题软换行、
       * 副标题、页眉都会让它认错（实测把标题切成两半、又弄丢过正文里的大标题）。
       * 所以把文件名通过 ?title= 交给服务端，服务端优先用它、并且不再从正文
       * 里抽走任何一行 —— 版面内容整篇进正文。文件名不合适就在标题框里改。
       *
       * 图：PDF 里真正画在页面上的截图会由服务端取出来、存进**文章同名资源目录**，
       * 正文里写 Hexo 原生 {% asset_img %}。两件事必须在这里对齐：
       *   ① ?draft=1（下面默认勾了"存为草稿"，服务端就得把图放进 _drafts，
       *      否则发布时 Hexo 找不到图片）；
       *   ② 资源目录名 = 保存时的文件名（lib.sanitizeName(f-name || title)），
       *      所以服务端把算好的名字回传，这里写进 f-name —— 之后在标题框里改标题
       *      也不会换目录（f-name 优先于 title），图片不会失联。 */
      importPdf: async (file) => {
        if (state.dirty || $('body').value.trim()) {
          if (!confirm('导入会把编辑区换成这份 PDF 的内容。\n\n当前编辑区里的内容（未保存的部分只在本机缓存里）会被替换掉。继续吗？')) {
            throw new Error('已取消导入');
          }
        }
        const buf = await file.arrayBuffer();
        const base = file.name.replace(/\.pdf$/i, '');
        const r = await api('/api/import-pdf?title=' + encodeURIComponent(base) + '&draft=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: buf,
        });
        newPost(false);
        $('f-title').value = (r.title || '').trim() || base;
        $('f-draft').checked = true;
        /* f-name 是保存时的**文件名**，也决定资源目录名：用服务端回传的那个，
           保证"图放在哪"和"保存到哪"是同一个目录。 */
        $('f-name').value = (r.assets && r.assets.name) || '';
        $('body').value = r.markdown;
        refreshFieldSummary();
        markDirty();
        window.Editor.render();
        updateStats();
        const n = (r.assets && r.assets.count) || 0;
        const hint = n ? `已存为草稿，并取出 ${n} 张图放在同名资源目录里`
          : (r.assetFolder === false ? '已存为草稿（博客没开 post_asset_folder，图片不能存进文章目录）'
            : '已存为草稿待你确认');
        return { stats: r.stats, hint };
      },
    });
    window.Editor.render();

    setRunning(false, '连接中…');
    $('status').textContent = '连接中…';

    for (let i = 0; i < 60; i++) {
      try {
        await loadInfo();
        break;
      } catch (e) {
        if (i === 59) {
          $('status').textContent = '无法连接';
          toast('连接本地服务失败。请确认命令行窗口里 node server.js 没有报错，然后刷新本页。', 'err');
          return;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    if (!state.info.blog) {
      newPost(false);
      setRunning(false, '请设置博客目录');
      await openSettings();
      $('s-blog').focus();
      return;
    }
    await loadPosts();
    setRunning(false, '空闲');

    const c = cacheRead(NEW_CACHE);
    if (c && c.fields) {
      if (confirm(`有一篇未保存的新文章（${fmtTime(new Date(c.at).toISOString())}）。\n\n恢复它吗？\n选“取消”将丢弃。`)) {
        newPost(false);
        applyCache(c);
        toast('已恢复未保存的新文章', 'warn');
      } else {
        cacheClear(NEW_CACHE);
        newPost(false);
      }
    } else {
      newPost(false);
    }

    await restoreJobs();
  }

  boot().catch((e) => {
    $('status').textContent = '启动失败';
    toast('启动失败：' + e.message, 'err');
  });
})();
