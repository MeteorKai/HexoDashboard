// pdfimage.js —— 从 PDF 里取出**真正画在页面上**的那几张图
//
// 为什么要自己写，以及为什么只能自己写：
//   pdf.js 在 Node 里**取不到图像字节** —— 它要靠 canvas 解码，没有 canvas 时
//   `page.objs` 是空的（试过，第 1 页三个 paintImageXObject 一个字节都没有）。
//   但 pdf.js 的 **operator list 是完整可信的**：它已经把 Form XObject、ExtGState
//   这些展平过了，`OPS.paintImageXObject` 会带着"图的原始像素尺寸"和"画在哪个
//   位置"报出来。所以这里分成两半：
//     · 位置/顺序/大小 → 问 pdf.js（它连软蒙版的 Form 都帮我们展开了）；
//     · 像素字节       → 自己按 PDF 对象解析（DCTDecode 直接就是 JPEG，
//                        FlateDecode 自己解 + 自己写 PNG）。
//
// 最容易踩的坑：**不能"见到 /Subtype /Image 就导出"**。实测那份代码审计 PDF 里
// 58 个图像对象只有 18 个是真图，另外 40 个是**软蒙版**：
//     `页 → ExtGState /SMask <</S /Luminosity /G 43 0 R>> → Form obj43 → 画出 obj41`
// 白色代表"完全不透明"，只有边缘一圈渐变是羽化/阴影，所以它们 95% 以上像素是白的，
// 导出成文件看就是一张白图。它们还**成对出现**（2136×1337 与 2144×1345，每边差
// 4px），分别是图本体和外阴影的蒙版。
// 所以过滤走两条路：① 结构：凡是只被 /SMask、/Mask 的 /G 引用到的（含 Form 里
// 画出的）一律不算图；② 像素：解码后统计白占比和颜色数，近乎纯色的丢掉。
//
// 另一半教训写在 pdfimport.js / pdfmd.js 里（标题怎么定、行怎么聚），这里不管文字。
'use strict';
const zlib = require('zlib');

const MAX_IMAGES = 200;              // 一篇文章塞两百张图已经没有阅读价值了
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MIN_SIDE = 48;                 // 比这更小的多半是图标/装饰（14×16 那类）
/* JPEG 的信息密度下限（字节/像素）。一张真照片/截图在 0.05~1 之间；
   纯白软蒙版实测只有 0.006 —— 差两个数量级，这条判据很硬。 */
const JPG_MIN_BPP = 0.02;

/* ── 一、PNG 编码（零依赖） ────────────────────────────────────────────
 * 只需要写 IHDR/IDAT/IEND 三种块：图是拿来给 Hexo 当文章配图的，不需要
 * 调色板、不需要隔行。滤波一律用 0（None），反正 zlib 之后体积差别不大。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** pixels 是已经排好行的原始像素（每行 width*comps 字节，无滤波字节）。 */
function pngEncode(width, height, comps, pixels) {
  const colorType = comps === 1 ? 0 : comps === 3 ? 2 : 4;      // 灰 / RGB / RGBA
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * comps;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                                   // 滤波类型 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 二、把 PDF 里的对象扫出来 ────────────────────────────────────────
 * 不读 xref，直接按 `N G obj … endobj` 扫全文。理由：图像对象**永远不会**被塞进
 * ObjectStream（ObjStm 只能放非流对象），所以哪怕 xref 是流式的、或者干脆坏了，
 * 图像照样能扫到。代价是拿不到"第 N 号对象在不在 xref 里"这种信息 —— 这里不需要。 */
function scanObjects(s) {
  const objs = new Map();
  const re = /(^|[^\d])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[2];
    if (objs.has(num)) continue;                                 // 更新过的对象取最后一次
    const start = m.index + m[0].length;
    let end = s.indexOf('endobj', start);
    if (end < 0) end = s.length;
    objs.set(num, { num, start, end });
  }
  return objs;
}
/** 对象体里"字典那一段"（stream 之前的部分）。所有键都在这里找。 */
function dictOf(s, o) {
  const body = s.slice(o.start, o.end);
  const i = body.indexOf('stream');
  return i < 0 ? body : body.slice(0, i);
}
/** 取对象的流字节。/Length 可能是间接引用，也可能干脆是错的 —— 都以 endstream 兜底。 */
function streamOf(s, buf, objs, o) {
  const st = s.indexOf('stream', o.start);
  if (st < 0 || st > o.end) return null;
  let from = st + 6;
  if (s[from] === '\r') from++;
  if (s[from] === '\n') from++;
  const d = dictOf(s, o);
  let len = null;
  const im = /\/Length\s+(\d+)\s+0\s+R/.exec(d);
  if (im) {
    const t = objs.get(+im[1]);
    if (t) { const tm = /^\s*(\d+)\s*$/m.exec(s.slice(t.start, t.end)); if (tm) len = +tm[1]; }
  }
  if (len == null) { const dm = /\/Length\s+(\d+)/.exec(d); if (dm) len = +dm[1]; }
  let stop = s.indexOf('endstream', from);
  if (stop < 0 || stop > o.end) stop = o.end;
  if (len == null || from + len > stop + 16) len = stop - from;   // /Length 不靠谱时以 endstream 为准
  while (len > 0 && (buf[from + len - 1] === 10 || buf[from + len - 1] === 13)) len--;
  return buf.slice(from, from + len);
}

const intIn = (re, dict) => { const m = re.exec(dict); return m ? parseInt(m[1], 10) : null; };

/* ── 三、颜色空间 → 每个像素几个分量 ────────────────────────────────── */
function compsOf(s, objs, dict) {
  const m = /\/ColorSpace\s+(\d+)\s+0\s+R/.exec(dict);
  if (m) return compsOf(s, objs, dictOf(s, objs.get(+m[1]) || { start: 0, end: 0 }) || '');
  const idx = /\/ColorSpace\s*\[\s*\/Indexed([^\]]*)\]/.exec(dict);
  if (idx) {
    const base = compsOf(s, objs, '/ColorSpace ' + idx[1].trim().split(/\s+/)[0]);
    return { indexed: true, base: base && base.indexed ? 1 : (base || 1), rest: idx[1] };
  }
  if (/\/ColorSpace\s*\[\s*\/ICCBased/.test(dict)) {
    const ref = /\/ColorSpace\s*\[\s*\/ICCBased\s+(\d+)\s+0\s+R/.exec(dict);
    if (ref && objs.has(+ref[1])) {
      const n = intIn(/\/N\s+(\d+)/, dictOf(s, objs.get(+ref[1])));
      return n || 3;                                             // ICCBased 常见就是 RGB
    }
    return 3;
  }
  if (/\/DeviceCMYK|\/CalCMYK|\/ Separation/.test(dict)) return 4;
  if (/\/DeviceGray|\/CalGray|\/Separation|\/G\b/.test(dict)) return 1;
  if (/\/DeviceRGB|\/CalRGB|\/DeviceN|\/Lab/.test(dict)) {
    const n = intIn(/\/N\s+(\d+)/, dict);
    return n && n > 1 ? n : 3;
  }
  return 3;                                                      // 认不出来按 RGB 试，解码大小对不上会被后面挡掉
}

/* ── 四、PNG 预测器反算 ───────────────────────────────────────────────
 * PDF 里 FlateDecode 的图像常常带 /Predictor 15（PNG 自适应）。不反算的话
 * 导出的是**差分数据**，看起来就是一片噪声。只支持 8 位（1 位的模板蒙版本来就不要）。 */
function undoPredictor(data, w, h, bpp, predictor) {
  if (!predictor || predictor < 10) return data;
  const stride = w * bpp;
  const need = (stride + 1) * h;
  if (data.length < need) return null;
  const out = Buffer.alloc(stride * h);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < h; y++) {
    const ft = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const upv = y > 0 ? out[up + x] : 0;
      const ul = (y > 0 && x >= bpp) ? out[up + x - bpp] : 0;
      let v;
      if (ft === 0) v = raw;
      else if (ft === 1) v = raw + left;
      else if (ft === 2) v = raw + upv;
      else if (ft === 3) v = raw + ((left + upv) >> 1);
      else if (ft === 4) v = raw + paeth(left, upv, ul);
      else v = raw;
      out[dst + x] = v & 255;
    }
  }
  return out;
}

/** /DecodeParms：可能是 <<…>>，也可能是 `N 0 R`，还可能是数组。取出 Predictor/Colors/Columns/BitsPerComponent。 */
function decodeParms(s, objs, dict) {
  let body = /\/DecodeParms\s*(\[?)([\s\S]{0,200}?)(?=\/|\])/.exec(dict);
  let src = dict;
  const im = /\/DecodeParms\s+(\d+)\s+0\s+R/.exec(dict) || /\/Decode\s+(\d+)\s+0\s+R/.exec(dict);
  if (im && objs.has(+im[1])) src = dictOf(s, objs.get(+im[1]));
  const i = src.indexOf('<<');
  if (i < 0) return null;
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '<' && src[j + 1] === '<') { depth++; j++; }
    else if (src[j] === '>' && src[j + 1] === '>') { depth--; j++; if (!depth) break; }
  }
  const d = src.slice(i, j + 1);
  void body;
  return {
    predictor: intIn(/\/Predictor\s+(\d+)/, d),
    colors: intIn(/\/Colors\s+(\d+)/, d),
    columns: intIn(/\/Columns\s+(\d+)/, d),
    bpc: intIn(/\/BitsPerComponent\s+(\d+)/, d),
  };
}

/** 图像对象 → 解码后的像素 + 分量数。解不了就返回 null（宁可少一张，也不要坏图）。 */
function decodeImage(s, buf, objs, o) {
  const d = dictOf(s, o);
  if (!/\/Subtype\s*\/Image/.test(d)) return null;
  if (/\/ImageMask\s+true/.test(d)) return null;                  // 模板蒙版：1 位戳印，不是图
  const w = intIn(/\/Width\s+(\d+)/, d), h = intIn(/\/Height\s+(\d+)/, d);
  if (!w || !h || w < MIN_SIDE || h < MIN_SIDE) return null;
  const bpc = intIn(/\/BitsPerComponent\s+(\d+)/, d) || 8;
  if (bpc !== 8) return null;                                     // 16 位/其它位深先不支持
  const raw = streamOf(s, buf, objs, o);
  if (!raw || !raw.length) return null;
  const filters = (d.match(/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|LZWDecode|RunLengthDecode|FlateDecode)/g) || []).map((x) => x.slice(1));
  const cs = compsOf(s, objs, d);

  /* JPEG：PDF 里存的就是一个完整的 JFIF，原样拿出来即可。 */
  if (filters.includes('DCTDecode')) {
    let data = raw;
    if (data[0] === 0x0a) data = data.slice(1);                   // 有些生成器多写一个换行
    if (!(data[0] === 0xff && data[1] === 0xd8)) return null;
    const bpp = data.length / (w * h);
    if (bpp < JPG_MIN_BPP) return { blank: true, w, h, bpp };     // 纯色/空白蒙版
    return { ext: 'jpg', data, w, h };
  }
  if (filters.includes('JPXDecode') || filters.includes('JBIG2Decode') ||
      filters.includes('CCITTFaxDecode') || filters.includes('LZWDecode')) return null;   // 解不了就不要

  let px = raw;
  if (filters.includes('FlateDecode')) {
    try { px = zlib.inflateSync(raw); } catch (e) {
      try { px = zlib.inflateRawSync(raw); } catch (e2) { return null; }
    }
  }

  const indexed = cs && cs.indexed;
  const baseComps = indexed ? cs.base : (typeof cs === 'number' ? cs : 3);
  const parms = decodeParms(s, objs, d);
  const predictor = parms && parms.predictor;
  const bpp = predictor ? (parms.colors || baseComps) : baseComps;
  if (predictor && predictor >= 10) {
    const undone = undoPredictor(px, parms.columns || w, h, bpp, predictor);
    if (!undone) return null;
    px = undone;
  }
  const stride = w * baseComps;
  if (px.length < stride * h) return null;                        // 分量数猜错了，别硬解

  /* Indexed：调色板可能是 16 进制字符串，也可能是一个流对象。展开成 RGB。 */
  let pixels = px, comps = baseComps;
  if (indexed) {
    const pal = (() => {
      const hex = /<([0-9A-Fa-f\s]+)>\s*$/.exec(cs.rest);
      if (hex) return Buffer.from(hex[1].replace(/\s/g, ''), 'hex');
      const ref = /(\d+)\s+0\s+R/.exec(cs.rest);
      if (ref && objs.has(+ref[1])) return streamOf(s, buf, objs, objs.get(+ref[1]));
      return null;
    })();
    if (!pal || pal.length < baseComps * 3) return null;
    const out = Buffer.alloc(w * h * 3);
    const n = Math.floor(pal.length / baseComps);
    for (let i = 0; i < w * h; i++) {
      const p = Math.min(n - 1, px[i]) * baseComps;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = pal[p + (c < baseComps ? c : 0)] || 0;
    }
    pixels = out; comps = 3;
  }
  /* CMYK → RGB：PDF 的 CMYK 是减色，直接反相近似（不做色彩管理，够看）。 */
  if (comps === 4) {
    const out = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const c = pixels[i * 4], m2 = pixels[i * 4 + 1], y = pixels[i * 4 + 2], k = pixels[i * 4 + 3];
      out[i * 3] = 255 - Math.min(255, c + k);
      out[i * 3 + 1] = 255 - Math.min(255, m2 + k);
      out[i * 3 + 2] = 255 - Math.min(255, y + k);
    }
    pixels = out; comps = 3;
  }
  if (comps !== 1 && comps !== 3) return null;
  const st = pixelStats(pixels, w, h, comps);
  /* 近乎纯色 → 不是内容，是装饰/蒙版。颜色数放宽到 6 是因为抗锯齿会多出几档灰。 */
  if (st.colors <= 6 && st.white > 92) return { blank: true, w, h };
  return { ext: 'png', data: pngEncode(w, h, comps, pixels.slice(0, w * h * comps)), w, h };
}

/** 抽样统计：白占比、颜色数、平均亮度。抽 4 万个点足够分辨"有没有内容"。 */
function pixelStats(pixels, w, h, comps) {
  const step = Math.max(1, Math.floor((w * h) / 40000));
  let white = 0, n = 0, sum = 0;
  const seen = new Set();
  for (let i = 0; i < w * h; i += step) {
    const o = i * comps;
    const r = pixels[o], g = comps >= 3 ? pixels[o + 1] : r, b = comps >= 3 ? pixels[o + 2] : r;
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    sum += lum; n++;
    if (r > 245 && g > 245 && b > 245) white++;
    if (seen.size < 4096) seen.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
  }
  return { white: n ? white * 100 / n : 100, colors: seen.size, avg: n ? sum / n : 255 };
}

/* ── 五、哪些对象只是"蒙版" ───────────────────────────────────────────
 * 结构判据：`/SMask N 0 R`、`/SMask <</S /Luminosity /G N 0 R>>`、`/Mask` 同理。
 * 引用到的如果是个 Form，就把 Form 里画的图也算成蒙版（实测就是这条把 40 张白图
 * 挡住的 —— 光靠像素统计挡不住，它们的边框渐变有 15~26 个灰阶）。 */
function xobjectMap(s, objs, dict) {
  const names = {};
  let src = dict;
  const rm = /\/Resources\s+(\d+)\s+0\s+R/.exec(dict);
  if (rm && objs.has(+rm[1])) src = dictOf(s, objs.get(+rm[1]));
  let sub = src;
  const xi = src.indexOf('/XObject');
  if (xi >= 0) sub = src.slice(xi);
  const im = /\/XObject\s+(\d+)\s+0\s+R/.exec(sub);
  if (im && objs.has(+im[1])) sub = dictOf(s, objs.get(+im[1]));
  const re = /\/(\w+)\s+(\d+)\s+0\s+R/g;
  let m;
  while ((m = re.exec(sub))) { if (!names[m[1]]) names[m[1]] = +m[2]; }
  return names;
}
function maskNumbers(s, objs) {
  const roots = new Set();
  for (const o of objs.values()) {
    const d = dictOf(s, o);
    let m;
    const re1 = /\/S?Mask\s+(\d+)\s+0\s+R/g;
    while ((m = re1.exec(d))) roots.add(+m[1]);
    const re2 = /\/(?:SMask|Mask)\s*<<([\s\S]*?)>>/g;
    while ((m = re2.exec(d))) { const g = /\/G\s+(\d+)\s+0\s+R/.exec(m[1]); if (g) roots.add(+g[1]); }
  }
  /* 展开 Form：蒙版常常是"一个只画了一张图的 Form" */
  const masks = new Set();
  const seen = new Set();
  const walk = (n) => {
    if (seen.has(n)) return; seen.add(n);
    const o = objs.get(n); if (!o) return;
    const d = dictOf(s, o);
    if (/\/Subtype\s*\/Image/.test(d)) { masks.add(n); return; }
    if (!/\/Subtype\s*\/Form/.test(d)) return;
    const names = xobjectMap(s, objs, d);
    const stream = streamOf(s, Buffer.from(s, 'latin1'), objs, o) || '';
    const str = typeof stream === 'string' ? stream : stream.toString('latin1');
    const re = /\/(\w+)\s+Do/g;
    let m;
    while ((m = re.exec(str))) { if (names[m[1]] != null) walk(names[m[1]]); }
  };
  for (const n of roots) walk(n);
  return masks;
}

/* ── 六、pdf.js 的 operator list → 每张图的落点 ────────────────────────
 * 自己解析内容流也能做，但要处理 Resources 继承、Form 嵌套、ExtGState ——
 * pdf.js 已经把这些都展平好了，直接用它给的：
 *   OPS.transform(12)   → 乘 CTM；OPS.save(10)/restore(11) → 栈
 *   OPS.paintImageXObject(85) → args = [objId, 原始宽, 原始高]
 * 图像画在单位正方形上，所以 CTM 的 a/d/e/f 就是它在**默认用户空间**里的矩形。 */
function mul(m, t) {
  return [
    t[0] * m[0] + t[1] * m[2],
    t[0] * m[1] + t[1] * m[3],
    t[2] * m[0] + t[3] * m[2],
    t[2] * m[1] + t[3] * m[3],
    t[4] * m[0] + t[5] * m[2] + m[4],
    t[4] * m[1] + t[5] * m[3] + m[5],
  ];
}
async function placements(doc, pdfjs, { maxPages = 500 } = {}) {
  const OPS = pdfjs.OPS || {};
  const SAVE = OPS.save || 10, RESTORE = OPS.restore || 11, TRANSFORM = OPS.transform || 12;
  const IMG = [OPS.paintImageXObject || 85, OPS.paintImageMaskXObject || 83, OPS.paintInlineImageXObject || 86];
  const out = [];
  const total = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= total; i++) {
    let page, ops;
    try { page = await doc.getPage(i); } catch (e) { continue; }
    try { ops = await page.getOperatorList(); } catch (e) { ops = null; }
    let pageH = 792;
    try { pageH = page.getViewport({ scale: 1 }).height || 792; } catch (e) { /* 用默认值 */ }
    if (ops && ops.fnArray) {
      let m = [1, 0, 0, 1, 0, 0]; const stack = [];
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k], args = ops.argsArray[k] || [];
        if (fn === SAVE) stack.push(m.slice());
        else if (fn === RESTORE) m = stack.pop() || m;
        else if (fn === TRANSFORM) m = mul(m, args);
        else if (IMG.includes(fn)) {
          const w = Number(args[1]) || 0, h = Number(args[2]) || 0;
          /* 单位正方形经 CTM 变换后的矩形（旋转/翻转的情况直接放弃，位置算不准） */
          const a = m[0], d = m[3];
          if (!w || !h || a <= 0 || d <= 0) continue;
          out.push({
            page: i, w, h,
            x: m[4], width: a, height: d,
            yTop: pageH - (m[5] + d),
          });
        }
      }
    }
    try { page.cleanup(); } catch (e) { /* 忽略 */ }
  }
  return out;
}

/** 主入口：`doc` 是 pdf.js 的文档对象（pdfimport.lib() 开出来的），`buffer` 是原始字节。
 *  返回按"页 → 纵向位置"排好序的图：[{page, yTop, data, ext, width, height}] */
async function extract({ doc, buffer, pdfjs, maxImages = MAX_IMAGES, maxBytes = MAX_TOTAL_BYTES }) {
  if (!doc || !buffer) return [];
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const s = buf.toString('latin1');
  const objs = scanObjects(s);
  const masks = maskNumbers(s, objs);

  /* 先按"原始像素尺寸"建索引：pdf.js 的 op 里只有尺寸，没有对象号。 */
  const bySize = new Map();
  for (const o of objs.values()) {
    const d = dictOf(s, o);
    if (!/\/Subtype\s*\/Image/.test(d)) continue;
    const w = intIn(/\/Width\s+(\d+)/, d), h = intIn(/\/Height\s+(\d+)/, d);
    if (!w || !h) continue;
    const k = w + 'x' + h;
    if (!bySize.has(k)) bySize.set(k, []);
    bySize.get(k).push(o.num);
  }

  /* pdfjs 由调用方传进来（生产路径都是）；命令行自检那条路在自检块里就地取一份。
     运行时这一层**不 require pdfimport** —— 两个模块互相 require 会把加载顺序搞脆，
     而且 pdfimage 本来就不需要知道 pdf.js 是怎么配的。 */
  const spots = await placements(doc, pdfjs);
  const cache = new Map();
  const out = [];
  let bytes = 0;
  for (const sp of spots) {
    if (out.length >= maxImages || bytes >= maxBytes) break;
    const cands = bySize.get(sp.w + 'x' + sp.h) || [];
    let picked = null;
    for (const num of cands) {
      if (masks.has(num)) continue;                              // 蒙版一律不算图
      if (!cache.has(num)) {
        try { cache.set(num, decodeImage(s, buf, objs, objs.get(num))); } catch (e) { cache.set(num, null); }
      }
      const dec = cache.get(num);
      if (dec && !dec.blank) { picked = dec; break; }
    }
    if (!picked) continue;
    if (bytes + picked.data.length > maxBytes) continue;
    bytes += picked.data.length;
    out.push({ page: sp.page, yTop: sp.yTop, x: sp.x, width: sp.width, height: sp.height, data: picked.data, ext: picked.ext });
  }
  out.sort((a, b) => (a.page - b.page) || (a.yTop - b.yTop) || (a.x - b.x));
  return out;
}

module.exports = { extract, scanObjects, decodeImage, pngEncode, maskNumbers, placements, MAX_IMAGES, MIN_SIDE };

/* 命令行自检：node pdfimage.js <a.pdf> [输出目录]
 * 用来离线确认"这份 PDF 到底能取出几张图、都是什么"。 */
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const pdfimport = require('./pdfimport');
  const [file, outDir] = process.argv.slice(2);
  if (!file) { console.log('用法: node pdfimage.js <a.pdf> [输出目录]'); process.exit(1); }
  (async () => {
    const buf = fs.readFileSync(file);
    const p = pdfimport.lib();
    const doc = await p.getDocument({
      data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false,
      cMapUrl: pdfimport.VDIR.replace(/\\/g, '/') + '/cmaps/', cMapPacked: true,
      standardFontDataUrl: pdfimport.VDIR.replace(/\\/g, '/') + '/standard_fonts/', verbosity: 0,
    }).promise;
    const imgs = await extract({ doc, buffer: buf, pdfjs: p });
    console.log('共 ' + imgs.length + ' 张：');
    for (const im of imgs) {
      console.log('  第' + String(im.page).padStart(2) + '页 y=' + String(Math.round(im.yTop)).padStart(5) +
        '  ' + String(Math.round(im.width)).padStart(4) + 'x' + String(Math.round(im.height)).padStart(4) +
        'pt  ' + String(im.data.length).padStart(8) + 'B  .' + im.ext);
    }
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      imgs.forEach((im, i) => fs.writeFileSync(path.join(outDir, 'p' + im.page + '-' + (i + 1) + '.' + im.ext), im.data));
      console.log('已写入 ' + outDir);
    }
    process.exit(0);
  })().catch((e) => { console.log('失败: ' + (e && e.message)); process.exit(1); });
}
