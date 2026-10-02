// lib.js —— 与博客打交道的所有"文件层"逻辑
// 只依赖 Node 内置模块，不需要 npm install 任何东西
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fm = require('./frontmatter');
const storage = require('./storage');
const yaml = require('../vendor/js-yaml');

const WIN_BAD = /[<>:"/\\|?*\x00-\x1f]/g;   // Windows 文件名非法字符

/** 1) 定位博客根目录：必须包含 _config.yml 且含 hexo 依赖 */
function isBlogRoot(dir) {
  try {
    if (!fs.existsSync(path.join(dir, '_config.yml'))) return false;
    if (!fs.existsSync(path.join(dir, 'source', '_posts'))) return false;
    return true;
  } catch {
    return false;
  }
}

function findBlogRoot(startDir) {
  let cur = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 8; i++) {
    if (isBlogRoot(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/** 2) 标题 -> 文件名。中文直接保留（你的 permalink 是 :title/，Hexo 会自己 URL 编码） */
function sanitizeName(title) {
  let n = String(title || '').replace(WIN_BAD, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/[. ]+$/, '');              // Windows 不允许文件名以点/空格结尾
  if (!n) n = 'untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n)) {
    throw Object.assign(new Error('文件名不能使用 Windows 保留名称'), {status:400});
  }
  if (n.length > 120) n = n.slice(0, 120);
  return n;
}

/** 3) 防路径穿越：任何用户传来的文件名都必须落在这两个目录内 */
function resolveInside(baseDir, name, ext = '.md') {
  const full = path.resolve(baseDir, name + ext);
  const rel = path.relative(baseDir, full);
  // 校验的是"最终文件必须是 baseDir 的子路径"，而不是只看输入字符串
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('非法路径'), { status: 400 });
  }
  let cursor = path.resolve(baseDir);
  for (const part of ['', ...rel.split(path.sep)]) {
    cursor = part ? path.join(cursor, part) : cursor;
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw Object.assign(new Error('不允许通过符号链接访问文件'), {status:400});
    }
  }
  return full;
}

const { parseFrontMatter, buildFrontMatter } = fm;
function stripQuote(s) { return typeof s === 'string' ? s.replace(/^(["'])(.*)\1$/, '$2') : s; }
function validateDate(value) {
  const text=String(value || '');
  const m=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  if(!m || +m[2]<1 || +m[2]>12 || +m[3]<1 || +m[3]>new Date(Date.UTC(+m[1],+m[2],0)).getUTCDate() || +(m[4]||0)>23 || +(m[5]||0)>59 || +(m[6]||0)>59 || Number.isNaN(Date.parse(text.replace(' ','T')))) {
    throw Object.assign(new Error('日期无效，请使用 YYYY-MM-DD HH:mm:ss 或 ISO 日期'),{status:400});
  }
  return text;
}

/** 6) 时间格式：Hexo 认 "YYYY-MM-DD HH:mm:ss"，本地时区 */
function formatDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 7) 列出所有文章：_posts 与 _drafts 一起扫，读文件名 + 从 front-matter 拿标题/日期。
 *  draft 标志会一路带到前端，删除/打开/上传都得靠它选对目录。 */
function listPosts(blogRoot, query = '') {
  const out = [];
  for (const sub of ['_posts', '_drafts']) {
    const dir = path.join(blogRoot, 'source', sub);
    if (!fs.existsSync(dir)) continue;                 // 没有草稿目录很正常
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      const full = path.join(dir, e.name);
      let title = e.name.replace(/\.md$/i, ''), date = '', size = 0, mtime = 0, meta = {}, raw = ''; 
      try {
        const st = fs.statSync(full);
        size = st.size; mtime = st.mtimeMs;
        date = st.mtime.toISOString();
        raw = fs.readFileSync(full, 'utf8');
        const { data } = parseFrontMatter(raw); meta = data;
        if (data.title) title = String(data.title);
        if (data.date) date = String(data.date);
      } catch { /* 单篇读失败不影响整体 */ }
      if (query && !(title + '\n' + e.name + '\n' + raw).toLowerCase().includes(query.toLowerCase())) continue;
      out.push({ name: e.name.slice(0, -3), title, date, size, mtime, categories: meta.categories || [], tags: meta.tags || [], revision: storage.revision(raw), draft: sub === '_drafts' });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 7.1) 读一篇。draft 显式给了就只查对应目录；没给就两边都找（兼容旧调用）。 */
function readPost(blogRoot, name, draft) {
  const subs = draft === true ? ['_drafts'] : draft === false ? ['_posts'] : ['_posts', '_drafts'];
  for (const sub of subs) {
    let file;
    try { file = resolveInside(path.join(blogRoot, 'source', sub), name); }
    catch (e) { throw e; }
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const { data, body, header } = parseFrontMatter(raw);
    /* 是否草稿只看目录，不看 front-matter。
       理由：Hexo 判定"发不发布"的唯一依据是文件在 _posts 还是 _drafts
       （见 hexo/dist/plugins/processor/post.js:254，_drafts 一律 published:false）。
       如果这里再看 layout: draft，那么一篇留在 _posts 里的旧草稿会被误判成草稿，
       一保存就被搬去 _drafts —— 反而把已发布的文章藏起来了。 */
    return { name, file, meta: data, body, frontMatter: header, revision: storage.revision(raw), draft: sub === '_drafts' };
  }
  throw Object.assign(new Error('文章不存在'), { status: 404 });
}

/** 8) 图片扩展名：走白名单，认不出来的（或 .exe 之类危险的）一律按 png 处理，
 *  避免把奇怪扩展名写进博客目录 */
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff', 'tif']);
function assetExt(original, fallbackExt = 'png') {
  const ext = path.extname(String(original || '')).replace(/^\./, '').toLowerCase();
  return IMG_EXT.has(ext) ? ext : fallbackExt;
}

/** 8.1) 图片资源名 = 文件内容的 MD5 + 扩展名。
 *  名字完全由字节内容决定，好处有两个：
 *    - 同一张图不管原始文件名叫什么、传几次，算出来的名字都一样 —— 于是重复上传
 *      会命中同一个文件，落盘前发现已存在就直接复用，目录里永远只有一份；
 *    - 不同的图一定算出不同名字，不存在"同名覆盖"这回事。
 *  代价是文件名不可读，所以 md 里的 alt 仍然写原始文件名（见 altFromName）。 */
function assetName(buf, original, fallbackExt = 'png') {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  const hash = crypto.createHash('md5').update(data).digest('hex');
  return `${hash}.${assetExt(original, fallbackExt)}`;
}

/** 8.2) md 里的 alt 文本：用原始文件名（去掉扩展名），这样即使文件名是哈希，
 *  人读 md 时还能看出这张图原来叫什么。方括号会破坏 markdown 语法，要清掉。 */
function altFromName(original) {
  const s = path.basename(String(original || ''), path.extname(String(original || '')))
    .replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return s || 'image';
}

/** 8.3) 插入 md 的写法：Hexo 原生 asset_img 标签，而不是 `![](文件名)`。
 *  为什么不能用 markdown 写法（真机实测，见 README 第 4.2 节）：
 *  博客没装 hexo-asset-image 之类插件，裸 marked 不会把相对路径翻译成资源地址，
 *  `![x](a.png)` 生成的是 `<img src="/a.png">` —— 站点根目录没这个文件，必坏。
 *  `{% asset_img a.png %}` 则由 Hexo 自己查 PostAsset 表，生成
 *  `/2026/09/30/文章名/a.png`，正确且图片会被复制进 public。
 *  注意 alt 里的空格会让标签参数错位，一律换成连字符。 */
function assetTag(fileName, original) {
  const alt = altFromName(original).replace(/[{}%<>"']/g, '').replace(/\s+/g, '-');
  return `{% asset_img ${fileName} ${alt} %}`;
}

/** 9) 文章所在目录：草稿进 _drafts，正式进 _posts（服务端与写入端共用，避免两处硬编码走偏） */
function postDir(blogRoot, draft) {
  return path.join(blogRoot, 'source', draft ? '_drafts' : '_posts');
}

/** 递归删除。自己写而不用 fs.rmSync：一是老 Node 没有，二是能避开某些环境里
 *  rmSync 被劫持成"送系统回收站"从而卡死的问题。 */
function rmrf(target) {
  if (!fs.existsSync(target)) return;
  const st = fs.lstatSync(target);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target)) rmrf(path.join(target, e));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

function writePost(blogRoot, { name, meta, body, originalName, originalDraft, revision, changedFields, frontMatter }) {
  name=sanitizeName(name);const dir=postDir(blogRoot,meta.draft);
  const file=resolveInside(dir,name),assets=resolveInside(dir,name,'');
  const oldFile=originalName ? resolveInside(postDir(blogRoot,!!originalDraft),originalName) : null;
  const oldAssets=originalName ? resolveInside(postDir(blogRoot,!!originalDraft),originalName,'') : null;
  if(oldFile && !fs.existsSync(oldFile))throw Object.assign(new Error('原文章已被删除或移动，请重新打开'),{status:409});
  const previous=oldFile ? fs.readFileSync(oldFile,'utf8') : null;
  if(previous!=null && revision!==undefined && storage.revision(previous)!==revision)throw Object.assign(new Error('文章已在外部被修改，请先保存本地恢复副本，再重新打开对比'),{status:409});
  if(file!==oldFile && fs.existsSync(file))throw Object.assign(new Error('目标目录存在同名文章，请换一个文件名'),{status:409});
  if(oldAssets && oldAssets!==assets && fs.existsSync(oldAssets) && fs.existsSync(assets))throw Object.assign(new Error('目标资源目录已存在，拒绝合并或覆盖图片'),{status:409});
  const parsed=parseFrontMatter(previous || '');
  let header=frontMatter===undefined ? parsed.header : String(frontMatter);
  const base=fm.parseYAML(header),changes={};
  const fields=changedFields || ['title','date','categories','tags','description','keywords','cover','mathjax','top'];
  for(const key of fields) {
    if(!['title','date','categories','tags','description','keywords','cover','mathjax','top'].includes(key) || meta[key]===undefined)continue;
    let value=meta[key];
    if(['categories','tags'].includes(key)) {
      const normalize=v=>Array.isArray(v) ? v : String(v||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean);
      if(JSON.stringify(normalize(base[key]))===JSON.stringify(normalize(value)))continue;
      value=normalize(value);
    }
    if(key==='top' && value!=='') {value=Number(value);if(!Number.isFinite(value))throw Object.assign(new Error('置顶值必须是数字'),{status:400});}
    changes[key]=(value==='' || value===false || (Array.isArray(value)&&!value.length)) ? null : value;
  }
  if(previous==null) {changes.title=meta.title;changes.date=meta.date || formatDate();}
  if(meta.draft) { if(!base.layout || base.layout==='post')changes.layout='draft'; }
  else if(base.layout==='draft')changes.layout=null;
  header=fm.patchHeader(header,changes,parsed.eol);
  const data=fm.parseYAML(header);
  if(!String(data.title||'').trim())throw Object.assign(new Error('标题不能为空'),{status:400});
  if(data.date)validateDate(data.date);
  const content='---'+parsed.eol+header+parsed.eol+'---'+parsed.eol+String(body || '');
  if(previous!==null)storage.backupPost(blogRoot,originalName,originalDraft,previous);
  if(originalName && (originalName!==name || !!originalDraft!==!!meta.draft))storage.moveHistory(blogRoot,originalName,originalDraft,name,meta.draft);
  fs.mkdirSync(dir,{recursive:true});let moved=false,createdAssets=false;
  try {
    storage.atomicWrite(file,content);
    if(oldAssets && oldAssets!==assets && fs.existsSync(oldAssets)) {fs.renameSync(oldAssets,assets);moved=true;}
    else if(!fs.existsSync(assets)){fs.mkdirSync(assets,{recursive:true});createdAssets=true;}
    if(oldFile && oldFile!==file)fs.unlinkSync(oldFile);
  } catch(e) {
    if(moved)fs.renameSync(assets,oldAssets);
    if(createdAssets)fs.rmdirSync(assets);
    if(file===oldFile && previous!==null)storage.atomicWrite(file,previous);
    else if(fs.existsSync(file))fs.unlinkSync(file);
    throw e;
  }
  return file;
}

/* ---------------- 草稿 <-> 正式 ----------------
 * 先说清楚规则，否则很容易做错方向：
 *   Hexo 判断"发不发布"只认目录。_drafts 里的文章 published=false，
 *   在 render_drafts: false（默认值）下连生成都不会生成，自然也不会被 deploy 推走。
 *   所以「草稿 = 只存在于本地、绝不发布」这件事由目录保证，不需要额外开关。
 *   而 front-matter 里的 `layout: draft` 是 Hexo 官方 `hexo new draft` 留下的标记，
 *   hexo 自己的 publish 会把它改成 post（hexo/dist/hexo/post.js:290）。
 *   发表时必须清掉它，否则正式文章会去找主题里根本不存在的 draft 布局。 */

/** 对原文做最小改动：加/去 `layout: draft`，其余字段一个字节都不动。
 *  （不用 buildFrontMatter 重建，是因为那会丢掉文章里我们没建模的自定义字段。） */
function setDraftFlag(raw, draft) {
  const text = String(raw || '');
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*\r?\n?)/.exec(text);
  if (!m) return draft ? `---\nlayout: draft\n---\n${text}` : text;
  // 只删值为 draft 的 layout；用户自己写的 layout: page 之类不能动
  const lines = m[2].split(/\r?\n/).filter(l => !/^[ \t]*layout[ \t]*:[ \t]*draft[ \t]*$/i.test(l));
  if (draft) lines.unshift('layout: draft');
  return m[1] + lines.join('\n') + m[3] + text.slice(m[0].length);
}

/** 发表草稿 / 把正式文章转回草稿：md 与同名资源目录一起搬，图片不会丢。
 *  publish=true  -> 搬到 _posts 并去掉 layout: draft
 *  publish=false -> 搬到 _drafts 并加上 layout: draft */
function publishPost(blogRoot,name,fromDraft,publish,revision) {
  const current=readPost(blogRoot,name,fromDraft);
  const file=writePost(blogRoot,{name,originalName:name,originalDraft:fromDraft,
    revision,meta:{...current.meta,draft:!publish},changedFields:[],body:current.body});
  return {name,draft:!publish,file};
}

/* ---------------- 博客配置文件：原文编辑、版本校验与备份 ---------------- */
const CONFIG_NAME = /^_?config(?:\.[a-z0-9_-]+)*\.ya?ml$/i;
const CONFIG_MAX = 1024 * 1024;
function parseBlogConfig(content) {
  if(typeof content!=='string' || Buffer.byteLength(content,'utf8')>CONFIG_MAX)throw Object.assign(new Error('配置内容必须是文本，且不能超过 1MB'),{status:400});
  let data;
  try {data=yaml.load(content,{schema:yaml.CORE_SCHEMA}) ?? {};}
  catch(e) {throw Object.assign(new Error('YAML 格式错误：'+e.message),{status:400});}
  if(typeof data!=='object' || Array.isArray(data))throw Object.assign(new Error('配置文件必须是 YAML 对象'),{status:400});
  for(const key of ['__proto__','constructor','prototype'])if(Object.hasOwn(data,key))throw Object.assign(new Error('不支持的配置字段：'+key),{status:400});
  try {JSON.stringify(data);}catch {throw Object.assign(new Error('配置不能包含循环引用'),{status:400});}
  return data;
}
function listConfigFiles(blogRoot) {
  return fs.readdirSync(blogRoot,{withFileTypes:true}).filter(e=>e.isFile() && CONFIG_NAME.test(e.name)).map(e=>e.name)
    .sort((a,b)=>a==='_config.yml'?-1:b==='_config.yml'?1:a.localeCompare(b));
}
function readConfig(blogRoot,name) {
  if(typeof name!=='string' || !CONFIG_NAME.test(name))throw Object.assign(new Error('只能编辑博客根目录的 config / _config 系列 YAML 文件'),{status:400});
  const file=resolveInside(blogRoot,name,'');
  try {
    const stat=fs.statSync(file);
    if(!stat.isFile())throw Object.assign(new Error('配置文件不存在'),{status:404});
    if(stat.size>CONFIG_MAX)throw Object.assign(new Error('配置文件不能超过 1MB'),{status:400});
    const content=fs.readFileSync(file,'utf8');
    return {name,content,revision:storage.revision(content)};
  } catch(e) {if(e.code==='ENOENT')throw Object.assign(new Error('配置文件不存在'),{status:404});throw e;}
}
function writeConfig(blogRoot,name,content,revision) {
  if(!revision)throw Object.assign(new Error('缺少配置版本，请重新读取文件'),{status:428});
  const current=readConfig(blogRoot,name);
  if(current.revision!==revision)throw Object.assign(new Error('配置已在外部修改，请重新读取后再保存'),{status:409});
  parseBlogConfig(content);
  const eol=current.content.includes('\r\n')?'\r\n':'\n';
  content=(current.content.startsWith('\uFEFF')?'\uFEFF':'')+content.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\n/g,eol);
  if(Buffer.byteLength(content,'utf8')>CONFIG_MAX)throw Object.assign(new Error('配置文件不能超过 1MB'),{status:400});
  const backup=path.join('.hexo-tool-history','configs',name+'.'+Date.now()+'-'+crypto.randomBytes(6).toString('hex')+'.bak');
  const backupFile=resolveInside(blogRoot,backup,'');
  storage.ensureHistory(blogRoot);
  storage.atomicWrite(backupFile,current.content);
  storage.atomicWrite(resolveInside(blogRoot,name,''),content);
  return {name,content,revision:storage.revision(content),backup:backup.split(path.sep).join('/')};
}

/* ---------------- 读站点配置 ---------------- */
function readSiteConfig(blogRoot) {
  const data=parseBlogConfig(fs.readFileSync(path.join(blogRoot,'_config.yml'),'utf8'));
  const deploys=(Array.isArray(data.deploy) ? data.deploy : [data.deploy]).filter(d=>d&&typeof d==='object');
  return {renderDrafts:!!data.render_drafts,defaultLayout:data.default_layout||'post',url:data.url||'',
    postAssetFolder:!!data.post_asset_folder,deploy:deploys[0]||null,deploys,
    permalink:String(data.permalink||':year/:month/:day/:title/'),publicDir:String(data.public_dir||'public')};
}

/* ---------------- 编译产物路径（permalink） ----------------
 * 光有"编译成功"是不够的：写完一篇文章，用户真正想看的是"编译出来的那页在哪"。
 * Hexo 不提供反查接口，只能照着 _config.yml 的 permalink 模板，用文章自己的
 * date + slug 把路径算出来，再去 public/ 下验证文件真的存在。
 *
 * 只认下面这些占位符。遇到不认识的（:abbrlink / :hash / :category …）**返回 null**，
 * 由调用方如实说"推不出来" —— 编一个看起来合理其实 404 的链接，比不显示更糟。 */
const PERMALINK_TOKENS = ['year','month','i_month','day','i_day','hour','minute','second','title','name','post_title'];

/** 算出相对输出路径（形如 `2026/10/01/某篇/`）；模板含未知占位符或日期非法时返回 null。 */
function permalinkPath(template, { date, slug }) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const map = {
    year: String(date.getFullYear()), month: pad(date.getMonth() + 1), i_month: String(date.getMonth() + 1),
    day: pad(date.getDate()), i_day: String(date.getDate()),
    hour: pad(date.getHours()), minute: pad(date.getMinutes()), second: pad(date.getSeconds()),
    title: slug, name: slug, post_title: slug,
  };
  let unknown = null;
  const replaced = String(template || '').replace(/:([A-Za-z_]+)/g, (whole, key) => {
    const k = key.toLowerCase();
    if (k in map) return map[k];
    unknown = k;                                   // 只记第一个就够报错用了
    return whole;
  });
  if (unknown) return null;
  const clean = replaced.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  return clean ? clean + '/' : '';
}

/** 一篇文章编译后在 public/ 里的落点。exists=false 表示还没编译过（或它压根不会被生成）。 */
function resolvePostOutput(blogRoot, name, draft) {
  const post = readPost(blogRoot, name, draft);
  const cfg = readSiteConfig(blogRoot);
  const raw = post.meta.date;
  const date = raw instanceof Date ? raw : new Date(raw);
  const slug = String(post.meta.slug || name);
  const rel = permalinkPath(cfg.permalink, { date, slug });
  if (rel === null) {
    return { ok:false, draft:!!post.draft, title:String(post.meta.title||name),
      reason:`_config.yml 里的 permalink（${cfg.permalink}）含本工具不认识的占位符，无法推算产物路径` };
  }
  const dir = path.join(blogRoot, cfg.publicDir, ...rel.split('/').filter(Boolean));
  const file = path.join(dir, 'index.html');
  const exists = fs.existsSync(file);
  return { ok:true, draft:!!post.draft, title:String(post.meta.title||name),
    url:'/' + rel, dir, exists, mtime: exists ? fs.statSync(file).mtimeMs : 0 };
}

function detectImage(buf) {
  if(buf.length>=24 && buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(buf.length>=4 && buf[0]===255 && buf[1]===216 && buf[2]===255 && buf.at(-2)===255 && buf.at(-1)===217)return 'jpg';
  if(buf.length>=13 && /^(GIF87a|GIF89a)$/.test(buf.toString('ascii',0,6)))return 'gif';
  if(buf.length>=16 && buf.toString('ascii',0,4)==='RIFF' && buf.toString('ascii',8,12)==='WEBP')return 'webp';
  if(buf.length>=26 && buf.toString('ascii',0,2)==='BM')return 'bmp';
  if(buf.length>=16 && ['avif','avis'].includes(buf.toString('ascii',8,12)))return 'avif';
  if(buf.length>=8 && ['49492a00','4d4d002a'].includes(buf.subarray(0,4).toString('hex')))return 'tiff';
  if(buf.length>=22 && buf.subarray(0,4).toString('hex')==='00000100')return 'ico';
  throw Object.assign(new Error('文件不是支持的图片；SVG 请先转换为 PNG'),{status:415});
}
function listAssets(blogRoot,name,draft) {
  const current=readPost(blogRoot,name,draft);const dir=resolveInside(postDir(blogRoot,draft),name,'');
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&IMG_EXT.has(assetExt(e.name,''))).map(e=>({
    name:e.name,size:fs.statSync(path.join(dir,e.name)).size,referenced:current.body.includes(e.name)||String(current.meta.cover||'').includes(e.name),
  }));
}

/* ---------------- 回收站 ----------------
 * 放在博客根目录下（与 source 同盘，所以"删除"只是一次 rename，瞬时且不占双倍空间）。
 * 目录里写一个 .gitignore(*)，免得回收站的内容被 git 一起提交上去。 */
const TRASH_DIRNAME = '.hexo-tool-trash';
function trashDir(blogRoot) { return path.join(blogRoot, TRASH_DIRNAME); }

function ensureTrash(blogRoot) {
  const d = trashDir(blogRoot);
  fs.mkdirSync(d, { recursive: true });
  const gi = path.join(d, '.gitignore');
  if (!fs.existsSync(gi)) {
    try { fs.writeFileSync(gi, '*\n', 'utf8'); } catch { /* 非致命 */ }
  }
  return d;
}

function newTrashId() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/** 把一篇文章（md + 同名资源目录）挪进回收站，返回这条记录的元信息 */
function moveToTrash(blogRoot, name, draft) {
  const src = postDir(blogRoot, !!draft);
  const mdFile = resolveInside(src, name);
  if (!fs.existsSync(mdFile)) throw Object.assign(new Error('文章不存在'), { status: 404 });

  let title = name, size = fs.statSync(mdFile).size, assetCount = 0;
  try { title = parseFrontMatter(fs.readFileSync(mdFile, 'utf8')).data.title || name; } catch { /* 读不出就用文件名 */ }
  const assets = path.join(src, name);
  if (fs.existsSync(assets)) {
    for (const f of fs.readdirSync(assets, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      assetCount++;
      try { size += fs.statSync(path.join(assets, f.name)).size; } catch { /* 忽略 */ }
    }
  }

  const id = newTrashId();
  const safe = sanitizeName(name).slice(0, 60) || 'untitled';
  const dest = path.join(ensureTrash(blogRoot), `${id}-${safe}`);
  fs.mkdirSync(dest, { recursive: true });
  let movedMd=false, movedAssets=false;
  try {
    fs.renameSync(mdFile, resolveInside(dest, name)); movedMd=true;
    if (fs.existsSync(assets)) {fs.renameSync(assets, path.join(dest, name)); movedAssets=true;}
  } catch(e) {
    if(movedAssets)fs.renameSync(path.join(dest,name),assets);
    if(movedMd)fs.renameSync(resolveInside(dest,name),mdFile);
    rmrf(dest);throw e;
  }

  const meta = {
    id, dir: path.basename(dest), name, title,
    source: draft ? '_drafts' : '_posts',
    deletedAt: formatDate(), size, assetCount,
  };
  try {storage.atomicWrite(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2));}
  catch(e) {if(fs.existsSync(path.join(dest,name)))fs.renameSync(path.join(dest,name),assets);fs.renameSync(resolveInside(dest,name),mdFile);rmrf(dest);throw e;}
  return meta;
}

function listTrash(blogRoot) {
  const d = trashDir(blogRoot);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(d, e.name, 'meta.json'), 'utf8'))); }
    catch { /* 缺 meta.json 的目录不是我们放的，跳过 */ }
  }
  return out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

/** 按 id 找到回收站里的那条（id 也接受目录名） */
function findTrashItem(blogRoot, id) {
  const d = trashDir(blogRoot);
  if (!fs.existsSync(d) || !id) return null;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(d, e.name, 'meta.json'), 'utf8')); }
    catch { continue; }
    if (meta.id === id || e.name === id) return { dir: path.join(d, e.name), meta };
  }
  return null;
}

function restoreFromTrash(blogRoot,id) {
  const hit=findTrashItem(blogRoot,id);
  if(!hit)throw Object.assign(new Error('回收站里没有这条记录'),{status:404});
  const {dir,meta}=hit;
  if(!['_posts','_drafts'].includes(meta.source) || !meta.name || /[\\/]/.test(meta.name))throw Object.assign(new Error('回收站元数据无效'),{status:400});
  const dest=path.join(blogRoot,'source',meta.source);fs.mkdirSync(dest,{recursive:true});
  const md=resolveInside(dest,meta.name),assets=resolveInside(dest,meta.name,'');
  const srcMd=resolveInside(dir,meta.name),srcAssets=resolveInside(dir,meta.name,'');
  if(fs.existsSync(md)||fs.existsSync(assets))throw Object.assign(new Error('目标文章或资源目录已存在，不会覆盖'),{status:409});
  if(!fs.existsSync(srcMd))throw Object.assign(new Error('回收站文章文件缺失'),{status:404});
  let moved=false;
  try {fs.renameSync(srcMd,md);moved=true;if(fs.existsSync(srcAssets))fs.renameSync(srcAssets,assets);}
  catch(e) {if(moved)fs.renameSync(md,srcMd);throw e;}
  rmrf(dir);return meta;
}

/** 回收站空了就把目录壳也删掉，别在博客根目录留下看不见的遗留物。
 *  （下次删除时 ensureTrash 会连同 .gitignore 一起重建） */
function pruneTrash(blogRoot) {
  const d = trashDir(blogRoot);
  if (!fs.existsSync(d)) return;
  const left = fs.readdirSync(d).filter(n => n !== '.gitignore');
  if (!left.length) rmrf(d);
}

function deleteFromTrash(blogRoot, id) {
  const hit = findTrashItem(blogRoot, id);
  if (!hit) throw Object.assign(new Error('回收站里没有这条记录'), { status: 404 });
  rmrf(hit.dir);
  pruneTrash(blogRoot);
  return hit.meta;
}

function emptyTrash(blogRoot) {
  const items = listTrash(blogRoot);
  for (const it of items) {
    const hit = findTrashItem(blogRoot, it.id);
    if (hit) rmrf(hit.dir);
  }
  pruneTrash(blogRoot);
  return items.length;
}

module.exports = {
  ...storage, validateDate, detectImage, listAssets,
  isBlogRoot, findBlogRoot, sanitizeName, resolveInside,
  parseFrontMatter, buildFrontMatter, formatDate, postDir, rmrf,
  assetExt, assetName, altFromName, assetTag,
  listPosts, readPost, writePost,
  setDraftFlag, publishPost, readSiteConfig,
  listConfigFiles, readConfig, writeConfig,
  permalinkPath, resolvePostOutput,
  trashDir, moveToTrash, listTrash, findTrashItem, pruneTrash,
  restoreFromTrash, deleteFromTrash, emptyTrash,
};
