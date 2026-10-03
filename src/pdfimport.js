// pdfimport.js —— 用 pdf.js 把 PDF 读成"行"，交给 pdfmd 还原成 Markdown
//
// 为什么解析放在**服务端**而不是浏览器：
//   - pdf.js 需要 cmaps / standard_fonts 两套资源目录（合计 ~2.2MB, 185 个文件），
//     放服务端就是两个本地路径，放浏览器还得逐个路由、还要处理 worker 的 CSP；
//   - 同一份 pdf.js 在 Node 里能直接跑（下面用的是 legacy build），于是"取版式"
//     这件事能在命令行里复现、能被测试脚本驱动，不用每次开浏览器；
//   - 浏览器的 CSP 是 script-src 'self'，pdf.js 的 worker 与 CMap 加载都要额外放行，
//     服务端完全没有这些摩擦。
//
// 代价是解析会占 CPU。所以做了两件事：逐页处理，**每页之间让出一次事件循环**，
// 免得一个 155 页的 PDF 把整个写作台的界面卡住；同时限制页数上限。
'use strict';
const fs = require('fs');
const path = require('path');
const pdfmd = require('./pdfmd');
const pdfimage = require('./pdfimage');

const VDIR = path.join(__dirname, '..', 'vendor', 'pdfjs');
const sl = (p) => p.replace(/\\/g, '/');                 // pdf.js 内部按 URL 拼，正斜杠最保险
const tick = () => new Promise((r) => setImmediate(r));
const MAX_PAGES = 500;

let pdfjs = null;
function lib() {
  if (pdfjs) return pdfjs;
  /* pdf.worker.js 必须和 pdf.js 放同一个目录：Node 下 pdf.js 走的是
     "fake worker"，靠 require('./pdf.worker.js') 就地加载，起不来会直接抛
     `Setting up fake worker failed`。这个错很难猜，所以把两个文件放一起。 */
  pdfjs = require(path.join(VDIR, 'pdf.js'));
  return pdfjs;
}

/** 把一页的 textContent 抹平成行需要的字段。
 *  关键：**字号取 transform，不取 item.height** —— 空白 item 的 height 是 0，
 *  而行首常常正好是个空格，取 height 会让整行的字号变成 0。 */
function flatten(page, tc) {
  const vp = page.getViewport({ scale: 1 });
  const items = [];
  for (const it of tc.items) {
    const t = it.str;
    if (typeof t !== 'string' || !t) continue;
    const tf = it.transform;
    if (!tf || tf.length < 6) continue;
    const size = Math.hypot(tf[2], tf[3]) || 0;
    if (!size) continue;
    items.push({
      text: t.replace(/\u0000/g, ''),
      x: tf[4],
      yTop: vp.height - tf[5],          // PDF 是原点左下、y 向上；统一成"离页顶多远"
      size,
      width: it.width || 0,
      font: it.fontName || '',
      eol: !!it.hasEOL,
    });
  }
  return { num: page.pageNumber, width: vp.width, height: vp.height, items };
}

/** 主入口。buffer 与 filePath 二选一。
 *
 *  `images` 是一个可选的回调：`(img, index) => tag|null`。给一张图（带 page / yTop /
 *  data / ext），返回一个要插进正文的字符串（通常是 Hexo 的 asset_img 标签）；
 *  返回 null 就跳过这张图。
 *  **为什么用回调而不是把图直接返回给调用方**：图的落点（插在正文哪一行）只有
 *  pdfmd 在还原版式时才知道，而文件名要先落盘才能定（资源名是内容哈希）。
 *  回调让"写文件 + 定文件名"留在调用方（server.js 知道资源目录在哪），
 *  "插在哪一行"留在 pdfmd —— 这一层只负责把两者接起来。
 *
 *  外面这层只做一件事：把 pdf.js 的 console 噪音收起来。
 *  写作台的控制台窗口是给人看的，"translateFont failed" 或者 Node 里装不上 canvas 时
 *  那两条 "Cannot polyfill DOMMatrix" 刷上去就没法用了。
 *  两个要点：① pdf.js 走的是 **console.log** 而不是 console.warn，只拦 warn/error 会漏；
 *  ② 必须罩住整段解析 —— 有些警告是模块加载时打出来的，圈小了照样漏出去。 */
async function convert(opts) {
  const warnings = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const swallow = (orig) => (...a) => { if (warnings.length < 40) warnings.push(String(a[0] == null ? '' : a[0])); void orig; };
  console.log = swallow(saved.log); console.warn = swallow(saved.warn); console.error = swallow(saved.error);
  try {
    return await convertInner(opts, warnings);
  } finally {
    console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
  }
}

async function convertInner({ buffer, filePath, title, images }, warnings) {
  const src = buffer ? new Uint8Array(buffer) : new Uint8Array(fs.readFileSync(filePath));
  const p = lib();
  let doc = null;
  try {
    doc = await p.getDocument({
      data: src,
      isEvalSupported: false,          // 受限环境里别用 eval 构造
      useSystemFonts: false,
      cMapUrl: sl(path.join(VDIR, 'cmaps')) + '/',          // 少了这条：用预定义 CMap 的
      cMapPacked: true,                                      // 中文 PDF 会一个字都抽不出来
      standardFontDataUrl: sl(path.join(VDIR, 'standard_fonts')) + '/',
      verbosity: 0,
    }).promise;
  } catch (e) {
    throw Object.assign(new Error('这个文件不是有效的 PDF，或者已损坏：' + (e && e.message)), { cause: e });
  }
  if (!doc) throw new Error('PDF 打不开');

  const total = Math.min(doc.numPages, MAX_PAGES);
  const pages = [];
  const warnN = warnings.length;
  for (let i = 1; i <= total; i++) {
    let page;
    try { page = await doc.getPage(i); } catch { continue; }   // 单页坏了不该毁掉整份
    try {
      const tc = await page.getTextContent();
      pages.push(flatten(page, tc));
    } catch { /* 同上 */ } finally { try { page.cleanup(); } catch { /* 忽略 */ } }
    await tick();                                              // 让出事件循环
  }

  /* 元数据里的标题作为最后兜底：Chromium 打印的 PDF 会把 <title> 写进 /Title。 */
  let metaTitle = '';
  try {
    const meta = await doc.getMetadata();
    metaTitle = String((meta && meta.info && meta.info.Title) || '').trim();
  } catch { /* 没有就算了 */ }
  /* 图片：位置/顺序问 pdf.js（它能把 Form、ExtGState 展平），字节自己解析
     （pdf.js 在 Node 里取不到图，见 pdfimage.js 文件头）。
     每张图交给调用方落盘并换回一个正文标签；单张失败不该毁掉整篇。 */
  const imageTags = [];
  if (typeof images === 'function') {
    let imgs = [];
    try {
      imgs = await pdfimage.extract({
        doc, pdfjs: p, buffer: Buffer.from(src.buffer, src.byteOffset, src.byteLength),
      });
    } catch { imgs = []; }                                        // 取不出图就当这份 PDF 没图
    for (let i = 0; i < imgs.length; i++) {
      try {
        const tag = await images(imgs[i], i);
        if (tag) imageTags.push({ page: imgs[i].page, yTop: imgs[i].yTop, tag });
      } catch { /* 忽略这一张 */ }
    }
  }

  try { await doc.destroy(); } catch { /* 忽略 */ }

  /* 标题的优先级：**调用方给的（前端给的就是文件名）> 版面 > 元数据**。
   *
   * 为什么把文件名顶到最前面：版面里"哪一行算标题"只能靠字号猜，长标题软换行、
   * 副标题、页眉都会让它认错 —— 实测蓝鲸那篇一边把标题切成两半、一边又把正文里的
   * 大标题弄丢。文件名是确定的，而且导入后本来就要自己改标题。
   *
   * 顺带一个好处：**给了标题就不再从正文里抽走任何行**，版面内容整篇进正文，
   * 不会莫名少一段。 */
  const r = pdfmd.toMarkdown(pages, { title: String(title || '').trim(), images: imageTags });
  const finalTitle = (r.title || metaTitle || '').trim();
  return {
    title: finalTitle,
    markdown: r.markdown,
    stats: Object.assign({}, r.stats, {
      pages: pages.length,
      truncated: doc.numPages > total,
      totalPages: doc.numPages,
      warnings: warnN,
    }),
  };
}

const convertFile = (filePath, opts) => convert(Object.assign({ filePath }, opts || {}));

module.exports = { convert, convertFile, flatten, lib, VDIR, MAX_PAGES };

/* 命令行：node pdfimport.js a.pdf b.pdf   → 生成同名 .md，用来离线核对质量 */
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) { console.log('用法: node pdfimport.js <a.pdf> [b.pdf ...]'); process.exit(1); }
  (async () => {
    for (const f of args) {
      const t0 = Date.now();
      try {
        const r = await convertFile(f);
        const out = f.replace(/\.pdf$/i, '') + '.md';
        fs.writeFileSync(out, (r.title ? '# ' + r.title + '\n\n' : '') + r.markdown, 'utf8');
        console.log(`[ok] ${path.basename(f)}  ${r.stats.pages}页 ${r.stats.chars}字 ` +
          `标题${r.stats.headings} 列表${r.stats.lists} 代码块${r.stats.codeBlocks} ` +
          `修部首${r.stats.kangxi} 去页眉页脚${r.stats.dropped}  ${Date.now() - t0}ms → ${path.basename(out)}`);
      } catch (e) {
        console.log(`[x] ${path.basename(f)}  ${e && e.message}`);
      }
    }
  })();
}
