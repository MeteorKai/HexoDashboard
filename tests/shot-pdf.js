/* PDF → Markdown 导入的真浏览器验收。
 *
 *   node tests/shot-pdf.js [baseUrl] [outDir] [postName]
 *
 * 为什么要专门一个脚本：static-check 只能证明"文件之间对得上"（按钮在、opts 注了、
 * 接口路径没写错），证明不了这条链在真浏览器里真的能走通：
 *   · 动态生成的 <input type=file> 到底有没有把文件交到 opts.importPdf 手上
 *   · File.arrayBuffer() 拿到的字节 POST 到 /api/import-pdf 会不会被令牌拦掉（403）
 *   · 写作台那一路"新文章 + 填标题 + 勾草稿 + 整篇替换"有没有真的发生
 *   · 单篇页那一路是**插到光标处**（不是替换）—— 这两条路恰好相反，最容易接错
 *
 * 怎么把文件"塞"进去：不点系统的文件选择框（headless 下会挂），而是在页内
 * 用 DataTransfer 造一个真的 File 直接赋给 input.files 再派发 change ——
 * 和用户手选走的是同一条 onchange 路径，但全程不弹窗、可重复。
 * 前提是先把 HTMLInputElement.prototype.click 换掉，把那个 input 捞出来。
 *
 * 前置：node tests/ui-blog-setup.js && PORT=4466 node server.js %TEMP%/hexo-ui-blog
 *
 * 两点可重复性说明：
 *   - 临时博客是复用的，正文里会留着上一轮导入的内容。所以样本 PDF 的文字带时间戳，
 *     且第六节按"命中数有没有 +1"判定，而不是按"正文里有没有这段话"。
 *   - 完成判据一律用**按钮从「解析中」复位**，不用"正文出现某段文字"（同上，会误判）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launch } = require('./cdp');
const { tinyPdf } = require('./pdf-fixture');

const BASE = (process.argv[2] || 'http://127.0.0.1:4466').replace(/\/$/, '');
const OUT = process.argv[3] || path.join(__dirname, '..', '.workbuddy', 'shots', 'pdfimport');
const POST = process.argv[4] || '第二篇';
const POST_URL = `${BASE}/post?name=${encodeURIComponent(POST)}&draft=0`;

/* 样本 PDF：和 tests/e2e.js 共用同一个 fixture，二进制里只有一行 ASCII。
   中文要嵌 CID 字体，那体量不该进测试；这里要验的是"链路通不通"，不是"抽取准不准"
   （抽取质量由 tests/pdfmd.test.js 用合成数据 + 三个真实样本覆盖）。 */
const PDF_B64 = tinyPdf('Hello PDF import ' + Date.now()).toString('base64');
const PDF_NAME = 'import-sample.pdf';
const EXPECT = 'Hello PDF import ';

const log = [];
const say = (k, v) => log.push(String(k).padEnd(12, ' ') + ' ' + v);
let fails = 0;
const check = (cond, label, detail) => {
  if (cond) say('PASS', label);
  else { fails++; say('FAIL', label + (detail === undefined ? '' : '  → ' + detail)); }
};
/* 进度打到 stderr：这个脚本要起浏览器、跑好几段，卡住时得能一眼看出卡在哪一步 */
const step = (s) => process.stderr.write('>> ' + s + '\n');

/* 把一段 base64 造出来的 File 塞进"上一次被 click 过的 file input"，并派发 change。 */
const INJECT = (b64, name) => `(async () => {
  const bin = atob(${JSON.stringify(b64)});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const f = new File([arr], ${JSON.stringify(name)}, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(f);
  const inp = window.__pdfInput;
  if (!inp) return { error: '没抓到 file input（按钮的 click 没被 hook 到）' };
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  /* 完成判据是**按钮从"解析中"复位**，不是"正文里出现了某段文字"：
     正文里可能本来就有（上一轮存进临时博客的），那样循环一进去就 break，
     会把"还在解析中"误当成"已完成"。 */
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (!document.getElementById('btnPdf').disabled) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const last = document.getElementById('toast').lastElementChild;
  return { name: inp.files[0].name, size: inp.files[0].size, tookMs: Date.now() - t0,
           stillBusy: document.getElementById('btnPdf').disabled,
           toast: last ? last.textContent : '' };
})()`;

/* 每次导航后都要重挂：导航会清掉 window 上的钩子。
   顺带把 confirm 换成"总是同意 + 记数"：一来 headless 下点不掉原生框，
   二来第三节要断言"确实先问了一句"。 */
const ARM = `(() => {
  window.__pdfInput = null;
  window.__confirmCalls = 0;
  if (!window.__pdfHooked) {
    const origClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file') { window.__pdfInput = this; return; }   // 不真的点，避免弹原生框
      return origClick.apply(this, arguments);
    };
    window.confirm = function () { window.__confirmCalls++; return true; };
    window.__pdfHooked = true;
  }
  return true;
})()`;

(async () => {
  step('起浏览器');
  const br = await launch({ out: OUT, profile: 'hexo-shot-pdf', freshProfile: true });
  const { evaluate, waitFor, media, shot, sleep } = br;

  try {
    await run();
  } finally {
    /* 一定要优雅收尾：中途抛错时若直接走人，Chrome 被硬杀，这个 profile 目录就脏了
       （脏了之后复用它的下一轮会整个卡死，症状见 tests/cdp.js 的 close()）。 */
    step('关浏览器');
    await br.close().catch(() => { /* 忽略 */ });
    write();
  }

  async function run() {
    /* 每节都从干净状态开始：清掉上一节/上一轮留在本机的草稿缓存。
       不清的话重新载入时会弹"有一篇未保存的新文章，恢复它吗？"，
       自动确认后会把上一节的正文恢复进编辑区 —— 截图和断言都会跟着漂。 */
    const open = async (url, theme) => {
      step('打开 ' + url + ' [' + (theme || 'light') + ']');
      await br.goto(url);
      await evaluate(`(() => {
        localStorage.setItem("hexo-tool-theme", ${JSON.stringify(theme || 'light')});
        for (const k of Object.keys(localStorage)) if (k.indexOf('hexo-tool-cache:') === 0) localStorage.removeItem(k);
        return true;
      })()`);
      await media(theme || 'light');
      await br.send('Page.navigate', { url });
      await waitFor('document.readyState === "complete"');
      await waitFor('!!document.querySelector("#postlist, #postpage")', 20000);
      await sleep(700);
    };

    /* ═══ ① 写作台：按钮存在、真的点得到、提示语对 ═════════════════════ */
    step('① 写作台');
    await open(BASE + '/', 'light');
    await waitFor('!!document.querySelector("#postlist li")', 20000);

    const btn = await evaluate(`(() => { const b = document.getElementById('btnPdf');
      if (!b) return { missing: true };
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { text: b.textContent.trim(), title: b.title, disabled: b.disabled,
               w: Math.round(r.width), h: Math.round(r.height),
               clickable: b.contains(top) || top === b }; })()`);
    say('按钮外观', JSON.stringify(btn));
    check(!btn.missing, '写作台有「导入 PDF」按钮');
    check(btn.clickable === true, '按钮真的点得到（没被别的元素盖住）', JSON.stringify(btn));
    check(/PDF/.test(btn.text || '') && /新文章/.test(btn.title || ''), '按钮文案说清了它会做什么', btn.text);
    say('按钮图', path.basename(await shot('i1-light-btn.png')));

    /* ═══ ② 第一次导入：编辑区为空 → 不该弹确认 ════════════════════════ */
    step('② 首次导入');
    await evaluate(ARM);
    await evaluate('document.getElementById("btnPdf").click()');
    const picked = await evaluate('window.__pdfInput ? window.__pdfInput.accept : null');
    say('文件框', String(picked));
    check(!!picked && /pdf/i.test(picked), '文件选择框只收 PDF', String(picked));

    const r1 = await evaluate(INJECT(PDF_B64, PDF_NAME));
    say('导入1', JSON.stringify(r1));
    check(!r1.error && r1.stillBusy === false, '一次导入在浏览器里真的跑完了', JSON.stringify(r1));

    const st1 = await evaluate(`(() => ({
      title: document.getElementById('f-title').value,
      draft: document.getElementById('f-draft').checked,
      editorTitle: document.getElementById('editorTitle').textContent,
      words: document.getElementById('wordCount').textContent,
      inBody: document.getElementById('body').value.includes(${JSON.stringify(EXPECT)}),
      previewOnDemand: !!document.getElementById('btnPreview') && !document.getElementById('preview'),
      selected: !!document.querySelector('#postlist li.sel'),
      confirmCalls: window.__confirmCalls,
    }))()`);
    say('状态1', JSON.stringify(st1));
    check(st1.confirmCalls === 0, '编辑区本来是空的 —— 不该弹确认框');
    check(st1.title === 'import-sample', '标题按文件名兜底填上了', st1.title);
    check(st1.draft === true, '默认勾上了"存为草稿"');
    check(st1.inBody === true, '抽取结果进了编辑区');
    check(st1.previewOnDemand === true, 'PDF 导入后仍使用按需预览，不挤占正文空间');
    check(/新建文章/.test(st1.editorTitle), '走的是"新文章"这条路，没有覆盖某篇现有文章', st1.editorTitle);
    check(!!st1.words && !/^0 /.test(st1.words), '字数统计跟着更新了', st1.words);
    check(/已从 PDF 提取/.test(r1.toast || ''), '提示语报出了提取结果', r1.toast);
    say('浅色导入', path.basename(await shot('i2-light-imported.png')));

    /* ═══ ③ 第二次导入：编辑区已有内容 → 必须先确认再整篇替换 ══════════ */
    step('③ 二次导入');
    await evaluate(`(() => { const ta = document.getElementById('body');
      ta.value = '这段是脚本先塞进去的旧内容，导入应该把它整段换掉。';
      ta.dispatchEvent(new Event('input', { bubbles: true })); return ta.value.length; })()`);
    await sleep(300);
    await evaluate(ARM);
    await evaluate('document.getElementById("btnPdf").click()');
    const r2 = await evaluate(INJECT(PDF_B64, 'second.pdf'));
    const st2 = await evaluate(`(() => { const v = document.getElementById('body').value; return {
      confirmCalls: window.__confirmCalls,
      oldGone: !v.includes('脚本先塞进去的旧内容'),
      title: document.getElementById('f-title').value,
      occurrences: v.split(${JSON.stringify(EXPECT)}).length - 1,
    }; })()`);
    say('导入2', JSON.stringify(r2));
    say('状态2', JSON.stringify(st2));
    check(st2.confirmCalls === 1, '编辑区有内容时先问了用户一句', 'confirm 被调了 ' + st2.confirmCalls + ' 次');
    check(st2.oldGone === true, '旧内容被整段换掉（不是拼接）');
    check(st2.occurrences === 1, '整篇替换后只有一份新内容', '出现了 ' + st2.occurrences + ' 次');

    /* ═══ ④ 失败要"说清楚"，不能装作无事 ═══════════════════════════════
       选一个不是 PDF 的文件：服务端先验文件头，回一句人话，页面弹红色提示。 */
    step('④ 非 PDF 文件');
    await evaluate(ARM);
    await evaluate('document.getElementById("btnPdf").click()');
    const bad = await evaluate(`(async () => {
      /* 先把旧 toast 清掉。不清的话下面那句"等到出现错误提示"会被**上一条成功提示**
         里的 "PDF" 二字骗到，一进循环就 break —— 断言于是变成了在看一条过期消息。 */
      document.getElementById('toast').textContent = '';
      const f = new File([new TextEncoder().encode('这不是 PDF，只是一段文字')], 'not-a-pdf.pdf', { type: 'application/pdf' });
      const dt = new DataTransfer(); dt.items.add(f);
      window.__pdfInput.files = dt.files;
      window.__pdfInput.dispatchEvent(new Event('change', { bubbles: true }));
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        if (document.querySelector('#toast .err')) break;      // 只认"新冒出来的红色提示"
        await new Promise((r) => setTimeout(r, 150));
      }
      return { toast: document.getElementById('toast').textContent.trim(),
               errShown: !!document.querySelector('#toast .err'),
               text: document.getElementById('btnPdf').textContent.trim() };
    })()`);
    say('非 PDF', JSON.stringify(bad));
    check(bad.errShown === true, '选错文件时弹的是错误提示（不是静默无事）');
    check(/不是\s*PDF|PDF 文件/.test(bad.toast), '错误文案是人话，没把异常栈糊到脸上', bad.toast);
    say('错误图', path.basename(await shot('i3-light-badfile.png')));
    /* 等这条线彻底静下来再翻页：按钮从"解析中"复位就说明收尾了 */
    const quiet = await waitFor('document.getElementById("btnPdf").disabled === false', 10000);
    check(quiet, '失败后按钮复位了（没一直卡在"解析中"）');

    /* ═══ ⑤ 深色：同一页再来一遍，确认新按钮在深色下也看得清 ═══════════ */
    step('⑤ 深色');
    await open(BASE + '/', 'dark');
    await waitFor('!!document.querySelector("#postlist li")', 20000);
    await evaluate(ARM);
    await evaluate('document.getElementById("btnPdf").click()');
    /* 判据用**一个独有文件名**：写作台这条路是整篇替换，替换完标题必然变成这个新名字。
       不能拿"正文里有没有那段文字"当判据 —— 这一节加载时浏览器可能已经把上一节留在
       本机的草稿自动恢复了（"恢复未保存的新文章"那条提示），编辑区里本来就有一段同样的文字。 */
    const r4 = await evaluate(INJECT(PDF_B64, 'dark-sample.pdf'));
    const dark = await evaluate(`(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      title: document.getElementById('f-title').value,
      draft: document.getElementById('f-draft').checked,
      hits: document.getElementById('body').value.split(${JSON.stringify(EXPECT)}).length - 1,
      btnVisible: (() => { const b = document.getElementById('btnPdf'); const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
    }))()`);
    say('深色', JSON.stringify(dark) + ' ' + JSON.stringify(r4));
    check(dark.theme === 'dark', '深色主题确实生效了', dark.theme);
    check(r4.stillBusy === false, '深色下导入一样能跑完', JSON.stringify(r4));
    check(dark.title === 'dark-sample' && dark.draft === true && dark.hits === 1,
      '深色下导入真的发生了（标题换成新文件名、勾上草稿、正文恰好一份）', JSON.stringify(dark));
    check(dark.btnVisible === true, '深色下按钮有尺寸（没被挤没）');
    say('深色导入', path.basename(await shot('i4-dark-imported.png')));

    /* ═══ ⑥ 单篇编辑页：这里是**插到光标处**，不是整篇替换 ═════════════ */
    step('⑥ 单篇页');
    await open(POST_URL, 'light');
    await waitFor('document.getElementById("ppState").textContent !== "载入中…"', 20000);
    await sleep(500);

    const before = await evaluate(`(() => { const v = document.getElementById('body').value;
      return { len: v.length, hits: v.split(${JSON.stringify(EXPECT)}).length - 1 }; })()`);
    const hasPdfBtn = await evaluate(`(() => { const b = document.getElementById('btnPdf');
      return b ? { text: b.textContent.trim(), title: b.title } : null; })()`);
    say('单篇按钮', JSON.stringify(hasPdfBtn));
    say('单篇原稿', JSON.stringify(before));
    check(!!hasPdfBtn && /PDF/.test(hasPdfBtn.text), '单篇页也有「导入 PDF」按钮');
    check(/插到光标处/.test((hasPdfBtn || {}).title || ''), '单篇页的提示语说的是"插到光标处"（和写作台相反）', (hasPdfBtn || {}).title);
    say('单篇图', path.basename(await shot('i5-post-before.png')));

    await evaluate(ARM);
    await evaluate('document.getElementById("btnPdf").click()');
    const r5 = await evaluate(INJECT(PDF_B64, PDF_NAME));
    const st5 = await evaluate(`(() => { const v = document.getElementById('body').value; return {
      grew: v.length > ${before.len},
      keptOld: v.includes('背景') || v.includes('复现步骤'),
      hits: v.split(${JSON.stringify(EXPECT)}).length - 1,
      state: document.getElementById('ppState').textContent,
    }; })()`);
    say('单篇导入', JSON.stringify(r5));
    say('单篇状态', JSON.stringify(st5));
    check(st5.hits === before.hits + 1, '内容被**插进去**了（命中数正好 +1，不是替换）',
      before.hits + ' → ' + st5.hits);
    check(st5.keptOld === true, '原有正文没被动过（"插到光标处"而不是覆盖）');
    check(st5.grew === true, '编辑区确实变长了');
    check(st5.state === '未保存', '插入后被标成未保存（否则用户以为已经存好了）', st5.state);
    say('单篇图2', path.basename(await shot('i6-post-imported.png')));

    /* 单篇页也要能真的存下去 —— 不然"插到光标处"只是看着成功 */
    await evaluate('document.getElementById("btnSave").click()');
    const saved = await waitFor(`document.getElementById('ppState').textContent === '已保存'`, 10000);
    check(saved, '单篇页保存成功（插入的内容真的落到了 md 里）');

    /* 原生对话框被自动 accept 掉了（不处理会卡死渲染进程），但得让人看见它确实弹过 */
    say('原生对话框', br.dialogs.length + ' 个' + (br.dialogs.length ? ' · ' + JSON.stringify(br.dialogs) : ''));
    say(fails ? '结果' : '完成', fails ? fails + ' 项没过 ❌' : '全部通过 ✅');
  }

  function write() {
    const txt = log.join('\n').trimEnd();
    console.log(txt);
    fs.writeFileSync(path.join(OUT, 'report.txt'), txt + '\n');
    if (fails) process.exitCode = 1;
  }
})().catch((e) => {
  console.error('失败: ' + (e && e.stack ? e.stack : e.message));
  process.exit(1);
});
