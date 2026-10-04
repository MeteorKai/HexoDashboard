/* 端到端实测：起真的 server.js，把 app.js 实际会发的请求原样跑一遍。
 *
 *   node tests/e2e.js
 *
 * 特点：
 *   - 用一个临时假博客（系统临时目录），**全程不碰你的真实博客**；
 *   - 不依赖 stdout（这台机器上 PowerShell 有时会吞掉输出），结果同时写进
 *     tests/e2e.out 并在最后打一遍；
 *   - 覆盖 18 组、90+ 项：静态资源与 CSP / 令牌 / 检索 / 只提交改动字段 /
 *     乐观锁 428·409 / 插图与复用 / 图片路由与隔离 / 图片归档 / 历史版本 /
 *     草稿发表往返 / 回收站 / 设置校验 / 任务契约 / 编译产物路径 /
 *     独立编辑页路由 / PDF→Markdown 导入 / Markdown 导入（含图片落盘）/ 关闭服务。
 *
 * 注意：设置校验那组**只测失败分支**，确保不会在 hexo-tool 目录里落下一个
 *       指向临时博客的 .hexo-tool-settings.json。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { tinyPdf } = require('./pdf-fixture');

const TOOL = path.join(__dirname, '..');
const BLOG = path.join(os.tmpdir(), 'hexo-tool-e2e-blog');
const PORT = Number(process.env.E2E_PORT || 4823);
const OUT = path.join(__dirname, 'e2e.out');

const out = [];
const log = (...a) => out.push(a.join(' '));
let fail = 0;
const check = (cond, label, detail) => {
  if (cond) log('  PASS  ' + label);
  else { fail++; log('  FAIL  ' + label + (detail !== undefined ? '  → ' + detail : '')); }
};

/* ---------- 造一个假博客 ---------- */
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) rmrf(path.join(p, e)); fs.rmdirSync(p); }
  else fs.unlinkSync(p);
}
rmrf(BLOG);
const POSTS_DIR = path.join(BLOG, 'source', '_posts');
const SAMPLE = path.join(POSTS_DIR, '示例文章');
fs.mkdirSync(SAMPLE, { recursive: true });
fs.mkdirSync(path.join(BLOG, 'source', '_drafts'), { recursive: true });
fs.writeFileSync(path.join(BLOG, '_config.yml'), [
  'title: 测试博客',
  'url: https://example.test',
  'post_asset_folder: true',
  'render_drafts: false',
  'default_layout: post',
  'deploy:',
  '  type: git',
  '  repo: git@github.com:someone/someone.github.io.git',
  '  branch: main',
  '',
].join('\n'), 'utf8');

/* 故意留一个工具没建模的字段和一条注释，后面验证保存后不会被抹掉 */
const SAMPLE_RAW = [
  '---',
  'title: 原始标题',
  'date: 2026-09-30 10:00:00',
  'tags:',
  '  - Hexo',
  '  - "a,b"',
  'categories: tech_article',
  'abbrlink: 12345',
  '# 这条注释必须保留',
  'password: "keep-me"',
  '---',
  '',
  '正文第一段，这里放一个独特词：紫水晶。',
  '',
].join('\n');
fs.writeFileSync(path.join(POSTS_DIR, '示例文章.md'), SAMPLE_RAW, 'utf8');
fs.writeFileSync(path.join(SAMPLE, 'seed.png'), Buffer.from('seed-image-bytes'), 'utf8');

/* 真 PNG（1x1），detectImage 会校验签名 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0YQAAAAASUVORK5CYII=', 'base64');

/* 最小可用 PDF，给 /api/import-pdf 当输入（造法见 tests/pdf-fixture.js） */
const PDF = tinyPdf('Hello PDF import');

/* ---------- multipart/form-data：Markdown 导入就是这么发的（md + 图片一个请求） ----------
 * 手写一个而不用 FormData：这里是 node 侧，而且必须能精确控制字段名（图片用的是
 * `f:<相对路径>`，服务端靠它对上子目录里的图）。 */
function multipart(parts, boundary) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"` +
      (p.file ? `; filename="${p.file}"` : '') + '\r\n' +
      (p.type ? `Content-Type: ${p.type}\r\n` : '') + '\r\n', 'utf8'));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data), 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

/* ---------- HTTP ---------- */
function req(opts, body) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, timeout: 8000, ...opts }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => res({ code: resp.statusCode, headers: resp.headers, buf: Buffer.concat(chunks) }));
    });
    r.on('error', (e) => res({ code: 0, headers: {}, buf: Buffer.from('ERR:' + e.code) }));
    r.on('timeout', () => { r.destroy(); res({ code: 0, headers: {}, buf: Buffer.from('TIMEOUT') }); });
    if (body) r.write(body);
    r.end();
  });
}
let TOKEN = '';
const j = (r) => { try { return JSON.parse(r.buf.toString('utf8')); } catch { return {}; } };
const GET = (p) => req({ method: 'GET', path: p, headers: TOKEN ? { 'x-hexo-token': TOKEN } : {} });
const POST = (p, obj) => { const b = Buffer.from(JSON.stringify(obj || {}), 'utf8'); return req({ method: 'POST', path: p, headers: { 'Content-Type': 'application/json', 'Content-Length': b.length, 'x-hexo-token': TOKEN } }, b); };
const PUT = (p, buf, ct) => req({ method: 'PUT', path: p, headers: { 'Content-Type': ct || 'image/png', 'Content-Length': buf.length, 'x-hexo-token': TOKEN } }, buf);
const DEL = (p) => req({ method: 'DELETE', path: p, headers: { 'x-hexo-token': TOKEN } });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 假 hexo：一个立刻成功退出的包装脚本。第 14 组要验证"部署开始前清残留锁"，
   这一步发生在跑 hexo **之前**，所以用一个不干活的命令最安全 —— 不会真去
   generate / deploy，也就绝不会碰到你的仓库或远端。
   为什么写成 .cmd/.sh 而不是 .js：HEXO_CMD 是**当可执行文件** spawn 的
   （见 server.js 的 runStep），.js 直接 spawn 会 ENOENT。 */
const FAKE_HEXO = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'hexo-tool-e2e-fake-hexo.cmd')
  : path.join(os.tmpdir(), 'hexo-tool-e2e-fake-hexo.sh');
fs.writeFileSync(FAKE_HEXO, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
if (process.platform !== 'win32') { try { fs.chmodSync(FAKE_HEXO, 0o755); } catch { /* ignore */ } }

const srv = spawn(process.execPath, [path.join(TOOL, 'src', 'server.js'), BLOG], {
  env: { ...process.env, PORT: String(PORT), HEXO_CMD: FAKE_HEXO }, cwd: TOOL, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = ''; srv.stdout.on('data', (c) => slog += c); srv.stderr.on('data', (c) => slog += c);

(async () => {
  await wait(2600);

  log('== 1. 静态资源（前端真正会加载的 6 个文件）==');
  for (const [url, wantType] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/theme.js', 'javascript'], ['/editor.js', 'javascript'], ['/app.js', 'javascript'], ['/marked.js', 'javascript'], ['/purify.js', 'javascript'], ['/preview', 'text/html'], ['/preview.js', 'javascript']]) {
    const r = await GET(url);
    const ct = r.headers['content-type'] || '';
    check(r.code === 200 && ct.includes(wantType), `${url} → 200 ${wantType}`, `${r.code} ${ct}`);
  }
  const home = await GET('/');
  const csp = home.headers['content-security-policy'] || '';
  log('  CSP  : ' + csp.slice(0, 60) + '…');
  check(!/<script(?![^>]*src=)/i.test(home.buf.toString('utf8')), '首页没有内联 script（否则会被 CSP 拦掉）');

  log('');
  log('== 2. 令牌 ==');
  const info = await GET('/api/info');
  const ij = j(info);
  TOKEN = ij.token || '';
  check(info.code === 200 && !!TOKEN, '/api/info 返回令牌');
  check(ij.postAssetFolder === true, 'postAssetFolder 读到 true', ij.postAssetFolder);
  check(!!ij.deploy && ij.deploy.branch === 'main', 'deploy 配置解析正确', JSON.stringify(ij.deploy));
  const rawPost = await req({ method: 'POST', path: '/api/trash/empty', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, '{}');
  check(rawPost.code === 403, '无令牌写操作被拒 403', rawPost.code);

  log('');
  log('== 3. 列表与检索 ==');
  const list = await GET('/api/posts');
  const lj = j(list);
  check(lj.posts.length === 1 && !!lj.posts[0].revision, '列表带 revision', lj.posts[0] && lj.posts[0].revision ? 'ok' : 'missing');
  const hit = await GET('/api/posts?q=' + encodeURIComponent('紫水晶'));
  check(j(hit).posts.length === 1, '按正文关键词搜索命中（前端搜索框走这条）', j(hit).posts.length);
  const miss = await GET('/api/posts?q=' + encodeURIComponent('zzz不存在的词zzz'));
  check(j(miss).posts.length === 0, '无匹配时返回空');

  log('');
  log('== 4. 读一篇 ==');
  const one = j(await GET('/api/post?name=' + encodeURIComponent('示例文章') + '&draft=0'));
  check(one.ok && !!one.frontMatter && !!one.revision, '返回 frontMatter + revision');
  check(String(one.frontMatter).includes('abbrlink'), 'frontMatter 里带着未建模字段 abbrlink');
  const rev = one.revision, fm = one.frontMatter;

  log('');
  log('== 5. 保存：只提交改动字段（changedFields）==');
  const saveBody = {
    title: '改过的标题', name: '示例文章', date: '2026-09-30 10:00:00',
    categories: 'tech_article', tags: 'Hexo, a,b', description: '', cover: '', top: '', mathjax: false,
    draft: false, body: one.body, originalName: '示例文章', originalDraft: false,
    revision: rev, changedFields: ['title'], frontMatter: fm,
  };
  const saved = await POST('/api/post', saveBody);
  check(saved.code === 200 && j(saved).ok, '保存成功', JSON.stringify(j(saved)).slice(0, 120));
  const afterRaw = fs.readFileSync(path.join(POSTS_DIR, '示例文章.md'), 'utf8');
  check(/abbrlink: 12345/.test(afterRaw), '未建模字段 abbrlink 仍在');
  check(/# 这条注释必须保留/.test(afterRaw), '注释仍在');
  check(/password: "keep-me"/.test(afterRaw), 'password 字段仍在');
  check(/title: 改过的标题/.test(afterRaw), '标题已更新');
  check(/a,b/.test(afterRaw), '带逗号的引号标签未被拆坏');

  log('');
  log('== 6. 版本冲突：428 / 409 ==');
  const noRev = await POST('/api/post', Object.assign({}, saveBody, { revision: undefined, changedFields: undefined }));
  check(noRev.code === 428, '已存在文章不带 revision → 428', noRev.code + ' ' + j(noRev).error);
  const stale = await POST('/api/post', Object.assign({}, saveBody, { title: '不该生效' }));
  check(stale.code === 409, '过期 revision → 409（拒绝覆盖外部改动）', stale.code + ' ' + j(stale).error);
  check(!/不该生效/.test(fs.readFileSync(path.join(POSTS_DIR, '示例文章.md'), 'utf8')), '被拒后磁盘内容未被改动');

  log('');
  log('== 7. 插图（内容寻址 + 复用）==');
  const up1 = await PUT('/api/upload?post=' + encodeURIComponent('示例文章') + '&draft=0&name=' + encodeURIComponent('截图 1.png'), PNG);
  const u1 = j(up1);
  check(up1.code === 200 && !!u1.name && /^[a-f0-9]{32}\.png$/.test(u1.name), '上传成功且文件名是 md5', u1.name);
  check(/^\{% asset_img [a-f0-9]{32}\.png .+ %\}$/.test(u1.markdown || ''), '返回 Hexo 原生 asset_img 标签', u1.markdown);
  check(u1.reused === false, '首次上传 reused=false');
  const up2 = await PUT('/api/upload?post=' + encodeURIComponent('示例文章') + '&draft=0&name=x.png', PNG);
  check(j(up2).reused === true, '同内容再传 reused=true（目录里只留一份）');
  const up3 = await PUT('/api/upload?post=' + encodeURIComponent('示例文章') + '&draft=0&name=other.png', Buffer.concat([PNG, Buffer.from('diff')]));
  check(j(up3).reused === false && j(up3).name !== u1.name, '不同内容得到不同文件名');

  log('');
  log('== 8. 预览图片路由（新格式 /media/p|d/）==');
  const media = await GET('/media/p/' + encodeURIComponent('示例文章') + '/' + u1.name);
  check(media.code === 200 && media.buf.equals(PNG), '/media/p/<文章>/<图> 返回原图字节');
  check(String(media.headers['content-security-policy'] || '').includes("default-src 'none'"), '图片响应带隔离 CSP');
  const traverse = await GET('/media/p/' + encodeURIComponent('示例文章') + '/..%2f..%2f_config.yml');
  check(traverse.code >= 400, '路径穿越被拒', traverse.code);
  const nonImg = await GET('/media/p/' + encodeURIComponent('示例文章') + '/%E7%A4%BA%E4%BE%8B%E6%96%87%E7%AB%A0.md');
  check(nonImg.code >= 400, '非图片后缀被拒', nonImg.code);

  log('');
  log('== 9. 图片管理（引用中不可删 / 可恢复）==');
  await POST('/api/post', Object.assign({}, saveBody, {
    body: '正文\n\n' + u1.markdown + '\n', title: '改过的标题',
    revision: j(saved).revision, frontMatter: j(saved).frontMatter, changedFields: ['title'],
  }));
  let assets = j(await GET('/api/assets?name=' + encodeURIComponent('示例文章') + '&draft=0'));
  const refAsset = assets.items.find((i) => i.name === u1.name);
  check(!!refAsset && refAsset.referenced === true, '被正文引用的图片标记为 referenced', JSON.stringify(refAsset));
  const delRef = await DEL('/api/assets?name=' + encodeURIComponent('示例文章') + '&draft=0&asset=' + encodeURIComponent(u1.name));
  check(delRef.code === 409, '引用中的图片拒绝删除 → 409', delRef.code + ' ' + j(delRef).error);
  const delFree = await DEL('/api/assets?name=' + encodeURIComponent('示例文章') + '&draft=0&asset=' + encodeURIComponent(j(up3).name));
  check(delFree.code === 200, '未引用的图片可以删除', delFree.code);
  assets = j(await GET('/api/assets?name=' + encodeURIComponent('示例文章') + '&draft=0'));
  check(assets.archived.length === 1, '删除后进入历史归档', assets.archived.length);
  const restore = await POST('/api/assets/restore', { name: '示例文章', draft: false, id: assets.archived[0].id });
  check(restore.code === 200, '归档图片可恢复', restore.code);

  log('');
  log('== 10. 历史版本 ==');
  const hist = j(await GET('/api/history?name=' + encodeURIComponent('示例文章') + '&draft=0'));
  check(hist.items.length >= 2, '每次保存前都自动备份了旧版本', hist.items.length);
  /* items 按 id 倒序 → items[0] 最新。最新一份 = 第 9 节改正文前的内容（标题已是"改过的标题"）；
     最早一份 = 第 5 节改标题前的内容。两头都验，才说明备份的确实是"保存前的原文"。 */
  const newest = j(await GET('/api/history/version?name=' + encodeURIComponent('示例文章') + '&draft=0&id=' + encodeURIComponent(hist.items[0].id)));
  check(newest.ok && newest.meta && newest.meta.title === '改过的标题', '最新历史版本 = 上一次保存时的内容', newest.meta && newest.meta.title);
  const oldest = j(await GET('/api/history/version?name=' + encodeURIComponent('示例文章') + '&draft=0&id=' + encodeURIComponent(hist.items[hist.items.length - 1].id)));
  check(oldest.ok && oldest.meta && oldest.meta.title === '原始标题', '最早历史版本保留着改动前的标题', oldest.meta && oldest.meta.title);
  check(/紫水晶/.test(oldest.body || ''), '历史版本的正文可原样读回', JSON.stringify(oldest.body || '').slice(0, 40));
  check(!/asset_img/.test(newest.body || ''), '备份的确是「本次保存之前」的文件（不含本次才写进去的图片标签）');

  log('');
  log('== 11. 草稿：发表 / 转回 ==');
  const mk = await POST('/api/post', { title: '草稿甲', name: '草稿甲', date: '2026-10-01 09:00:00', draft: true, body: '草稿正文\n' });
  check(mk.code === 200 && j(mk).draft === true, '新建草稿成功', mk.code);
  check(fs.existsSync(path.join(BLOG, 'source', '_drafts', '草稿甲.md')), '草稿落在 _drafts');
  check(!fs.existsSync(path.join(BLOG, 'source', '_posts', '草稿甲.md')), '草稿不在 _posts');
  const pub = await POST('/api/publish', { name: '草稿甲', draft: true, publish: true, revision: j(mk).revision });
  check(pub.code === 200 && j(pub).draft === false, '草稿发表成功', pub.code + ' ' + j(pub).error);
  check(fs.existsSync(path.join(BLOG, 'source', '_posts', '草稿甲.md')) && !fs.existsSync(path.join(BLOG, 'source', '_drafts', '草稿甲.md')), '文件已从 _drafts 搬到 _posts');
  const back = await POST('/api/publish', { name: '草稿甲', draft: false, publish: false, revision: j(pub).revision });
  check(back.code === 200 && j(back).draft === true, '转回草稿成功', back.code);
  const pubStale = await POST('/api/publish', { name: '草稿甲', draft: true, publish: true, revision: 'deadbeef' });
  check(pubStale.code === 409, '发表时过期 revision → 409', pubStale.code);
  const l2 = j(await GET('/api/posts'));
  check(l2.posts.filter((p) => p.draft).length === 1, '列表里草稿计数正确', l2.posts.filter((p) => p.draft).length);

  log('');
  log('== 12. 删除：回收站 / 批量 / 恢复 ==');
  const l3 = j(await GET('/api/posts'));
  const draftItem = l3.posts.find((p) => p.draft);
  const bulk = await POST('/api/posts/delete', { items: [{ name: draftItem.name, draft: true, revision: draftItem.revision }] });
  check(bulk.code === 200 && j(bulk).deleted === 1, '批量删除（带 revision）成功', JSON.stringify(j(bulk)).slice(0, 120));
  const badBulk = await POST('/api/posts/delete', { items: [{ name: draftItem.name, draft: true, revision: 'nope' }, { name: '不存在', draft: false, revision: 'x' }] });
  check(j(badBulk).deleted === 0 && j(badBulk).failed.length === 2, '坏 revision / 不存在的文章逐条失败但不影响整体', JSON.stringify(j(badBulk).failed).slice(0, 100));
  let trash = j(await GET('/api/trash'));
  check(trash.items.length === 1, '回收站里有 1 项', trash.items.length);
  const rs = await POST('/api/trash/restore', { id: trash.items[0].id });
  check(rs.code === 200 && j(rs).restored.source === '_drafts', '恢复回 _drafts（meta.source 记录原位置）', rs.code + ' ' + j(rs).restored.source);
  check(fs.existsSync(path.join(BLOG, 'source', '_drafts', j(rs).restored.name + '.md')), '文件确实落回了 _drafts');
  const l4 = j(await GET('/api/posts'));
  const again = l4.posts.find((p) => p.draft);
  await POST('/api/posts/delete', { items: [{ name: again.name, draft: true, revision: again.revision }] });
  trash = j(await GET('/api/trash'));
  const hard = await POST('/api/trash/delete', { id: trash.items[0].id });
  check(hard.code === 200, '彻底删除成功', hard.code);
  check(j(await GET('/api/trash')).items.length === 0, '回收站已空');

  log('');
  log('== 13. 设置校验（只测不落盘的失败分支，避免改动本机设置文件）==');
  const st = j(await GET('/api/settings'));
  check(st.ok && !!st.blog, '/api/settings 可读', st.blog);
  const badPort = await POST('/api/settings', { blog: BLOG, toolPort: 0, previewPort: st.previewPort });
  check(badPort.code === 400, '非法端口 → 400', badPort.code + ' ' + j(badPort).error);
  const samePort = await POST('/api/settings', { blog: BLOG, toolPort: 4000, previewPort: 4000 });
  check(samePort.code === 400, '写作台端口与预览端口相同 → 400', samePort.code);
  const badBlog = await POST('/api/settings', { blog: path.join(BLOG, 'not-a-blog'), toolPort: st.toolPort, previewPort: st.previewPort });
  check(badBlog.code === 400, '非博客目录 → 400', badBlog.code);

  log('');
  log('== 14. 任务（不真跑 hexo，只验证契约与拒绝分支）==');
  const jobs = j(await GET('/api/jobs'));
  check(jobs.ok && Array.isArray(jobs.jobs), '/api/jobs 可读', JSON.stringify(jobs.jobs).length);
  const unknown = await POST('/api/run', { kind: 'nope' });
  check(unknown.code === 400, '未知任务 → 400', unknown.code + ' ' + j(unknown).error);
  const goodInfo = j(await GET('/api/info'));
  check(goodInfo.deploy && goodInfo.deploy.repo, 'deploy 预检所需字段齐全（前端据此给确认文案）');

  /* 中止部署后清 git 残留锁（用户实测：一键发布跑到一半按中止，下一次发布直接被
     `Unable to create '…/.deploy_git/.git/index.lock': File exists` 挡死）。
     这里不真跑 hexo：用 HEXO_CMD 指到一个立刻成功退出的假命令，重点验证的是
     "任务开始前会把残留锁清掉"这条 —— 它发生在跑 hexo 之前，与 hexo 本身无关。 */
  const FAKE_GIT_DIR = path.join(BLOG, '.deploy_git', '.git');
  fs.mkdirSync(FAKE_GIT_DIR, { recursive: true });
  const staleLock = path.join(FAKE_GIT_DIR, 'index.lock');
  fs.writeFileSync(staleLock, 'stale', 'utf8');
  check(fs.existsSync(staleLock), '前置：造了一个残留的 index.lock');
  const runDeploy = await POST('/api/run', { kind: 'deploy' });
  check(runDeploy.code === 200, '带 deploy 的任务能起来（HEXO_CMD 是假命令）', runDeploy.code + ' ' + j(runDeploy).error);
  /* 清锁是异步的（先查有没有 git 在跑），给它一点时间。 */
  await new Promise((r) => setTimeout(r, 900));
  check(!fs.existsSync(staleLock), '部署开始前残留的 index.lock 已被清掉（下次发布不会被它挡住）');
  const ranId = j(runDeploy).id;
  if (ranId) await POST('/api/stop', { id: ranId });

  log('');
  log('== 15. 编译产物路径（「编译」跑完靠它给出本文的直达链接）==');
  check((await GET('/api/post-url')).code === 400, '缺文章名 → 400');
  const pu0 = j(await GET('/api/post-url?name=' + encodeURIComponent('示例文章') + '&draft=0'));
  check(pu0.ok === true && pu0.url === '/2026/09/30/示例文章/', '按 _config.yml 的 permalink 模板算出产物 URL', pu0.url);
  check(pu0.exists === false, '还没编译过时 exists=false（不谎报产物存在）', pu0.exists);
  check(pu0.file === undefined, '响应里不吐绝对文件路径');
  /* 真把产物摆出来再问一次 —— exists 必须是"查过磁盘"的结果，不是照着模板猜的 */
  const poHtml = path.join(BLOG, 'public', '2026', '09', '30', '示例文章', 'index.html');
  fs.mkdirSync(path.dirname(poHtml), { recursive: true });
  fs.writeFileSync(poHtml, '<html>ok</html>', 'utf8');
  const pu1 = j(await GET('/api/post-url?name=' + encodeURIComponent('示例文章') + '&draft=0'));
  check(pu1.exists === true && pu1.mtime > 0, '产物落盘后 exists=true 并带上 mtime', JSON.stringify({ exists: pu1.exists, mtime: pu1.mtime }));
  /* 草稿：路径算得出来，但 render_drafts=false 时永远不会有产物 */
  fs.writeFileSync(path.join(BLOG, 'source', '_drafts', '草稿甲.md'),
    '---\ntitle: 草稿甲\ndate: 2026-09-30 11:00:00\n---\n\n草稿正文\n', 'utf8');
  const pu2 = j(await GET('/api/post-url?name=' + encodeURIComponent('草稿甲') + '&draft=1'));
  check(pu2.ok === true && pu2.draft === true && pu2.exists === false,
    '草稿能算出路径但 exists=false（本来就该没有产物）', JSON.stringify({ url: pu2.url, exists: pu2.exists }));
  /* permalink 用了本工具不认识的占位符时，宁可说"推不出来"，也不要编一个 404 链接 */
  const cfgFile = path.join(BLOG, '_config.yml');
  const cfgBackup = fs.readFileSync(cfgFile, 'utf8');
  fs.writeFileSync(cfgFile, cfgBackup + 'permalink: posts/:abbrlink/\n', 'utf8');
  const pu3 = j(await GET('/api/post-url?name=' + encodeURIComponent('示例文章') + '&draft=0'));
  check(pu3.ok === false && /permalink/.test(pu3.reason || ''), 'permalink 含不支持的占位符 → 如实报告', pu3.reason);
  fs.writeFileSync(cfgFile, cfgBackup, 'utf8');

  log('');
  log('== 16. 独立编辑页的静态路由（/post）==');
  const pg = await GET('/post');
  const pgHtml = pg.buf.toString('utf8');
  check(pg.code === 200 && /id="body"/.test(pgHtml) && /src="\/post\.js"/.test(pgHtml),
    '/post 返回独立编辑页（editor.js 要挂载的 #body 与 /post.js 都在）', 'HTTP ' + pg.code);
  const pj = await GET('/post.js');
  check(pj.code === 200 && /x-hexo-token/.test(pj.buf.toString('utf8')),
    '/post.js 可访问，且写操作会带上令牌', 'HTTP ' + pj.code);
  /* 独立页刻意不新增任何接口：它读写的还是 /api/post，页面只是换了个壳 */
  const rd = j(await GET('/api/post?name=' + encodeURIComponent('示例文章') + '&draft=0'));
  check(rd.ok === true && typeof rd.body === 'string' && !!rd.revision,
    '独立页靠 /api/post 取文章，返回 body + revision（保存要用它做乐观锁）',
    JSON.stringify({ body: typeof rd.body, revision: !!rd.revision }));

  log('');
  log('== 17. PDF → Markdown 导入（/api/import-pdf）==');
  check(PDF.slice(0, 5).toString('latin1') === '%PDF-', '测试用的 PDF 文件头合法（不然测的是修复模式）');
  const binPost = (p, buf, withToken = true) => req({
    method: 'POST', path: p,
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, ...(withToken ? { 'x-hexo-token': TOKEN } : {}) },
  }, buf);
  /* 先记一下博客里有多少文件：导入**只做转换**，一个字节都不该往博客里写 */
  const beforeFiles = [...fs.readdirSync(POSTS_DIR), ...fs.readdirSync(path.join(BLOG, 'source', '_drafts'))].sort().join('|');

  const noTok = await binPost('/api/import-pdf', PDF, false);
  check(noTok.code === 403, '没令牌 → 403（导入也算写操作，一律要令牌）', noTok.code);
  const notPdf = await binPost('/api/import-pdf', Buffer.from('这不是 PDF'));
  check(notPdf.code === 400 && /不是 PDF/.test(j(notPdf).error || ''), '选错文件 → 400 且说人话', notPdf.code + ' ' + j(notPdf).error);
  const wrongMethod = await req({ method: 'PUT', path: '/api/import-pdf', headers: { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length, 'x-hexo-token': TOKEN } }, PDF);
  check(wrongMethod.code === 404, '只认 POST，PUT 落到 404', wrongMethod.code);

  const im = await binPost('/api/import-pdf?title=' + encodeURIComponent('导入的稿子'), PDF);
  const ij2 = j(im);
  check(im.code === 200 && ij2.ok === true, '导入成功返回 200 + ok', im.code + ' ' + JSON.stringify(ij2).slice(0, 140));
  check(/Hello PDF import/.test(ij2.markdown || ''), 'PDF 里的文字被抽出来了', JSON.stringify((ij2.markdown || '').slice(0, 60)));
  /* 标题**优先**用 ?title=（前端传的就是文件名），不再靠字号猜版面里哪行是标题 ——
     版面猜测认错过两次：一次把长标题切成两半，一次把正文里的大标题弄丢。 */
  check(ij2.title === '导入的稿子', '标题优先取 ?title=（前端传文件名）', ij2.title);
  /* 给了标题就不能再从正文里抽走任何行：版面内容整篇进正文 */
  check(/Hello PDF import/.test(ij2.markdown || ''), '给了标题时版面文字一行不删（不会被当成标题抽走）',
    JSON.stringify((ij2.markdown || '').slice(0, 60)));
  check(ij2.stats && ij2.stats.pages === 1 && ij2.stats.lines === 1, 'stats 如实报告页数/行数', JSON.stringify(ij2.stats));
  check(typeof ij2.markdown === 'string' && ij2.markdown.endsWith('\n'), 'markdown 以换行收尾（填进正文不会和下文粘行）');
  const afterFiles = [...fs.readdirSync(POSTS_DIR), ...fs.readdirSync(path.join(BLOG, 'source', '_drafts'))].sort().join('|');
  check(beforeFiles === afterFiles, '导入只做转换，不往博客里写任何文件', afterFiles);
  /* 返回的字段要够前端落地用，但不能多吐内部路径。
     判据是"**落盘位置**"本身，不是把整个响应转成 JSON 再找反斜杠 ——
     后者有 bug 且已经踩到：`JSON.stringify` 会把每个反斜杠转义成两个，
     于是 `/\\\\\\\\|\\/[A-Za-z]:\\//`（四个反斜杠）匹配的是**单个**反斜杠，
     连 `"yes\\u2192no"` 这种 JSON 转义都会被误判成"吐了本机路径"。
     这里换成看三个真正该说的字段：assets.dir（服务端自己算的绝对路径）、
     url（站内相对链接）、name（目录名，不含斜杠）。 */
  check(ij2.stats && typeof ij2.stats.kangxi === 'number' && typeof ij2.stats.codeBlocks === 'number',
    'stats 里带着前端提示要用的 kangxi / codeBlocks', JSON.stringify(ij2.stats));
  check(ij2.assets && ij2.assets.name && !/[\\/]/.test(String(ij2.assets.name)),
    'assets 回传的目录名是**目录名**，不是路径', String(ij2.assets && ij2.assets.name));
  check(ij2.assets && !('dir' in ij2.assets) && !/[A-Za-z]:[\\/]/.test(JSON.stringify(ij2.assets)),
    'assets 里不带本机绝对路径（前端只要目录名）', JSON.stringify(ij2.assets));

  log('');
  log('== 17b. Markdown 导入（/api/import-md）==');
  /* 和 PDF 导入最大的区别：这一次**真的会往博客里写东西** —— 图片要复制进
     "文章同名资源目录"。所以这一组盯的是"图到底落在哪、正文指的对不对"，
     这两件事错一处，保存之后就是一整篇裂图。 */
  const BOUND = '----e2eMdImportBoundary';
  const mpPost = (p, parts, withToken = true) => {
    const body = multipart(parts, BOUND);
    return req({
      method: 'POST', path: p,
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUND}`, 'Content-Length': body.length, ...(withToken ? { 'x-hexo-token': TOKEN } : {}) },
    }, body);
  };
  const MD_SRC = [
    '---',
    'title: 导入的稿子',
    'date: 2026-09-30 10:00:00',
    'tags:',
    '  - Hexo',
    '---',
    '',
    '正文第一段。',
    '',
    '![示意图](img/one.png)',
    '',
    '```md',
    '![代码示例](img/one.png)',
    '```',
    '',
    '![缺的图](img/two.png)',
    '',
  ].join('\n');

  const noTokMd = await mpPost('/api/import-md?title=x&draft=1', [{ name: 'md', data: MD_SRC }], false);
  check(noTokMd.code === 403, '没令牌 → 403（导入也算写操作）', noTokMd.code);
  const badCt = await req({ method: 'POST', path: '/api/import-md?title=x&draft=1', headers: { 'Content-Type': 'text/plain', 'Content-Length': 4, 'x-hexo-token': TOKEN } }, Buffer.from('abcd'));
  check(badCt.code === 400 && /multipart/.test(j(badCt).error || ''), '不是 multipart → 400 且说清要什么格式', badCt.code + ' ' + j(badCt).error);
  const emptyMd = await mpPost('/api/import-md?title=x&draft=1', [{ name: 'md', data: '   ' }]);
  check(emptyMd.code === 422 && /空/.test(j(emptyMd).error || ''), '空文件 → 422 说"是空的"', emptyMd.code + ' ' + j(emptyMd).error);

  const mdR = await mpPost('/api/import-md?title=' + encodeURIComponent('导入的稿子') + '&draft=1', [
    { name: 'mdrel', data: 'a.md' },
    { name: 'md', file: 'a.md', data: MD_SRC },
    { name: 'f:img/one.png', file: 'one.png', type: 'image/png', data: PNG },
  ]);
  const mdJ = j(mdR);
  check(mdR.code === 200 && mdJ.ok === true, '导入成功返回 200 + ok', mdR.code + ' ' + JSON.stringify(mdJ).slice(0, 160));
  check(mdJ.title === '导入的稿子', '标题取 front-matter 里写的那个', mdJ.title);
  check(!/^---/.test(mdJ.markdown || '') && /^正文第一段/.test(mdJ.markdown || ''),
    'front-matter 被拆走，正文里只剩正文', JSON.stringify((mdJ.markdown || '').slice(0, 40)));
  check(mdJ.meta && mdJ.meta.tags && mdJ.meta.tags[0] === 'Hexo' && mdJ.meta.date, '标题以外的元数据也回给前端（日期 / 标签）', JSON.stringify(mdJ.meta));

  const hash = crypto.createHash('md5').update(PNG).digest('hex');
  check(new RegExp('\\{% asset_img ' + hash + '\\.png 示意图 %\\}').test(mdJ.markdown || ''),
    '正文里的图片换成 {% asset_img <内容哈希> %} 且保留原文 alt', JSON.stringify((mdJ.markdown || '').slice(0, 120)));
  check(/```md\n!\[代码示例\]\(img\/one\.png\)\n```/.test(mdJ.markdown || ''),
    '代码块里的图片示例一个字都没动', JSON.stringify((mdJ.markdown || '').slice(0, 200)));
  check(Array.isArray(mdJ.missing) && mdJ.missing.length === 1 && mdJ.missing[0] === 'two.png',
    '没带来字节的图片如实报回前端', JSON.stringify(mdJ.missing));
  check(/!\[缺的图\]\(img\/two\.png\)/.test(mdJ.markdown || ''), '缺的那张保持原样（不假装成功）');

  /* 落点：_drafts/<目录名>/<哈希>.png。目录名必须和保存时算出来的**完全一致**。 */
  check(mdJ.assets && mdJ.assets.name === '导入的稿子' && mdJ.assets.count === 1 && mdJ.assets.draft === true,
    '回传的目录名 / 图片数 / 草稿位都对', JSON.stringify(mdJ.assets));
  const ddir = path.join(BLOG, 'source', '_drafts', '导入的稿子');
  const landed = fs.existsSync(ddir) ? fs.readdirSync(ddir) : [];
  check(landed.length === 1 && landed[0] === hash + '.png', '图片已复制进**文章同名资源目录**', JSON.stringify(landed));
  check(fs.existsSync(path.join(ddir, hash + '.png')) && fs.readFileSync(path.join(ddir, hash + '.png')).equals(PNG),
    '复制过去的字节和原图一致');
  check(!fs.existsSync(path.join(BLOG, 'source', '_posts', '导入的稿子')),
    'draft=1 时图进 _drafts，不会落到 _posts（否则发布时找不到图）');

  /* 同一张图再导一次：命中同一个哈希，不会多出一份副本 */
  const mdAgain = await mpPost('/api/import-md?title=' + encodeURIComponent('导入的稿子') + '&draft=1', [
    { name: 'mdrel', data: 'a.md' },
    { name: 'md', file: 'a.md', data: MD_SRC },
    { name: 'f:img/one.png', file: 'one.png', type: 'image/png', data: PNG },
  ]);
  check(j(mdAgain).ok === true && fs.readdirSync(ddir).length === 1, '重复导入同一张图不会多出副本',
    JSON.stringify(fs.readdirSync(ddir)));

  /* Obsidian 导出的 md 里图片写作 `![[文件名]]`。不认这种写法的话整篇一张都换不掉，
     而且因为压根没走到查找那一步，连 missing 都不会报 —— 用户看到的是"导入成功、图没变"。 */
  const wikiMd = '正文\n\n![[Pasted image 20260101120000.png]]\n';
  const mdWiki = await mpPost('/api/import-md?title=' + encodeURIComponent('导入的稿子') + '&draft=1', [
    { name: 'mdrel', data: 'w.md' },
    { name: 'md', file: 'w.md', data: wikiMd },
    { name: 'f:Pasted image 20260101120000.png', file: 'Pasted image 20260101120000.png', type: 'image/png', data: PNG },
  ]);
  const wj = j(mdWiki);
  check(new RegExp('\\{% asset_img ' + hash + '\\.png Pasted-image-20260101120000 %\\}').test(wj.markdown || ''),
    'Obsidian 的 ![[图片]] 也换成 asset_img', JSON.stringify((wj.markdown || '').slice(0, 120)));
  /* 反过来：图没带来时必须报 missing，不许闷声不响 */
  const mdWikiMiss = await mpPost('/api/import-md?title=' + encodeURIComponent('导入的稿子') + '&draft=1', [
    { name: 'mdrel', data: 'w.md' },
    { name: 'md', file: 'w.md', data: '正文 ![[没了.png]]' },
  ]);
  check(JSON.stringify(j(mdWikiMiss).missing) === JSON.stringify(['没了.png']),
    'Obsidian 的图没带来字节也要报缺图（不能静默留死链）', JSON.stringify(j(mdWikiMiss).missing));

  const badMode = await mpPost('/api/import-md?title=x&draft=1', [
    { name: 'md', data: '正文' }, { name: 'mdmode', data: 'invalid' },
  ]);
  check(badMode.code === 400, '无效的导入模式 → 400', badMode.code);
  const plainMode = await mpPost('/api/import-md?title=x&draft=1', [
    { name: 'md', data: '![[one.png]]\n![图](one.png)' }, { name: 'mdmode', data: 'markdown' },
    { name: 'f:one.png', file: 'one.png', type: 'image/png', data: PNG },
  ]);
  check(j(plainMode).markdown.startsWith('![[one.png]]') && j(plainMode).stats.images === 1,
    '普通模式只转换普通图片，不转换 wiki', j(plainMode).markdown);
  const obsidianMode = await mpPost('/api/import-md?title=x&draft=1', [
    { name: 'md', data: '![[one.png]]\n![[one.png|300]]\n![[另一篇笔记]]' }, { name: 'mdmode', data: 'obsidian' },
    { name: 'f:assets/one.png', file: 'one.png', type: 'image/png', data: PNG },
  ]);
  check(j(obsidianMode).assets.count === 1 && j(obsidianMode).stats.images === 1 && j(obsidianMode).stats.missing === 0,
    'Obsidian 模式复制 wiki 图片、按唯一图片计数，笔记嵌入不误报缺图', j(obsidianMode).stats);

  log('');
  log('== 18. 关闭服务（前端「关闭服务」按钮走的接口）==');
  const PID_FILE = path.join(TOOL, 'data', `.server-${PORT}.pid`);
  check(fs.existsSync(PID_FILE), '运行期间写下了 pid 文件', PID_FILE.replace(TOOL, '.'));
  const sd = await POST('/api/shutdown', {});
  check(sd.code === 200 && j(sd).pid, '/api/shutdown 正常返回', sd.code + ' pid=' + j(sd).pid);
  /* 关闭是「先发响应，再收尾」：等够时间让 exit 钩子跑完，别提前 SIGKILL，
     否则 pid 文件不会被清理、也就验不出这条收尾逻辑 */
  await wait(3500);
  let dead = false;
  try {
    const after = await GET('/api/info');
    dead = after.code === 0;
  } catch { dead = true; }
  check(dead, '服务已退出，端口不再响应');
  check(!fs.existsSync(PID_FILE), '退出时 pid 文件已被清理（不残留 .server-*.pid）',
    fs.existsSync(PID_FILE) ? '仍存在 ' + PID_FILE.replace(TOOL, '.') : '');

  log('');
  log('--- server stdout ---');
  log(slog.trim().split('\n').slice(0, 6).join('\n'));

  log('');
  const tail = fail === 0 ? '端到端全部通过 ✅' : `有 ${fail} 项未通过 ❌`;
  log(tail);
  const report = out.join('\n');
  fs.writeFileSync(OUT, report, 'utf8');
  process.stdout.write(report + '\n');
  console.log('\n（报告已写入 ' + OUT + '；假博客留在 ' + BLOG + '）');

  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})();
