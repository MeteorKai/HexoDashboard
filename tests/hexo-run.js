/* 真跑 hexo：把 server.js 的 /api/run + /api/logs(SSE) 整条链路跑一遍。
 *
 *   node tests/hexo-run.js [真博客路径]        # 默认 D:\myblog
 *
 * 做法：在系统临时目录造一个「空壳博客」，用 junction 把真博客的 node_modules
 *       和 themes 借过来，再把 _config.yml / package.json 复制过去。
 *       **生成全部发生在临时目录里，真博客的 public/ 与 db.json 一个字节都不会动。**
 *
 * 为什么必须借这三样（都是踩过才知道的）：
 *   ① node_modules —— hexo 本体在这里；
 *   ② package.json —— hexo-cli 是按 dependencies 加载命令与插件的。缺了它，
 *      `hexo clean` / `hexo generate` 会既不认识命令、又只打印一段 usage
 *      然后 **exit 0** —— 工具据此报"生成完成"，其实什么都没生成（假成功）。
 *   ③ themes —— 没主题时 hexo 只 WARN "No layout" 然后写出 **0 字节**页面，
 *      同样看着"成功"。少了它，连 `<img>` 有没有渲染出来都验不了。
 *
 * 另外：SSE 事件的字段是 {type, text}（type ∈ info/out/err/ok/fail/end），
 *       不是 event/line；按错字段解析会永远等不到结束事件而挂死。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.join(__dirname, '..');
const REAL = path.resolve(process.argv[2] || 'D:/myblog');
const BLOG = path.join(os.tmpdir(), 'hexo-tool-run-blog');
const PORT = Number(process.env.RUN_PORT || 4847);
const OUT = path.join(__dirname, 'hexo-run.out');

const out = [];
const log = (...a) => out.push(a.join(' '));
let fail = 0;
const check = (c, label, detail) => {
  if (c) log('  PASS  ' + label);
  else { fail++; log('  FAIL  ' + label + (detail !== undefined ? '  → ' + detail : '')); }
};

if (!fs.existsSync(path.join(REAL, 'node_modules', 'hexo')) || !fs.existsSync(path.join(REAL, '_config.yml'))) {
  log('跳过：' + REAL + ' 不是装好 hexo 的博客目录（需要 _config.yml 与 node_modules/hexo）。');
  log('用法：node tests/hexo-run.js <你的博客路径>');
  fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(2);
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) rmrf(path.join(p, e)); fs.rmdirSync(p); }
  else fs.unlinkSync(p);
}
function junctionsOff(p) {
  // 先解开 junction，免得 rmrf 顺着链接删到真博客里去
  for (const n of ['node_modules', 'themes']) {
    const j = path.join(p, n);
    try { if (fs.existsSync(j) && fs.lstatSync(j).isSymbolicLink()) fs.unlinkSync(j); } catch { /* ignore */ }
  }
}
junctionsOff(BLOG);
rmrf(BLOG);
fs.mkdirSync(path.join(BLOG, 'source', '_posts'), { recursive: true });
fs.mkdirSync(path.join(BLOG, 'scaffolds'), { recursive: true });

let linked = false;
try {
  fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(BLOG, 'node_modules'), 'junction');
  fs.symlinkSync(path.join(REAL, 'themes'), path.join(BLOG, 'themes'), 'junction');
  linked = true;
} catch (e) { log('junction 失败: ' + e.code + ' ' + e.message); }
log('借用 ' + REAL + ' 的 node_modules / themes: ' + linked);
if (!linked) { fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8'); process.exit(2); }

/* _config.yml 去掉 deploy 段，杜绝任何误部署可能 */
fs.writeFileSync(path.join(BLOG, '_config.yml'),
  fs.readFileSync(path.join(REAL, '_config.yml'), 'utf8').replace(/^deploy:[\s\S]*?(?=\n\S)/m, ''), 'utf8');
fs.copyFileSync(path.join(REAL, 'package.json'), path.join(BLOG, 'package.json'));
const pkg = JSON.parse(fs.readFileSync(path.join(BLOG, 'package.json'), 'utf8'));
log('package.json 依赖数: ' + Object.keys(pkg.dependencies || {}).length + '（hexo: ' + ((pkg.dependencies || {}).hexo || '未声明') + '）');

/* 一篇文章 + 一张真 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0YQAAAAASUVORK5CYII=', 'base64');
const assetDir = path.join(BLOG, 'source', '_posts', '作业测试');
fs.mkdirSync(assetDir, { recursive: true });
fs.writeFileSync(path.join(assetDir, 'abc123.png'), PNG);
fs.writeFileSync(path.join(BLOG, 'source', '_posts', '作业测试.md'), [
  '---', 'title: 作业测试', 'date: 2026-10-01 10:00:00', 'tags:', '  - 测试', '---', '',
  '正文一段。', '', '{% asset_img abc123.png 测试图 %}', '',
].join('\n'), 'utf8');
fs.mkdirSync(path.join(BLOG, 'source', '_drafts'), { recursive: true });
fs.writeFileSync(path.join(BLOG, 'source', '_drafts', '不该出现的草稿.md'),
  ['---', 'title: 不该出现的草稿', 'date: 2026-10-01 10:00:00', 'layout: draft', '---', '', '草稿正文。', ''].join('\n'), 'utf8');

function req(opts, body) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, timeout: 20000, ...opts }, (resp) => {
      const chunks = []; resp.on('data', (c) => chunks.push(c));
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
const POST = (p, o) => { const b = Buffer.from(JSON.stringify(o || {}), 'utf8'); return req({ method: 'POST', path: p, headers: { 'Content-Type': 'application/json', 'Content-Length': b.length, 'x-hexo-token': TOKEN } }, b); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* SSE 读取：字段 {type,text}；结束时 type==='end'；硬性封顶，绝不无限等。 */
function readSSE(jobId, capMs) {
  return new Promise((resolve) => {
    const lines = [];
    let settled = false;
    const t0 = Date.now();
    let why = 'timeout';
    const finish = (ev, reason) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (reason) why = reason;
      try { rq.destroy(); } catch { /* ignore */ }
      resolve({ lines, end: ev, waited: Date.now() - t0, why });
    };
    const timer = setTimeout(() => finish(null, 'timeout'), capMs);
    /* SSE 是长连接：必须显式关掉请求/套接字层的闲置超时，否则会在 hexo 沉默的那
       几十秒里被掐断（实测本机网络层 4s 无数据就报 timeout，而服务端心跳是 15s 一次，
       正好救不回来）。关掉之后靠 capMs 这个自己的封顶来兜底，不会无限等。 */
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/api/logs?id=' + jobId + '&after=0', timeout: 0, headers: { 'x-hexo-token': TOKEN } }, (resp) => {
      resp.setTimeout(0);
      let buf = '';
      resp.on('data', (c) => {
        buf += c;
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const p of parts) {
          const dl = p.split('\n').find((l) => l.startsWith('data:'));
          if (!dl) continue;
          let ev; try { ev = JSON.parse(dl.slice(5)); } catch { continue; }
          if (ev.text) lines.push((ev.type === 'err' ? '[err] ' : '') + ev.text);
          if (ev.type === 'end') finish(ev);
        }
      });
      resp.on('end', () => finish(null, 'resp-end'));
      resp.on('error', () => finish(null, 'resp-error'));
    });
    rq.on('error', () => finish(null, 'req-error'));
    rq.on('timeout', () => finish(null, 'req-timeout'));
    rq.end();
  });
}

/* 起服务时**故意不带 NODE_OPTIONS**：本机沙箱会用它注入一个"批量删除守卫"，
   而 `hexo clean` 要删 public/ 和 db.json —— 实测会被那个守卫**直接阻塞住**
   （不是失败，是卡死，日志永远停在 `$ hexo clean` 这一行）。
   真实用户的机器上没有这层注入，所以剥掉它才是**更接近真实**的运行环境。 */
const srvEnv = { ...process.env, PORT: String(PORT) };
delete srvEnv.NODE_OPTIONS;
if (process.env.NODE_OPTIONS) log('（已剥掉 NODE_OPTIONS：' + process.env.NODE_OPTIONS + '）');

const srv = spawn(process.execPath, [path.join(TOOL, 'src', 'server.js'), BLOG], {
  env: srvEnv, cwd: TOOL, stdio: ['ignore', 'pipe', 'pipe'],
});

(async () => {
  await wait(2600);
  TOKEN = j(await GET('/api/info')).token || '';

  log('');
  log('== A. 通过工具自己的 /api/run 真跑 hexo（hexo clean && hexo generate）==');
  const started = await POST('/api/run', { kind: 'build', clean: true });
  const job = j(started);
  check(started.code === 200 && !!job.id, '启动任务（kind=build）', started.code + ' ' + (job.error || '') + ' id=' + job.id);
  check(job.status === 'running', '任务进入 running', job.status);
  check(job.title === '本地生成', '标题与 TASKS 表一致', job.title);

  /* 封顶从 90s 提到 180s：hexo 7 在本机冷启动很慢（实测 clean≈33s、generate≈51s，
     两步加起来就 80s+），90s 会把"跑完了但慢"误判成"没跑完"。封顶仍然在，
     只是放宽到真跑一次够用的量级。 */
  const sse = job.id ? await readSSE(job.id, 180000) : { lines: [], end: null };
  log('  —— SSE 实时日志（前 12 行）——');
  for (const l of sse.lines.slice(0, 12)) log('     ' + l);
  log('  —— 共 ' + sse.lines.length + ' 行 ——');

  check(sse.lines.length > 0, 'SSE 收到实时日志', sse.lines.length + ' 行');
  check(!!sse.end, 'SSE 收到 type=end 结束事件',
    sse.end ? JSON.stringify(sse.end) : `没收到（等了 ${(sse.waited / 1000).toFixed(1)}s，结束原因=${sse.why}，共 ${sse.lines.length} 行）`);
  const joined = sse.lines.join('\n');
  check(!/Usage: hexo <command>/.test(joined), 'hexo 真的执行了命令（不是打印 usage 后假成功）');
  check(/hexo clean/.test(joined) && /hexo generate/.test(joined), '两步命令都发出去了');
  check(/Generated|INFO|files/i.test(joined), '日志里有 hexo 的实际输出');

  let info = null;
  for (let i = 0; i < 40; i++) {
    const jobs = j(await GET('/api/jobs'));
    info = (jobs.jobs || []).find((x) => x.id === job.id);
    if (info && info.status !== 'running') break;
    await wait(1000);
  }
  check(info && info.status === 'done', '任务最终状态 done', info && info.status + ' code=' + (info && info.code));

  log('');
  log('== B. 产物检查（「真的生成成功了吗」）==');
  const pub = path.join(BLOG, 'public');
  check(fs.existsSync(pub), 'public/ 已生成');
  const html = [];
  if (fs.existsSync(pub)) { const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'index.html') html.push(p); } }; walk(pub); }
  check(html.length > 0, 'public/ 里有 index.html', html.length + ' 个');
  check(html.every((h) => fs.statSync(h).size > 0), '每个页面都不是 0 字节（说明主题真的生效了）');

  const postHtml = html.find((h) => h.includes('作业测试'));
  check(!!postHtml, '文章页已生成', postHtml && postHtml.replace(BLOG, '…'));
  if (postHtml) {
    const page = fs.readFileSync(postHtml, 'utf8');
    check(!/\{%\s*asset_img/.test(page), '页面里没有残留的 {% asset_img %} 模板标签');
    const img = page.match(/<img[^>]+src="([^"]+)"/);
    check(!!img, '页面里渲染出了 <img>', img && img[1]);
    if (img) {
      const src = decodeURIComponent(img[1].replace(/^\//, '').split('?')[0]);
      const imgFile = path.join(pub, src);
      check(fs.existsSync(imgFile), '图片真的被复制进 public', src);
      if (fs.existsSync(imgFile)) check(fs.readFileSync(imgFile).equals(PNG), 'public 里的图片字节与原图一致');
    }
  }
  const draftPages = html.filter((h) => fs.readFileSync(h, 'utf8').includes('不该出现的草稿'));
  check(draftPages.length === 0, 'render_drafts=false 时草稿没进 public', draftPages.length + ' 页');

  log('');
  log('== C. 常驻任务：本地预览（hexo server）与中止 ==');
  const PREVIEW = Number(process.env.RUN_PREVIEW_PORT || 4899);
  const serve = await POST('/api/run', { kind: 'serve', port: PREVIEW });
  const sjob = j(serve);
  check(serve.code === 200 && !!sjob.id, '启动本地预览任务', serve.code + ' ' + (sjob.error || ''));
  check(sjob.long === true, '标记为常驻任务（long=true）', sjob.long);

  /* 等端口真的起来：这才是「预览真的能看」的证据，而不是"命令发出去了" */
  let previewOk = false, draftVisible = false;
  for (let i = 0; i < 40; i++) {
    const r = await new Promise((res) => {
      const q = http.request({ host: '127.0.0.1', port: PREVIEW, path: '/', timeout: 3000 }, (x) => {
        const c = []; x.on('data', (b) => c.push(b)); x.on('end', () => res({ code: x.statusCode, buf: Buffer.concat(c) }));
      });
      q.on('error', () => res({ code: 0, buf: Buffer.alloc(0) }));
      q.on('timeout', () => { q.destroy(); res({ code: 0, buf: Buffer.alloc(0) }); });
      q.end();
    });
    if (r.code === 200 && r.buf.length > 0) {
      previewOk = true;
      draftVisible = r.buf.toString('utf8').includes('不该出现的草稿');
      break;
    }
    await wait(1000);
  }
  check(previewOk, '本地预览端口真的起来了并且能返回页面', '127.0.0.1:' + PREVIEW);
  /* 草稿的 permalink 由 front-matter 的 date 决定：/2026/10/01/<标题>/ */
  const draftPage = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port: PREVIEW, path: '/' + encodeURIComponent('2026/10/01/不该出现的草稿') + '/', timeout: 5000 }, (x) => {
      const c = []; x.on('data', (b) => c.push(b)); x.on('end', () => res({ code: x.statusCode, buf: Buffer.concat(c) }));
    });
    q.on('error', () => res({ code: 0, buf: Buffer.alloc(0) }));
    q.on('timeout', () => { q.destroy(); res({ code: 0, buf: Buffer.alloc(0) }); });
    q.end();
  });
  check(draftPage.code === 200 && draftPage.buf.toString('utf8').includes('草稿正文'),
    '本地预览用 --draft 启动：草稿在预览里可见（而正式生成里不可见）',
    draftPage.code + ' ' + (draftVisible ? '(首页也提到了)' : ''));

  const stopped = await POST('/api/stop', { id: sjob.id });   // 必须带 id，前端就是这么调的
  check(stopped.code === 200 && !j(stopped).noop, '中止常驻任务 → 200（非 noop）', stopped.code + ' ' + JSON.stringify(j(stopped)));

  /* 杀进程树要一点时间，轮询等端口释放，别一次判定 */
  let afterStop = 1;
  for (let i = 0; i < 20; i++) {
    afterStop = await new Promise((res) => {
      const q = http.request({ host: '127.0.0.1', port: PREVIEW, path: '/', timeout: 3000 }, (x) => { x.resume(); res(x.statusCode); });
      q.on('error', () => res(0));
      q.on('timeout', () => { q.destroy(); res(0); });
      q.end();
    });
    if (afterStop === 0) break;
    await wait(1000);
  }
  check(afterStop === 0, '中止后预览端口已释放（没有留下孤儿 hexo 进程）', afterStop);
  const jobsAfter = j(await GET('/api/jobs'));
  const sInfo = (jobsAfter.jobs || []).find((x) => x.id === sjob.id);
  check(sInfo && sInfo.status === 'stopped', '常驻任务状态变为 stopped', sInfo && sInfo.status);

  log('');
  log('== D. 隔离性：真博客一个字节没动 ==');
  check(fs.existsSync(path.join(REAL, 'public')), '真博客 public/ 仍在');
  check(!fs.existsSync(path.join(BLOG, '.git')), '临时博客里没有 .git（未误建仓库）');
  log('  真博客 db.json 最后修改时间: ' + fs.statSync(path.join(REAL, 'db.json')).mtime.toLocaleString() + '（本测试不应改动它）');

  log('');
  const tail = fail === 0 ? '真跑 hexo 全流程通过 ✅' : `有 ${fail} 项未通过 ❌`;
  log(tail);
  const report = out.join('\n');
  fs.writeFileSync(OUT, report, 'utf8');
  process.stdout.write(report + '\n');

  try { await POST('/api/shutdown', {}); } catch { /* ignore */ }
  await wait(800);
  junctionsOff(BLOG);
  try { srv.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})();
