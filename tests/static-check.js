/* 前端静态自检：不开服务，直接读文件做一致性检查。
 *
 *   node tests/static-check.js
 *
 * 检查什么（都是"不跑起来就发现不了、但一跑就是静默失效"的那类问题）：
 *   ① 4 个前端 JS 能否编译（用 vm 内存编译，**不能用 node --check**——
 *      这台机器上 spawnSync 被劫持，会假报语法错误）
 *   ② JS 里 $('xxx') 引用的 id 是否都在 index.html 里；反过来有没有多余 id
 *   ③ CSP 合规：没有内联 <script>、没有内联事件属性
 *   ④ index.html 引用的每个 /xxx 路径，能否按 server.js 的 STATIC 表解析到真实文件
 *   ⑤ 写操作是否只从 api() 一处发出（令牌不会漏加）
 *   ⑥ 媒体路径格式 /media/p|d/、保存时是否带 revision / changedFields / frontMatter
 *   ⑦ HTML 标签开合是否配对
 *   ⑧ HTML/JS 里用到的 class 是否都在 styles.css 里有定义（抓拼写错）
 *   ⑨ 编译窗口的拖高 / 放大 / 产物路径三件事是否成对存在
 *   ⑩ 独立编辑页 post.html / post.js 的同一套一致性检查 —— 尤其是 editor.js 是
 *      两个页面共用的模块，独立页少一个它要的 id，编辑器就会静默失灵
 *   ⑪ PDF 导入这条链是否完整：按钮 → editor.js → 页面注入 → /api/import-pdf → vendor/pdfjs，
 *      以及真浏览器验收（tests/shot-pdf.js + tests/cdp.js）里那两个"症状离真相很远"的
 *      坑有没有被填回去（原生对话框卡死渲染进程、脏 profile 卡死下一轮）
 *   ⑫ 便携包布局：src/ web/ data/ 三层是否各就各位，以及"把源码挪进 src/"之后
 *      有没有哪处还按老位置找文件（这类引用只有真跑起来才暴露）
 *      顺带钉住"退出时清 pid 文件"必须走**改名挪走**而不是删除 —— exit 钩子里
 *      的 unlinkSync 会被删除守卫接管，最坏的情况不是失败而是**把进程阻塞住**
 *   ⑬ 跨平台启动：Windows 通过 .vbs 隐藏运行，macOS 使用 .command；
 *      以及关闭时"页面一起退场"这条链（--app 窗口允许脚本关闭自己，普通标签页不允许，
 *      所以两种都要有安排）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');     // 服务端源码
const WEB = path.join(ROOT, 'web');     // 页面与前端资源
const DATA = path.join(ROOT, 'data');   // 运行时产物（settings / pid / last-deploy）
const OUT = path.join(__dirname, 'static-check.out');
const out = [];
const log = (...a) => out.push(a.join(' '));
let fail = 0;
const ok = (cond, label, detail) => {
  if (cond) log('  PASS  ' + label);
  else { fail++; log('  FAIL  ' + label + (detail ? '  → ' + detail : '')); }
};

const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const srv = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const ed = fs.readFileSync(path.join(WEB, 'editor.js'), 'utf8');
const phtml = fs.readFileSync(path.join(WEB, 'post.html'), 'utf8');
const pjs = fs.readFileSync(path.join(WEB, 'post.js'), 'utf8');
const pdfmdSrc = fs.readFileSync(path.join(SRC, 'pdfmd.js'), 'utf8');
const pimpSrc = fs.readFileSync(path.join(SRC, 'pdfimport.js'), 'utf8');

/* STATIC 表：URL -> 真实文件。注意表里写的是**相对应用根**的路径
   （页面全在 web/，第三方在 vendor/），所以下面一律用 path.join(ROOT, ...) 解析。 */
const STATIC = new Map([...srv.matchAll(/\['(\/[^']*)','([^']+)'\]/g)].map((m) => [m[1], m[2]]));

log('== 1. 语法编译 ==');
for (const f of ['web/theme.js', 'web/editor.js', 'web/app.js', 'web/post.js', 'src/pdfmd.js', 'src/pdfimport.js']) {
  try { new vm.Script(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f }); log('  PASS  ' + f + ' 语法正确'); }
  catch (e) { fail++; log('  FAIL  ' + f + ' → ' + e.message); }
}

log('');
log('== 2. JS 引用的 id 都存在 ==');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Map();
for (const [f, src] of [['editor.js', ed], ['app.js', app]]) {
  for (const m of src.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) if (!used.has(m[1])) used.set(m[1], f);
}
const missing = [...used.entries()].filter(([id]) => !htmlIds.has(id));
ok(missing.length === 0, `引用的 ${used.size} 个 id 全部存在`, missing.map(([i, f]) => `${i}(${f})`).join(', '));

const labelled = new Set([...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]));
const unusedIds = [...htmlIds].filter((id) => !used.has(id) && !labelled.has(id));
ok(unusedIds.length === 0, '没有多余的 id（除 aria-labelledby 目标）', unusedIds.join(', '));

log('');
log('== 3. CSP 合规 ==');
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
ok(inlineScripts.length === 0, '没有内联 <script>', inlineScripts.length + ' 处');
const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*["']/gi)];
ok(handlers.length === 0, '没有内联事件属性', handlers.map((h) => h[0].trim()).join(', '));

log('');
log('== 4. 页面引用的资源（按 STATIC 表解析）==');
const refs = [...new Set([...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]))];
for (const r of refs) {
  const target = STATIC.get(r);
  if (!target) { fail++; log('  FAIL  ' + r + ' 不在 STATIC 表中'); continue; }
  const exists = fs.existsSync(path.join(ROOT, target));
  if (!exists) fail++;
  log('  ' + (exists ? 'PASS' : 'FAIL') + '  ' + r + '  →  ' + target);
}

log('');
log('== 5. 写操作令牌 ==');
ok(/x-hexo-token/.test(app), 'app.js 注入 x-hexo-token');
const rawFetch = [...app.matchAll(/(?<![.\w])fetch\(/g)].length;
ok(rawFetch === 1, '只有 api() 一处直接 fetch', '实际 ' + rawFetch);

log('');
log('== 6. 媒体路径 / 版本字段 ==');
ok(/\/media\/' \+ \(ctx\.draft \? 'd' : 'p'\)/.test(ed), 'editor.js 用 /media/p|d/...');
ok(/\/media\/' \+ \(draft \? 'd' : 'p'\)/.test(app), 'app.js 用 /media/p|d/...');
ok(/payload\.revision = state\.revision/.test(app), '保存时带上 revision');
ok(/payload\.changedFields = changedFields\(\)/.test(app), '保存时只提交改动字段');
ok(/payload\.frontMatter = state\.frontMatter/.test(app), '保存时回传原始 front-matter');

log('');
log('== 7. HTML 结构 ==');
const opens = [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)].filter((m) => !/\/>$/.test(m[0]) && !['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'track', 'wbr', 'area', 'col', 'embed', 'param'].includes(m[1].toLowerCase()));
const closes = [...html.matchAll(/<\/([a-z][a-z0-9]*)>/gi)];
const count = (arr, tag) => arr.filter((x) => x[1].toLowerCase() === tag).length;
for (const tag of ['div', 'section', 'aside', 'header', 'details', 'button', 'ul', 'li', 'textarea', 'pre', 'h2', 'a', 'span', 'label']) {
  ok(count(opens, tag) === count(closes, tag), `<${tag}> 开合配对 (${count(opens, tag)})`);
}

log('');
log('== 8. class 是否都有样式（抓拼写错）==');
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
const usedClasses = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => usedClasses.add(c));
for (const src of [app, ed]) {
  /* 只认完整的 className 赋值；'l-' + (...) 这种动态拼接不算（下面单独校验 l-* 全集） */
  for (const m of src.matchAll(/className\s*=\s*'([^']+)'(?!\s*\+)/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => usedClasses.add(c));
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) usedClasses.add(m[1]);
}
/* 动态拼出来的：l-out/l-err/l-info/l-ok/l-fail/l-end 一起校验 */
['l-out', 'l-err', 'l-info', 'l-ok', 'l-fail', 'l-end'].forEach((c) => usedClasses.add(c));
const noStyle = [...usedClasses].filter((c) => !cssClasses.has(c));
ok(noStyle.length === 0, `用到的 ${usedClasses.size} 个 class 都有样式`, noStyle.join(', '));

log('');
log('== 9. 编译窗口（拖高 / 放大 / 产物直达）==');
ok(/id="consoleGrip"/.test(html) && /role="separator"/.test(html), 'index.html 里有可聚焦的拖拽分隔条');
ok(/grid-template-rows:[^;]*var\(--console-h\)/.test(css), '网格行高走 --console-h（改回硬编码 px 会让拖动静默失效）');
ok(/--console-h:/.test(css), '--console-h 有默认值（不依赖 JS 才有高度）');
ok(/\.app\.console-max/.test(css) && /classList\.toggle\('console-max'/.test(app), '放大态：样式与开关成对存在');
ok(/'\/api\/post-url\?name='/.test(app), 'app.js 会查本文的产物路径');
ok(/p==='\/api\/post-url'/.test(srv), 'server.js 提供 /api/post-url');
ok(/animation:\s*rise[^}]*backwards/.test(css), '入场动画仍用 backwards 填充（被强制禁用动画时不会整页留白）');

log('');
log('== 10. 独立编辑页（post.html / post.js）==');
const pInline = [...phtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
ok(pInline.length === 0, 'post.html 没有内联 <script>', pInline.length + ' 处');
const pHandlers = [...phtml.matchAll(/\son[a-z]+\s*=\s*["']/gi)];
ok(pHandlers.length === 0, 'post.html 没有内联事件属性', pHandlers.map((h) => h[0].trim()).join(', '));

/* 独立页复用 editor.js，所以"被引用"的 id 来自两个文件；把 editor.js 一起算进来，
   否则它要的 body / btnPreview 会被误判成"多余的 id"。 */
const pIds = new Set([...phtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const pUsed = new Set();
for (const src of [pjs, ed]) for (const m of src.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) pUsed.add(m[1]);
const pMissing = [...pUsed].filter((id) => !pIds.has(id));
ok(pMissing.length === 0, `post.js / editor.js 引用的 ${pUsed.size} 个 id 在 post.html 里都存在`, pMissing.join(', '));
const pUnused = [...pIds].filter((id) => !pUsed.has(id));
ok(pUnused.length === 0, 'post.html 没有多余的 id', pUnused.join(', '));

/* editor.js 两个页面共用：这 5 个节点少一个，独立页的编辑器就是一块打不开的空白 */
const edNeeds = [...new Set([...ed.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
const edGap = edNeeds.filter((id) => !pIds.has(id));
ok(edGap.length === 0, `editor.js 需要的 ${edNeeds.length} 个节点在独立页里一个不缺`, edGap.join(', '));

const pRefs = [...new Set([...phtml.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]))];
const pBadRef = pRefs.filter((r) => { const t = STATIC.get(r); return !t || !fs.existsSync(path.join(ROOT, t)); });
ok(pBadRef.length === 0, `post.html 引用的 ${pRefs.length} 个资源都能按 STATIC 表解析到文件`, pBadRef.join(', '));
ok(STATIC.get('/post') === 'web/post.html' && STATIC.get('/post.js') === 'web/post.js', 'server.js 的 STATIC 表登记了 /post 与 /post.js');

const pFetch = [...pjs.matchAll(/(?<![.\w])fetch\(/g)].length;
ok(pFetch === 1, 'post.js 只有 api() 一处直接 fetch（令牌不会漏加）', '实际 ' + pFetch);
ok(/revision: state\.revision,/.test(pjs), 'post.js 保存时带上 revision（否则服务端 428）');
ok(/changedFields: changedFields\(\)/.test(pjs), 'post.js 只提交真的改过的字段');
ok(/frontMatter:/.test(pjs) === false, 'post.js 不回传 frontMatter（交给服务端读磁盘上的原始 header）');

const pOpens = [...phtml.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)].filter((m) => !/\/>$/.test(m[0]) && !['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'track', 'wbr', 'area', 'col', 'embed', 'param'].includes(m[1].toLowerCase()));
const pCloses = [...phtml.matchAll(/<\/([a-z][a-z0-9]*)>/gi)];
for (const tag of ['div', 'section', 'header', 'details', 'button', 'textarea', 'span', 'label', 'p', 'h2', 'a']) {
  ok(count(pOpens, tag) === count(pCloses, tag), `post.html <${tag}> 开合配对 (${count(pOpens, tag)})`);
}

const pClasses = new Set();
for (const m of phtml.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => pClasses.add(c));
for (const m of pjs.matchAll(/className\s*=\s*'([^']+)'(?!\s*\+)/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => pClasses.add(c));
for (const m of pjs.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) pClasses.add(m[1]);
const pNoStyle = [...pClasses].filter((c) => !cssClasses.has(c));
ok(pNoStyle.length === 0, `独立页用到的 ${pClasses.size} 个 class 都有样式`, pNoStyle.join(', '));

ok(/function openPostTab\(/.test(app) && /`\/post\?name=\$\{encodeURIComponent\(name\)\}&draft=/.test(app), 'app.js 里有打开独立页的入口');
ok(/id="btnOpenTab"/.test(html) && /id="btnEditTab"/.test(html), '写作台上两个入口按钮都在（工具栏 / 编译摘要条）');

log('');
log('== 11. PDF → Markdown 导入 ==');
/* vendor 里这几样少任何一个，功能都是"整个不可用"，而不是"降级" ——
   尤其是 pdf.worker.js：Node 下 pdf.js 走 fake worker，靠 require('./pdf.worker.js')
   就地加载，不同目录就抛 `Setting up fake worker failed`（这个错很难猜）。 */
const VDIR = path.join(ROOT, 'vendor', 'pdfjs');
ok(fs.existsSync(path.join(VDIR, 'pdf.js')), 'vendor/pdfjs/pdf.js 在');
ok(fs.existsSync(path.join(VDIR, 'pdf.worker.js')), 'pdf.worker.js 与 pdf.js 同目录（Node 下的 fake worker 靠它）');
ok(fs.existsSync(path.join(VDIR, 'cmaps')), 'vendor/pdfjs/cmaps/ 在（缺了它，用预定义 CMap 的中文 PDF 一个字都抽不出来）');
ok(fs.existsSync(path.join(VDIR, 'standard_fonts')), 'vendor/pdfjs/standard_fonts/ 在');
const cmapN = fs.existsSync(path.join(VDIR, 'cmaps')) ? fs.readdirSync(path.join(VDIR, 'cmaps')).length : 0;
ok(cmapN > 100, `cmaps 目录内容完整（${cmapN} 个文件，官方发行版是 168 个）`);

/* 解析全在服务端，4.9MB 的解析器一个字节都不该发给浏览器 */
ok(![...STATIC.keys()].some((k) => /pdf/i.test(k)), 'STATIC 表里没有 pdf.js（解析器不发到浏览器）');
ok(/\brequire\s*\(/.test(pdfmdSrc) === false, 'pdfmd.js 零依赖（不读文件、不碰网络），所以能被单测直接驱动');
ok(/pdfmd\.toMarkdown/.test(pimpSrc) && /vendor/.test(pimpSrc) && /pdfjs/.test(pimpSrc), 'pdfimport.js 把 pdf.js 的产物交给 pdfmd.js（两层职责不混）');

ok(/%PDF-/.test(srv), '导入接口先验文件头（用户选错文件时给人话，不是 InvalidPDFException）');
ok(/PDF_MAX/.test(srv) && /readRawBody\(req,PDF_MAX/.test(srv), '导入接口有自己的体积上限（默认 30MB 装不下 41MB 的 PDF）');
ok(/p==='\/api\/import-pdf' && req\.method==='POST'/.test(srv), 'server.js 只注册 POST /api/import-pdf');
ok(/PDF_MAX = 60 \* 1024 \* 1024/.test(srv), '体积上限是 60MB（本机最大的样本 PDF 是 41MB）');
ok(/if\(!r\.markdown\.trim\(\)\)/.test(srv), '抽不到文字时明确报"可能是扫描件"（不静默返回空文章）');

ok(/id="btnPdf"/.test(html), '写作台有「导入 PDF」按钮');
ok(/id="btnPdf"/.test(phtml), '单篇编辑页有「导入 PDF」按钮');
ok(/\$\('btnPdf'\)/.test(ed) && /opts\.importPdf/.test(ed), 'editor.js 负责 按钮 → opts.importPdf 这条线');
ok(/return \{[^}]*\binsertText\b/.test(ed), 'editor.js 导出了 insertText');
ok(/importPdf: async/.test(app) && /\/api\/import-pdf/.test(app), 'app.js 注入 importPdf 并调用 /api/import-pdf');
ok(/importPdf: async/.test(pjs) && /\/api\/import-pdf/.test(pjs), 'post.js 注入 importPdf 并调用 /api/import-pdf');
ok(/f-draft'\)\.checked = true/.test(app), '写作台上导入后默认勾上"存为草稿"（PDF 抽出来的字几乎不可能直接能发）');
ok(/window\.Editor\.insertText\(/.test(pjs), '单篇页把转出来的内容插到光标处');
/* 导入是"只算不改"，不该被生成/部署卡住；别的写接口都在那条 409 名单里 */
ok(/\^\\\/api\\\/\(post\|posts\|publish\|upload\|assets\|trash\)/.test(srv), '导入不在"运行中禁止改动"的名单里（它只转换、不写博客）');

/* 真浏览器验收（tests/shot-pdf.js + tests/cdp.js）这条链的静态守护。
   下面两条都是踩过的坑，而且症状离真相很远，值得钉死。 */
const e2eSrc = fs.readFileSync(path.join(ROOT, 'tests', 'e2e.js'), 'utf8');
const cdpSrc = fs.readFileSync(path.join(ROOT, 'tests', 'cdp.js'), 'utf8');
const shotPdfSrc = fs.readFileSync(path.join(ROOT, 'tests', 'shot-pdf.js'), 'utf8');
for (const f of ['cdp.js', 'pdf-fixture.js', 'shot-pdf.js']) {
  try { new vm.Script(fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8'), { filename: f }); ok(true, `tests/${f} 语法正确`); }
  catch (e) { ok(false, `tests/${f} 语法正确`, e.message); }
}
ok(/Page\.handleJavaScriptDialog/.test(cdpSrc),
  'CDP 会自动点掉原生对话框（不点会卡死渲染进程：Runtime.evaluate 永不返回，而 /json/version 照常响应）');
ok(/Browser\.close/.test(cdpSrc),
  'CDP 优雅关闭 Chrome（硬杀会把 user-data-dir 留成脏状态，下次复用同一个目录必然卡死）');
ok(/freshProfile/.test(cdpSrc) && /freshProfile:\s*true/.test(shotPdfSrc),
  '验收脚本每轮换一个新 profile（上一轮被掐死留下的脏目录不会把这一轮拖下水）');
ok(/require\('\.\/pdf-fixture'\)/.test(e2eSrc) && /require\('\.\/pdf-fixture'\)/.test(shotPdfSrc),
  'e2e 与浏览器验收共用同一份 PDF fixture（各抄一份迟早跑偏）');
ok(!/function tinyPdf/.test(e2eSrc) && !/function tinyPdf/.test(shotPdfSrc),
  '两边都没有再内联一份 tinyPdf');
ok(/this\.type === 'file'/.test(shotPdfSrc) && /DataTransfer/.test(shotPdfSrc),
  '浏览器验收用"劫持 click + DataTransfer"把文件塞进去（不弹原生文件框，headless 下才跑得动）');
ok(/btnPdf.*disabled|disabled.*btnPdf/.test(shotPdfSrc) && /stillBusy/.test(shotPdfSrc),
  '验收的完成判据是"按钮从解析中复位"，不是"正文出现某段文字"（后者会被残留内容骗到）');

log('');
log('== 12. 按需实时预览标签页 ==');
const previewHtml = fs.readFileSync(path.join(WEB, 'preview.html'), 'utf8');
const previewJs = fs.readFileSync(path.join(WEB, 'preview.js'), 'utf8');
try { new vm.Script(previewJs); ok(true, 'preview.js 语法正确'); } catch (e) { ok(false, 'preview.js 语法正确', e.message); }
ok(!/id="preview"/.test(html) && !/id="preview"/.test(phtml), '两个编辑页都不再常驻预览');
ok(/id="btnPreview"/.test(html) && /id="btnPreview"/.test(phtml), '两个编辑页都有实时预览按钮');
ok(STATIC.get('/preview') === 'web/preview.html' && STATIC.get('/preview.js') === 'web/preview.js', '预览页面及脚本路由已注册');
for (const m of previewHtml.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
  ok(STATIC.has(m[1]) && fs.existsSync(path.join(ROOT, STATIC.get(m[1]))), '预览依赖可加载 ' + m[1]);
}
ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(previewHtml) && !/\son[a-z]+=/.test(previewHtml), '预览页面符合 CSP');
ok(/e\.origin !== location\.origin/.test(previewJs) && /e\.source !== window\.opener/.test(previewJs), '预览只接收同源打开者的消息');
ok(/Editor\.renderPreview/.test(previewJs) && /sanitize\(html\)/.test(ed), '新标签页复用 Markdown 清洗与资源路径解析');

log('');
log('== 13. 便携包目录布局 ==');
/* 这一组防的是"重构把某处引用留在老位置"——静态检查里少见的、只有真跑才会炸的类目。
   每条都对着一个具体的失败后果，不是为了凑数。 */
const srvFiles = ['server.js', 'lib.js', 'storage.js', 'frontmatter.js', 'pdfimport.js', 'pdfmd.js'];
const webFiles = ['index.html', 'app.js', 'post.html', 'post.js', 'preview.html', 'preview.js', 'editor.js', 'theme.js', 'styles.css'];
ok(srvFiles.every((f) => fs.existsSync(path.join(SRC, f))), 'src/ 下 6 个服务端文件齐', srvFiles.filter((f) => !fs.existsSync(path.join(SRC, f))).join(','));
ok(webFiles.every((f) => fs.existsSync(path.join(WEB, f))), 'web/ 下 9 个前端文件齐', webFiles.filter((f) => !fs.existsSync(path.join(WEB, f))).join(','));
ok(fs.existsSync(path.join(ROOT, 'vendor', 'pdfjs', 'pdf.js')), 'vendor/ 留在应用根（不属于 src/ 也不属于 web/）');
const rootJunk = fs.readdirSync(ROOT).filter((f) => /^\.(server|hexo-serve|hexo-tool)-/.test(f));
ok(rootJunk.length === 0, '应用根目录没有运行时残留文件（pid / settings / last-deploy 都该在 data/）', JSON.stringify(rootJunk));

/* STATIC 表的路径是**相对应用根**写的。如果有人图省事改回相对 __dirname，
   静态资源会整体 404 —— 而且只有打开页面才发现。 */
ok(/path\.join\(APP,STATIC\.get\(p\)\)/.test(srv), '静态资源按 APP（应用根）解析，不是 __dirname');
ok(!/path\.join\(__dirname,\s*STATIC/.test(srv), '没有残留"相对本文件"的资源解析写法');
const staticTargets = [...STATIC.values()];
ok(staticTargets.every((t) => fs.existsSync(path.join(ROOT, t))), 'STATIC 表里每个路径都能在应用根下找到',
  staticTargets.filter((t) => !fs.existsSync(path.join(ROOT, t))).join(','));
ok(staticTargets.every((t) => !t.startsWith('..')), 'STATIC 表不写 ../ 这类越界路径');

/* YAML 模块都从应用根的 vendor/ 加载。 */
const fmSrc = fs.readFileSync(path.join(SRC, 'frontmatter.js'), 'utf8');
ok(/require\('\.\.\/vendor\/js-yaml'\)/.test(fmSrc), 'frontmatter.js 用 ../vendor 引 js-yaml');
ok(!/require\('\.\/vendor/.test(fmSrc), 'frontmatter.js 没有残留相对本目录的 ./vendor 写法');
const pdfimpSrc2 = fs.readFileSync(path.join(SRC, 'pdfimport.js'), 'utf8');
ok(/path\.join\(__dirname, '\.\.', 'vendor', 'pdfjs'\)/.test(pdfimpSrc2), 'pdfimport.js 的 pdf.js 目录指向 ../vendor/pdfjs');

/* 双平台启动器：系统 Node 优先，缺失时才使用便携运行时。 */
const batSrc = fs.readFileSync(path.join(ROOT, '启动写作台.bat'), 'latin1');
ok(/src\\server\.js/.test(batSrc), '启动器指向 src\\server.js');
ok(/where node[\s\S]*if errorlevel 1[\s\S]*node\\node\.exe/.test(batSrc), 'Windows 优先系统 Node，自带运行时仅作兜底');
ok(/set "PATH=%~dp0node;%PATH%"/.test(batSrc), '使用自带 Node 时才把 node\\ 补进 PATH');
ok(/"%~1" --open/.test(batSrc) && !/set "PORT=4321"/.test(batSrc), 'Windows 不覆盖已保存的博客与端口设置，交给服务就绪后打开');
const macSrc = fs.readFileSync(path.join(ROOT, '启动写作台.command'), 'utf8');
ok(macSrc.startsWith('#!/bin/bash\n') && !macSrc.includes('\r'), 'macOS 启动器使用 Bash 与 LF 换行');
ok(/command -v node/.test(macSrc) && !/node\.exe/.test(macSrc), 'macOS 选择本机 Node，不运行 Windows exe');
ok(/src\/server\.js" "\$BLOG" --open/.test(macSrc), 'macOS 对带空格的脚本与博客路径正确加引号');
ok(!/read -r -p "Hexo blog directory/.test(macSrc), 'macOS 不再要求先在终端填写博客路径，由网页设置完成');
ok(/process\.platform==='darwin'\)spawn\('open',\[url\]\)/.test(srv), '服务就绪后 macOS 用 open 打开浏览器');

const vbsSrc = fs.readFileSync(path.join(ROOT, '启动写作台.vbs'), 'utf8');
ok(/start "" .*wscript\.exe/.test(batSrc), 'BAT 交给无窗口启动器后立即退出');
ok(/shell\.Run\(command, 0, True\)/i.test(vbsSrc), 'VBS 隐藏运行并等待服务退出后自行结束');
ok(!/^\s*pause\s*$/mi.test(batSrc), 'Windows 启动器不再等待按键，网页关闭服务后自动退出');

/* 退出时清 pid 文件必须走"改名挪走"，不能走"删除"。
   实测（同一个 exit 钩子跑 8 轮）：unlinkSync 5 成成功、1 成抛错、2 成**把进程直接阻塞住**；
   renameSync 6/6 全成、零卡死。退出流程里"卡住"是最坏的结果 —— 服务收不了尾，
   而界面那边已经显示关掉了。所以钉死：这里不许出现 unlinkSync / rmSync。 */
ok(/function dropPidFileSync\(/.test(srv), '服务端有"让 pid 路径不再存在"的同步 helper');
ok(/fs\.renameSync\(file, file \+ '\.stale'\)/.test(srv), 'pid 清理走 renameSync 挪走（不是删除，避免被守卫阻塞）');
ok(/function removeOwnPidFile\(/.test(srv), '服务端有"确实属于本进程才清"的 pid 清理 helper');
ok(/removeOwnPidFile\(PID_FILE\)/.test(srv), '退出钩子走 removeOwnPidFile');
ok(!/fs\.unlinkSync\(PID_FILE\)/.test(srv) && !/fs\.unlinkSync\(SERVE_PID_FILE\)/.test(srv)
  && !/fs\.rmSync\(PID_FILE\)/.test(srv), 'pid 文件不再有任何 unlinkSync / rmSync 调用点');

log('');
log('== 14. 关闭服务后的页面收尾 ==');

/* 服务端自己把 node\ 前置进 PATH：便携化不再只依赖启动器，
   手动 `node src/server.js` 起来也跑得动 hexo */
ok(/const NODE_DIR = path\.join\(APP, 'node'\)/.test(srv), '服务端自己管 PATH 上的 node（不依赖启动器）');
ok(/const hasNode = cur\.split/.test(srv), '自带的 node 只作兜底：PATH 里已经有 node 就不抢（见 §9.4 的对照实验）');

/* 关闭之后页面也要收尾：
   --app 窗口允许脚本关闭自己，普通标签页不允许 —— 所以两种都要有安排。 */
ok(/function finishShutdown\(/.test(app), '前端有"服务退出后页面一并收尾"的函数');
ok(/window\.close\(\)/.test(app), '关闭服务后尝试 window.close()（--app 窗口下会直接关掉整个窗口）');
ok(/function showClosedOverlay\(/.test(app), '关闭被浏览器拦掉时有整页兜底提示（普通标签页不允许脚本关闭）');
ok(/function closeCompanionWindows\(/.test(app), '关闭时带走本页开出去的预览页 / 独立编辑页');
ok(/if \(state\.closing\) return;/.test(app), '主动关闭时跳过 beforeunload 的"确定要离开吗"');
ok(/closePreview/.test(ed), '编辑器暴露 closePreview，供关闭时一并关掉预览窗口');

log('');
log('== 15. 网页初始化与博客配置编辑 ==');
ok(/configured:false/.test(srv) && /if \(!state\.info\.blog\)/.test(app), '未配置博客时服务仍可启动，前端进入网页设置');
ok(!/settings\.blog \|\| 'D:/.test(srv), '不再默认打开开发者机器上的博客路径');
ok(/\/api\/configs/.test(srv) && /\/api\/config/.test(app), '配置文件列表与读取、保存接口已接通');
ok(/discardConfig/.test(app) && /configDirty\(\)/.test(app), '配置未保存时关闭、切换或刷新会提醒');

const tail = fail === 0 ? '全部通过 ✅' : `有 ${fail} 项未通过 ❌`;
log(tail);
const report = out.join('\n');
fs.writeFileSync(OUT, report, 'utf8');
process.stdout.write(report + '\n');
process.exit(fail === 0 ? 0 : 1);
