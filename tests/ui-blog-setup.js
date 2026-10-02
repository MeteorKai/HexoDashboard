/* 搭一个"够真但完全可丢"的博客，专门用来做界面验收/真跑 hexo。
 *
 *   node tests/ui-blog-setup.js            # 用默认真博客当素材源
 *   node tests/ui-blog-setup.js D:\myblog
 *
 * 为什么要它：做一轮界面验收要重复"造临时博客 + 借 node_modules/主题 + 剥掉 deploy 段"
 * 这三步，手工做过三次了。固化成脚本后，验收只剩"起服务 + 截图"。
 *
 * 两条安全底线：
 *   ① node_modules / themes 走 **junction**（不复制，省几万个文件）；
 *      因此清理时必须先 unlink 掉 junction，否则递归删除会顺着链接删进真博客。
 *   ② _config.yml 里 **剥掉 deploy 段** —— 临时博客永远不该有推送能力。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const REAL = process.argv[2] || process.env.HEXO_BLOG || 'D:\\myblog';
const BLOG = path.join(os.tmpdir(), 'hexo-ui-blog');

/* ── 清场：先拆 junction，再删目录 ───────────────────────────────────────── */
function removeTree(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return fs.unlinkSync(p);          // junction 只拆链接
  if (!st.isDirectory()) return fs.unlinkSync(p);
  for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
  fs.rmdirSync(p);
}

/* ── 剥掉顶层 deploy: 段（连同其后所有缩进行） ──────────────────────────── */
function stripDeploy(yaml) {
  const lines = yaml.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^deploy\s*:/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (/^\s/.test(line) || line.trim() === '') continue;   // 仍属 deploy 段的缩进行/空行
      skipping = false;                                       // 遇到下一个顶层键，恢复
    }
    out.push(line);
  }
  return out.join('\n');
}

/* ── 种子文章：一篇已发布 + 一篇草稿，列表不空才看得出字号和层级 ────────── */
function post(title, date, body) {
  return `---\ntitle: ${title}\ndate: ${date}\ntags: [渗透测试, 内网]\ncategories: [tech_article]\n---\n\n${body}\n`;
}

const BODY = [
  '## 一、背景',
  '',
  '这是一段用来**观察正文可读性**的示例文字。字号、行高、墨色浓度够不够，',
  '盯着这一段看最直观：中文小字最怕"颜色淡 + 字号小"两件事撞在一起。',
  '',
  '## 二、复现步骤',
  '',
  '1. 先起一条隧道，把流量引到本地代理',
  '2. 用 `asset_img` 插入截图，确认图片能从同名资源目录里解析出来',
  '3. 对比预览区与编辑区的字号是否协调',
  '',
  '> 引用块也要能看清。这里的底色是强调色的极淡版本，文字必须仍然压得住。',
  '',
  '## 三、结论',
  '',
  '| 检查项 | 结果 | 备注 |',
  '|---|---|---|',
  '| 正文对比度 | 通过 | 正文与次要文字都要够 |',
  '| 控件轮廓 | 通过 | 输入框不能看着像没有边框 |',
  '| 行分隔 | 通过 | 太淡就等于没有层级 |',
  '',
  '```bash',
  '# 代码块在正文里也会出现，同样要够清楚',
  'hexo clean && hexo generate',
  '```',
  '',
  '行内代码 `render_drafts: false` 与**加粗**、[链接](https://hexo.io/) 一起看。',
].join('\n');

/* ── 开始 ───────────────────────────────────────────────────────────────── */
if (!fs.existsSync(path.join(REAL, 'node_modules'))) throw new Error(`素材源里没有 node_modules：${REAL}`);
if (!fs.existsSync(path.join(REAL, 'themes'))) throw new Error(`素材源里没有 themes：${REAL}`);

removeTree(BLOG);

for (const d of ['source/_posts', 'source/_drafts', 'scaffolds', 'public']) {
  fs.mkdirSync(path.join(BLOG, d), { recursive: true });
}

fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(BLOG, 'node_modules'), 'junction');
fs.symlinkSync(path.join(REAL, 'themes'), path.join(BLOG, 'themes'), 'junction');

const realCfg = fs.readFileSync(path.join(REAL, '_config.yml'), 'utf8');
fs.writeFileSync(path.join(BLOG, '_config.yml'), stripDeploy(realCfg), 'utf8');

const pkg = path.join(REAL, 'package.json');
if (fs.existsSync(pkg)) fs.copyFileSync(pkg, path.join(BLOG, 'package.json'));

fs.writeFileSync(path.join(BLOG, 'source/_posts/第二篇.md'), post('第二篇', '2026-09-20 10:00:00', BODY), 'utf8');
fs.writeFileSync(path.join(BLOG, 'source/_posts/样式复核稿.md'), post('样式复核稿', '2026-10-01 09:00:00', BODY), 'utf8');
fs.writeFileSync(path.join(BLOG, 'source/_drafts/草稿一篇.md'), post('草稿一篇', '2026-10-01 11:00:00', BODY), 'utf8');

const cfg = fs.readFileSync(path.join(BLOG, '_config.yml'), 'utf8');
console.log('临时博客: ' + BLOG);
console.log('deploy 段已剥掉: ' + (!/^deploy\s*:/m.test(cfg)));
console.log('permalink: ' + (/^permalink\s*:\s*(.+)$/m.exec(cfg) || [, '(默认)'])[1]);
console.log('文章: ' + fs.readdirSync(path.join(BLOG, 'source/_posts')).join(', '));
