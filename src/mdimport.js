// mdimport.js —— 把一份现成的 Markdown（连同它引用的图片）变成写作台能直接用的文章
//
// 和 PDF 导入的分工：PDF 要"从版式里猜内容"，Markdown 已经是成品 —— 所以这一层只做三件事：
//   ① 拆 front-matter：标题/日期/标签交给写作台的表单，编辑区里只放正文；
//   ② 把正文里的图片引用换成 Hexo 原生 {% asset_img %}；
//   ③ 把引用到的图片**按内容哈希**复制一份到文章的同名资源目录。
//
// 为什么 ②③ 必须在服务端做（不能让浏览器自己改完再上传）：
//   资源名是**内容的 MD5**，只有真拿到字节才算得出来；而"图片放在哪"是服务端的
//   内部结构。前端只认"引用长什么样"，不认"文件叫什么"。
//
// 为什么图片要**跟 md 一起选进来**（见 web/editor.js 的 buildImportForm）：
//   浏览器给的是字节，不是"这个文件旁边的目录"。md 里的 `![x](assets/a.png)`
//   只是一串相对路径，服务端没有那串路径对应的字节就只能把引用原样留下 ——
//   生成出来就是一条死链，而且死得很安静（页面上只是一个裂图）。
//
// 这一层不碰 fs、不发网络请求，所以能被单测直接驱动（tests/mdimport.test.js）。
'use strict';
const lib = require('./lib');
const path = require('path');

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;

/* ---------- 相对路径规整：md 里怎么写、上传时怎么报，两边都可能带反斜杠 / ./ ---------- */
const normalize = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
const normalizeRel = (p) => p ? path.posix.normalize(normalize(p)) : '';
const baseOf = (p) => { const s = normalize(p); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); };
const dirOf = (p) => { const s = normalize(p); const i = s.lastIndexOf('/'); return i < 0 ? '' : s.slice(0, i); };
const joinRel = (dir, rel) => (dir ? dir + '/' + rel : rel);
const unquote = (s) => String(s || '').replace(/^(["'])([\s\S]*)\1$/, '$2');
const escRE = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** md 里写的图片地址 → 能用来比对的字符串。
 *  `%20`、`file:///`、`![a](<x y.png>)` 的尖括号、`?v=1` 这些都得先剥掉，
 *  否则"明明选了这张图"却因为一串后缀对不上，最后被当成缺图。 */
function decodeTarget(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/^file:\/\//i, '');            // file:///D:/a.png → D:/a.png
  s = s.replace(/^<|>$/g, '');                 // ![a](<x y.png>)
  s = s.replace(/[?#].*$/, '');                // 去掉 ?v=1 与 #frag
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try { s = decodeURIComponent(s); } catch { /* 不是合法转义就当普通文件名 */ }
  }
  return normalize(s);
}
/* 外链 = http(s) 与协议相对地址。data: **不算**外链 ——
   内嵌的 base64 图就在 md 里，是最该被换成 asset_img 的一种（见 dataBytes）。 */
function isRemote(t) { return /^(?:https?:)?\/\//i.test(t); }

/* ---------- 内嵌的图：data:image/png;base64,.... ----------
 * "在 Windows 里复制一张图、粘进编辑器"最常见的落地形态就是它：
 * 图被 base64 编进 md 正文，md 单文件自包含。这种图**不用用户另选文件** ——
 * 字节本来就在请求里，直接解码落盘即可，这正是"只选一个 md 也能导入成功"的关键。
 * 返回 { buf, ext }；不是图片、或者不是 base64 编码的 data URI → 返回 null（原样留着）。 */
const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/avif': 'avif', 'image/tiff': 'tiff',
};
function dataBytes(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^<|>$/g, '');
  const m = /^data:([^;,]*)((?:;[^;,=]+=[^;,]*|;[^;,]+)*)?,([\s\S]*)$/i.exec(s);
  if (!m) return null;
  const mime = String(m[1] || '').trim().toLowerCase();
  const params = String(m[2] || '');
  const payload = String(m[3] || '');
  if (!/^image\//.test(mime)) return null;                 // data:text/plain 之类不是图，别动
  if (!/;\s*base64\b/i.test(';' + params)) return null;    // 未编码（裸 %XX）的 data URI 先不支持
  /* base64 里只可能有 A-Za-z0-9+/= 与换行。出现别的字符说明这段根本不是 base64
     （或者被别的语法截断了），硬解出来是一张坏图，不如原样留着让人自己看。 */
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) return null;
  const buf = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
  if (!buf.length) return null;
  return { buf, ext: MIME_EXT[mime] || 'png' };
}

/* ---------- 本机绝对路径的图：C:\...\image.png / file:///C:/.../image.png ----------
 * Typora 之类"粘贴图片"时默认把图存进自己的目录并在 md 里写绝对路径。
 * 换台机器这个路径就废了，但**导入的这台机器上它还在** —— 服务端是本机进程，
 * 直接读出来即可，同样不用用户去选。
 * 能不能读由调用方（server.js）说了算：这一层不碰 fs，所以只判断"长得像本机绝对路径"，
 * 真正的读取通过 readLocal 回调注入（单测里可以换成假函数）。 */
function isLocalPath(t) {
  const s = String(t || '');
  /* `file:///C:/x.png` 被 decodeTarget 剥掉协议后会变成 `/C:/x.png`（多一个前导斜杠），
     所以 `\/?` 那一段不能少 —— 少了就认不出来，这种图会被误判成缺图。 */
  return /^(?:file:\/\/\/?)?\/?[A-Za-z]:[\\/]/i.test(s)   // C:\x.png / file:///C:/x.png / /C:/x.png
    || /^(?:file:\/\/)?\/?(?:Users|home|mnt|media|Volumes)\//i.test(s);  // macOS / Linux 的家目录
}
/** md 里那串路径 → 能直接喂给 fs 的绝对路径。
 *  `file:///C:/a.png` 剥掉协议后是 `/C:/a.png` —— Windows 上 Node 会把它当成
 *  "当前盘符根目录下的 C:\a.png"，`existsSync` 直接 false（实测），
 *  于是这种最常见写法会被整片判成缺图。这里把盘符前面那个多余的斜杠抹掉。 */
function toAbsPath(t) {
  let s = String(t || '').trim().replace(/^file:\/\//i, '');
  s = s.replace(/^\/(?=[A-Za-z]:[\\/])/, '');       // /C:/a.png → C:/a.png（只在盘符前才抹）
  return s;
}
/** 给"从本机路径读出来的图"起个能看的名字（只影响 alt 兜底与扩展名） */
function pastedName(seq, ext) { return `pasted-image-${seq}.${ext || 'png'}`; }

/* ---------- 语法 ----------
 * 配对规则与 web/editor.js 的 expandAssetTags 一致（同类型、且不短于开启长度）。
 * 两边必须完全一致：否则"这里认为在代码块里"和"渲染时认为在代码块里"会错开一行，
 * 结果是正文里的图片被漏改、或者代码示例里的 ![](…) 被改成 asset_img。 */
function fenceMap(lines) {
  const flags = new Array(lines.length).fill(false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) flags[i] = true;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!f) continue;
    const marker = f[1];
    /* 反引号围栏的行内不能再有反引号（CommonMark 规定），这种行不是围栏 */
    if (marker[0] === '`' && line.includes('`', f.index + marker.length)) continue;
    if (!fence) { fence = { ch: marker[0], len: marker.length }; flags[i] = true; }
    else if (marker[0] === fence.ch && marker.length >= fence.len) { fence = null; flags[i] = true; }
  }
  return flags;
}

const RE_ASSET = /\{%[-]?\s*asset_img\s+("[^"]*"|'[^']*'|\S+)([\s\S]*?)%\}/g;
/* 行内图片：`![alt](url "title")` 与 `![alt](<url with space>)` */
const RE_INLINE = /!\[([^\]]*)\]\(\s*(<[^>]*>|(?:\\.|[^()\n]|\([^()\n]*\))+?)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
/* Obsidian 的 `![[文件名]]` / `![[文件名|宽度]]`（wikilink）。
   Obsidian 导出的 md 里图片全是这种写法，光认 `![](…)` 会**一个都换不掉**，
   而且因为这条规则之前根本没走到 lookup，连"缺图"都不会报 —— 静默失败，最坏的一种。 */
const RE_WIKI = /!\[\[([^\[\]|]+)(?:\|[^\]]*)?\]\]/g;
/* 引用式图片：`![alt][id]` */
const RE_REF = /!\[([^\]]*)\]\[([^\]]*)\]/g;
/* 折叠式引用：`![id]`。必须后面不是 `(`（那是行内写法，上面已经处理过）。
   id 里也不许出现 `[` —— 那是 Obsidian 的 `![[x]]`，不该被这条规则咬掉半个。 */
const RE_COLLAPSED = /!\[([^\]\[]*)\](?!\()/g;
const RE_HTML = /<img\b[^>]*>/gi;
/* 引用式定义：`[id]: url "title"` */
const RE_DEF = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'))?[ \t]*$/;

function attr(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  if (!m) return '';
  return m[1] != null ? m[1] : m[2] != null ? m[2] : (m[3] || '');
}

/**
 * 主入口。
 *  @param text     整篇 md 的原文（可以带 front-matter）
 *  @param files    Map<相对路径, Buffer>：一起选进来的图片
 *  @param mdPath   md 在上传时的相对路径（用来把引用解析到"md 所在目录"）
 *  @param images   可选回调 (img, index) => tag|null：落盘并返回正文里要写的标签。
 *                  **为什么是回调**：资源名由内容哈希决定，得先有字节才能定；
 *                  而"能往哪个目录写"只有调用方（server.js）知道。返回 null 就保留原引用。
 *                  img 带 `alt`（原文里写的那个；没有就是空串，调用方自己退回文件名）。
 *  @param readLocal 可选回调 (绝对路径) => Buffer|null：允许读本机图片时用。
 *                  **为什么是回调**：这一层不碰 fs（要能单测），而"能不能读用户磁盘上的
 *                  任意路径"是调用方的决定 —— server.js 注入时会先卡扩展名白名单。
 *  @returns {markdown, meta, frontMatter, stats, missing}
 */
async function convert({ text, files, mdPath, images, readLocal, mode = 'auto' } = {}) {
  const raw = String(text || '');
  const parsed = lib.parseFrontMatter(raw);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  /* front-matter 结束那行后面通常还跟着一个空行（写 md 的习惯），
     不去掉的话导入完正文第一行就是空行 —— 看着像"开头莫名多了一行"。 */
  let lines = String(parsed.body).split(/\r?\n/);
  let lead = 0;
  while (lead < lines.length && !String(lines[lead]).trim()) lead++;
  if (lead) lines = lines.slice(lead);
  const flags = fenceMap(lines);

  /* 先匹配相对路径；只在文件名唯一时兜底，避免导入同名的另一张图片。 */
  const byPath = new Map();
  const byBase = new Map();
  for (const [k, buf] of files || []) {
    const key = normalizeRel(k);
    if (!key || !Buffer.isBuffer(buf)) continue;
    if (!byPath.has(key)) byPath.set(key, buf);
    const b = baseOf(key).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push({ path: key, buf });
  }
  const mdDir = dirOf(mdPath);

  const stats = { chars: 0, lines: lines.length, images: 0, missing: 0, remote: 0, skipped: 0, files: 0,
    embedded: 0, localPath: 0, ambiguous: 0 };          // ambiguous=无法确定路径的同名图片
  let pasteSeq = 0;
  for (const [, buf] of byPath) if (Buffer.isBuffer(buf)) stats.files++;
  const missingSet = new Set();
  const ambiguousSet = new Set();
  const written = new Set();
  let seq = 0;
  /* 找到的引用先记成一条"待办"，落盘留到后面统一做。
     **为什么不能边扫边落盘**：落盘回调是 async（要写文件），而 String.replace 的
     回调只能是同步的 —— 直接把回调的返回值当标签用，拿到的是一个 Promise，
     写进正文就变成 `[object Promise]`（这个坑踩过一次，而且只在真机上出现，
     单测里用同步回调根本试不出来）。所以先打个占位标记，扫完再逐个兑现。 */
  const entries = [];
  /** @param id 引用式定义的 id（用掉之后那行定义就成了孤儿，见文末） */
  function mark(raw, hit, alt, id) {
    const token = '\u0001MDIMG' + entries.length + '\u0001';
    entries.push({ token, raw, hit, alt, id });
    return token;
  }

  /** 一串引用 → 找到它的字节。找不到就把文件名记进 missing（前端要如实告诉用户哪张没带来）。
   *  三种来源，按"要不要用户额外提供文件"排：
   *    ① 内嵌 base64 —— 字节就在 md 里，最省事；
   *    ② 随 md 一起上传的文件 —— 用户多选 / 选文件夹带进来的；
   *    ③ 本机绝对路径 —— 服务端自己读（Typora 粘贴的默认形态）。
   *  三种都没有才叫缺图。 */
  function lookup(target, wiki = false) {
    /* ① data URI 必须**在 decodeTarget 之前**判断：
       那段 base64 里可能有 `%2B` 之类的转义被 decodeURIComponent 改掉，
       也可能被 `[?#].*$` 那条规则截掉尾巴 —— 一经处理就解不出原图了。 */
    const data = dataBytes(target);
    if (data) {
      stats.embedded++;
      return { buf: data.buf, key: pastedName(++pasteSeq, data.ext) };
    }
    const decoded = decodeTarget(target);
    if (!decoded) return null;
    if (isRemote(decoded)) { stats.remote++; return null; }   // 外链原样留着，不复制
    const t = normalize(decoded);
    const candidates = [joinRel(mdDir, t), t];
    if (wiki) candidates.splice(1, 0, joinRel(mdDir, 'assets/' + t));
    for (const candidate of candidates) {
      const cand = normalizeRel(candidate);
      if (cand && byPath.has(cand)) return { buf: byPath.get(cand), key: cand };
    }
    const hit = byBase.get(baseOf(t).toLowerCase());
    if (hit && hit.length === 1) return { buf: hit[0].buf, key: hit[0].path };
    /* 是 data URI 但不是图片（或解不出来）—— 它仍然是**自包含**的，
       既不复制也不该被报成"缺图"，原样留着就对了。 */
    if (/^data:/i.test(String(target || '').trim())) return null;
    /* ③ 长得像本机绝对路径、且调用方允许读 → 交给 emit 阶段去读（读文件是异步的）。
       key 用**原文件名**：alt 兜底时 Typora 那种 image-20260101120000 比 pasted-image-1 有用得多。 */
    if (readLocal && isLocalPath(decoded)) {
      const abs = toAbsPath(decoded);
      return { local: abs, key: normalize(abs) };
    }
    if (hit && hit.length > 1) ambiguousSet.add(t);
    missingSet.add(baseOf(t) || decoded);
    return null;
  }

  /** 落盘 + 换标签。返回 null 表示"这次换不了"，调用方保留原引用。 */
  async function emit(hit, alt) {
    if (typeof images !== 'function') { stats.skipped++; return null; }  // 没开资源目录：不是缺图，是没地方放
    /* 本机路径的图要在这儿才读：读文件是 async 的，而扫正文那一步只能同步。 */
    if (hit.local) {
      let buf = null;
      try { buf = (await readLocal(hit.local)) || null; } catch { buf = null; }
      if (!buf || !Buffer.isBuffer(buf) || !buf.length) {
        missingSet.add(baseOf(hit.local));
        return null;                                   // 路径不在了 / 不是图片 → 如实算缺图
      }
      stats.localPath++;
      hit = { buf, key: hit.key };
    }
    const fileName = lib.assetName(hit.buf, hit.key);
    let tag = null;
    /* alt 一并交给调用方：标签里的 alt 要写**原文里那个人写的**（`![alt](…)` 的 alt、
       `<img alt>`），没有才退回文件名。服务端只认字节，alt 只能由这一层给。 */
    try { tag = (await images({ data: hit.buf, name: hit.key, ext: lib.assetExt(hit.key, 'png'), alt: String(alt || '') }, seq++)) || null; }
    catch { tag = null; }
    if (!tag) { stats.skipped++; return null; }
    written.add(fileName);
    return tag;
  }

  /* 引用式定义先扫一遍：`![alt][id]` 里的 id 要查表才知道指向哪。
     顺带记下行号 —— 用掉之后那行定义就是孤儿，得删（见文末）。 */
  const defs = new Map();
  const defAt = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (flags[i]) continue;
    const m = RE_DEF.exec(lines[i]);
    if (!m) continue;
    defs.set(m[1].trim().toLowerCase(), m[2]);
    defAt.set(i, { id: m[1].trim(), target: m[2] });
  }
  const consumed = new Set();

  function rewrite(line) {
    const code = [];
    let s = line.replace(/(`+)[\s\S]*?\1(?!`)/g, (m) => {
      code.push(m);
      return '\u0002MDCODE' + (code.length - 1) + '\u0002';
    });
    /* ① 已经是 asset_img：字节带来了就重写成新资源名（同一篇再导一次也能对上） */
    s = s.replace(RE_ASSET, (m, file, rest) => {
      const hit = lookup(unquote(file));
      return hit ? mark(m, hit, String(rest || '').trim() || lib.altFromName(hit.key), '') : m;
    });
    /* ② <img src="…" alt="…"> */
    s = s.replace(RE_HTML, (m) => {
      const src = attr(m, 'src');
      if (!src) return m;
      const hit = lookup(src);
      return hit ? mark(m, hit, attr(m, 'alt'), '') : m;
    });
    /* ③ ![alt](url) */
    s = s.replace(RE_INLINE, (m, alt, url) => {
      const hit = lookup(url);
      return hit ? mark(m, hit, alt, '') : m;
    });
    /* ④ ![[文件名]]（Obsidian）—— 必须排在 ![alt][id] 与 ![id] **之前**：
         那两条会把 `![[a.png]]` 吞成 `![[a.png]`（id 里带着前导 `[`），
         虽然查不到定义会被原样退回，但结果就是永远换不成 asset_img。
         `|300` 那段是 Obsidian 的显示宽度，不是 alt，丢掉（alt 退回文件名）。 */
    s = s.replace(RE_WIKI, (m, name) => {
      if (mode === 'markdown' || !lib.assetExt(decodeTarget(name), '')) return m;
      const hit = lookup(name, true);
      return hit ? mark(m, hit, '', '') : m;
    });
    /* ⑤ ![alt][id] —— id 没在定义表里就别动（那多半是普通文本，不是图片引用） */
    s = s.replace(RE_REF, (m, alt, id) => {
      const key = String(id || alt || '').trim().toLowerCase();
      const target = defs.get(key);
      if (!target) return m;
      const hit = lookup(target);
      return hit ? mark(m, hit, alt, key) : m;
    });
    /* ⑥ ![id]（折叠式）—— 同上，只认定义表里存在的 id */
    s = s.replace(RE_COLLAPSED, (m, id) => {
      const key = String(id || '').trim().toLowerCase();
      const target = defs.get(key);
      if (!target) return m;
      const hit = lookup(target);
      return hit ? mark(m, hit, '', key) : m;
    });
    return s.replace(/\u0002MDCODE(\d+)\u0002/g, (_m, i) => code[Number(i)]);
  }

  const out = lines.map((line, i) => (flags[i] ? line : rewrite(line)));
  let body = out.join(eol);

  /* 兑现所有待办：换成功就写标签，换不了就退回原来那行引用（不假装成功）。 */
  for (const e of entries) {
    const tag = await emit(e.hit, e.alt);
    if (tag && e.id) consumed.add(e.id);
    body = body.replace(e.token, () => tag || e.raw);
  }

  /* 引用式定义被图片用掉之后就没人引用了，留着是一行死链接。
     但**同一个 id 也可能被普通链接引用**（`[文字][id]`），所以先看看正文里还有没有
     `][id]` —— 有就得把定义留着。 */
  const drop = new Set();
  for (const [i, d] of defAt) {
    if (!consumed.has(d.id.toLowerCase())) continue;
    if (new RegExp('\\[[^\\]]*\\]\\[[ \\t]*' + escRE(d.id) + '[ \\t]*\\]', 'i').test(body)) continue;
    drop.add(i);
  }
  /* 必须拿**兑换过之后**的正文按行过滤：out 里的那些行还带着占位标记，
     用它重建正文会把刚换好的标签又冲掉（引用式/折叠式才会走到这里，所以只有这两条路径炸）。 */
  if (drop.size) body = body.split(eol).filter((_, i) => !drop.has(i)).join(eol);

  stats.chars = body.length;
  stats.images = written.size;
  stats.missing = missingSet.size;
  stats.ambiguous = ambiguousSet.size;
  return {
    markdown: body,
    meta: parsed.data || {},
    frontMatter: parsed.header || '',
    stats,
    missing: [...missingSet],
  };
}

/* ---------------- multipart/form-data 解析 ----------------
 * 浏览器用 FormData 发的就是这种格式。自己解析而 **不引第三方库**：
 * 整包才 80MB 上限、字段只有三四类，引一个 multipart 解析器不值当。
 *
 * 关键的一点：分段的分界必须按 `\r\n--boundary` 去找，而不是只找 `--boundary`。
 * 图片字节里出现 `--boundary` 的概率不算低，只找短的那个会把一张图拦腰截断；
 * 带上前导 CRLF 之后，那其实正是"这一段到此为止"的唯一正确位置。 */
function fieldOf(headers) {
  const out = { name: '', filename: '' };
  for (const line of String(headers || '').split(/\r?\n/)) {
    const m = /^content-disposition\s*:\s*(.*)$/i.exec(line.trim());
    if (!m) continue;
    /* 按 param=value 抓，value 可能是带引号的字符串（里面还能有分号） */
    for (const p of m[1].matchAll(/([A-Za-z0-9_*-]+)\s*=\s*(?:"([^"]*)"|([^;]*))/g)) {
      const k = p[1].toLowerCase();
      const v = (p[2] != null ? p[2] : String(p[3] || '')).trim();
      if (k === 'name') out.name = v;
      else if (k === 'filename') out.filename = v;
    }
  }
  return out;
}

function parseMultipart(buf, boundary) {
  const parts = [];
  if (!Buffer.isBuffer(buf) || !boundary) return parts;
  const head = Buffer.from('--' + boundary, 'latin1');
  const delim = Buffer.from('\r\n--' + boundary, 'latin1');
  /* 第一段前面没有 CRLF，它的分界就在第 0 个字节上 */
  let pos = buf.length >= head.length && buf.subarray(0, head.length).equals(head) ? 0 : -1;
  if (pos < 0) {
    const i = buf.indexOf(delim);
    if (i < 0) return parts;
    pos = i + 2;                                  // 跳过 CRLF，指向 '--'
  }
  for (;;) {
    const after = pos + head.length;
    if (buf.subarray(after, after + 2).toString('latin1') === '--') break;   // 结束分界
    const hs = after + 2;                                                    // 跳过分界后的 CRLF
    const he = buf.indexOf('\r\n\r\n', hs, 'latin1');
    if (he < 0) break;
    const meta = fieldOf(buf.subarray(hs, he).toString('utf8'));
    const bs = he + 4;
    const next = buf.indexOf(delim, bs, 'latin1');
    if (next < 0) break;
    parts.push({ name: meta.name, filename: meta.filename, data: buf.subarray(bs, next) });
    pos = next + 2;
  }
  return parts;
}

module.exports = { convert, parseMultipart, decodeTarget, fenceMap, MD_EXT, isLocalPath, toAbsPath, dataBytes };

/* 命令行：node mdimport.js a.md [图片目录]  → 打印转换结果，用来离线核对 */
if (require.main === module) {
  const fs = require('fs');
  const p = require('path');
  const file = process.argv[2];
  if (!file) { console.log('用法: node mdimport.js <a.md> [图片所在目录]'); process.exit(1); }
  const files = new Map();
  for (const dir of process.argv.slice(3)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) files.set(e.name, fs.readFileSync(p.join(dir, e.name)));
    }
  }
  /* convert 是 async（落盘回调是异步的），这里得接着 Promise 再打印 */
  convert({ text: fs.readFileSync(file, 'utf8'), files, mdPath: p.basename(file), images: null }).then((r) => {
    console.log(r.markdown);
    console.log('---');
    console.log(JSON.stringify(r.stats), r.missing.length ? '缺图: ' + r.missing.join(', ') : '');
  });
}
