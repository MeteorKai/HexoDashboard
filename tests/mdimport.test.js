/* mdimport 单元测试：Markdown 导入的"图片怎么换成 asset_img"这一层
 *
 *   node --test tests/mdimport.test.js
 *
 * 这里盯的都是**错了很安静**的那类问题：
 *   · 图片没换成 asset_img → 生成出来是 `<img src="/a.png">`，站点根目录没这文件，裂图；
 *   · 换成了但资源目录名对不上 → 保存后图片全部失联（比不换更难查）；
 *   · 代码块里的示例被换掉 → 文章里凭空多出一张图。
 *
 * 注意：这里的回调**故意写成 async**（和服务端一致）。落盘回调是异步的，
 * 而 String.replace 的回调只能同步 —— 谁要是把它改回"边扫边落盘"，
 * 正文里就会出现 `[object Promise]`，而同步回调的单测试不出来。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const lib = require('../src/lib');
const mdimport = require('../src/mdimport');

/** 内容哈希资源名（和手动上传同一套规则） */
const nameOf = (content, file = 'x.png') => lib.assetName(Buffer.from(content), file);
/** 默认回调：只算标签、不落盘（落盘是 server.js 的事）。
 *  alt 的取值顺序必须和服务端一致：原文写过的 alt 优先，没有才退回文件名。 */
const tagger = (list) => async (img) => {
  if (list) list.push(img);
  return lib.assetTagAlt(lib.assetName(img.data, img.name), img.alt || lib.altFromName(img.name));
};
const files = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]));
const run = (text, map, opts = {}) => mdimport.convert({
  text, files: map, mdPath: opts.mdPath || 'a.md', images: opts.images || tagger(),
  mode: opts.mode,
});

test('行内图片换成 asset_img，文件名按内容哈希', async () => {
  const r = await run('开头\n\n![图一](a.png)\n\n结尾', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, `开头\n\n{% asset_img ${nameOf('AAA')} 图一 %}\n\n结尾`);
  assert.equal(r.stats.images, 1);
  assert.equal(r.stats.missing, 0);
});

test('alt 为空时退回文件名，不会生成空标签', async () => {
  /* 文件名带空格在 md 里只能写成 <…> 或 %20 —— 两种都得认 */
  const r = await run('![](<my photo.png>) ![](other%20one.png)', files({ 'my photo.png': 'BBB', 'other one.png': 'CCC' }));
  assert.equal(r.markdown, `{% asset_img ${nameOf('BBB')} my-photo %} {% asset_img ${nameOf('CCC')} other-one %}`);
});

test('图片在子目录：按 md 所在目录解析相对路径', async () => {
  /* Typora 导出的典型摆法：md 在 posts/，图在 posts/名字.assets/ */
  const r = await run('![x](名字.assets/b.png)', files({ 'posts/名字.assets/b.png': 'CCC' }), { mdPath: 'posts/a.md' });
  assert.equal(r.markdown, `{% asset_img ${nameOf('CCC')} x %}`);
});

test('相对路径对不上时退到文件名（换过机器、绝对路径也能救回来）', async () => {
  const r = await run('![x](/Users/someone/Desktop/b.png)', files({ '别的目录/b.png': 'DDD' }));
  assert.equal(r.markdown, `{% asset_img ${nameOf('DDD')} x %}`);
});

test('URL 转义与 file:// 前缀也会被剥掉再比对', async () => {
  const r = await run('![x](b%20c.png) 和 ![y](file:///D:/img/a.png)', files({ 'b c.png': 'EEE', 'a.png': 'AAA' }));
  assert.equal(r.markdown, `{% asset_img ${nameOf('EEE')} x %} 和 {% asset_img ${nameOf('AAA')} y %}`);
});

test('外链原样保留：不复制、也不算缺图', async () => {
  const src = '![远图](https://example.com/a.png)';
  const r = await run(src, files({}));
  assert.equal(r.markdown, src);
  assert.equal(r.stats.remote, 1);
  assert.equal(r.stats.missing, 0);
});

test('图片没一起选进来：保留原引用，并把文件名报给前端', async () => {
  const r = await run('![x](missing.png)', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, '![x](missing.png)');
  assert.deepEqual(r.missing, ['missing.png']);
  assert.equal(r.stats.missing, 1);
});

test('没有资源目录（images 回调缺失）时不算缺图，算 skipped', async () => {
  const r = await mdimport.convert({ text: '![x](a.png)', files: files({ 'a.png': 'AAA' }), mdPath: 'a.md' });
  assert.equal(r.markdown, '![x](a.png)');
  assert.equal(r.stats.skipped, 1);
  assert.equal(r.stats.missing, 0);
});

test('代码块里的图片示例一个字都不能动', async () => {
  const src = '```md\n![示例](a.png)\n```\n\n![真图](a.png)';
  const r = await run(src, files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, `\`\`\`md\n![示例](a.png)\n\`\`\`\n\n{% asset_img ${nameOf('AAA')} 真图 %}`);
  assert.equal(r.stats.images, 1);
});

test('HTML <img> 也换掉，alt 取自 alt 属性', async () => {
  const r = await run('<img src="a.png" alt="我的 图">', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, `{% asset_img ${nameOf('AAA')} 我的-图 %}`);
});

test('已经是 asset_img 的：字节带来了就重写成新资源名，alt 保留', async () => {
  const r = await run('{% asset_img a.png 旧描述 %}', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, `{% asset_img ${nameOf('AAA')} 旧描述 %}`);
});

test('引用式图片：换掉后那行定义成为孤儿，删掉它', async () => {
  const r = await run('![图][1]\n\n[1]: a.png "标题"', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, `{% asset_img ${nameOf('AAA')} 图 %}\n`);
  assert.equal(r.stats.images, 1);
});

test('同一个 id 还被普通链接引用时，定义必须留着', async () => {
  const r = await run('![图][1] 和 [文字][1]\n\n[1]: a.png', files({ 'a.png': 'AAA' }));
  assert.match(r.markdown, /\[1\]: a\.png/);
  assert.match(r.markdown, /\{\% asset_img/);
});

test('折叠式 ![id] 只在定义表里存在时才换；id 不在表里就当普通文本', async () => {
  const r = await run('![a] 用了定义\n\n![b] 只是普通文本\n\n[a]: a.png', files({ 'a.png': 'AAA' }));
  const lines = r.markdown.split('\n');
  assert.equal(lines[0], `{% asset_img ${nameOf('AAA')} a %} 用了定义`);   // 换掉，alt 退回文件名
  assert.equal(lines[2], '![b] 只是普通文本');                              // 没这个定义 → 原文不动
  assert.equal(r.stats.missing, 0);                                         // 也不能被算成"缺图"
});

test('front-matter 只拆出来，正文里不留；标题日期标签进 meta', async () => {
  const r = await run('---\ntitle: 原标题\ndate: 2026-09-30 10:00:00\ntags:\n  - Hexo\n---\n正文 ![x](a.png)',
    files({ 'a.png': 'AAA' }));
  assert.equal(r.meta.title, '原标题');
  assert.deepEqual(r.meta.tags, ['Hexo']);
  assert.doesNotMatch(r.markdown, /^---/);
  assert.match(r.markdown, /^正文/);
});

test('Obsidian 的 ![[图片]] 也换成 asset_img', async () => {
  /* Obsidian 导出的 md 里图片全是 `![[文件名]]`。这条**必须先于** ![id] 折叠式规则匹配，
     否则会被咬成 `![[文件名]`（id 里带个前导 `[`），查不到定义 → 原样退回 → 永远换不掉，
     而且连"缺图"都不报，是静默失败。 */
  const r = await run('正文\n\n![[Pasted image 20260101120000.png]]', files({ 'Pasted image 20260101120000.png': 'FFF' }));
  /* alt 退回文件名，大小写按原样保留（和手动上传用的 altFromName 同一套） */
  assert.equal(r.markdown, `正文\n\n{% asset_img ${nameOf('FFF')} Pasted-image-20260101120000 %}`);
  assert.equal(r.stats.images, 1);
});

test('Obsidian 的 ![[图片|宽度]]：宽度不是 alt，丢掉', async () => {
  const r = await run('![[a.png|300]]', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, `{% asset_img ${nameOf('AAA')} a %}`);
});

test('Obsidian 的图没带来字节：不能闷声不响，要报缺图', async () => {
  const r = await run('![[没了.png]]', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, '![[没了.png]]');
  assert.deepEqual(r.missing, ['没了.png']);
  assert.equal(r.stats.missing, 1);
});

test('内嵌 base64 的图：直接从 md 里抽出来，不用另外选文件', async () => {
  /* Windows 里复制一张图、粘进编辑器，最常见的落地形态就是 data URI。
     字节本来就在 md 里 —— 这种 md **单文件自包含**，导入时选它一个就够了。 */
  const b64 = Buffer.from('AAA').toString('base64');
  const r = await run(`![粘贴的图](data:image/png;base64,${b64})`, files({}));
  assert.equal(r.markdown, `{% asset_img ${nameOf('AAA')} 粘贴的图 %}`);
  assert.equal(r.stats.embedded, 1);
  assert.equal(r.stats.files, 0);                 // 没有随 md 上传任何文件
  assert.equal(r.stats.missing, 0);
});

test('base64 的 <img> 也一样能抽出来', async () => {
  const b64 = Buffer.from('BBB').toString('base64');
  const r = await run(`<img src="data:image/jpeg;base64,${b64}" alt="照片">`, files({}));
  assert.equal(r.markdown, `{% asset_img ${nameOf('BBB', 'x.jpg')} 照片 %}`);
});

test('data URI 不是图片、或不是 base64 → 原样留着，不算缺图也不算图', async () => {
  const txt = '![](data:text/plain;base64,aGVsbG8=)';
  const r = await run(txt, files({}));
  assert.equal(r.markdown, txt);
  assert.equal(r.stats.embedded, 0);
  assert.equal(r.stats.missing, 0);
});

test('本机绝对路径的图：服务端自己读（Typora 粘贴的默认形态）', async () => {
  /* md 里写的是换台机器就废的绝对路径，但**导入这台机器上它还在**。
     读取通过 readLocal 回调注入 —— 这一层不碰 fs。 */
  const seen = [];
  const r = await mdimport.convert({
    text: '![](file:///C:/Users/me/typora-user-images/image-20260101120000.png)',
    files: files({}), mdPath: 'a.md', images: tagger(),
    readLocal: async (abs) => { seen.push(abs); return Buffer.from('CCC'); },
  });
  assert.equal(seen.length, 1);
  /* 交给读取方的必须是**能直接喂给 fs 的路径**：
     `file:///C:/…` 剥协议后那个 `/C:/…` 在 Windows 上 existsSync 是 false（实测过），
     不抹掉就整片变缺图。这条钉的就是"抹没抹"。 */
  assert.equal(seen[0], 'C:/Users/me/typora-user-images/image-20260101120000.png');
  /* alt 兜底用原文件名（Typora 的 image-20260101120000 比 pasted-image-1 有辨识度） */
  assert.equal(r.markdown, `{% asset_img ${nameOf('CCC', 'image-20260101120000.png')} image-20260101120000 %}`);
  assert.equal(r.stats.localPath, 1);
  assert.equal(r.stats.missing, 0);
});

test('本机路径的三种写法都认（带盘符 / 反斜杠 / file:// 双斜杠）', async () => {
  const seen = [];
  const r = await mdimport.convert({
    text: [
      '![](C:\\Users\\me\\a.png)',
      '![](file://C:/Users/me/b.png)',
      '![](file:///C:/Users/me/c.png)',
    ].join('\n'),
    files: files({}), mdPath: 'a.md', images: tagger(),
    readLocal: async (abs) => { seen.push(abs); return Buffer.from('x' + seen.length); },
  });
  /* 三种写法最终都收敛成 `C:/…`（decodeTarget 会把反斜杠统一成正斜杠，
     Windows 的 fs 认正斜杠，这样"同一张图三种写法"也不会被当成三张不同的图） */
  assert.deepEqual(seen, [
    'C:/Users/me/a.png', 'C:/Users/me/b.png', 'C:/Users/me/c.png',
  ]);
  assert.equal(r.stats.localPath, 3);
  assert.equal(r.stats.missing, 0);
});

test('本机路径读不到（换了机器）→ 如实算缺图，不假装成功', async () => {
  const r = await mdimport.convert({
    text: '![](C:\\Users\\me\\gone.png)', files: files({}), mdPath: 'a.md', images: tagger(),
    readLocal: async () => null,
  });
  assert.equal(r.markdown, '![](C:\\Users\\me\\gone.png)');
  assert.deepEqual(r.missing, ['gone.png']);
  assert.equal(r.stats.localPath, 0);
});

test('没给 readLocal 时，本机路径不去碰（当成普通缺图）', async () => {
  const r = await mdimport.convert({
    text: '![](C:\\Users\\me\\x.png)', files: files({}), mdPath: 'a.md', images: tagger(),
  });
  assert.equal(r.markdown, '![](C:\\Users\\me\\x.png)');
  assert.equal(r.stats.localPath, 0);
});

test('front-matter 后面那个空行不会变成正文第一行', async () => {
  /* 写 md 的习惯是 `---\n\n正文`，拆完 front-matter 后正文以 "\n正文" 开头。
     留着就是"导入完开头莫名空一行"，所以要把开头的空行削掉。 */
  const r = await run('---\ntitle: 标题\n---\n\n正文第一段', files({}));
  assert.equal(r.markdown, '正文第一段');
  assert.equal(r.meta.title, '标题');
});

test('同一张图被引两次：只写一次（内容哈希天然去重）', async () => {
  const seen = [];
  const r = await mdimport.convert({
    text: '![x](a.png)\n\n![y](./a.png)', files: files({ 'a.png': 'AAA' }),
    mdPath: 'a.md', images: tagger(seen),
  });
  assert.equal(r.stats.images, 1);
  assert.equal(new Set(r.markdown.match(/asset_img (\S+)/g)).size, 1);
});

test('CRLF 的 md 不会因为重写变成 LF', async () => {
  const r = await run('第一行\r\n\r\n![x](a.png)', files({ 'a.png': 'AAA' }));
  assert.match(r.markdown, /^第一行\r\n/);
});

test('multipart 解析：md 与带子目录的图片各自归位', async () => {
  const boundary = '----hexoToolTestBoundary';
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="md"; filename="a.md"\r\n` +
      'Content-Type: text/markdown\r\n\r\n正文 ![x](x.assets/b.png)'),
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="f:a/x.assets/b.png"; filename="b.png"\r\n` +
      'Content-Type: image/png\r\n\r\n'),
    bin,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="mdrel"\r\n\r\na/a.md`),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parts = mdimport.parseMultipart(body, boundary);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].name, 'md');
  assert.equal(parts[0].data.toString('utf8'), '正文 ![x](x.assets/b.png)');
  assert.equal(parts[1].name, 'f:a/x.assets/b.png');
  assert.equal(parts[1].data.equals(bin), true, '图片字节必须原样（不能被分界误伤）');
  assert.equal(parts[1].filename, 'b.png');

  const map = new Map(parts.filter((p) => p.name.startsWith('f:')).map((p) => [p.name.slice(2), p.data]));
  const r = await mdimport.convert({
    text: parts[0].data.toString('utf8'), files: map,
    mdPath: parts.find((p) => p.name === 'mdrel').data.toString('utf8'), images: tagger(),
  });
  const hash = crypto.createHash('md5').update(bin).digest('hex');
  assert.equal(r.markdown, `正文 {% asset_img ${hash}.png x %}`);
});

test('不是 multipart / 没有 boundary 时返回空，不抛', () => {
  assert.deepEqual(mdimport.parseMultipart(Buffer.from('随便一段字节'), ''), []);
  assert.deepEqual(mdimport.parseMultipart(Buffer.from('随便一段字节'), 'nope'), []);
});

test('两种导入模式：普通模式保留 wiki，Obsidian 模式转换 wiki 和普通图片', async () => {
  const text = '![[a.png]]\n![图](a.png)';
  const map = files({ 'assets/a.png': 'AAA' });
  const plain = await run(text, map, { mode: 'markdown' });
  assert.match(plain.markdown, /^!\[\[a.png\]\]/);
  const obsidian = await run(text, map, { mode: 'obsidian' });
  assert.doesNotMatch(obsidian.markdown, /!\[/);
  assert.equal(obsidian.stats.images, 1);
});

test('Obsidian 的笔记嵌入不是图片，不能误报缺图', async () => {
  const r = await run('![[另一篇笔记]]\n![[另一篇笔记.md#标题]]', files({}), { mode: 'obsidian' });
  assert.equal(r.markdown, '![[另一篇笔记]]\n![[另一篇笔记.md#标题]]');
  assert.deepEqual(r.missing, []);
});

test('相对路径的 ../ 必须归一化，不能误取另一个目录里的同名图', async () => {
  const r = await run('![图](../assets/a.png)', files({
    'vault/other/a.png': 'WRONG', 'vault/assets/a.png': 'RIGHT',
  }), { mdPath: 'vault/notes/a.md' });
  assert.equal(r.markdown, `{% asset_img ${nameOf('RIGHT')} 图 %}`);
});

test('Obsidian 优先匹配笔记旁的 assets，不随便取库里第一张同名图', async () => {
  const r = await run('![[a.png]]', files({
    'vault/other/assets/a.png': 'WRONG', 'vault/notes/assets/a.png': 'RIGHT',
  }), { mdPath: 'vault/notes/a.md', mode: 'obsidian' });
  assert.equal(r.markdown, `{% asset_img ${nameOf('RIGHT')} a %}`);
});

test('同名图片无法确定路径时保留引用并提示，不静默导入错图', async () => {
  const r = await run('![[a.png]]', files({ 'one/a.png': 'AAA', 'two/a.png': 'BBB' }), { mode: 'obsidian' });
  assert.equal(r.markdown, '![[a.png]]');
  assert.deepEqual(r.missing, ['a.png']);
  assert.equal(r.stats.ambiguous, 1);
});

test('普通图片路径含空格或括号时，仍完整替换图片引用', async () => {
  const r = await run('![图](My Images/a(1).png "标题")', files({ 'My Images/a(1).png': 'AAA' }), { mode: 'markdown' });
  assert.equal(r.markdown, `{% asset_img ${nameOf('AAA')} 图 %}`);
});

test('协议相对外链保留原样，不因路径归一化而被当成本机图片', async () => {
  const r = await run('![图](//example.com/a.png)', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, '![图](//example.com/a.png)');
  assert.equal(r.stats.remote, 1);
});

test('引用式图片定义支持尖括号中含空格的路径', async () => {
  const r = await run('![图][img]\n\n[img]: <assets/my photo.png>', files({ 'assets/my photo.png': 'AAA' }));
  assert.equal(r.markdown, `{% asset_img ${nameOf('AAA')} 图 %}\n`);
});

test('行内代码中的两种图片语法保持原样', async () => {
  const r = await run('`![示例](a.png)` 与 `![[a.png]]`\n![正文](a.png)', files({ 'a.png': 'AAA' }));
  assert.equal(r.markdown, '`![示例](a.png)` 与 `![[a.png]]`\n' + `{% asset_img ${nameOf('AAA')} 正文 %}`);
});
