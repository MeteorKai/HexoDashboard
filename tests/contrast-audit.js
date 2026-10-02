/* 对比度审计（常设测试，不是一次性脚本）
 *
 *   node tests/contrast-audit.js
 *
 * 它做三件事：
 *   ① 从 styles.css 里**解析**真实的令牌值 —— 不手抄，避免"改了 CSS 忘了改测试"；
 *   ② 把真正会碰面的「文字/底色」「描边/底色」组合算 WCAG 对比度；
 *   ③ 任何一项不达标就 exit 1，这样它能直接进测试套件当闸门。
 *
 * 为什么要有它：用户反馈"看不清"，而这类问题**静态检查、端到端全绿也照样存在** ——
 * 代码没错，只是字太小、线太淡。只有把对比度算成数字才拦得住。
 */
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');

/* ── 从 CSS 文本里抠出一个选择器块里所有 `--x: y;` ───────────────────────── */
function tokensIn(blockRe) {
  const m = blockRe.exec(CSS);
  if (!m) throw new Error('styles.css 里找不到令牌块：' + blockRe);
  const body = m[1];
  const out = {};
  for (const mm of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[mm[1]] = mm[2].trim();
  return out;
}

// 浅色：`:root, :root[data-theme="light"] { ... }`
const LIGHT = tokensIn(/^:root,\s*\n:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/m);
// 深色：显式 `:root[data-theme="dark"] { ... }`（与系统深色媒体查询内容一致）
const DARK = tokensIn(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m);

/* ── WCAG 相对亮度与对比度 ─────────────────────────────────────────────── */
function hex2rgb(h) {
  h = String(h).trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;      // 非纯色（rgba/变量）直接判为"跳过"
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function srgb(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(rgb) { return 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]); }
function ratio(a, b) {
  const ra = hex2rgb(a), rb = hex2rgb(b);
  if (!ra || !rb) return null;
  const l1 = lum(ra), l2 = lum(rb);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* ── 检查表 ──────────────────────────────────────────────────────────────
   门槛依据 WCAG 2.1：正文 1.4.3 要 4.5:1；界面控件与图形 1.4.11 要 3:1。
   这里对"面板外框/行分隔"用 2.0 / 1.5 的**自定下限** —— 它们属装饰性分隔，
   WCAG 不管，但这也是"看不清"的重灾区，所以自定一条不为零的下限。 */
const CHECKS = [
  // [说明, 前景令牌, 背景令牌, 下限]
  ['正文 text / paper', '--text', '--paper', 4.5],
  ['正文 text / surface', '--text', '--surface', 4.5],
  ['正文 text / surface-2', '--text', '--surface-2', 4.5],
  ['正文 text / surface-3', '--text', '--surface-3', 4.5],
  ['次要 text-2 / surface', '--text-2', '--surface', 4.5],
  ['次要 text-2 / surface-2', '--text-2', '--surface-2', 4.5],
  ['次要 text-2 / paper', '--text-2', '--paper', 4.5],
  ['最弱 text-3 / surface', '--text-3', '--surface', 4.5],
  ['最弱 text-3 / surface-2', '--text-3', '--surface-2', 4.5],
  ['最弱 text-3 / paper', '--text-3', '--paper', 4.5],
  ['强调色 accent / surface', '--accent', '--surface', 4.5],
  ['强调底字 accent-on / accent', '--accent-on', '--accent', 4.5],
  ['成功 ok / surface', '--ok', '--surface', 4.5],
  ['错误 err / surface', '--err', '--surface', 4.5],
  ['警告 warn / surface', '--warn', '--surface', 4.5],
  ['控件描边 line-strong / surface', '--line-strong', '--surface', 3.0],
  ['控件描边 line-strong / surface-2', '--line-strong', '--surface-2', 3.0],
  ['面板外框 line / paper', '--line', '--paper', 2.0],
  ['面板外框 line / surface', '--line', '--surface', 2.0],
  ['行分隔 hairline / surface', '--hairline', '--surface', 1.5],
  ['行分隔 hairline / surface-2', '--hairline', '--surface-2', 1.5],
];

const lines = [];
let fail = 0, pass = 0;

for (const [themeName, T] of [['浅色', LIGHT], ['深色', DARK]]) {
  lines.push(`===== ${themeName} =====`);
  for (const [label, fg, bg, min] of CHECKS) {
    const a = T[fg], b = T[bg];
    if (a === undefined || b === undefined) {
      lines.push(`FAIL  ${fg} 或 ${bg} 在 styles.css 里没定义`);
      fail++;
      continue;
    }
    const r = ratio(a, b);
    if (r === null) { lines.push(`SKIP  ${label}（${a} / ${b} 不是纯色，无法计算）`); continue; }
    const ok = r >= min;
    if (ok) pass++; else fail++;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(6)}  (下限 ${min})  ${label}   ${a} on ${b}`);
  }
  lines.push('');
}

lines.push(`对比度：PASS=${pass} FAIL=${fail}`);
const txt = lines.join('\n');
console.log(txt);
fs.writeFileSync(path.join(__dirname, 'contrast.out'), txt + '\n');
process.exit(fail ? 1 : 0);
