// pdfmd.js —— 把 PDF 的文字版式还原成 Markdown
//
// 设计要点（都是踩过才定下来的）：
//
// 1) 这一层**不认识 pdf.js**。输入是已经抹平的普通对象数组，输出是字符串，
//    不读文件、不碰网络。这样才能像 lib.js 一样被单测覆盖 —— PDF 版式还原的坑
//    几乎全在"行怎么聚、段怎么分、字号怎么定"，用合成数据测比拿真 PDF 测有效得多。
//
// 2) 坐标一律用 **yTop（离页面顶部的距离，越大越靠下）**。PDF 用户空间是原点在
//    左下、y 向上，直接用会在"第一行到底在顶部还是底部"这件事上反复搞错。
//    转换在 pdfimport.js 里做掉。
//
// 3) 字号有两层，都不能想当然：
//    - 行级：**按 item 个数**取众数，不能按字符数。实测有一行
//      `我们跟进 isUrlOrChildUrlOfCurrentEnv 方法：`，标识符 26 个字符是代码字号
//      10.5、中文只有 10 个字符是正文号 12，按字符数算整行会被判成代码。
//    - 文档级：**不能取"字符数最多的字号"**。同一篇文章里代码 10.5 有 5575 字、
//      正文 12 只有 952 字，取众数会把正文判成标题、把代码判成正文，整篇结构反过来。
//      正确做法是先排除小字号（在中位数以上的字号里挑），因为正文一定不是小字号。
//
// 4) **fontFamily 不可信**。Chromium 打印的中文 PDF，pdf.js 把几乎全部字体都报成
//    monospace（字体加载回落的结果），拿它判代码块会整篇误判。版式判断只靠几何量：
//    字号、x、行距。
//
// 5) **康熙部首要归一化**。Chromium/Skia 打印中文 PDF 时，字体映射会把常用字写成
//    U+2F00–U+2FD5 的"康熙部首"：`记⼀次`(U+2F00)、`⽂件`(U+2F42)、`⽤⼾`(U+2F64)。
//    不处理的话导进来整篇是错字，而且**肉眼极难发现**（部首和正字形近：
//    ⼀/一、⽂/文、⽤/用）。映射表来自 Unicode 官方 EquivalentUnifiedIdeograph.txt。
//
// 6) **表格不能靠"这行有几个空隙"认**。正文里偶尔也会出现大空隙，一行的空隙数
//    说明不了什么。真正的信号是**列线**：表格每一列的起点 x 在整页里反复出现
//    （速查手册那种宽表，一条列线会被命中几十次），而正文偶然的大空隙只出现一两次。
//    所以先统计列线、再用列线认表格行。认出来之后每行**自己成一段**，绝不与上下文
//    合并 —— 否则整张宽表会粘成一个巨型段落（那本手册最初的症状就是这样）。
//
// 7) **代码续行的判据是"断点不可能是行尾"，不是"上一行排满了"**。实测反例：
//    某 PDF 里三条独立的 shell 命令（`openssl x509 …` / `openssl x509 …` / `mv …`）
//    都以同一个 x 起头，其中前两条正好排满整行 —— 按"排满了就并"会把三条粘成一条。
//    反过来，"上一行以 `,([{=+…` 收尾 / 这一行以 `)]},;` 起头"才是真的被折断。
//    所以**默认不合并**，只在有正向证据时才合并。
'use strict';

/* ── 部首 → 等价汉字 ────────────────────────────────────────────────────
 * 数据源：https://www.unicode.org/Public/UCD/latest/ucd/EquivalentUnifiedIdeograph.txt
 * 共 341 条，覆盖 CJK 部首补充(U+2E80–U+2EFF) 108 条、康熙部首(U+2F00–U+2FD5) 214 条、
 * CJK 笔画(U+31C0–U+31EF) 19 条。三块都放在下面，都是**程序化从官方文件生成**的，
 * 没有一条是手抄的。康熙块码位连续，所以压成一条 214 字的字符串（第 i 个字对应
 * U+2F00+i）；另外两块稀疏，用显式表。 */
const KANGXI_BASE = 0x2f00;
const KANGXI_CHARS =
  '一丨丶丿乙亅二亠人儿入八冂冖冫几凵刀力勹匕匚匸十卜卩厂厶又口囗土士夂夊夕大女子宀寸小尢尸屮山巛工己巾干幺广廴廾弋弓彐彡彳心戈戶手支攴文斗斤方无日' +
  '曰月木欠止歹殳毋比毛氏气水火爪父爻爿片牙牛犬玄玉瓜瓦甘生用田疋疒癶白皮皿目矛矢石示禸禾穴立竹米糸缶网羊羽老而耒耳聿肉臣自至臼舌舛舟艮色艸虍虫血行' +
  '衣襾見角言谷豆豕豸貝赤走足身車辛辰辵邑酉釆里金長門阜隶隹雨靑非面革韋韭音頁風飛食首香馬骨高髟鬥鬯鬲鬼魚鳥鹵鹿麥麻黃黍黑黹黽鼎鼓鼠鼻齊齒龍龜龠';

const SUP_MAP = {
  0x2E81: '厂', 0x2E82: '乛', 0x2E83: '乚', 0x2E84: '乙', 0x2E85: '亻', 0x2E86: '冂',
  0x2E87: '𠘨', 0x2E88: '刀', 0x2E89: '刂', 0x2E8A: '卜', 0x2E8B: '㔾', 0x2E8C: '小',
  0x2E8E: '兀', 0x2E8F: '尣', 0x2E90: '尢', 0x2E91: '𡯂', 0x2E92: '巳', 0x2E93: '幺',
  0x2E94: '彑', 0x2E95: '𫜹', 0x2E96: '忄', 0x2E97: '心', 0x2E98: '扌', 0x2E99: '攵',
  0x2E9B: '旡', 0x2E9C: '日', 0x2E9D: '月', 0x2E9E: '歺', 0x2E9F: '母', 0x2EA0: '民',
  0x2EA1: '氵', 0x2EA2: '氺', 0x2EA3: '灬', 0x2EA4: '爫', 0x2EA6: '丬', 0x2EA7: '牛',
  0x2EA8: '犭', 0x2EA9: '王', 0x2EAA: '𤴔', 0x2EAB: '目', 0x2EAC: '示', 0x2EAD: '礻',
  0x2EAE: '𥫗', 0x2EAF: '糹', 0x2EB0: '纟', 0x2EB1: '罓', 0x2EB2: '罒', 0x2EB3: '㓁',
  0x2EB4: '冗', 0x2EB5: '𦉫', 0x2EB6: '羊', 0x2EB7: '𦍌', 0x2EB8: '𦍋', 0x2EB9: '耂',
  0x2EBA: '肀', 0x2EBB: '聿', 0x2EBC: '肉', 0x2EBD: '𦥑', 0x2EBE: '艹', 0x2EC1: '虎',
  0x2EC2: '衤', 0x2EC3: '覀', 0x2EC4: '西', 0x2EC5: '见', 0x2EC6: '角', 0x2EC7: '𧢲',
  0x2EC8: '讠', 0x2EC9: '贝', 0x2ECA: '𧾷', 0x2ECB: '车', 0x2ECC: '辶', 0x2ECF: '邑',
  0x2ED0: '钅', 0x2ED1: '長', 0x2ED2: '镸', 0x2ED3: '长', 0x2ED4: '门', 0x2ED5: '𨸏',
  0x2ED6: '阝', 0x2ED7: '雨', 0x2ED8: '青', 0x2ED9: '韦', 0x2EDA: '页', 0x2EDB: '风',
  0x2EDC: '飞', 0x2EDD: '食', 0x2EDE: '𩙿', 0x2EDF: '飠', 0x2EE0: '饣', 0x2EE1: '𩠐',
  0x2EE2: '马', 0x2EE3: '骨', 0x2EE4: '鬼', 0x2EE5: '鱼', 0x2EE6: '鸟', 0x2EE7: '卤',
  0x2EE8: '麦', 0x2EE9: '黄', 0x2EEA: '黾', 0x2EEB: '斉', 0x2EEC: '齐', 0x2EED: '歯',
  0x2EEE: '齿', 0x2EEF: '竜', 0x2EF0: '龙', 0x2EF1: '龜', 0x2EF2: '亀', 0x2EF3: '龟',
};
const STROKE_MAP = {
  0x31C6: '𠃌', 0x31CF: '乀', 0x31D0: '一', 0x31D1: '丨', 0x31D2: '丿', 0x31D4: '丶',
  0x31D5: '𠃍', 0x31D6: '乛', 0x31D7: '𠃊', 0x31D8: '𠃎', 0x31D9: '𠄌', 0x31DA: '亅',
  0x31DB: '𡿨', 0x31DC: '𠃋', 0x31DD: '乀', 0x31DE: '𠃑', 0x31DF: '乚', 0x31E0: '乙',
  0x31E1: '𠄎',
};

/* 只在"这个字在简体中文里根本不会出现"时才转简体。
 * 判据很关键：像 言/金/食/糸/爿/西 这些既是部首、本身也是**简体里正常在用**的字，
 * 绝不能整体替换（把「语言」的言改成讠、把「资金」的金改成钅就是制造新错字）。
 * 而 戶見貝車門長韋頁風飛馬魚鳥鹵麥黃黽齊齒龍龜艸辵 加上日文形的 斉歯竜亀、繁体
 * 部首形的 糹飠镸 —— 这些字在简体中文里根本不出现，所以出现必然是被部首映射污染，
 * 转成简体是安全的。对应关系取自 EquivalentUnifiedIdeograph 与 CJKRadicals 的对照。 */
const TRAD_ONLY = {
  戶: '户', 見: '见', 貝: '贝', 車: '车', 門: '门', 長: '长', 韋: '韦', 頁: '页',
  風: '风', 飛: '飞', 馬: '马', 魚: '鱼', 鳥: '鸟', 鹵: '卤', 麥: '麦', 黃: '黄',
  黽: '黾', 齊: '齐', 齒: '齿', 龍: '龙', 龜: '龟', 艸: '艹', 辵: '辶',
  糹: '纟', 飠: '饣', 镸: '长', 斉: '齐', 歯: '齿', 竜: '龙', 亀: '龟',
};

const RE_RADICAL = /[\u2e80-\u2eff\u2f00-\u2fd5\u31c0-\u31ef]/g;

/** 部首 → 正常汉字。返回 [新串, 修掉几个]。
 *  三类码位各查各的表；查不到就原样留着（宁可留个怪字，也不能乱改）。 */
function normalizeKangxi(text) {
  let n = 0;
  const s = String(text).replace(RE_RADICAL, (ch) => {
    const cp = ch.codePointAt(0);
    let hit;
    if (cp >= 0x2f00 && cp <= 0x2fd5) hit = KANGXI_CHARS[cp - KANGXI_BASE];
    else if (cp >= 0x2e80 && cp <= 0x2eff) hit = SUP_MAP[cp];
    else hit = STROKE_MAP[cp];
    if (!hit) return ch;
    n++;
    return TRAD_ONLY[hit] || hit;
  });
  return [s, n];
}

/* ── 字符分类 ─────────────────────────────────────────────────────────── */
const RE_HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const RE_HAN_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const RE_WIDE_PUNCT = /[\u3000-\u303f\uff01-\uff60\u2018\u2019\u201c\u201d\u2026\u2014\u300a\u300b]/;
const isHan = (ch) => RE_HAN.test(ch);
const isWide = (ch) => RE_HAN.test(ch) || RE_WIDE_PUNCT.test(ch);
const isWordChar = (ch) => /[0-9A-Za-z]/.test(ch);

const q = (n) => Math.round(n * 2) / 2;                       // 字号量化到 0.5，抵掉 11.9999 这类浮点抖动

/* ── 一、把一页的 item 聚成"行" ─────────────────────────────────────────
 * 容差不能写死：字号 12 的文档行距可能只有 10，写死 3 勉强能用；但字号 30 的大标题
 * 里的上标会把同一行拆开。取"本页字号中位数 × 0.4"，两种都照顾到。 */
function buildLines(page) {
  const items = (page.items || []).filter((it) => it && typeof it.text === 'string' && it.text);
  if (!items.length) return [];
  const sizes = items.filter((it) => it.text.trim()).map((it) => it.size).sort((a, b) => a - b);
  const median = sizes.length ? sizes[sizes.length >> 1] : 12;
  const tol = Math.max(1.5, 0.4 * median);

  const sorted = items.slice().sort((a, b) => (a.yTop - b.yTop) || (a.x - b.x));
  const groups = [];
  let cur = null;
  for (const it of sorted) {
    if (!cur || it.yTop - cur.yTop > tol) { cur = { yTop: it.yTop, items: [] }; groups.push(cur); }
    cur.items.push(it);
  }

  const out = [];
  for (const g of groups) {
    /* 有些 PDF 用"把同一段文字画两遍"来假装加粗。不去重的话整行会变成双份字。 */
    const dedup = [];
    for (const it of g.items) {
      const p = dedup[dedup.length - 1];
      if (p && p.text === it.text && Math.abs(p.x - it.x) < 0.4 * it.size) continue;
      dedup.push(it);
    }
    dedup.sort((a, b) => a.x - b.x);
    const text = joinItems(dedup);
    if (!text.trim()) continue;
    const solid = dedup.filter((it) => it.text.trim());
    const size = lineSize(solid);
    const x = Math.min(...solid.map((it) => it.x));
    const xEnd = Math.max(...solid.map((it) => it.x + (it.width || estimateWidth(it.text, size))));
    /* 单元格的行内拼法与整行拼法**不能共用一次 joinItems**，得拆成两步：
     *  - 列边界只从"有字的 item"上算。空白 item 会把间隙算小，容易把两列并成一列。
     *  - 单元格文字则用**全部** item 来拼。显式空格 item 必须保留 —— 直接丢掉它们
     *    再靠"间隙够大才补空格"重算，会把 `less` + `文件名` 粘成 `less文件名`
     *    （实测就是这样，整本手册的英文后都少了一个空格）。 */
    const bounds = [];
    let bPrevEnd = null;
    for (const it of solid) {
      const w = it.width || estimateWidth(it.text, it.size || size);
      if (bPrevEnd == null || it.x - bPrevEnd > 0.85 * (it.size || size)) bounds.push(it.x);
      bPrevEnd = it.x + w;
    }
    const buckets = bounds.map((bx) => ({ x: bx, items: [] }));
    for (const it of dedup) {
      let bi = 0;
      for (let k = 0; k < bounds.length; k++) if (it.x >= bounds[k] - 0.01) bi = k;
      buckets[bi].items.push(it);
    }
    const cells = buckets.map((b) => ({ x: b.x, text: joinItems(b.items, true) })).filter((c) => c.text);
    out.push({
      page: page.num, yTop: g.yTop, x, xEnd, size, text,
      cols: cells.length - 1, cells, width: page.width, height: page.height,
    });
  }
  return out;
}

/** 一行的字号：按 **item 个数** 取众数（理由见文件头第 3 条）。平局倒向大字号。 */
function lineSize(items) {
  const w = new Map();
  for (const it of items) { const s = q(it.size); w.set(s, (w.get(s) || 0) + 1); }
  let best = items[0] ? q(items[0].size) : 12, bn = -1;
  for (const [s, n] of [...w].sort((a, b) => a[0] - b[0])) if (n > bn) { bn = n; best = s; }
  return best;
}

/** 文档级正文字号。
 *
 * 这个判据被实测反例逼着改过两轮，三个反例都来自本机的真实 PDF：
 *   A) 只取"字符数最多的字号"：代码审计那篇里代码字号 10.5 有 5575 字、正文 12 只有
 *      952 字（代码块比正文还长），于是**正文被判成标题、代码被判成正文**，整篇反过来。
 *   B) 只取"不小于中位数的字号里字最多的"：速查手册那本只有 9（全部表格）与 18（标题）
 *      两档，中位数落在 18，结果**整张表被判成代码块**。
 *   C) 两档的文档里若正文恰是较小那档（比如"大标题 + 正文"没有代码），上一版同样会翻车。
 *
 * 所以最后的判据是：先取字符数众数当基线，再看有没有"体量也够大的、稍大一点的字号"
 * —— 有就升上去（解决 A/C），但**用 1.18 倍封顶**（不把大号引文/标题当正文，解决 B）。
 * "体量够大"用行数占比 ≥8% 衡量，避免被一两行大号字带跑。
 */
function bodySizeOf(lines) {
  const chars = new Map(), cnt = new Map();
  for (const L of lines) {
    const s = q(L.size);
    chars.set(s, (chars.get(s) || 0) + L.text.replace(/\s/g, '').length);
    cnt.set(s, (cnt.get(s) || 0) + 1);
  }
  const uniq = [...chars.keys()].sort((a, b) => a - b);
  if (!uniq.length) return 12;
  let mode = uniq[0], mn = -1;
  for (const [s, n] of chars) if (n > mn) { mn = n; mode = s; }
  const floor = lines.length * 0.08;
  let best = mode;
  for (const s of uniq) if (s > best && s <= mode * 1.18 + 0.01 && (cnt.get(s) || 0) >= floor) best = s;
  return best;
}

function estimateWidth(text, size) {
  let w = 0;
  for (const ch of text) w += isWide(ch) ? size : size * 0.5;
  return w;
}

/** 一行/一格之内把 item 拼起来。空隙大到一定程度才补空格：正常词间距 0.28em，
 *  而**列间距**（表格、被排版拉开的 CJK）给到 0.85em —— 只有明显是"两栏"
 *  才插空格，免得把逐字排版的中文拆出一堆空格。
 *
 *  `tight` 为真时先压掉 item **内部**被排版撑出来的空格（判据见 tightenItem）。
 *  只在表格单元格里用：item 之间的空格是真空格，绝不能压。 */
function joinItems(items, tight) {
  let out = '', prevEnd = null;
  for (const it of items) {
    const t = tight ? tightenItem(it) : it.text;
    const size = it.size || 12;
    if (out && prevEnd != null && !/\s$/.test(out) && !/^\s/.test(t)) {
      const gap = it.x - prevEnd;
      const a = out.slice(-1), b = t[0];
      const need = (!isWide(a) && !isWide(b)) ? 0.28 * size : 0.85 * size;
      if (gap > need) out += ' ';
    }
    out += t;
    prevEnd = it.x + (it.width || estimateWidth(t, size));
  }
  return out.replace(/[ \t\u00a0]+/g, ' ').replace(/^ +| +$/g, '');
}

/* ── 二、剔除页眉页脚 ───────────────────────────────────────────────────
 * **只能靠"重复"判，不能靠"位置"判。** 实测教训：审计那篇 PDF 的正文一直排到页面
 * 最底部（yTop=744，页高 792），按"底部 10% 就是页脚"来删会把真内容删掉。
 * 判据是：出现在 ≥50% 页面上、且**去掉数字后字面相同**的行 —— 正文不可能跨页逐字重复。
 * 数字先归一成 #，这样"第 3 页 / 第 4 页"算同一条。 */
function stripRunningHeads(lines, pageCount) {
  if (pageCount < 3) return { lines, dropped: 0 };
  const key = (t) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const inBand = (L) => L.yTop < L.height * 0.15 || L.yTop > L.height * 0.85;
  const seen = new Map();
  for (const L of lines) {
    if (!inBand(L)) continue;                              // 不在页边，一律不动
    const t = L.text.trim();
    /* 单个非数字字符不参与"重复"判定。听起来多余，但实测过：某本速查手册是宽表格，
       单元格 `文件管理` 折成 `文 件 管` / `理` 两行，于是"理"这个单字在一页里合法地
       出现了 45 次。只要求"重复"的话它会被当成页眉。 */
    if (t.length < 2 && !/^[\d\s\-–—_·.]+$/.test(t)) continue;
    const k = key(t);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(L.page);
  }
  const need = Math.max(2, Math.ceil(pageCount * 0.5));
  const kill = new Set([...seen].filter(([, s]) => s.size >= need).map(([k]) => k));
  if (!kill.size) return { lines, dropped: 0 };
  /* **只删"自己就在页边带里"的行。**
     不能拿在页边发现的那个键去删全文 —— 同一个键在页面中部完全可能是正文。
     （就是这一条把上面那本手册的 91 行正文删没了。） */
  const kept = lines.filter((L) => !(inBand(L) && kill.has(key(L.text))));
  return { lines: kept, dropped: lines.length - kept.length };
}

/* ── 三、判行类型 ─────────────────────────────────────────────────────── */
const BULLET_RE = /^([•·‣▪◦●○∙⋅⁃]|\*(?=\s))\s*/;
const DASH_RE = /^[-–—]\s+/;
/* 有序列表的标记后面**不能紧跟数字**，否则 `1.2.3.4:80` 这种会被当成"第 1 条"，
   整行变成 `1. 2.3.4:80…`。实测那篇审计文章里正好有 `1.2.3.4:80#x.example.com`。 */
const ORDER_RE = /^(\d{1,3}|[a-zA-Z])[.)](?![0-9])\s*/;
const CN_ORDER_RE = /^(\d{1,3}|[a-zA-Z])[、）](?!\d)\s*/;
const PAREN_ORDER_RE = /^[(（](\d{1,3}|[a-zA-Z])[)）](?!\d)\s*/;
const CN_NUM_ORDER_RE = /^[一二三四五六七八九十]{1,3}[、.)）](?!\d)\s*/;
const TASK_RE = /^([☐☑✓✔✗✘])\s*/;

function listInfo(text) {
  let m;
  if ((m = TASK_RE.exec(text))) return { kind: 'task', done: /[☑✓✔]/.test(m[1]), body: text.slice(m[0].length) };
  if ((m = BULLET_RE.exec(text))) return { kind: 'bullet', body: text.slice(m[0].length) };
  if ((m = DASH_RE.exec(text))) return { kind: 'bullet', body: text.slice(m[0].length) };
  if ((m = ORDER_RE.exec(text))) return { kind: 'ordered', body: text.slice(m[0].length) };
  if ((m = CN_ORDER_RE.exec(text))) return { kind: 'ordered', body: text.slice(m[0].length) };
  if ((m = PAREN_ORDER_RE.exec(text))) return { kind: 'ordered', body: text.slice(m[0].length) };
  if ((m = CN_NUM_ORDER_RE.exec(text))) return { kind: 'ordered', body: text.slice(m[0].length) };
  return null;
}

const TERMINAL = /[。！？；.!?;：:”"』」）)]$/;
const NO_HEAD_TAIL = /[，,、；;：:。.]$/;                 // 以这些收尾的多半不是标题
const OPEN_TAIL = /[([{<]$/;
const CLOSE_HEAD = /^[)\]},;.>]/;

/* 代码续行的**正向**证据（见文件头第 7 条）：默认不合并，只有这几条命中才并。
 * 反过来用（"上一行没排满就说明断了"）会在 shell 命令上翻车。
 * 字符集里**故意不放 `/` `*` `?` `:`** —— 它们出现在 shell 行尾太正常了
 * （`cp a /b/`、`rm *`），放进来会把两条独立命令粘起来（实测踩过）。 */
const CODE_OPEN_TAIL = /[({\[,=+\-\\%&|<>]$/;
const CODE_CLOSE_HEAD = /^[)\]},;]/;
/* 以这些词收尾的行不可能是完整的一行（`= new` / `return` / `import`）。
 * 只列**shell 里不会出现在行尾**的 —— 像 `in` / `do` / `as` 就不能放进来，
 * 否则 `for i in a b c` 会被当成折断。 */
const CODE_OPEN_WORD = /\b(new|return|throw|throws|else|case|extends|implements|instanceof|lambda|yield|await|assert|del|import|from)$/;

/* PDF 里"被排版拉开的汉字"会被写成一个**内部带空格的 item**。实测手册那一行：
 *   `文 件 管`   宽 32.5 = 3 个汉字 27 + 2 个空档 5.5 → 每个空档 0.31em（排版撑出来的）
 *   `文件名 文件名` 宽 58.5 = 6 个汉字 54 + 1 个空档 4.5 → 每个空档 0.50em（真空格）
 * 所以判据是**空档宽度**：窄于 0.42em 的空档是排版撑的，压掉；宽的留着。
 * 光看文字形状分不出来 —— 两串都是"汉字中间夹空格"，压错了 `文件名 文件名`
 * 会变成 `文件名文件名`（这个坑真踩过）。只在单元格里做，正文不动。 */
const SPACE_ARTIFACT = 0.42;
function tightenItem(it) {
  const t = it.text;
  if (!t || t.indexOf(' ') < 0) return t;
  const size = it.size || 12;
  let wide = 0, sp = 0;
  for (const ch of t) {
    if (ch === ' ') sp++;
    else if (isWide(ch)) wide++;
    else return t;                     // 混了西文就不猜，宁可留着空格
  }
  if (!sp || !wide || !it.width) return t;      // 纯空白 item 是分隔符，交给 joinItems 管
  return (it.width - wide * size) / sp < SPACE_ARTIFACT * size ? t.replace(/ /g, '') : t;
}

/* ── 四、主流程 ───────────────────────────────────────────────────────── */
function toMarkdown(pages, options) {
  const opt = Object.assign({ title: '' }, options || {});
  const stats = { pages: pages.length, lines: 0, chars: 0, headings: 0, lists: 0, codeBlocks: 0, dropped: 0, kangxi: 0 };

  const all = [];
  for (const p of pages) all.push(...buildLines(p));
  const { lines, dropped } = stripRunningHeads(all, pages.length);
  stats.dropped = dropped;
  stats.lines = lines.length;
  if (!lines.length) return { title: normalizeKangxi(opt.title || '')[0], markdown: '', stats };

  const bodySize = bodySizeOf(lines);

  /* 左边界：正文最常见的起始 x。首行缩进判断靠它。 */
  const leftX = (() => {
    const w = new Map();
    for (const L of lines) { const x = Math.round(L.x); w.set(x, (w.get(x) || 0) + 1); }
    let best = 0, bn = -1;
    for (const [x, n] of w) if (n > bn) { bn = n; best = x; }
    return best;
  })();

  /* 行距基准：同一页内、贴着左边界、正文字号的相邻行间距的中位数。 */
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (a.page !== b.page) continue;
    if (Math.abs(a.size - bodySize) > 0.6 || Math.abs(b.size - bodySize) > 0.6) continue;
    if (Math.abs(a.x - leftX) > bodySize * 0.5 || Math.abs(b.x - leftX) > bodySize * 0.5) continue;
    const g = b.yTop - a.yTop;
    if (g > 0.5) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[gaps.length >> 1] : bodySize * 1.5;
  const p90Gap = gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.9))] : medianGap;
  /* 文档用"段间空一行"还是"首行缩进"来分段，决定了段边界怎么判。 */
  const gapBased = gaps.length >= 6 && p90Gap > medianGap * 1.25;

  /* 标题字号分档：比正文大 10% 以上才算标题，从大到小依次对应 # ## ### #### */
  const headSizes = [...new Set(lines.map((L) => q(L.size)).filter((s) => s >= bodySize * 1.1))].sort((a, b) => b - a);

  /* 标题先行抽取：第 1 页靠上、字号最大的那行。抽到之后正文里的标题要整体降一级
     （H1 留给 front-matter 的 title），并且开头的重复 H1 要删掉。 */
  const firstPageHeads = lines.filter((L) => L.page === 1 && L.yTop < L.height * 0.4 && q(L.size) === headSizes[0]);
  let title = opt.title || (firstPageHeads.length ? firstPageHeads[0].text : '');
  const shift = title ? 1 : 0;

  /* 列表缩进层级：把列表行的 x 聚成几档 */
  const listXs = lines.filter((L) => listInfo(L.text)).map((L) => L.x).sort((a, b) => a - b);
  const listCluster = [];
  for (const x of listXs) {
    const last = listCluster[listCluster.length - 1];
    if (last && x - last[last.length - 1] < bodySize * 0.9) last.push(x);
    else listCluster.push([x]);
  }
  const listLevels = listCluster.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
  const levelOf = (x) => {
    let best = 0, bd = 1e9;
    listLevels.forEach((v, i) => { const d = Math.abs(v - x); if (d < bd) { bd = d; best = i; } });
    return Math.min(best, 4);
  };

  /* 代码块：字号明显小于正文的行。**成段（≥2 行）才算** —— 单行小字号往往只是
   * 行内代码被单独排了一行，围成代码块反而打断阅读；顺带兜住版式判断偶发失灵。 */
  const isCode = (L) => L.size < bodySize * 0.93 && L.text.trim().length > 0;

  /* ── 表格识别（见文件头第 6 条）──────────────────────────────────────
   * 先把"多列行"的每一格起点 x 聚成**列尺**，只保留反复出现（≥3 次）的列线；
   * 再用列尺认表格行：一行要命中至少两条列线才算。
   * 整篇至少得有 3 行才算数，免得正文里一两句偶然带大空隙的句子被拆出来。 */
  const rulerTol = Math.max(4, bodySize * 1.6);
  const ruler = (() => {
    const xs = [];
    for (const L of lines) if (L.cols >= 2) for (const c of L.cells) xs.push(c.x);
    if (!xs.length) return [];
    xs.sort((a, b) => a - b);
    const bands = [];
    for (const x of xs) {
      const b = bands[bands.length - 1];
      if (b && x - b.hi <= rulerTol) { b.n++; b.hi = x; }
      else bands.push({ n: 1, lo: x, hi: x });
    }
    return bands.filter((b) => b.n >= 3).map((b) => b.lo);
  })();
  const onRuler = (x) => ruler.some((b) => Math.abs(x - b) <= rulerTol);
  const looksRow = (L) => !!L.cells && L.cols >= 2 && L.cells.filter((c) => onRuler(c.x)).length >= 2;
  const tableRows = lines.filter(looksRow).length;
  const isTable = tableRows >= 3 ? looksRow : () => false;
  /* 表格单元格折行的行距上限：窄列里的长文本会被排到下一行（`文 件 管` + `理`）。 */
  const rowGapMax = Math.max(medianGap, bodySize) * 1.6;

  const out = [];
  let para = [], codeRun = [], listOpen = false, lastEmitted = null;

  const flushPara = () => {
    if (!para.length) return;
    const t = joinLines(para);
    if (t) { out.push(t); lastEmitted = para[para.length - 1]; }
    para = [];
  };
  /* 表格行缓存：一行要等它的折行格子续上来（`文 件 管` + `理`）才算定稿。 */
  let trow = null;
  const flushRow = () => {
    if (!trow) return;
    const txt = trow.cells.map((c) => c.text).filter((t) => t).join('  ');
    if (txt) out.push(txt);
    trow = null;
    lastEmitted = null;                                   // 表格后面不接"把正文折行续上"的活
  };
  /* 表格单元格的折行：窄列里的长文本会被排到下一行。行首正好落在上一行某一格的
     列线上，就认定它是那一格的续行，塞回去（`文 件 管` + `理` → `文件管理`）。 */
  const mergeIntoRow = (L) => {
    if (!trow || !L.cells || L.cols > 1) return false;
    if (L.page !== trow.page || L.yTop - trow.yTop > rowGapMax) return false;
    let hit = 0;
    for (const c of L.cells) {
      let bi = -1, bd = rulerTol;
      trow.cells.forEach((t, i) => { const d = Math.abs(t.x - c.x); if (d < bd) { bd = d; bi = i; } });
      if (bi >= 0) { trow.cells[bi].text += c.text; hit++; }
    }
    if (hit) trow.yTop = L.yTop;
    return hit > 0;
  };

  const flushCode = () => {
    if (!codeRun.length) return;
    /* 单行小字号不围代码块（理由见上）。而且也不能把它当成一个独立段落推出去 ——
       实测有些 PDF 同一段正文里字号会在 10 和 9 之间来回跳，孤立成段会把整段切碎。
       所以把它**交回正文流**：能给上一段续上就续上。 */
    if (codeRun.length < 2) {
      const one = codeRun[0];
      codeRun = [];
      const prevOut = out[out.length - 1];
      if (prevOut && lastEmitted && lastEmitted.page === one.page &&
          one.yTop - lastEmitted.yTop <= medianGap * 1.6 && !TERMINAL.test(prevOut)) {
        out[out.length - 1] = joinTwo(prevOut, one.text);
        lastEmitted = one;
      } else para.push(one);
      return;
    }
    /* 代码在 PDF 里一样会被**软换行**，硬按行还原会多出断行的假语句。
       但判据只能是"这个断点不可能是行尾"：上一行以 `,([{=+…` 或 `new`/`return`
       这类词收尾，或这一行以 `)]},;` 起头。**默认不合并** —— 反过来用会在 shell
       命令上翻车（实测有 PDF 里三条独立命令都以同一个 x 起头，其中前两条正好排满
       整行，按"排满了就是续行"会把三条粘成一条）。 */
    const minX = Math.min(...codeRun.map((L) => L.x));
    const size = codeRun[0].size;
    const merged = [];
    for (const L of codeRun) {
      const prev = merged[merged.length - 1];
      const broken = prev && (CODE_OPEN_TAIL.test(prev.text) || CODE_OPEN_WORD.test(prev.text));
      const wrapped = prev && L.x <= minX + size * 0.7 && (broken || CODE_CLOSE_HEAD.test(L.text));
      if (wrapped) prev.text = joinPieces(prev.text, L.text);
      else merged.push({ x: L.x, text: L.text });
    }
    const colw = Math.max(2, size * 0.55);                // 等宽字一个字符大约 0.55em
    const text = merged.map((L) => ' '.repeat(Math.max(0, Math.round((L.x - minX) / colw))) + L.text).join('\n');
    const fence = text.includes('```') ? '~~~~' : '```';
    out.push(fence + guessLang(text) + '\n' + text + '\n' + fence);
    stats.codeBlocks++;
    lastEmitted = null;
    codeRun = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], prev = lines[i - 1];

    if (isCode(L)) { flushPara(); flushRow(); listOpen = false; codeRun.push(L); continue; }
    flushCode();

    /* 表格行自己成一行，**绝不与上下文合并** —— 否则整张宽表会粘成一个巨型段落。 */
    if (isTable(L)) {
      flushPara(); flushRow(); listOpen = false;
      trow = { page: L.page, yTop: L.yTop, cells: L.cells.map((c) => ({ x: c.x, text: c.text })) };
      continue;
    }
    /* 上一行是表格行、这一行落在它的列线上 → 是某一格的续行，塞回去。 */
    if (trow && mergeIntoRow(L)) continue;
    flushRow();

    const li = listInfo(L.text);
    if (li) {
      flushPara();
      const pad = '  '.repeat(levelOf(L.x));
      if (li.kind === 'task') out.push(`${pad}- [${li.done ? 'x' : ' '}] ${li.body}`);
      else if (li.kind === 'ordered') out.push(`${pad}1. ${li.body}`);
      else out.push(`${pad}- ${li.body}`);
      stats.lists++;
      listOpen = true;
      lastEmitted = null;                                 // 列表项后面不接"折行续上"的活
      continue;
    }

    const hl = hlLevel(L, headSizes, bodySize, shift);
    if (hl) {
      flushPara(); listOpen = false;
      out.push('#'.repeat(hl) + ' ' + L.text.replace(/\s+$/, ''));
      stats.headings++;
      lastEmitted = null;                                 // 标题后面同理，不能把正文并进标题
      continue;
    }

    /* 列表项的折行：上一行是列表项、没以句末标点收尾、行距也是正常行距 → 接着写。
       不做这一步，一个折成两行的列表项会变成"列表项 + 一个孤立段落"。 */
    if (listOpen && prev && out.length) {
      const sameFlow = prev.page === L.page && (L.yTop - prev.yTop) <= medianGap * 1.35;
      if (sameFlow && !TERMINAL.test(prev.text)) {
        out[out.length - 1] = joinTwo(out[out.length - 1], L.text);
        continue;
      }
      listOpen = false;
    }

    /* 正文行 —— 判"要不要另起一段" */
    let newPara = !para.length;
    if (!newPara && prev) {
      const crossPage = prev.page !== L.page;
      const gap = crossPage ? Infinity : (L.yTop - prev.yTop);
      const prevShort = prev.xEnd < (prev.width || L.width) - bodySize * 2.5;
      if (crossPage) {
        /* 跨页：上一页最后一行若以句末标点收尾就是段落结束，否则认为这句被页面切断。 */
        newPara = TERMINAL.test(prev.text) || prevShort;
      } else if (gapBased) {
        newPara = gap > medianGap * 1.35;
      } else {
        newPara = (L.x - leftX) > bodySize * 1.2 || (TERMINAL.test(prev.text) && prevShort);
      }
    }
    if (newPara) flushPara();
    para.push(L);
  }
  flushCode(); flushRow(); flushPara();

  /* 开头的重复 H1（标题已经单独抽出来了）删掉，别让 md 一上来就重复一遍。
     注意要**同时把统计里的标题数减回去** —— 这一行是先当标题发出去、再被删掉的，
     不减的话正文里明明只有 1 个 H2，界面却报"标题 2 个"。 */
  if (title) {
    const first = out[0] || '';
    if (first.replace(/^#+\s*/, '').trim() === title.trim()) { out.shift(); stats.headings--; }
  }

  let md = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  if (md === '\n') md = '';
  const [clean, kn] = normalizeKangxi(md);
  stats.kangxi = kn;
  stats.chars = countChars(clean);
  return { title: normalizeKangxi(String(title).trim())[0], markdown: clean, stats };
}

/** 行 → 标题级别。字号够大、够短、不以逗号收尾，三者都满足才算标题。 */
function hlLevel(L, headSizes, bodySize, shift) {
  const s = q(L.size);
  if (s < bodySize * 1.1) return 0;
  if (L.text.length > 90) return 0;
  if (NO_HEAD_TAIL.test(L.text)) return 0;
  const idx = headSizes.indexOf(s);
  return Math.min(Math.max((idx < 0 ? 1 : idx + 1) + (shift || 0), 2), 6);
}

/** 两段文字的接法：中文直接接、英文补空格、行尾连字符回接。
 *  段内换行和列表项折行都用它，避免两处规则走偏。 */
function joinTwo(a, b) {
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.replace(/-$/, '') + b;
  const x = a.slice(-1), y = b[0];
  return a + ((isWordChar(x) && isWordChar(y)) ? ' ' + b : b);
}

/** 段内多行拼成一句 */
function joinLines(list) {
  let s = list[0].text;
  for (let i = 1; i < list.length; i++) s = joinTwo(s, list[i].text);
  return s.replace(/\s+([，。！？；：、）】》”])/g, '$1').replace(/([（【《“])\s+/g, '$1').trim();
}

/** 代码续行的拼接：贴着括号/标点接，其余补一个空格。
 *  `Integer` + `fileSourceId,` → 空格；`getXxx(` + `);` → 直接接。 */
function joinPieces(a, b) {
  if (OPEN_TAIL.test(a) || CLOSE_HEAD.test(b)) return a + b;
  return a + ' ' + b;
}

function guessLang(code) {
  if (/^\s*(#!\/|sudo\s|\$\s)/m.test(code)) return 'bash';
  if (/\b(def|import|from)\s+\w+|print\(/.test(code)) return 'python';
  if (/<[a-z]+[^>]*>/.test(code) && /<\/[a-z]+>/.test(code)) return 'html';
  if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(code)) return 'sql';
  if (/\b(function|const|let|var|=>)\b/.test(code)) return 'javascript';
  if (/\b(public|private|protected)\s+(static\s+)?\w+\s+\w+\s*\(/.test(code)) return 'java';
  return '';
}

function countChars(text) {
  const han = (text.match(RE_HAN_G) || []).length;
  const latin = (text.replace(RE_HAN_G, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’._-]*/g) || []).length;
  return han + latin;
}

module.exports = {
  toMarkdown, normalizeKangxi, buildLines, bodySizeOf, lineSize, joinItems,
  KANGXI_BASE, KANGXI_CHARS, SUP_MAP, STROKE_MAP, TRAD_ONLY,
};
