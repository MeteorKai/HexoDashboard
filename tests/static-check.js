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
const keysSrc = fs.readFileSync(path.join(WEB, 'mdkeys.js'), 'utf8');

/* STATIC 表：URL -> 真实文件。注意表里写的是**相对应用根**的路径
   （页面全在 web/，第三方在 vendor/），所以下面一律用 path.join(ROOT, ...) 解析。 */
const STATIC = new Map([...srv.matchAll(/\['(\/[^']*)','([^']+)'\]/g)].map((m) => [m[1], m[2]]));

log('== 1. 语法编译 ==');
for (const f of ['web/theme.js', 'web/editor.js', 'web/app.js', 'web/post.js', 'src/pdfmd.js', 'src/pdfimport.js', 'src/mdimport.js', 'src/pages.js']) {
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
/* 和主页面那条保持一致：aria-labelledby 指向的标题也算"被用到"。
   不给它开口子的话，任何带 aria-labelledby 的对话框都会误报成多余 id。 */
const pLabelled = new Set([...phtml.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]));
const pUnused = [...pIds].filter((id) => !pUsed.has(id) && !pLabelled.has(id));
ok(pUnused.length === 0, 'post.html 没有多余的 id（除 aria-labelledby 目标）', pUnused.join(', '));

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

/* ── 取图这条链（pdfimage.js）────────────────────────────────────────────
 * 这一整块都是踩出来的，每一行都对应一个真实反例，别当成可选项删掉：
 *   · 见到 /Subtype /Image 就导出 → 蓝鲸那篇 58 个对象里 40 个是**软蒙版**，
 *     导出成 40 张白图（白占比 90~97%）。蒙版是经 ExtGState/SMask 生效的，
 *     成对出现（2136×1337 与 2144×1345，分别是图本体和外阴影）。
 *   · pdf.js 在 Node 里**取不到图像字节**（没有 canvas，page.objs 是空的），
 *     所以字节只能自己按 PDF 对象解；但位置/顺序要问 pdf.js（它把 Form 展平了）。
 *   · FlateDecode 的图常带 /Predictor 15（PNG 自适应），不反算导出的是差分
 *     数据，看起来就是一片噪声。
 *   · 资源目录名必须和保存时算出来的**完全一致**，否则一保存图片全部失联。 */
const pimgSrc = fs.readFileSync(path.join(ROOT, 'src', 'pdfimage.js'), 'utf8');
/* 只看**运行时依赖**：把命令行自检那一块（`if (require.main === module)` 之后）
   切掉再扫 require —— 自检要用 fs/path/pdfimport 是应该的，跟"引了第三方库"不是一回事。 */
const pimgLib = pimgSrc.slice(0, pimgSrc.indexOf('if (require.main === module)'));
const pimgImports = [...pimgLib.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  .filter((m) => !m.startsWith('.'));
ok(pimgImports.length && pimgImports.every((m) => m === 'zlib'),
  'pdfimage.js 只依赖 zlib（PNG 编码、预测器反算都是自己写的，不引 canvas / sharp）',
  pimgImports.join(','));
ok(/require\('\.\/pdfimport'\)/.test(pimgLib) === false,
  '运行时区段里不反向依赖 pdfimport（避免循环 require；取 pdf.js 实例挪到自检块里）');
ok(/pngEncode|IDAT/.test(pimgSrc), '自己写 PNG（不依赖 canvas / sharp）');
ok(/undoPredictor/.test(pimgSrc) && /Predictor/.test(pimgSrc), '处理 FlateDecode 的 /Predictor（不反算导出的是差分数据，看着像噪声）');
ok(/DCTDecode/.test(pimgSrc) && /0xff.*0xd8|0xFF.*0xD8|0xd8/.test(pimgSrc), 'DCTDecode 直接取原始 JPEG 字节（PDF 里存的就是完整 JFIF）');
ok(/maskNumbers/.test(pimgSrc) && /SMask/.test(pimgSrc), '识别软蒙版（/SMask 的 /G 指到的对象不算图）');
ok(/paintImageXObject/.test(pimgSrc) && /getOperatorList/.test(pimgSrc),
  '位置/顺序问 pdf.js 的 operator list（它把 Form、ExtGState 展平了）');
ok(/pdfimage\.extract/.test(pimpSrc), 'pdfimport.js 调 pdfimage.extract 取图');
ok(/typeof images === 'function'/.test(pimpSrc) && /images\(imgs\[i\], i\)/.test(pimpSrc),
  'pdfimport 用回调把图交给调用方（写文件/定资源名留在 server，插在哪一行留在 pdfmd）');
ok(/lib\.assetName\(im\.data/.test(srv) && /lib\.assetTag\(/.test(srv),
  'server.js 用与手动上传同一套资源命名（内容哈希 + asset_img 标签），不另起一套');
ok(/lib\.sanitizeName\(assetBase\)/.test(srv),
  '资源目录名按保存时的同一条规则算（lib.sanitizeName）—— 不一致的话一保存图片就全部失联');
ok(/qDraft=url\.searchParams\.get\('draft'\)==='1'/.test(srv) && /assetDraft/.test(srv),
  '导入接口认 draft 参数（否则图会写进 _posts、而文章在 _drafts，发布时找不到图）');
ok(/draft=1/.test(app), '写作台导入时把 draft=1 传给服务端（默认就是存草稿）');
ok(/r\.assets \|\| \{\}\)\.name|r\.assets\s*&&/.test(app), '写作台把服务端回传的目录名写进 f-name（保存后目录才不会错位）');
ok(/&post=' \+ encodeURIComponent\(state\.name\)/.test(pjs), '单篇页把 post 名传给服务端（图片要存进这篇文章的资源目录）');
ok(/assetFolder/.test(srv) && /postAssetFolder/.test(srv),
  '没开 post_asset_folder 时不硬塞图片目录（如实回 assetFolder=false 让前端说明白）');

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
log('== 11b. Markdown 导入 ==');
/* 和 PDF 导入同一条链，多出来的麻烦是**图片**：
 *   · 浏览器只给字节，不给"这个文件旁边的目录" → 图片必须和 md 一起选进来，
 *     否则 md 里那串相对路径没人兑现，生成出来是一条死链，而且死得很安静；
 *   · 图片可能在子目录（Typora 的 xxx.assets）→ Windows 的文件框只能在一个目录里
 *     多选，所以另有"选整个文件夹"的口子，靠 webkitRelativePath 把相对路径带过来；
 *   · 代码块里的 `![示例](a.png)` 是**示例代码**，一个字都不能动。 */
const mdimpSrc = fs.readFileSync(path.join(SRC, 'mdimport.js'), 'utf8');
try { new vm.Script(mdimpSrc, { filename: 'src/mdimport.js' }); ok(true, 'src/mdimport.js 语法正确'); }
catch (e) { ok(false, 'src/mdimport.js 语法正确', e.message); }

ok(/p==='\/api\/import-md' && req\.method==='POST'/.test(srv), 'server.js 只注册 POST /api/import-md');
ok(/MD_MAX/.test(srv) && /readRawBody\(req,MD_MAX/.test(srv), '导入接口有自己的体积上限（图片是跟 md 一起上来的）');
ok(/multipart\/form-data/.test(srv) && /boundary=/.test(srv), '服务端按 multipart 的 boundary 切分（md 与图片同一个请求）');
ok(/mdimport\.parseMultipart/.test(srv) && /function parseMultipart/.test(mdimpSrc),
  'multipart 解析放在 mdimport.js（可单测；server.js 只管路由）');
ok(/mdimport\.parseMultipart/.test(srv), 'server.js 调 mdimport.parseMultipart');
ok(/form\.append\('md',/.test(ed) && /form\.append\('mdrel'/.test(ed),
  'editor.js 把 md 原文与它的相对路径一起发过去（相对路径是解析子目录图片的基准）');
ok(/'f:' \+ relOf\(f\)/.test(ed), '图片以"相对路径"为字段名上传（同名不同目录的图不会互相顶掉）');
ok(/webkitRelativePath/.test(ed) && /webkitdirectory/.test(ed), '目录模式保留相对路径（图片在子目录时对得上号）');

/* 「只选了 md、没选图片」是最容易踩的一个坑：服务端没有字节可复制，引用只能原样留着，
   而页面上照样显示"导入成功" —— 用户事后才发现一整篇裂图。所以必须在**替换编辑区之前**处理。 */
ok(/function countLocalImageRefs/.test(ed) && /built\.refs > 0 && built\.images === 0/.test(ed),
  'md 里有本地图片引用却一张图都没选时，导入前就处理（不是事后才在提示里提一句）');
ok(/new Blob\(\[mdText\]/.test(ed), 'md 只读一遍：判断引用数与真正上传用的是同一份文本');

/* 文件框一次只能在一个目录里多选 → 图片在 assets/ 里时「导入 MD」够不着。
   光提醒"请重新选择"没用（用户还会再点一次同一个按钮），必须**直接把文件夹选择框开出来**。
   实测踩到的坑：先弹确认框再开选择框的话，确认框把 showDirectoryPicker 要的"用户激活"
   耗过期了 —— 用户点「确定」后调用被浏览器拒绝，而拒绝又被吞成"用户取消"，
   看起来就是"点了确定什么都没发生"（用户截图抓到的就是这一幕）。所以现在不问、直接开。 */
ok(/const st = await openImportPicker\(\{ directory: true \}\)/.test(ed) && /if \(st === 'picked'\) return;/.test(ed)
  && /if \(st === 'fail'\)/.test(ed),
  '只选了 md 时不弹确认框、直接开文件夹选择框（文件刚选完、激活还热着，一次就成）');
ok(/\? 'cancel' : 'fail'/.test(ed),
  '开不出来时必须如实报 fail（吞成"用户取消"就会变成"点了确定没反应"）');
ok(/pickFile\('', \(fs2\) => \{ importMarkdown\(fs2, \{ noAutoDir: true \}\); \}, \{ directory: true \}\)/.test(ed),
  '降级路径用 input 那条路兜底（showDirectoryPicker 刚被拒过，再调还是被拒）');
ok(/!\(extra && extra\.noAutoDir\)/.test(ed) && /noAutoDir: true/.test(ed),
  '自动补开有防循环护栏（选目录进来的导入不再二次弹框，缺图交给提示点名）');
ok(/window\.showDirectoryPicker/.test(ed) && /collectDirFiles/.test(ed),
  '选目录优先用 showDirectoryPicker（能拿到真实路径，顺带判断"这是不是一个博客目录"）');
ok(/function looksLikeBlog/.test(ed) && /onOpenBlogSettings/.test(ed) && /blogDir: \(\) =>/.test(app),
  '选中的目录像博客时问一句要不要切过去，但**只填设置不自动保存**');
ok(/openSettings\(\{ blog: dir \}\)/.test(app), 'app.js 把路径填进设置弹窗（保存仍由用户点）');
/* 一个文件夹里躺着好几篇笔记是常态，随手捡第一篇 = "导错了比没导成更难发现" */
ok(/list\.filter\(\(f\) => MD_EXT_RE/.test(ed) && /candidates\.length > 1/.test(ed) && /opts\.chooseMd/.test(ed),
  '文件夹里有多个 md 时让用户挑一篇（不替他猜）');
ok(/chooseMd: \(message, items\) => chooseFromList\(message, items\)/.test(app) && /function chooseFromList/.test(app),
  'app.js 有"选一个文件"的对话框（原生 confirm 表达不了"我要第 3 篇"）');
ok(/chooseMd: \(message, items\)/.test(pjs), 'post.js 也注入了 chooseMd（这一页只有 confirm 可退）');
ok(/openImportPicker\(\{ multiple: true/.test(ed) || /openImportPicker\(opts/.test(ed),
  '两个入口都改走 openImportPicker（按钮与"自动补开"是同一条路）');

/* Obsidian 的 ![[图片]]：不认这种写法的话整篇图都换不掉，而且连 missing 都不报（静默失败） */
ok(/const RE_WIKI/.test(mdimpSrc) && /s\.replace\(RE_WIKI/.test(mdimpSrc), 'mdimport 认 Obsidian 的 ![[图片]] 写法');
ok(mdimpSrc.indexOf('s.replace(RE_WIKI') < mdimpSrc.indexOf('s.replace(RE_REF') &&
  mdimpSrc.indexOf('s.replace(RE_WIKI') < mdimpSrc.indexOf('s.replace(RE_COLLAPSED'),
  '![[…]] 必须排在 ![id] / ![alt][id] 之前匹配（否则会被咬成半个，永远换不掉）');
/* 这条用 includes 而不是正则：要匹配的是源码里的字符类 `[^\]\[]*`，
   写成正则要转义一串反斜杠，写错一点就是"永远为真"的假断言。 */
ok(mdimpSrc.includes('([^\\]\\[]*)'),
  '折叠式规则的 id 里不许出现 [（同样是给 Obsidian 的 ![[…]] 让路）');

/* 普通 md（Windows 里复制粘贴出来的）的两种图片来源。
   Obsidian 的 ![[…]] 是"第三种"，但它们必须共用同一个按钮 —— 用户不该被要求
   先判断"我这份 md 是哪一款"，那份判断本来就该由程序替他做。 */
ok(/function dataBytes/.test(mdimpSrc) && /const MIME_EXT/.test(mdimpSrc),
  'mdimport 认内嵌的 data:image/...;base64 图（Windows 粘贴最常见的落地形态）');
ok(/stats\.embedded\+\+/.test(mdimpSrc), '内嵌图单独计数（前端要能说清"这几张是从 md 里抽的"）');
/* 顺序断言：base64 里出现 %2B 会被 decodeURIComponent 改掉，[?#] 那条还会截掉尾巴 ——
   先解码再判断 = 解出一张坏图。 */
ok(mdimpSrc.indexOf('const data = dataBytes(target)') < mdimpSrc.indexOf('const decoded = decodeTarget(target)'),
  'data URI 必须在 decodeTarget **之前**判断（一经 URI 解码就解不出原图了）');
ok(mdimpSrc.includes("if (!/^image\\//.test(mime)) return null"),
  'data:text/plain 之类不是图片的 data URI 原样留着（不去动它）');
ok(mdimpSrc.includes('if (/^data:/i.test(String(target || \'\').trim())) return null'),
  '是 data URI 但解不出来 → 自包含，不算"缺图"（别人的 md 里没有要找的文件）');
ok(mdimpSrc.includes('if (!/^[A-Za-z0-9+/=\\s]+$/.test(payload)) return null'),
  'base64 段不合法就不硬解（硬解出来是一张坏图，不如原样留着）');
ok(/function isLocalPath/.test(mdimpSrc) && /stats\.localPath\+\+/.test(mdimpSrc),
  'mdimport 认 md 里写的本机绝对路径（Typora 粘贴的默认形态），并单独计数');
/* `file:///C:/x.png` 剥掉协议后是 `/C:/x.png`，正则里那个 `\/?` 少了就全线认不出来 */
ok(mdimpSrc.includes('/^(?:file:\\/\\/\\/?)?\\/?[A-Za-z]:[\\\\/]/i'),
  '本机路径的正则要容忍剥协议后多出来的那个前导斜杠（否则这种图会被误报成缺图）');
/* `file:///C:/a.png` 剥协议后是 `/C:/a.png`，Windows 上 fs.existsSync 实测 false
   （被当成"当前盘符根目录下的 C:\a.png"）→ 这种最常见的写法会整片变缺图。 */
ok(/function toAbsPath/.test(mdimpSrc) && mdimpSrc.includes("s.replace(/^\\/(?=[A-Za-z]:[\\\\/])/, '')"),
  '盘符前面那个多余的前导斜杠要抹掉（只在盘符前抹，POSIX 的 /Users/… 不受影响）');
ok(/const abs = toAbsPath\(decoded\)/.test(mdimpSrc) && /return \{ local: abs, key: normalize\(abs\) \}/.test(mdimpSrc),
  '交给读取方的是抹干净之后的路径（mdimport 不碰 fs，只能保证交出去的是干净的）');
ok(/if \(hit\.local\)/.test(mdimpSrc) && /await readLocal\(hit\.local\)/.test(mdimpSrc),
  '本机路径的图在落盘阶段才读（读文件是异步的，扫正文那一步只能同步）');
ok(/missingSet\.add\(baseOf\(hit\.local\)\)/.test(mdimpSrc),
  '本机路径读不到（换机器了）就如实算缺图，不假装成功');
ok(/const readLocal=async \(abs\)=>\{/.test(srv) && /if\(!path\.isAbsolute\(abs\)\)return null/.test(srv),
  '服务端只读**绝对**路径（相对路径是"随 md 上传"那条路，不能混）');
ok(/if\(!lib\.assetExt\(abs,''\)\)return null/.test(srv) && /if\(st\.size>IMG_MAX\)return null/.test(srv),
  '按本机路径读文件时也要卡后缀白名单与体积上限（不能把整块磁盘吸进博客）');
ok(/const IMG_MAX/.test(srv) && /readLocal,mode:mdMode/.test(srv), 'server.js 把 readLocal 与导入模式注入给 convert');
/* 前端"要不要提醒你另选图片"的判断：这三种都自带字节 / 本来就不需要文件 */
/* 用 includes 而不是正则：要匹配的就是 editor.js 里的那两条字面正则，
   写成正则要转义一串反斜杠，写错一点就是"永远为真"的假断言。 */
ok(/function needsNoFile/.test(ed) && ed.includes('|| /^data:/i.test(s)')
  && ed.includes('/^(?:file:\\/\\/\\/?)?[A-Za-z]:[\\\\/]/i')
  && ed.includes('REMOTE_RE.test(s)'),
  '前端用 needsNoFile 把"内嵌 base64 / 本机路径 / 外链"三种都排除在提醒之外');
/* 断言方式说明：要匹配的是 editor.js 里的正则字面量，写成正则要转义一串反斜杠，
   写错一点就是"永远为真"的假断言；所以这类一律用 includes 比对原文。 */
ok(/function needsNoFile/.test(ed) && ed.includes('|| /^data:/i.test(s)')
  && ed.includes('/^(?:file:\\/\\/\\/?)?[A-Za-z]:[\\\\/]/i')
  && ed.includes('REMOTE_RE.test(s)'),
  '前端用 needsNoFile 把"内嵌 base64 / 本机路径 / 外链"三种都排除在提醒之外');
ok(ed.includes('const add = (t) => {') && ed.includes('if (!needsNoFile(t)) n++;'),
  '四种引用写法共用一个 needsNoFile 过滤（各写各的迟早漏一种）');
/* 实测踩到的坑：老写法只认 `![](…)` 与 `![[…]]`，用 `![alt][id]` 写图的 md 会被
   数成 0 处 → **只选 md 时一句话都不说**，服务端照旧报缺图，用户事前毫不知情。
   这正是本轮要消灭的那类静默失败，必须钉住。 */
ok(ed.includes('const defs = new Map()') && ed.includes('defs.set(id, m[2])'),
  '前端数引用要先建"引用式定义表"（`![alt][id]` 的地址写在 `[id]: …` 那一行）');
ok(ed.includes('!\\[[^\\]]*\\]\\[') && ed.includes('defs.get('),
  '引用式 ![alt][id] 与折叠式 ![id] 也要数进去（数不出来 = 静默裂图）');
ok(ed.indexOf('!\\[[^\\]]*\\]\\[') >= 0 && ed.includes('defs.has(id)'),
  '同一 id 有多条定义时取第一条（和 marked 的行为一致）');
ok(/取消 = 只导入文字/.test(ed) && /装着 md 的那一层/.test(ed),
  '提示要说清"该选哪一层"与"取消的后果"（用户不该猜；内嵌/本机路径那种自包含的 md 根本不会走到这条提示）');
ok(/s\.embedded \?/.test(ed) && /s\.localPath \?/.test(ed), '导入结果里区分"内嵌"与"本机路径"两种来源');

/* 只有一个「导入 MD」按钮：以前还有个"导入 MD 目录"，可用户看一眼自己的 md
   也判断不出该点哪个，选错就是导入失败。现在按内容自动分流，目录模式在需要时自动补开。 */
ok(/id="btnMd"/.test(html) && /id="btnMd"/.test(phtml), '两个编辑页都有「导入 MD」按钮');
ok(!/btnMdDir/.test(html) && !/btnMdDir/.test(phtml) && !/btnMdDir/.test(app),
  '「导入 MD 目录」按钮已合并掉（只有一个入口，避免用户猜该点哪个）');
ok(/\$\('btnMd'\)/.test(ed) && /opts\.importMd/.test(ed), 'editor.js 负责 按钮 → opts.importMd 这条线');
ok(/\$\('btnMd'\)/.test(ed) && !/\$\('btnMdDir'\)/.test(ed), 'editor.js 里不再引用已删掉的 btnMdDir');
ok(/importMd: async/.test(app) && /\/api\/import-md/.test(app), 'app.js 注入 importMd 并调用 /api/import-md');
ok(/importMd: async/.test(pjs) && /\/api\/import-md/.test(pjs), 'post.js 注入 importMd 并调用 /api/import-md');
ok([html, phtml].every(s => /id="mdImportMode"/.test(s) && /value="markdown"/.test(s) && /value="obsidian"/.test(s)),
  '两个编辑页的同一导入弹窗都提供普通 Markdown 与 Obsidian 模式');
ok(/mdBtn\.addEventListener\('click', showMdImport\)/.test(ed) && /function submitMdImport/.test(ed),
  '导入按钮打开弹窗，确认后才提交');
ok(/buildImportForm\(\[md, \.\.\.list\], \{ md, mode \}\)/.test(ed) && /form\.append\('mdmode'/.test(ed),
  '补选图片目录保留原先选定的文档，并将模式传给服务端');
ok(/referenced\.has\(f\.name\.toLowerCase\(\)\)/.test(ed), '目录中未被文档引用的图片不上传');

/* 图片落点：与手动上传、PDF 导入同一套规则，任何一处另起炉灶就是"保存后图片失联"。 */
ok(/lib\.assetName\(img\.data/.test(srv), '资源名沿用内容哈希（和手动上传同一套，不另起一套）');
ok(/lib\.assetTagAlt\(/.test(srv) && /asset_img/.test(mdimpSrc), '正文里写 Hexo 原生 {% asset_img %}（不是 ![](相对路径)）');
ok(/img\.alt/.test(srv) && /alt: String\(alt \|\| ''\)/.test(mdimpSrc),
  '标签里的 alt 用原文写的那个（`![alt](…)` / `<img alt>`），不是一律变文件名');
ok(/importAssetDir\(qPost,qTitle,assetDraft\)/.test(srv),
  'Markdown 导入复用 PDF 那套"目录名按保存规则算"的 helper（不一致的话一保存图片就全部失联）');

/* 三类"不该动"的情况，都要如实让用户知道 */
ok(/function fenceMap/.test(mdimpSrc) && /flags\[i\] \? line : rewrite\(line\)/.test(mdimpSrc),
  '按围栏跳过代码块（代码示例里的 ![](…) 不能被换成真图）');
ok(/missingSet\.add/.test(mdimpSrc) && /missing:r\.missing\|\|\[\]/.test(srv),
  '没带来字节的图片如实报回前端（不静默留一条死链）');
ok(/stats\.remote\+\+/.test(mdimpSrc), '外链原样保留（不复制、也不算缺图）');
ok(/stats\.skipped\+\+/.test(mdimpSrc), '没开 post_asset_folder 时算 skipped，不谎报成"缺图"');

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
log('== 12b. 围栏配对 / 相邻图片间距 / 部署残留锁 ==');
/* 这三条都是用户在真机上撞出来的，共同点是"症状离根因很远"，只有钉住关键那几行
   才能保证不被后来的重构改回去。 */

/* ① 围栏配对必须看**类型**，不能只看"是不是围栏行"。
   老写法 `fence = fence ? null : f[1]` 会把 ` ``` ` 开、`~~~` 闭当成合法闭合，
   而 marked 不认 —— 两边的"在不在代码块里"就此错开。 */
ok(/fence\s*=\s*\{\s*ch:\s*marker\[0\],\s*len:\s*marker\.length\s*\}/.test(ed),
  'expandAssetTags 按"类型 + 长度"配对围栏（和 CommonMark 一致）');
ok(/marker\[0\]\s*===\s*fence\.ch\s*&&\s*marker\.length\s*>=\s*fence\.len/.test(ed),
  '闭合围栏必须与开启同类型且不短于它');
/* 断言"某个坏写法不在"时必须先剥掉注释 —— 注释里往往会引用那段坏代码来
   解释它是怎么坏的，直接扫全文就会命中注释，断言永远为假。这一条自己先踩了一次。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const edCode = stripComments(ed);
const pdfmdCode = stripComments(pdfmdSrc);
ok(!/fence\s*=\s*fence\s*\?\s*null\s*:\s*f\[1\]/.test(edCode),
  '老的"只看是不是围栏行"的写法已经不在（它就是合并两个代码块的元凶）');
/* ② 闭不上的代码块要自愈 —— 否则 marked 会把两个块吃成一个。 */
ok(/function normalizeFences/.test(ed) && /normalizeFences\(src\)/.test(ed),
  '有 normalizeFences，且真的接在渲染链上（它负责修好闭不上的围栏）');
ok(/expandAssetTags\(normalizeFences\(src\)\)/.test(ed),
  '先规整围栏、再展开 asset_img（顺序反了两处判断会错开一行）');
ok(/if\s*\(!open\)\s*return String\(src\)/.test(ed),
  '全部配对成功的 md 一个字都不动（否则会毁掉 `~~~` / ` ``` ` 各自成块的合法写法）');
ok(/Editor\.normalizeFences|normalizeFences,/.test(ed), 'normalizeFences 导出给测试用');

/* ③ 相邻图片的间距**归主题 CSS**，正文里不许再塞东西。
   以前在 markdown 里插过 `&nbsp;`，撤掉了 —— 它只覆盖"修复之后导入的文章"
   （用户手上那篇是修复前导的，于是"明明修过了为什么线上还是贴着"，症状离根因太远），
   而且和 CSS 方案叠加会出现双倍间距。钉住"不再插"，防止后来人又加回来。
   根因本身是：主题 CSS `img { display block; margin 0 auto }` 垂直间距为 0，
   而 asset_img 渲染出的是裸 `<img>`（外面没有 `<p>`），两张图之间只剩一个换行。 */
ok(!/spaceOutAdjacentImages/.test(pdfmdCode) && !/&nbsp;/.test(pdfmdCode),
  'pdfmd 不再往正文里插 &nbsp; 空段落（间距交给主题 CSS）');
ok(/相邻图片的间距/.test(pdfmdSrc) && /主题 CSS/.test(pdfmdSrc),
  'pdfmd 里写清了"间距归主题 CSS"的来龙去脉（否则后来人一定会再加回来）');
ok(!/<div style="height:/.test(pdfmdCode),
  '没有把内联样式写进正文（那样用户想调间距还得改文章）');

/* ④ 中止部署后要清 git 残留锁，且前提是"没有活着的 git"。 */
ok(/function clearGitLocks/.test(srv) && /function gitRunning/.test(srv),
  'server.js 有清锁与"查有没有 git 在跑"两个函数');
ok(/await gitRunning\(\)[\s\S]{0,80}return \[\]/.test(srv),
  '有 git 进程在跑时**不清锁**（那是真锁，抽掉会写坏索引）');
ok(/GIT_LOCK_DIRS[\s\S]{0,200}\.deploy_git/.test(srv),
  '锁目录指向 .deploy_git（hexo-deployer-git 的工作仓库，锁就在它里面）');
ok(/index\.lock/.test(srv) && /packed-refs\.lock/.test(srv),
  '锁清单包含 index.lock 与 packed-refs.lock 等 git 自己的锁');
ok(/function clearGitLocksAfterStop/.test(srv) && /clearGitLocksAfterStop\(push\)/.test(srv),
  '任务在 stopped 与 failed 两个出口都会清锁（用户看到的是"中止即干净"）');
ok(/spec\.deploy[\s\S]{0,120}clearGitLocks\('本次部署开始前'\)/.test(srv),
  '部署开始前再清一次（兜住上次被强杀、当场没清干净的情况）');
ok(/job\.kind==='deploy'\)clearGitLocksAfterStop/.test(srv),
  '/api/stop 里有兜底清锁（覆盖任务循环没走到 finally 的情况）');
ok(/fs\.renameSync\(file, file \+ '\.stale-'/.test(srv),
  '锁文件走"改名挪走"再删（某些环境里同步 unlink 会被删除守卫拖住甚至阻塞）');
ok(!/rm -rf|rmdir \/s/.test(srv), '没有用 shell 递归删除去清锁');

log('');
log('== 12c. Markdown 编辑快捷键 ==');
/* 这一组盯的都是"按下去没反应 / 反应错了"这类只有真用才知道的问题，
   而且每条都对应一个具体的退化：
     · 脚本没被 STATIC 路由 / 没被页面引入 → 整个功能静默消失（不报错，只是没反应）；
     · 直接 ta.value = 新文本 → 撤销栈被清空，Ctrl+Z 救不回误触；
     · 用 e.key 认键 → 中文输入法打开时 e.key 变成 'Process'，Ctrl+1 直接失灵；
     · 没躲开浏览器的保留键 → 按下去是关标签页、开控制台，页面连事件都收不到。 */
const keysCode = stripComments(keysSrc);

ok(STATIC.get('/mdkeys.js') === 'web/mdkeys.js' && fs.existsSync(path.join(WEB, 'mdkeys.js')),
  'web/mdkeys.js 已在 STATIC 表里注册（否则整个功能 404，且不报错）');
ok(/<script src="\/mdkeys\.js"><\/script>/.test(html) && /<script src="\/mdkeys\.js"><\/script>/.test(phtml),
  '两个编辑页都引入了 mdkeys.js（写作台 + 独立页）');
ok(html.indexOf('/mdkeys.js') < html.indexOf('/editor.js') && phtml.indexOf('/mdkeys.js') < phtml.indexOf('/editor.js'),
  'mdkeys.js 排在 editor.js 前面（editor 依赖它）');
ok(/module\.exports/.test(keysSrc) && /root\.MdKeys\s*=\s*api/.test(keysCode),
  'mdkeys.js 同时导出给 node（单测）和浏览器（globalThis.MdKeys）');

/* 撤销栈：这是"不能直接赋值 textarea.value"的唯一理由 */
ok(/function writeBack/.test(ed) && /execCommand\('insertText'/.test(ed),
  '改完文本走 writeBack + execCommand（保住撤销栈）');
/* 硬写本身不是错，错在把它当主路径 —— 必须是"execCommand 没成功"时的兜底 */
ok(/if \(!ok \|\| ta\.value !== next\) ta\.value = next/.test(stripComments(ed)),
  '直接赋值只在 execCommand 失败 / 结果对不上时才兜底（主路径不靠它）');
ok(/ta\.setSelectionRange\(from, to\)/.test(ed), '只替换真正变了的那一段（先夹出公共前后缀）');

/* 认键必须用 e.code */
ok(/e\.code/.test(keysCode) && !/e\.key\b/.test(keysCode),
  '只用 e.code 认键（e.key 在中文输入法下会变成 Process）');
ok(/e\.isComposing\s*\|\|\s*e\.keyCode\s*===\s*229/.test(stripComments(ed)),
  '输入法组合中不抢按键（否则打不出中文字）');

/* 浏览器保留键：躲开的要确认没进来，没躲开的（用户点名的）要有 Alt 退路 */
const bannedCodes = [
  ['KeyU', 'false'], ['KeyW', 'false'], ['KeyN', 'false'], ['KeyT', 'false'],
  ['KeyT', 'true'], ['KeyI', 'true'], ['KeyR', 'true'],
];
ok(bannedCodes.every(([c, shift]) => !new RegExp("code: '" + c + "', ctrl: true, shift: " + shift).test(keysCode)),
  '键位表没占用浏览器抢不回来的组合（Ctrl+U/W/N/T、Ctrl+Shift+T/I/R）',
  bannedCodes.filter(([c, s]) => new RegExp("code: '" + c + "', ctrl: true, shift: " + s).test(keysCode)).join(','));
ok(/alt \|\| s\.ctrl === mod/.test(keysCode),
  'Alt 是 Ctrl 的等价替身（Ctrl+1 被浏览器抢走时按 Alt+1 一样生效）');
ok(/Alt \+ <|把 Ctrl 换成 Alt/.test(keysSrc),
  '键位表注释里写明了"Ctrl 被浏览器占用时换 Alt"（含原因，不是只留一行结论）');

/* 围栏：光标停在 ``` 那一行时必须解开整块，不能套娃 */
ok(/function fenceBlocks/.test(keysCode) && /function fenceBlockAt/.test(keysCode),
  '围栏块按 CommonMark 规则在全文范围内配对');
ok(/ch === open\.ch && len >= open\.len/.test(keysCode),
  '闭合围栏必须与开启同字符且不短于它（不同字符只算代码内容）');
ok(/fenceBlockAt\(text, start, end\)/.test(keysCode) && /const fb = fenceBlockAt/.test(keysCode),
  '代码块快捷键先看"是不是已经在围栏里"（否则会把围栏行再包一层）');

/* 列表互转不能叠标记 */
ok(/function listBase/.test(keysCode) && /add: \(l\) => listBase\(l\)/.test(keysCode),
  '列表互转先拆旧标记（不然 `- [ ] a` 按无序列表会变成 `- - [ ] a`）');

/* 页面侧：面板与按钮 */
ok(/id="btnKeys"/.test(html) && /id="keysModal"/.test(html) && /id="keysList"/.test(html),
  '速查面板的三个节点都在 index.html 里');
ok(/toggleKeys/.test(ed) && /btnKeys'\)\.addEventListener/.test(ed) && /keysModal'\)\.addEventListener/.test(ed),
  '按钮、遮罩、Ctrl+/ 三条开合路径都接上了');
ok(/\.keys-grid/.test(css) && /\.krow\b/.test(css), '速查面板的样式已定义（.keys-grid / .krow）');
/* editor.js 是两页共用模块，独立页没有 btnKeys —— 必须判空，否则 init 直接抛 */
ok(/if \(\$\('btnKeys'\)\)/.test(ed) && /if \(\$\('keysModal'\)\)/.test(ed),
  '速查面板相关节点都做了判空（独立编辑页没有这些按钮）');

log('');
log('== 13. 便携包目录布局 ==');
/* 这一组防的是"重构把某处引用留在老位置"——静态检查里少见的、只有真跑才会炸的类目。
   每条都对着一个具体的失败后果，不是为了凑数。 */
const srvFiles = ['server.js', 'lib.js', 'storage.js', 'frontmatter.js', 'pdfimport.js', 'pdfmd.js', 'mdimport.js', 'pages.js'];
const webFiles = ['index.html', 'app.js', 'post.html', 'post.js', 'preview.html', 'preview.js', 'editor.js', 'theme.js', 'styles.css'];
ok(srvFiles.every((f) => fs.existsSync(path.join(SRC, f))), 'src/ 下 8 个服务端文件齐', srvFiles.filter((f) => !fs.existsSync(path.join(SRC, f))).join(','));
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
