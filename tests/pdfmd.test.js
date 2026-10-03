/* PDF → Markdown 转换内核的单测（pdfmd.js）
 *
 *   node tests/pdfmd.test.js
 *
 * 为什么给 pdfmd.js 写单测、而不是拿真 PDF 测：
 *   - pdfmd.js 被刻意设计成"不认识 pdf.js"——输入是抹平后的普通 item 数组、输出是字符串，
 *     所以"行怎么聚、段怎么分、字号怎么定、表格怎么认"这些真正容易出错的判断，
 *     用合成数据测比拿真 PDF 测**有效得多**（合成数据能精确控制几何量）。
 *   - 真实 PDF 只用来做端到端验收（见 tests/e2e.js 的 PDF 一节），起"别只在玩具数据上对"的作用。
 *
 * 下面每个反例都是从本机真实 PDF 上踩出来的，注释里写了它是怎么翻车的 —— 别删。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pdfmd = require('../src/pdfmd');

/* ── 造数据的小工具 ─────────────────────────────────────────────────────
 * width 很重要（列切分和"排版撑出来的空格"都靠它），默认按 CJK 一个全角、
 * 其余半角估一个，需要时显式传。 */
const RE_WIDE = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const wEst = (t, s) => [...t].reduce((n, ch) => n + (RE_WIDE.test(ch) ? s : s * 0.5), 0);
const it = (text, x, yTop, size, width) => ({
  text, x, yTop, size, width: width == null ? wEst(text, size) : width, eol: false,
});
const pg = (num, items, width = 595, height = 842) => ({ num, width, height, items });
const md = (pages, title) => pdfmd.toMarkdown(pages, { title: title || '' }).markdown;
const run = (pages, title) => pdfmd.toMarkdown(pages, { title: title || '' });

/* ══ 1. 康熙部首归一化 ══════════════════════════════════════════════════ */

test('康熙部首：214 个连续码位一个不漏地落回汉字', () => {
  assert.equal(pdfmd.KANGXI_CHARS.length, 214, 'KANGXI_CHARS 必须正好覆盖 U+2F00–U+2FD5');
  let s = '';
  for (let cp = 0x2f00; cp <= 0x2fd5; cp++) s += String.fromCodePoint(cp);
  const [out, n] = pdfmd.normalizeKangxi(s);
  assert.equal(n, 214);
  assert.equal(/[\u2f00-\u2fd5]/.test(out), false, '归一化后不该再剩部首码位');
  assert.equal(out[0], '一', 'U+2F00 是一');
  assert.equal(out[out.length - 1], '龠', 'U+2FD5 是龠');
});

test('康熙部首：真 PDF 抽出来的那三个词要修对', () => {
  /* Chromium/Skia 打印的中文 PDF 会把常用字写成"形近的部首"，肉眼极难发现：
     ⼀/一、⽂/文、⽤/用 长得几乎一样，漏了整篇就是错字。 */
  assert.equal(pdfmd.normalizeKangxi('记⼀次')[0], '记一次');
  assert.equal(pdfmd.normalizeKangxi('⽂件源')[0], '文件源');
  assert.equal(pdfmd.normalizeKangxi('⽤⼾')[0], '用户');
});

test('康熙部首：补充块能跨块映射（⻔ U+2ED4 → 门）', () => {
  /* 补充块在 U+2E80–U+2EFF，和康熙块(U+2F00–)不是同一段。
     最早那版手写表只覆盖了康熙块，`⻔`(U+2ED4) 掉在缝里没被修 —— 所以这条要留着。 */
  assert.equal(pdfmd.normalizeKangxi('\u2ed4')[0], '门');
  assert.equal(pdfmd.normalizeKangxi('\u2e9f')[0], '母');
});

test('简繁判据：本身是简体常用字的部首绝不能被简化', () => {
  /* 判据是"这个字在简体中文里根本不会出现"才转。言/金/食 这几个既是部首、
     本身也是简体里正常在用的字 —— 把「语言」的言改成讠就是**制造新错字**。 */
  const values = [];
  for (let cp = 0x2f00; cp <= 0x2fd5; cp++) values.push(pdfmd.normalizeKangxi(String.fromCodePoint(cp))[0]);
  for (const keep of ['言', '金', '食', '片']) {
    assert.equal(values.includes(keep), true, `⾔/⾦/⾷ 这类要留成 ${keep}，不能简化成偏旁`);
  }
  /* 反过来：只在繁体里出现的部首必须转简体，否则整篇是繁体字 */
  assert.equal(pdfmd.normalizeKangxi('\u2f3e')[0], '户', '⼾ → 户（不是 戶）');
  assert.equal(pdfmd.normalizeKangxi('\u2f8f')[0], '行', '⾏ 本来就是 行');
});

test('归一化不碰无关字符', () => {
  const [out, n] = pdfmd.normalizeKangxi('abc，中文 123');
  assert.equal(out, 'abc，中文 123');
  assert.equal(n, 0);
});

/* ══ 2. 行聚类 / 字号 ═══════════════════════════════════════════════════ */

test('buildLines：同一行按 yTop 聚起来、把重复绘制去重、拼成一行', () => {
  const items = [
    it('Hello', 50, 100, 12),
    it('World', 84, 100.4, 12),
    it('Hello', 50, 100.1, 12),          // 假装加粗：同一段文字画两遍
    it('第二行', 50, 130, 12),
  ];
  const lines = pdfmd.buildLines(pg(1, items));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'Hello World');
  assert.equal(lines[1].text, '第二行');
});

test('lineSize：按 item 个数取众数，不能按字符数', () => {
  /* 实测反例：`我们跟进 isUrlOrChildUrlOfCurrentEnv 方法：` 这行里
     标识符 26 个字符是代码字号 10.5、中文只有 10 个字符是正文号 12。
     按字符数算整行会被判成代码行，整段结构就反了。 */
  const items = [
    it('isUrlOrChildUrlOfCurrentEnv', 50, 100, 10.5),
    it('方法', 200, 100, 12),
    it('我们跟进', 50, 130, 12),
    it('xxx', 120, 130, 12),
  ];
  const lines = pdfmd.buildLines(pg(1, items));
  assert.equal(lines[0].size, 10.5, '这一行 1 个 item 是 10.5、2 个是 12 → 平局倒向大字号？');
  assert.equal(pdfmd.lineSize([{ size: 10.5 }, { size: 10.5 }, { size: 12 }]), 10.5);
  assert.equal(pdfmd.lineSize([{ size: 10.5 }, { size: 12 }, { size: 12 }]), 12);
});

test('bodySizeOf：代码比正文还长时，不能把正文判成标题', () => {
  /* 反例 A：审计那篇里代码字号 10.5 有 5575 字、正文 12 只有 952 字。
     只取"字符数最多的字号"→ 正文被判成标题、代码被判成正文，整篇反过来。 */
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push({ size: 10.5, text: 'a'.repeat(90) });   // 5400 字
  for (let i = 0; i < 12; i++) lines.push({ size: 12, text: '中'.repeat(60) });     // 720 字，但占 16% 行
  assert.equal(pdfmd.bodySizeOf(lines), 12);
});

test('bodySizeOf：两档文档里正文就是小的那档时也要认对', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push({ size: 9, text: '中'.repeat(40) });
  for (let i = 0; i < 6; i++) lines.push({ size: 10, text: '中'.repeat(20) });
  assert.equal(pdfmd.bodySizeOf(lines), 10, '10 只比 9 大 11%，且行数够多 → 正文是 10');
});

test('bodySizeOf：1.18 倍封顶，别把大号标题当成正文', () => {
  /* 反例 B：速查手册那本只有 9（整张表）和 18（标题）两档。
     不封顶的话正文会取到 18，然后 9pt 的整张表被判成"小字号代码块"。 */
  const lines = [];
  for (let i = 0; i < 80; i++) lines.push({ size: 9, text: '中'.repeat(30) });
  for (let i = 0; i < 4; i++) lines.push({ size: 18, text: '大标题' });
  assert.equal(pdfmd.bodySizeOf(lines), 9);
});

test('bodySizeOf：空文档给个安全默认值', () => {
  assert.equal(pdfmd.bodySizeOf([]), 12);
});

/* ══ 3. 页眉页脚 ════════════════════════════════════════════════════════ */

test('页眉页脚：只删"自己就在页边带里"的重复行，不动正文', () => {
  /* 这是踩得最狠的一个坑：某本手册的正文一直排到页面最底部，
     按"底部 10% 就是页脚"会把真内容删掉；而"发现某个键重复就拿去删全文"
     又因为 `文件管理` 折行出的单字 `理` 在一页里合法出现 45 次而删了 91 行正文。 */
  const pages = [];
  for (let p = 1; p <= 4; p++) {
    pages.push(pg(p, [
      it('某手册 · 第 ' + p + ' 页', 50, 20, 9),      // 页眉，在页边带里
      it('正文内容甲', 50, 400, 12),
      it('正文内容乙', 50, 420, 12),
      it('某手册 · 第 ' + p + ' 页', 50, 800, 9),     // 页脚，也在页边带里
    ]));
  }
  const r = run(pages);
  assert.equal(r.stats.dropped, 8, '4 页 × 2 条页眉页脚都要去掉');
  assert.equal(/某手册/.test(r.markdown), false);
  assert.match(r.markdown, /正文内容甲/);
});

test('页眉页脚：正文里出现和页眉一样的字眼时不能被误删', () => {
  const pages = [];
  for (let p = 1; p <= 4; p++) {
    pages.push(pg(p, [
      it('页眉甲', 50, 20, 9),
      it('页眉甲', 50, 400, 12),        // 页面中部：是正文，不能删
    ]));
  }
  const r = run(pages);
  assert.equal(r.stats.dropped, 4, '只删页面顶部那 4 条');
  assert.match(r.markdown, /页眉甲/);
});

test('页眉页脚：页数太少时不做剔除（没什么可"重复"的）', () => {
  const pages = [pg(1, [it('页眉', 50, 20, 9), it('正文', 50, 400, 12)])];
  assert.equal(run(pages).stats.dropped, 0);
});

/* ══ 4. 行内空格：排版撑出来的 vs 真的 ══════════════════════════════════ */

test('joinItems：正常词间距不插空格，列间距才插', () => {
  /* 逐字排版的中文如果每个字之间都插空格，整段就废了。 */
  const items = [it('中', 50, 100, 12), it('文', 62, 100, 12), it('字', 74, 100, 12)];
  assert.equal(pdfmd.joinItems(items), '中文字');
  const far = [it('中文', 50, 100, 12), it('远', 160, 100, 12)];
  assert.equal(pdfmd.joinItems(far), '中文 远');
});

test('表格单元格：排版撑出来的窄空档要压掉，真的空格要留着', () => {
  /* 实测的两条真数据（速查手册第 1 页）：
   *   `文 件 管`   宽 32.5 = 3 个汉字 27 + 2 个空档 5.5 → 每档 0.31em（排版撑的，要压）
   *   `文件名 文件名` 宽 58.5 = 6 个汉字 54 + 1 个空档 4.5 → 每档 0.50em（真的，要留）
   * 光看文字形状分不出来，两串都是"汉字中间夹空格"；只能量空档宽度。 */
  const narrow = pdfmd.joinItems([it('文 件 管', 67, 100, 9, 32.5)], true);
  const real = pdfmd.joinItems([it('文件名 文件名', 67, 100, 9, 58.5)], true);
  assert.equal(narrow, '文件管');
  assert.equal(real, '文件名 文件名');
});

test('表格单元格：纯空白的分隔 item 不能被当成"空档"删掉', () => {
  /* 分隔 item（text 只有空格、宽 1.8）比排版空档还窄，一刀切会把它删掉，
     于是 `ls -l 或 ll` 变成 `ls -l或ll`、`cat 文件名` 变成 `cat文件名`。 */
  const items = [it('cat', 50, 100, 9), it(' ', 64, 100, 9, 1.8), it('文件名', 66, 100, 9, 27)];
  assert.equal(pdfmd.joinItems(items, true), 'cat 文件名');
});

/* ══ 5. 表格 ════════════════════════════════════════════════════════════ */

/** 造一张 3 列的表：列线在 x = 40 / 120 / 300。第 1 行的"分类"格折行成两段。 */
function tablePages() {
  const items = [];
  items.push(it('NO', 40, 100, 12), it('分类', 120, 100, 12), it('说明', 300, 100, 12));
  let y = 120;
  for (let i = 1; i <= 5; i++) {
    items.push(it(String(i), 40, y, 12));
    items.push(it(i === 1 ? '文件管' : '文件管理', 120, y, 12));
    items.push(it('第' + i + '行说明文字', 300, y, 12));
    y += 20;
    if (i === 1) items.push(it('理', 120, y - 12, 12));      // 折行的后半段，落回 120 这条列线
  }
  return [pg(1, items)];
}

test('表格：每行自己成一段（不然整张宽表会粘成一个巨型段落）', () => {
  /* 速查手册那本最初的症状就是这样：242 行表格和正文全被并成几坨。 */
  const out = md(tablePages());
  assert.match(out, /^NO {2}分类 {2}说明$/m);
  assert.match(out, /^1 {2}文件管理 {2}第1行说明文字$/m, '折行的格子要合并回它自己那一格');
  assert.match(out, /^5 {2}文件管理 {2}第5行说明文字$/m);
});

test('表格：整篇不到 3 行时不当表格（免得把正文里偶然带大空隙的句子拆出来）', () => {
  const items = [
    it('正文一', 40, 300, 12),
    it('带', 40, 320, 12), it('列', 120, 320, 12), it('的', 300, 320, 12),
    it('正文三', 40, 340, 12),
  ];
  const r = run([pg(1, items)]);
  assert.equal(r.markdown.trim().split('\n\n').length, 1, '还是应该被拼成一段');
  assert.equal(r.stats.headings, 0);
});

test('表格行不会被当成有序列表（`1  文件管理…` 不是 "第 1 条"）', () => {
  const r = run(tablePages());
  assert.equal(r.stats.lists, 0);
  assert.match(r.markdown, /^1 {2}文件管理/m);
});

/* ══ 6. 代码块 ══════════════════════════════════════════════════════════ */

/** 正文（12pt）压住字号，代码用 9pt；两者都靠左。
 *  正文必须**够多字**，否则 bodySizeOf 的"字符数众数"会落在代码那一档，
 *  整个 fixture 就测不到代码块了（第一次写这篇测试时就踩了这个）。 */
function codePage(codeLines) {
  const body = [
    '这是一段足够长的正文，用来把正文字号稳稳地定在十二这一档上，不能短。',
    '这是第二段同样足够长的正文内容，长度也得实实在在压过下面的代码才行。',
    '这是第三段正文，凑够字数让字符数众数结结实实落在正文这一档上。',
    '这是第四段正文，作用是一样的，并且每一段的字数都不能少。',
    '这是第五段正文，再补一段以确保众数不会被代码反过来压过去。',
    '这是第六段正文，最后一段，长度同样和上面几段差不多。',
  ];
  const items = [];
  body.forEach((t, i) => items.push(it(t, 50, 60 + i * 20, 12)));
  let y = 200;
  for (const c of codeLines) { items.push(it(c, 50, y, 9)); y += 12; }
  return [pg(1, items)];
}

test('代码：三条独立的 shell 命令不能被粘成一条', () => {
  /* 实测反例：`openssl x509 …` / `openssl x509 …` / `mv …` 三条都以同一个 x 起头，
     其中前两条正好排满整行。按"排满了就是续行"算法会把三条粘成一行。 */
  const out = md(codePage([
    'openssl x509 -inform DER -in cacert.der -out cacert.pem',
    'openssl x509 -inform PEM -subject_hash_old -in cacert.pem',
    'mv cacert.pem 9a5ba575.0',
  ]));
  assert.match(out, /openssl x509 -inform DER -in cacert\.der -out cacert\.pem\n/);
  assert.equal(/cacert\.pem openssl/.test(out), false, '两条命令之间不能只差一个空格');
});

test('代码：以 / 收尾的 shell 路径不能被当续行', () => {
  /* `/` 曾经在"续行字符"集合里，于是 `cp a /b/` + `chmod 777` 被粘成一行。 */
  const out = md(codePage(['cp /sdcard/x /system/etc/security/', 'chmod 777 /system']));
  assert.match(out, /security\/\nchmod 777/);
});

test('代码：以 `(` 收尾 / 以 `);` 起头的软换行要合并', () => {
  const out = md(codePage(['foo(', ');']));
  assert.match(out, /foo\(\);/);
});

test('代码：以 `new` 收尾的软换行要合并', () => {
  const out = md(codePage(['A a = new', 'B();']));
  assert.match(out, /A a = new B\(\);/);
});

test('代码：以 `;` 收尾的一行是完整语句，绝不能再并进上一行', () => {
  const out = md(codePage(['a();', 'b();']));
  assert.match(out, /a\(\);\nb\(\);/);
});

test('代码：单行小字号不围代码块，而且能并回上一段', () => {
  /* 实测有些 PDF 同一段正文里字号在 10 和 9 之间来回跳，
     孤立成段会把整段切碎；围成代码块更打断阅读。 */
  const items = [
    it('这是一段正文，故意不用句号收尾', 50, 100, 12),
    it('小字号的半句', 50, 120, 9),
    it('这是后面另起的一段正文，长度也够。', 50, 160, 12),
  ];
  const r = run([pg(1, items)]);
  assert.equal(r.stats.codeBlocks, 0);
  assert.match(r.markdown, /故意不用句号收尾小字号的半句/);
});

test('代码：围栏内容里有 ``` 时自动换成 ~~~~', () => {
  const out = md(codePage(['a ``` b', 'c ``` d']));
  assert.match(out, /~~~~/);
});

/* ══ 7. 列表 ════════════════════════════════════════════════════════════ */

test('列表：常见标记都认，层级按缩进分', () => {
  const items = [
    it('这是一段足够长的正文，用来定住正文字号。', 50, 60, 12),
    it('- 无序项', 50, 200, 12),
    it('1. 有序项', 50, 220, 12),
    it('☑ 做完的事', 50, 240, 12),
    it('（2）中文括号序号', 50, 260, 12),
    it('  - 缩进的子项', 80, 280, 12),
  ];
  const out = md([pg(1, items)]);
  assert.match(out, /^- 无序项$/m);
  assert.match(out, /^1\. 有序项$/m);
  assert.match(out, /^- \[x\] 做完的事$/m);
  assert.match(out, /^1\. 中文括号序号$/m);
  assert.match(out, /^  - 缩进的子项$/m);
});

test('列表：`1.2.3.4:80` 不能被当成"第 1 条"', () => {
  /* 有序列表标记后面不能紧跟数字 —— 审计那篇里正好有 `1.2.3.4:80#x.example.com`。 */
  const out = md([pg(1, [
    it('这是一段足够长的正文，用来定住正文字号。', 50, 60, 12),
    it('1.2.3.4:80#x.bkrepo.example.com', 50, 200, 12),
  ])]);
  assert.match(out, /1\.2\.3\.4:80#x\.bkrepo\.example\.com/);
  assert.equal(/^1\. 2\.3\.4/m.test(out), false);
});

/* ══ 8. 标题 ════════════════════════════════════════════════════════════ */

test('标题：抽取大标题当 title，正文标题整体降一级', () => {
  const items = [
    it('一篇文档', 50, 50, 20),
    it('第一章', 50, 100, 16),
    it('这是一段足够长的正文，用来把正文字号定在 12 上面，长度也够。', 50, 200, 12),
    it('这是第二段同样足够长的正文内容，方便定字号。', 50, 220, 12),
  ];
  const r = run([pg(1, items)]);
  assert.equal(r.title, '一篇文档');
  assert.equal(r.markdown.startsWith('### 第一章'), true, 'H1 留给 front-matter，正文标题降一级');
  assert.equal(/一篇文档/.test(r.markdown), false, '开头重复的 H1 要删掉');
});

test('标题：以逗号收尾的长句不是标题', () => {
  const items = [
    it('这是一句话，', 50, 100, 16),
    it('这是一段足够长的正文，用来把正文字号定在 12 上面，长度也够。', 50, 200, 12),
    it('这是第二段同样足够长的正文内容，方便定字号。', 50, 220, 12),
  ];
  const r = run([pg(1, items)], '标题来自参数');
  assert.equal(r.stats.headings, 0);
  assert.match(r.markdown, /这是一句话，/);
});

test('标题：软换行成两行的长标题要整体抽走，不能切一半', () => {
  /* 真 PDF 反例：蓝鲸那篇的标题在版面上排成两行
       「记一次蓝鲸智云容器管理平台(BlueKing Container Service)」+「的代码审计」
     只取第一行时：前半截进了 front-matter 的 title，后半截留在正文里、
     又因为字号同样是最大档而被判成 `## 的代码审计`。
     注意首行是以 `)` 收尾的 —— 判"这行说完了没有"在那边**不能用 TERMINAL**
     （它含右括号），否则这种标题照样被切开。 */
  const pages = [pg(1, [
    it('记一次蓝鲸智云容器管理平台(BlueKing Container Service)', 50, 50, 20),
    it('的代码审计', 50, 74, 20),
    it('一、前言', 50, 150, 16),
    it('这是一段足够长的正文，用来把正文字号定在 12 上面，长度也够用了。', 50, 210, 12),
    it('这是第二段同样足够长的正文内容，方便把字号定住不掉档。', 50, 230, 12),
  ])];
  const r = run(pages);
  assert.equal(r.title, '记一次蓝鲸智云容器管理平台(BlueKing Container Service)的代码审计');
  assert.equal(/^##\s*的代码审计/m.test(r.markdown), false, '后半截不能留在正文里当标题');
  assert.equal(/的代码审计/.test(r.markdown), false, '后半截压根不该出现在正文里');
});

test('标题：续行吸收不能把副标题并进来', () => {
  const pages = [pg(1, [
    it('短标题', 50, 50, 20),
    it('这一行小一号字，是副标题不是续行', 50, 74, 18),
    it('这是一段足够长的正文，用来把正文字号定在 12 上面。', 50, 130, 12),
    it('这是第二段同样足够长的正文内容，方便定住字号。', 50, 150, 12),
  ])];
  const r = run(pages);
  assert.equal(r.title, '短标题', '差 2pt 就不是同一行标题的续行');
  assert.match(r.markdown, /这一行小一号字/, '副标题要留在正文里');
});

test('标题：折三行、第三行已越过"页面上部"那条线时也要接上', () => {
  /* 上面那条 40% 的线只用来**定位标题的第一行**。
     续行如果也要求自己落在 40% 以内，长标题折三行时第三行就会被漏掉 —— 又切一半。 */
  /* 宽度显式给：折行的前两截要"排满"到正文右边界（xEnd 450），最后一截不必 */
  const pages = [pg(1, [
    it('记一次蓝鲸智云容器管理平台的代码审计（上）', 50, 300, 20, 400),
    it('：从一次未授权访问说起', 50, 324, 20, 400),
    it('以及一些杂七杂八的补充', 50, 348, 20, 100),     // 842×0.4 = 336.8，这行已越线
    it('这是一段足够长的正文，用来把正文字号定在 12 上面，长度也够用了。', 50, 420, 12, 400),
    it('这是第二段同样足够长的正文内容，方便把字号定住不掉档。', 50, 440, 12, 400),
  ])];
  const r = run(pages);
  assert.equal(r.title, '记一次蓝鲸智云容器管理平台的代码审计（上）：从一次未授权访问说起以及一些杂七杂八的补充');
  assert.equal(/杂七杂八/.test(r.markdown), false, '第三行也不能留在正文里');
});

test('标题：给了文件名的情况下，软换行标题在正文里要合成一个 ##', () => {
  /* 现在导入默认用**文件名**当标题（见 pdfimport.js），版面里的大标题整篇留在正文。
     这时那行软换行的长标题如果不合并，正文里就会出现两个 `##` —— 半截标题
     明晃晃挂在正文开头，和"标题被切两半"是同一个病。 */
  const pages = [pg(1, [
    it('记一次蓝鲸智云容器管理平台(BlueKing Container Service)', 50, 50, 20),
    it('的代码审计', 50, 74, 20),
    it('这是一段足够长的正文，用来把正文字号定在 12 上面，长度也够用了。', 50, 150, 12),
    it('这是第二段同样足够长的正文内容，方便把字号定住不掉档。', 50, 170, 12),
  ])];
  const r = run(pages, '记一次蓝鲸智云容器管理平台的代码审计');
  assert.equal(r.title, '记一次蓝鲸智云容器管理平台的代码审计', '标题原样用传入的文件名');
  assert.equal(r.stats.headings, 1, '两行版面标题在正文里算**一个**标题');
  assert.match(r.markdown, /^## 记一次蓝鲸智云容器管理平台\(BlueKing Container Service\)的代码审计$/m);
  assert.equal(/^##\s*的代码审计/m.test(r.markdown), false, '不能出现孤零零的半个标题');
});

test('标题：上一行没排满时，后面的同字号行是另一个标题（蓝鲸真 PDF 反例）', () => {
  /* 真 PDF 第 1 页实测几何（页面 612 宽，正文右边界 557.2）：
       行0 记一次…(BlueKing Container Service)   xEnd 547.1  ← 排满
       行1 的代码审计                            xEnd 146.2  ← 远没排满
       行2 未认证 kubeconfig 校验 → 服务端 RCE    xEnd 376.1
     行0 排满 → 行1 是它的续行；行1 没排满 → 行2 是**独立标题**。
     只看字号和行距的话三行会被并成一句
     「…的代码审计未认证 kubeconfig 校验 → 服务端 RCE」。 */
  const body = (y) => it('这是一段足够长的正文，用来把正文字号定在 12 上面，长度也够用了的啊。', 51.7, y, 12, 495.5);
  const pages = [pg(1, [
    it('记一次蓝鲸智云容器管理平台(BlueKing Container Service)', 51.7, 71.2, 19, 495.4),
    it('的代码审计', 51.7, 94.5, 19, 94.5),
    it('未认证 kubeconfig 校验 → 服务端 RCE', 51.7, 128.2, 19, 324.4),
    body(160), body(178), body(196),
  ], 612, 792)];
  const r = run(pages);
  assert.equal(r.title, '记一次蓝鲸智云容器管理平台(BlueKing Container Service)的代码审计');
  assert.match(r.markdown, /^## 未认证 kubeconfig 校验 → 服务端 RCE$/m, '副标题要独立成一行');
  assert.equal(/的代码审计/.test(r.markdown), false, '被抽去当标题的两行不该再出现在正文里');
});

test('标题：隔得太远的同字号行不是续行', () => {
  const pages = [pg(1, [
    it('标题甲', 50, 50, 20),
    it('标题乙', 50, 200, 20),                       // 行距 150 >> 20×1.8
    it('这是一段足够长的正文，用来把正文字号定在 12 上面。', 50, 260, 12),
    it('这是第二段同样足够长的正文内容，方便定住字号。', 50, 280, 12),
  ])];
  const r = run(pages);
  assert.equal(r.title, '标题甲');
  assert.match(r.markdown, /^## 标题乙/m, '离得远的同字号行是另一个标题，不能并进 title');
});

/* ══ 9. 图片插位 ════════════════════════════════════════════════════════
 * 图片从 pdfimage.js 来，带着"第几页、离页顶多远"。这里的判据只有一条：
 * 图在谁上面就插在谁前面。最容易写错的是**忘了先收口段落** —— 那样图会被塞进
 * 一个段落中间，markdown 里变成"一段文字里夹一行 asset_img"。 */

const IMG_A = '{% asset_img aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png %}';
const IMG_B = '{% asset_img bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png %}';
const IMG_C = '{% asset_img cccccccccccccccccccccccccccccccc.png %}';
const body = (t, y) => it(t, 50, y, 12);

test('图片：插在它上面的文字之后、下面的文字之前', () => {
  const pages = [pg(1, [
    body('第一段正文，长度足够把正文字号定住不掉档。', 100),
    body('第二段正文，同样足够长，用来当图片上方的文字。', 140),
    body('第三段正文，用来当图片下方的文字。', 300),
  ])];
  const r = pdfmd.toMarkdown(pages, { title: '', images: [{ page: 1, yTop: 200, tag: IMG_A }] });
  const iImg = r.markdown.indexOf(IMG_A);
  assert.ok(iImg > 0, '图要出现在正文里');
  assert.ok(iImg > r.markdown.indexOf('第二段'), '图要在它上方那段文字之后');
  assert.ok(iImg < r.markdown.indexOf('第三段'), '图要在它下方那段文字之前');
  assert.equal(r.stats.images, 1);
});

test('图片：必须独占一行，不能粘进段落里', () => {
  /* 反过来写（不 flush 就 push）的话，图会跟后面的文字拼成一段，
     Hexo 解析 asset_img 时也会因为行首有别的字符而失败。 */
  const pages = [pg(1, [
    body('第一段正文，长度足够把正文字号定住不掉档。', 100),
    body('第二段正文，同样足够长，用来当图片上方的文字。', 140),
  ])];
  const r = pdfmd.toMarkdown(pages, { title: '', images: [{ page: 1, yTop: 120, tag: IMG_A }] });
  /* 判"独占一行"要**逐行**看：写成 /\S\s*\{% asset_img/ 会把上一行的句号算进来
     （\s 匹配换行），于是永远为真 —— 这条断言自己先翻过一次车。 */
  const tagLines = r.markdown.split('\n').filter((l) => l.includes('asset_img'));
  assert.equal(tagLines.length, 1);
  assert.equal(tagLines[0], IMG_A, 'asset_img 独占一行，前后都不挂字');
});

test('图片：同一页的两张图按纵向顺序排', () => {
  const pages = [pg(1, [
    body('第一段正文，长度足够把正文字号定住不掉档。', 100),
    body('第二段正文，同样足够长，用来当图片上方的文字。', 320),
  ])];
  const r = pdfmd.toMarkdown(pages, {
    title: '', images: [{ page: 1, yTop: 300, tag: IMG_B }, { page: 1, yTop: 200, tag: IMG_A }],
  });
  assert.ok(r.markdown.indexOf(IMG_A) < r.markdown.indexOf(IMG_B), 'yTop 小的排在前面（传参顺序被打乱也要排对）');
  assert.equal(r.stats.images, 2);
});

test('图片：跨页的图不能提前插到前一页里去', () => {
  const pages = [
    pg(1, [body('第一页的正文，长度足够把正文字号定住不掉档。', 100)]),
    pg(2, [body('第二页的正文，长度足够把正文字号定住不掉档。', 100)]),
  ];
  const r = pdfmd.toMarkdown(pages, { title: '', images: [{ page: 2, yTop: 50, tag: IMG_A }] });
  assert.ok(r.markdown.indexOf('第一页') < r.markdown.indexOf(IMG_A), '第 2 页的图不能跑到第 1 页的文字前面');
  assert.ok(r.markdown.indexOf(IMG_A) < r.markdown.indexOf('第二页'), '但它要在第 2 页的文字前面');
});

test('图片：整份 PDF 没有文字（扫描件）时，图照样要出来', () => {
  const r = pdfmd.toMarkdown([pg(1, [])], { title: '', images: [{ page: 1, yTop: 10, tag: IMG_A }] });
  assert.equal(r.markdown.trim(), IMG_A, '没有文字时正文就是那几张图');
  assert.equal(r.stats.images, 1);
});

test('图片：不传图片时行为完全不变', () => {
  const pages = [pg(1, [
    body('第一段正文，长度足够把正文字号定住不掉档。', 100),
    body('第二段正文，同样足够长，用来当对照。', 140),
  ])];
  const a = pdfmd.toMarkdown(pages, { title: '' }).markdown;
  const b = pdfmd.toMarkdown(pages, { title: '', images: [] }).markdown;
  assert.equal(a, b);
  assert.equal(/asset_img/.test(a), false);
});

/* 相邻图片的间距**不在 markdown 里做**，交给主题 CSS（`.post-content > img + img`）。
   以前这里插过 `&nbsp;`，三个原因撤掉了，详见 src/pdfmd.js 里"相邻图片的间距"那段：
     ① 只覆盖"修复之后导入的文章"——用户手上这篇是修复前导的，于是"明明修过了
        为什么线上还是贴着"，症状离根因太远；
     ② 污染正文，导出到 GitHub 等平台是一段莫名其妙的空白段落；
     ③ 和 CSS 方案叠加会double（图片外边距 + 一整行 &nbsp; 行高 + 段落外边距），
        同一个页面里出现两种间距反而更乱。
   这几条测试的意义是**钉住"不再往正文里塞东西"**，防止后来人看到图贴在一起
   又把这套加回来。 */
test('图片：两张图中间没有文字时，正文里也不许出现 &nbsp;（间距归主题 CSS 管）', () => {
  const pages = [pg(1, [
    body('图片上方的正文，长度足够把正文字号定住不掉档。', 100),
    body('图片下方的正文，同样足够长，用来当对照。', 500),
  ])];
  const r = pdfmd.toMarkdown(pages, {
    title: '', images: [{ page: 1, yTop: 200, tag: IMG_A }, { page: 1, yTop: 300, tag: IMG_B }],
  });
  assert.equal(/&nbsp;/.test(r.markdown), false, '不许再往正文里插空段落');
  /* 两张图仍然要各自独占一段（中间一个空行）—— 这样它们才是两个块，
     主题 CSS 的相邻兄弟选择器才认得出"这是两张挨着的图"。 */
  const lines = r.markdown.split('\n');
  const ia = lines.indexOf(IMG_A);
  assert.ok(ia >= 0, '第一张图在正文里');
  assert.equal(lines[ia + 1], '', '第一张图后面是空行');
  assert.equal(lines[ia + 2], IMG_B, '空一行就是第二张图（中间没有别的东西）');
});

test('图片：图与图之间有文字时，不加多余的空段落', () => {
  const pages = [pg(1, [
    body('图片上方的正文，长度足够把正文字号定住不掉档。', 100),
    body('夹在两张图中间的一段正文，要足够长才好定字号。', 260),
    body('图片下方的正文，同样足够长，用来当对照使用。', 500),
  ])];
  const r = pdfmd.toMarkdown(pages, {
    title: '', images: [{ page: 1, yTop: 200, tag: IMG_A }, { page: 1, yTop: 300, tag: IMG_B }],
  });
  assert.equal(/&nbsp;/.test(r.markdown), false, '中间本来就有文字，不需要补空段');
  assert.equal(r.stats.images, 2);
});

test('图片：三张图连续出现时仍是三个独立段落，正文里没有 &nbsp;', () => {
  const pages = [pg(1, [body('正文，长度足够把正文字号定住不掉档才行。', 100)])];
  const r = pdfmd.toMarkdown(pages, {
    title: '',
    images: [
      { page: 1, yTop: 200, tag: IMG_A },
      { page: 1, yTop: 260, tag: IMG_B },
      { page: 1, yTop: 320, tag: IMG_C },
    ],
  });
  const md = r.markdown;
  assert.equal((md.match(/&nbsp;/g) || []).length, 0);
  assert.ok(md.indexOf(IMG_A) < md.indexOf(IMG_B) && md.indexOf(IMG_B) < md.indexOf(IMG_C));
  /* 三张图排在正文那一段之后，各自独占一段、两两之间只有一个空行 */
  assert.deepEqual(md.trim().split('\n\n').slice(-3), [IMG_A, IMG_B, IMG_C]);
});

test('图片：扫描件（整篇只有图）也不插 &nbsp;', () => {
  const r = pdfmd.toMarkdown([pg(1, [])], {
    title: '', images: [{ page: 1, yTop: 10, tag: IMG_A }, { page: 1, yTop: 90, tag: IMG_B }],
  });
  assert.equal(/&nbsp;/.test(r.markdown), false);
  assert.equal(r.markdown, [IMG_A, IMG_B].join('\n\n') + '\n');
  assert.equal(r.stats.images, 2);
});

/* ══ 10. 统计出口 ═══════════════════════════════════════════════════════ */

test('stats：页码、字数、标题数、列表数、代码块数、修部首数都报出来', () => {
  const pages = [
    pg(1, [
      it('文档标题', 50, 50, 20),
      it('第一章', 50, 100, 16),
      it('- 一个列表项', 50, 200, 12),
      it('这是一段足够长的正文，用来把正文字号定在 12 上面。', 50, 220, 12),
    ]),
    pg(2, [it('second page', 50, 100, 12)]),
  ];
  const r = run(pages);
  assert.equal(r.stats.pages, 2, '页码数 = 传入的页数');
  assert.equal(r.stats.chars > 0, true);
  assert.equal(r.stats.headings, 1);
  assert.equal(r.stats.lists, 1);
  assert.equal(r.stats.kangxi, 0);
});

test('空输入不炸，返回空串', () => {
  const r = run([]);
  assert.equal(r.markdown, '');
  assert.equal(r.stats.pages, 0);
});
