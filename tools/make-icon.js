/* 零依赖生成应用图标：自己编码 PNG，再套进 ICO 容器。
   不引任何 npm 包 —— 这个项目连 marked/js-yaml 都是 vendored 的，
   为了一个图标去装 sharp/to-ico 是倒退。PNG 只用 zlib + CRC32，ICO 就是一层薄壳。
   用法：node tools/make-icon.mjs  （输出到应用根，另存一份 256px PNG 供人眼复查） */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP = path.join(__dirname, '..');
const SIZES = [16, 32, 48, 64, 128, 256];
const SS = 4; // 每个输出像素 4x4 超采样 —— 圆角与斜切的抗锯齿全靠它

/* ---------------- CRC32（PNG 每个 chunk 都要） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- PNG 编码（8bit RGBA，filter 0） ---------------- */
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function pngEncode(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: truecolor + alpha
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 图形定义（全部用 0..1 单位坐标，尺寸无关） ---------------- */
const hex = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const BG_TOP = hex(0x54806A);  // 底色渐变：左上（亮）
const BG_BOT = hex(0x27412F);  // 底色渐变：右下（暗）
const C_PAGE = hex(0xFEFFFC);  // 纸（复用 UI 的 --accent-on，同一个暖白）
const C_FOLD = hex(0xCFE0D5);  // 折角的背面
const C_LINE = hex(0x3E6249);  // 纸上的字行

const PAGE = { x0: 0.250, x1: 0.750, y0: 0.130, y1: 0.870, r: 0.055, cut: 0.150 };
const LINES = [
  { y: 0.400, x1: 0.665, a: 0.92 },
  { y: 0.505, x1: 0.665, a: 0.92 },
  { y: 0.610, x1: 0.665, a: 0.92 },
  { y: 0.715, x1: 0.560, a: 0.55 },
];
const LX0 = 0.335, LH = 0.052;

function inRoundedSquare(u, v, inset, r) {
  const a = inset, b = 1 - inset;
  if (u < a || u > b || v < a || v > b) return false;
  const cx = Math.min(Math.max(u, a + r), b - r);
  const cy = Math.min(Math.max(v, a + r), b - r);
  const dx = u - cx, dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

/* 纸：圆角矩形，但右上角被斜切掉一块（做出"折角"） */
function inPage(u, v) {
  const { x0, x1, y0, y1, r, cut } = PAGE;
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  if ((u - x1 + cut) > (v - y0)) return false;          // 斜切
  if (u < x0 + r && v < y0 + r) { const dx = x0 + r - u, dy = y0 + r - v; if (dx * dx + dy * dy > r * r) return false; }
  if (u < x0 + r && v > y1 - r) { const dx = x0 + r - u, dy = v - (y1 - r); if (dx * dx + dy * dy > r * r) return false; }
  if (u > x1 - r && v > y1 - r) { const dx = u - (x1 - r), dy = v - (y1 - r); if (dx * dx + dy * dy > r * r) return false; }
  return true;
}

/* 被切掉的那块三角 = 看得见的折角背面 */
function inFold(u, v) {
  const { x1, y0, cut } = PAGE;
  if (u < x1 - cut || u > x1 || v < y0 || v > y0 + cut) return false;
  return (u - x1 + cut) > (v - y0);
}

function inBar(u, v, x0, x1, yc, h) {
  const r = h / 2;
  const xa = x0 + r, xb = x1 - r;
  if (v < yc - r || v > yc + r) return false;
  if (u >= xa && u <= xb) return true;
  const cx = u < xa ? xa : xb;
  const dx = u - cx, dy = v - yc;
  return dx * dx + dy * dy <= r * r;
}

/* 单位坐标 -> 颜色（含 alpha），未覆盖处返回 null */
function sample(u, v) {
  if (!inRoundedSquare(u, v, 0.015, 0.215)) return null;
  const t = Math.min(1, Math.max(0, ((u - 0.015) + (v - 0.015)) / 1.97));
  let c = [0, 1, 2].map((i) => Math.round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t));
  if (inFold(u, v)) c = C_FOLD;
  else if (inPage(u, v)) {
    c = C_PAGE;
    for (const L of LINES) {
      if (inBar(u, v, LX0, L.x1, L.y, LH)) {
        c = [0, 1, 2].map((i) => Math.round(C_PAGE[i] + (C_LINE[i] - C_PAGE[i]) * L.a));
        break;
      }
    }
  }
  return c;
}

/* ---------------- 渲染：SS×SS 超采样，在预乘 alpha 空间求平均 ---------------- */
function render(S) {
  const out = Buffer.alloc(S * S * 4);
  const N = SS * SS;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / S;
          const v = (py + (sy + 0.5) / SS) / S;
          const c = sample(u, v);
          if (!c) continue;
          sr += c[0]; sg += c[1]; sb += c[2]; sa += 1;
        }
      }
      const i = (py * S + px) * 4;
      if (sa === 0) continue;
      out[i] = Math.round(sr / sa);
      out[i + 1] = Math.round(sg / sa);
      out[i + 2] = Math.round(sb / sa);
      out[i + 3] = Math.round((sa / N) * 255);
    }
  }
  return out;
}

/* ---------------- ICO 容器（内嵌 PNG，Vista 以上原生支持） ---------------- */
function icoWrap(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(entries.length, 4);
  const table = Buffer.alloc(16 * entries.length);
  let offset = 6 + table.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    table[o] = e.size >= 256 ? 0 : e.size;
    table[o + 1] = e.size >= 256 ? 0 : e.size;
    table[o + 2] = 0; table[o + 3] = 0;
    table.writeUInt16LE(1, o + 4); table.writeUInt16LE(32, o + 6);
    table.writeUInt32LE(e.png.length, o + 8);
    table.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([dir, table, ...entries.map((e) => e.png)]);
}

const entries = SIZES.map((size) => ({ size, png: pngEncode(size, size, render(size)) }));
const ico = icoWrap(entries);
const icoPath = path.join(APP, 'Hexo写作台.ico');
fs.writeFileSync(icoPath, ico);

/* 顺手在项目数据目录留两张 PNG 预览：.ico 在资源管理器外不好看，
   而且做小尺寸可用性复核时（16/32 到底糊没糊）直接看 PNG 最省事。 */
const shotDir = path.join(APP, '.workbuddy');
fs.mkdirSync(shotDir, { recursive: true });
const preview256 = path.join(shotDir, 'icon-256.png');
const preview32 = path.join(shotDir, 'icon-32.png');
fs.writeFileSync(preview256, entries[SIZES.indexOf(256)].png);
fs.writeFileSync(preview32, entries[SIZES.indexOf(32)].png);

console.log('ico      ' + icoPath + '  ' + ico.length + ' bytes');
console.log('sizes    ' + SIZES.join(' / ') + '   每个条目 ' + entries.map((e) => e.png.length).join('/') + ' bytes');
console.log('preview  ' + preview256);
console.log('preview  ' + preview32);
