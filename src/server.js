// server.js —— 本地服务：HTTP API + 跑 hexo 命令 + 推送日志
// 用法：node src/server.js --open   在网页「设置」中选择博客目录
//       （Windows 双击「启动写作台.bat」，macOS 双击「启动写作台.command」；优先使用本机 Node）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lib = require('./lib');
const pdfimport = require('./pdfimport');   // 只在 /api/import-pdf 用到；pdf.js 本体是惰性加载的
const mdimport = require('./mdimport');     // /api/import-md：Markdown 导入与 multipart 解析
const pages = require('./pages');           // 独立页面与主题数据
const crypto = require('crypto');
const net = require('net');

/* ---------------- 目录布局 ----------------
   源码在 src/，页面在 web/，第三方在 vendor/，运行时产物全在 data/。
   APP 是"应用根"（启动器所在那一层），所有跨目录引用都从它算起 ——
   这样 server.js 自己被挪进 src/ 之后，静态资源与 data/ 的定位都不受影响。
   data/ 按需创建：便携包首次拷到新机器时它可能还不存在。 */
const APP = path.join(__dirname, '..');

/* ---------------- 自带的 Node 运行时：兜底，不是优先 ----------------
   博客里的 node_modules\.bin\hexo.cmd 在同级找不到 node.exe 时会裸调 `node`（靠 PATH 找），
   找不到就死在 "'node' 不是内部或外部命令"。所以 PATH 上必须有一个 node：
   系统装了就用系统的，**只有 PATH 里一个都没有时，才把便携包自带的 APP/node/ 补上去**。
   放在服务端做（而不是只交给启动器）：这样手动 `node src/server.js` 起来也跑得动 hexo。
   为什么不一律优先自带的？一是系统 node 才是主人自己装的那一个（版本、全局包都对得上），
   二是实测过：无条件把自带的那份顶到最前面，会让 hexo 换用一个"并非系统登记过"的
   node.exe，某些带防护的环境里直接连 public/ 都建不出来（EPERM）。 */
const NODE_DIR = path.join(APP, 'node');
try {
  const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
  const cur = process.env.PATH || process.env.Path || '';
  const hasNode = cur.split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, nodeBin)));
  if (!hasNode && fs.existsSync(path.join(NODE_DIR, nodeBin))) {
    process.env.PATH = NODE_DIR + path.delimiter + cur;
  }
} catch { /* 改不了 PATH 就算了：系统里本来有 node 的话一样能跑 */ }

const DATA = path.join(APP, 'data');
try { fs.mkdirSync(DATA, { recursive: true }); } catch { /* 只读介质上仍能跑，只是设置存不下来 */ }
const SETTINGS_FILE = path.join(DATA, '.hexo-tool-settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.warn('[!] 设置文件读取失败，使用默认值'); }
const token = crypto.randomBytes(32).toString('hex');

const PORT = Number(process.env.PORT || settings.toolPort || 4321);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('写作台端口必须为 1–65535');
let BLOG = (() => {
  const arg = process.argv.slice(2).find(a => !a.startsWith('--')) || process.env.HEXO_BLOG || settings.blog || '';
  if (!arg) return '';
  if (arg && lib.isBlogRoot(arg)) return path.resolve(arg);
  return lib.findBlogRoot(arg) || '';
})();
console.log(BLOG ? `[*] 博客根目录: ${BLOG}` : '[*] 请在网页「设置」中选择 Hexo 博客目录');
console.log(`[*] 打开 http://127.0.0.1:${PORT}`);
console.log('[*] 关闭方式：点页面右下角「关闭服务」，或在终端按 Ctrl+C');

let shuttingDown = false;   // /api/shutdown 的幂等标记，避免重复触发退出流程

/* ---------------- 工具 ---------------- */
function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
function sendErr(res, err) {
  sendJSON(res, err.status || 500, { ok: false, error: err.message });
}
function readJSONBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > limit) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const PDF_MAX = 60 * 1024 * 1024;           // 导入 PDF 的体积上限（本机样本里最大的一份 41MB）
const MD_MAX = 80 * 1024 * 1024;            // 导入 Markdown 的上限：md 本身很小，主要是跟着一起上来的图片
const IMG_MAX = 30 * 1024 * 1024;           // 单张图的上限（含"按本机绝对路径去读"的那些）
function readRawBody(req, limit = 30 * 1024 * 1024, what = '文件') {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > limit) { reject(Object.assign(new Error(`${what}过大(>${Math.round(limit / 1048576)}MB)`), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* --------- 找到 hexo 命令：优先本地 node_modules/.bin，退回全局 --------- */
function hexoCmd() {
  if (process.env.HEXO_CMD) return process.env.HEXO_CMD;   // 测试/自定义命令入口
  const local = path.join(BLOG, 'node_modules', '.bin', 'hexo.cmd');
  if (process.platform === 'win32' && fs.existsSync(local)) return local;
  const localSh = path.join(BLOG, 'node_modules', '.bin', 'hexo');
  if (fs.existsSync(localSh)) return localSh;
  return 'hexo'; // 依赖 PATH 里的全局 hexo
}

/* ---------------- 长任务：跑 hexo clean / g / d，日志用 SSE 推 ---------------- */
const jobs = new Map();
let jobSeq = 0;

/* steps 写成函数是为了让本地预览能带端口参数（其余任务忽略 opts 即可）。 */
const TASKS = {
  build:  { title: '本地生成', steps: o => o.clean ? [['clean'], ['generate']] : [['generate']], deploy: false },
  deploy: { title: '部署到站点', steps: o => o.clean ? [['clean'], ['generate'], ['deploy']] : [['generate'], ['deploy']], deploy: true },
  clean:  { title: '清理缓存', steps: () => [['clean']], deploy: false },
  /* 本地预览：常驻任务，不会自己结束，只能靠中止按钮或关闭写作台来停。
     带 --draft 是故意的 —— 草稿本来就是"只存在于本地"的东西，本地预览该看得见；
     而正式生成与发布永远看不见它（_config.yml 里 render_drafts: false）。 */
  serve:  { title: '本地预览', steps: (o) => [['server', '--draft', '-p', String(o.port || 4000)]],
            deploy: false, long: true, port: true },
};

/** 跑单个 hexo 子命令，把 stdout/stderr 实时回调出去 */
function runStep(cmd, args, onLine, onDone) {
  if (process.platform === 'win32' && /\s/.test(cmd)) cmd = '"' + cmd + '"';
  let finished = false;
  const done = (code, msg) => { if (!finished) { finished = true; onDone(code, msg); } };
  const child = spawn(cmd, args, {
    cwd: BLOG,
    shell: process.platform === 'win32', // .cmd 需要 shell；其他平台直接执行
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const pipe = (stream, isErr) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();                       // 最后一段可能是半行，留到下次
      for (const line of parts) if (line.trim()) onLine(line.replace(/\u001b\[[0-9;]*m/g, ''), isErr);
    });
    stream.on('end', () => { if (buf.trim()) onLine(buf.trim(), isErr); });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  child.on('error', (e) => {
    // 常见坑：在受限/沙箱环境里 spawn 会直接 EPERM，报错要说得明白
    const hint = e.code === 'EPERM'
      ? `无法启动子进程 (${cmd})：当前环境不允许创建带管道的进程，请在普通终端里直接运行 node server.js`
      : e.message;
    done(1, hint);
  });
  child.on('close', (code) => done(code == null ? 1 : code, ''));
  return child;
}

/* --------- 常驻任务（本地预览）的 PID 记录 ---------
 * 常驻的 hexo server 不会自己结束。写作台走 /api/shutdown 优雅退出时，
 * 下面的 process.on('exit') 会把它连进程树一起带走；但如果是被外部强杀
 * （Stop-Process -Force 不给 node 跑清理的机会），hexo server 会变成孤儿
 * 继续占着 4000 端口。所以额外记一份 pid，方便排查和手动清理。 */
const SERVE_PID_FILE = path.join(DATA, `.hexo-serve-${PORT}.pid`);

/* --------- 让 pid 文件"不再存在"：一律改名挪走，不做删除 ---------
 * 两个约束把写法逼到了这一步：
 *   1) exit 钩子里事件循环已经停了，只能用同步 API，没有 await 的机会；
 *   2) 同步删除在这类环境里**可能直接阻塞住**，而不只是失败。
 *
 * 实测对照（同一个 exit 钩子，跑 8 轮）：
 *     fs.unlinkSync → 5 轮成功、1 轮抛 SAFE_DELETE_BULK_GUARD_ERROR、**2 轮把进程阻塞住**
 *     fs.renameSync → 6 轮全部成功，零失败零卡死
 * 差别在于"删除"会被批量删除守卫接管（它要抢锁，抢不到就拖着不放），"改名"不会。
 * 而**加重试只会更糟**：守卫第二次多半不是抛错而是卡住，重试等于主动去撞它。
 *
 * 为什么不能接受"删不掉就算了"：文件会静静留在 data/ 里，下次启动前谁看到它
 * 都以为还有一个服务在跑 —— 这比报错更坑，因为它不报错。
 * 所以这里走改名，挪到固定的 `.stale` 名字上（每次覆盖，不会越攒越多）；
 * 改名也不成（只读介质 / 权限）才退到清空内容，至少不留下一个"看起来还活着"的 pid。 */
function dropPidFileSync(file) {
  try {
    if (!fs.existsSync(file)) return true;
    fs.renameSync(file, file + '.stale');
    return true;
  } catch { /* 改名也不成（只读介质 / 权限）：退到最保守的一步 */ }
  try { fs.writeFileSync(file, ''); } catch { /* 放弃，非致命 */ }
  return false;
}
/** 清掉一份**确实是本进程写的** pid 文件：内容对不上就不碰，免得误清别的实例留下的。 */
function removeOwnPidFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.readFileSync(file, 'utf8').split('\n')[0] !== String(process.pid)) return;
  } catch { return; }   // 读不出来就无从判断归属，宁可留着
  dropPidFileSync(file);
}

function writeServePid(pid) {
  try { if (pid) fs.writeFileSync(SERVE_PID_FILE, String(pid), 'utf8'); } catch { /* 非致命 */ }
}
function clearServePid() {
  dropPidFileSync(SERVE_PID_FILE);   // 首次启动时它可能压根不存在，函数内部自会处理
}
/** 杀整棵进程树：spawn 时走了 shell，光 kill 掉 cmd.exe 会留下 hexo 本体继续占着端口。
 *
 *  这里有个容易踩的静默失效：`spawnSync` 可能拿不到结果（受限环境 / 权限 / 被安全软件拦）
 *  返回 `{status: null, error: 'EBUSY'}`。老写法只看 `r.status !== 0` 就退化成
 *  `process.kill(pid)` —— 那只能杀掉直接子进程 cmd.exe，孙子进程 hexo 本体活得好好的，
 *  端口继续被占，而界面已经提示"已停止本地预览"。所以这里必须补一次**异步** spawn
 *  （异步 spawn 在这些环境里是可用的），并且把两种情况都覆盖到。 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      if (r.error || r.status !== 0) {
        /* 注意顺序：**不能**在这里顺手先 process.kill(pid)**。**
           taskkill /T 要靠父进程还活着才能枚举出子孙；先把 cmd.exe 杀掉，
           taskkill 就找不到那棵树了，孙子进程 hexo 本体反而被留下。
           所以要等异步 taskkill 真的失败（起不来 / 退出码非 0）才退化到 kill 单个进程。 */
        const fallbackKill = () => { try { process.kill(pid); } catch { /* 已经没了 */ } };
        try {
          const t = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          t.on('error', fallbackKill);
          t.on('close', (code) => { if (code !== 0) fallbackKill(); });
        } catch { fallbackKill(); }
      }
    } else {
      try { process.kill(pid); } catch { /* 已经没了 */ }
    }
  } catch { /* 非致命 */ }
}

/* --------- 中止部署后残留的 git 锁 ---------
 * 现象：点"一键发布"跑了一半按中止，下一次发布直接失败，报
 *   `fatal: Unable to create '…/.deploy_git/.git/index.lock': File exists.`
 * 原因不是我们写的锁，是 **git 自己的**：hexo-deployer-git 在 `.deploy_git/` 里
 * 依次跑 `git add -A` → `git commit` → `git push`，这三步各自会创建
 * `.git/index.lock` 并（正常时）自己删掉。我们中止时的做法是 `taskkill /T /F`
 * 杀整棵进程树 —— git 收到的是 **SIGKILL 级的强杀**，它没有机会跑任何清理，
 * 锁就留在磁盘上了。窗口期正是 `git add -A` 那几秒（大站点能到十几秒）。
 *
 * 为什么不能"下次发布前无脑删锁"：锁存在的正当理由只有两种 ——
 *   ① 上一个 git 进程还活着（真在写索引）；
 *   ② 它被强杀留下了尸体。
 * 只看"文件在不在"就删，会在 ① 的情况下把一个正在运行的 git 的锁抽掉，
 * 索引写坏比"多一次失败"严重得多。所以判据必须是**没有活着的 git 在跑**。
 *
 * 因此这里分两步，顺序不能反：
 *   1) 任务启动前（含用户主动中止后再次点发布）：等到**没有任何 git 进程**，
 *      再把这几个已知锁文件删掉 —— 这叫"清理尸体"。
 *   2) 任务因为中止/失败退出时：主动扫一遍并删掉残留锁 —— 不等下次，当场清掉，
 *      用户看到的就是"中止即干净"。
 *
 * 锁文件清单：除 index.lock 外，`git commit` 期间的失败还常见
 *   HEAD.lock / config.lock / packed-refs.lock / refs/**\/**.lock，
 * 但**只清我们确实会碰的这个仓库**（.deploy_git 与站点根），且只清固定的几个名字，
 * 不做通配删除 —— 免得把用户自己仓库里的东西删了。 */
const GIT_LOCK_DIRS = () => [
  path.join(BLOG, '.deploy_git', '.git'),
  path.join(BLOG, '.git'),
];
const GIT_LOCK_NAMES = ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'shallow.lock', 'ORIG_HEAD.lock'];

/** 有没有正在跑的 git 进程（只看进程名，不关心命令行）。
 *  `tasklist` 输出在中文/英文系统上列宽不同，所以只做**子串**判断，
 *  不按列切分 —— 切列在本地化输出上会静默漏判。 */
function gitRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      /* 非 Windows 没有 tasklist：用 pgrep，大多数发行版自带；没有就当"跑不起来=无人"
         —— 宁可少删一次也不能误删。 */
      try {
        const t = spawn('pgrep', ['-x', 'git'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let o = ''; t.stdout.on('data', (d) => (o += d));
        t.on('close', () => resolve(o.trim().length > 0));
        t.on('error', () => resolve(false));
      } catch { resolve(false); }
      return;
    }
    try {
      const t = spawn('tasklist', ['/FI', 'IMAGENAME eq git.exe', '/NH'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let o = ''; t.stdout.setEncoding('utf8');
      t.stdout.on('data', (d) => (o += d));
      t.on('close', () => resolve(/\bgit\.exe\b/i.test(o)));
      t.on('error', () => resolve(false));   // 查不了 → 当作有人在跑，宁可不清
    } catch { resolve(false); }
  });
}

/** 删一个文件，走 rename-then-delete。
 *  为什么绕这一下：某些环境里同步 unlink 会被"批量删除守卫"拖住甚至阻塞
 *  （见上面 dropPidFileSync 的实测记录）。改名不经过那条路径，先改名让它
 *  立刻"不再叫 index.lock"（git 的判断就此解除），真删失败也只是留个 .stale。 */
function dropLockFile(file) {
  try {
    if (!fs.existsSync(file)) return false;
    try { fs.renameSync(file, file + '.stale-' + Date.now()); return true; }
    catch { /* 改不动：只读 / 被独占打开 */ }
    try { fs.unlinkSync(file); return true; } catch { return false; }
  } catch { return false; }
}

/** 清掉本站点仓库里残留的 git 锁（先确认没有活着的 git）。返回清掉的路径列表。 */
async function clearGitLocks(why) {
  if (!BLOG) return [];
  if (await gitRunning()) return [];     // 有 git 在跑 → 那是真锁，绝不能碰
  const gone = [];
  for (const dir of GIT_LOCK_DIRS()) {
    for (const name of GIT_LOCK_NAMES) {
      const f = path.join(dir, name);
      if (dropLockFile(f)) gone.push(f);
    }
    /* refs/ 下的锁名字不固定（refs/heads/main.lock 等），但目录很浅，扫一层就够。
       仍然只删 *.lock，且只在确认没有 git 进程之后。 */
    try {
      const refs = path.join(dir, 'refs');
      for (const sub of ['', 'heads', 'remotes', 'tags']) {
        const d = sub ? path.join(refs, sub) : refs;
        if (!fs.existsSync(d)) continue;
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          if (ent.isFile() && ent.name.endsWith('.lock')) {
            const f = path.join(d, ent.name);
            if (dropLockFile(f)) gone.push(f);
          } else if (ent.isDirectory() && sub === 'remotes') {
            for (const ent2 of fs.readdirSync(path.join(d, ent.name), { withFileTypes: true })) {
              if (ent2.isFile() && ent2.name.endsWith('.lock')) {
                const f = path.join(d, ent.name, ent2.name);
                if (dropLockFile(f)) gone.push(f);
              }
            }
          }
        }
      }
    } catch { /* refs 目录不存在或读不了：正常情况 */ }
  }
  if (gone.length) console.log(`[*] 清理 git 残留锁（${why}）：\n    ` + gone.join('\n    '));
  return gone;
}

/** 中止/失败之后清锁：被杀掉的那棵树可能要一小会儿才真正退出，
 *  而 `gitRunning()` 看到它还在就会拒绝清锁（那是对的，不能抽掉活锁）。
 *  所以这里**轮询等它退干净**，最多等 3 秒。等不到就放弃这一轮 ——
 *  不清总比清错强，而且下次点发布时 startJob 还会再清一次。 */
async function clearGitLocksAfterStop(push, opts = {}) {
  if (!BLOG) return [];
  for (let i = 0; i < 12; i++) {
    if (!(await gitRunning())) {
      const gone = await clearGitLocks('上一次任务中止后');
      if (gone.length && !opts.quiet) {
        push('info', `已清理中止残留的 git 锁 ${gone.length} 个，下次发布不会再被它挡住`);
      }
      return gone;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!opts.quiet) push('info', '仍有 git 进程在退出，这一轮的锁等下次发布开始时再清');
  return [];
}

function startJob(kind, opts = {}) {
  const spec = TASKS[kind];
  if (!spec) throw Object.assign(new Error('未知任务'), { status: 400 });

  /* 发布前先把该查的查清楚，别让用户跑完 generate 才在最后一步失败 */
  if (spec.deploy) {
    const cfg = lib.readSiteConfig(BLOG);
    if (!cfg.deploys.length || cfg.deploys.some(d => !d.type || (d.type === 'git' && !d.repo))) {
      throw Object.assign(new Error('未配置 deploy：请先在 _config.yml 里写好 deploy 的 type/repo/branch'), { status: 400 });
    }
  }
  if ([...jobs.values()].some(j => j.status === 'running')) throw Object.assign(new Error('已有任务运行，请先停止本地预览或等待当前任务完成'), {status:409});
  if (spec.long) { opts.port = validPort(opts.port || settings.previewPort || 4000); }
  if (spec.deploy && lib.readSiteConfig(BLOG).renderDrafts && !opts.allowDrafts) throw Object.assign(new Error('render_drafts 为 true：需要明确确认包含草稿后才能部署'), {status:400});
  const steps = spec.steps(opts);
  const job = {
    id: 'j' + Date.now() + '-' + (++jobSeq),
    kind, title: spec.title, status: 'running', long: !!spec.long,
    port: spec.port ? Number(opts.port || 4000) : null,
    logs: [], sequence: 0, clients: new Set(), child: null, startedAt: Date.now(), code: null, deploying: false,
  };
  jobs.set(job.id, job);
  // 只保留最近 20 个任务记录；正在跑的（尤其常驻的本地预览）不能清掉
  if (jobs.size > 20) {
    for (const k of [...jobs.keys()]) {
      if (jobs.get(k).status !== 'running') { jobs.delete(k); break; }
    }

  }

  const push = (type, text) => {
    const evt = { type, text, t: Date.now(), seq: ++job.sequence };
    job.logs.push(evt);
    if (job.logs.length > 4000) job.logs.shift();
    const payload = `id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of job.clients) { try { res.write(payload); } catch { /* 客户端断了 */ } }
  };

  (async () => {
    const hexo = hexoCmd();
    push('info', `任务开始: ${spec.title}  (${steps.map(a => 'hexo ' + a.join(' ')).join('  &&  ')})`);
    push('info', `hexo 命令: ${hexo}`);
    /* 带 deploy 的任务开始前先清一遍残留锁：用户上一次中止留下的 index.lock
       会让这次的 `git add -A` 直接 fatal 掉。清理前提是"没有活着的 git"，
       所以这里要 await 一次进程查询 —— 那点耗时（几十毫秒）比失败重来划算得多。 */
    if (spec.deploy) {
      const gone = await clearGitLocks('本次部署开始前');
      if (gone.length) push('info', `清掉了上一次中止留下的 ${gone.length} 个 git 锁文件`);
    }
    for (const args of steps) {
      /* 中止后必须真的停下：进程被杀会触发 close，若不检查状态，
         循环会继续跑下一个 hexo 子命令（比如 clean 之后照样 generate）。 */
      if (job.status !== 'running') break;
      push('info', `$ hexo ${args.join(' ')}`);
      const code = await new Promise((resolve) => {
        job.child = runStep(hexo, args, (line, isErr) => push(isErr ? 'err' : 'out', line), (c, msg) => {
          if (msg) push('err', msg);
          resolve(c);
        });
        if (spec.long) writeServePid(job.child && job.child.pid);
      });
      job.child = null;
      if (spec.long) clearServePid();
      if (job.status === 'stopped') {          // 用户主动中止，不算失败
        /* 中止是**唯一**会留下 git 锁的路径（进程被强杀，git 没机会清）。
           所以在这里当场清掉，而不是等下次发布时才补 —— 用户看到的应该是
           "点了中止，下一次发布照样能跑通"。清锁函数自己会先确认没有 git 进程，
           所以这里 await 是安全的：被杀的进程树这时候通常还没完全退干净，
           函数内会重试等待（见 clearGitLocksAfterStop）。 */
        if (spec.deploy) await clearGitLocksAfterStop(push);
        push('fail', '已中止');
        push('end', 'stopped');
        return;
      }
      if (code !== 0) {
        job.status = 'failed'; job.code = code;
        /* 失败分支同样要清：`git add -A` 起不来是**它自己**先建锁再报错的，
           也可能留下 index.lock。不清的话用户改完配置重试还是同一个错。 */
        if (spec.deploy) await clearGitLocksAfterStop(push);
        push('fail', `hexo ${args.join(' ')} 退出码 ${code}，任务中止`);
        push('end', 'failed');
        return;
      }
      if (args[0] === 'deploy') job.deploying = true;
    }
    if (job.status !== 'running') return;
    job.status = 'done'; job.code = 0;
    /* 部署成功也扫一遍：某些 git 版本在 push 成功后会残留 packed-refs.lock，
       不影响这次，但会让用户**下一次**莫名其妙失败。这里只删确认没进程守着的锁。 */
    if (spec.deploy) await clearGitLocksAfterStop(push, { quiet: true });
    if (kind === 'deploy') {
      lastDeploy = { blog: BLOG, at: new Date().toISOString(), url: lib.readSiteConfig(BLOG).url, status: 'done' };
      try { lib.atomicWrite(DEPLOY_FILE, JSON.stringify(lastDeploy)); } catch(e) { push('info', '部署成功，但记录写入失败：' + e.message); }
    }
    push('ok', '全部命令执行成功 ✓');
    push('end', 'done');
  })().catch((e) => { push('fail', String(e && e.message || e)); push('end', 'failed'); job.status = 'failed'; });

  return job;
}

/** 导入（PDF / Markdown）时图片该落进哪个"文章同名资源目录"。
 *
 *  目录名必须和**保存时算出来的那个**完全一致，否则一保存正文里的 asset_img 就全部
 *  找不到文件。保存走的是 `sanitizeName(f-name || title)`，所以这里用同一条规则算，
 *  并把名字回给前端写进 f-name —— 用户改标题也不会换目录（f-name 优先于 title）。
 *  返回 {name, dir}；没给名字或名字是 Windows 保留名时 → {name:'', dir:null}（就当这次没图）。 */
function importAssetDir(post, title, draft) {
  const assetBase = post || title;
  if (!assetBase) return { name: '', dir: null };
  try {
    const name = lib.sanitizeName(assetBase);
    return { name, dir: lib.resolveInside(lib.postDir(BLOG, draft), name, '') };
  } catch { return { name: '', dir: null }; }     // 保留名之类的极端文件名就不带图了
}

/* ---------------- 路由 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const DEPLOY_FILE = path.join(DATA, '.hexo-tool-last-deploy.json');
let lastDeploy = null;
try { lastDeploy = JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8')); } catch { /* 首次使用 */ }
function validPort(value) {
  const n=Number(value);if(!Number.isInteger(n)||n<1||n>65535)throw Object.assign(new Error('端口必须为 1–65535'),{status:400});return n;
}
function checkPort(port) {
  return new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Object.assign(new Error(`端口 ${port} 已被占用，请在设置里更换`),{status:409})));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
}
function runningJobs() { return [...jobs.values()].filter(j=>j.status==='running'); }
function jobInfo(j) {return {id:j.id,kind:j.kind,title:j.title,status:j.status,port:j.port,long:j.long,startedAt:j.startedAt,code:j.code,sequence:j.sequence};}
function assertRevision(name,draft,revision) {
  if(!revision)throw Object.assign(new Error('缺少文件版本，请刷新文章列表后重试'),{status:428});
  const post=lib.readPost(BLOG,name,draft);
  if(post.revision!==revision)throw Object.assign(new Error('文章已被修改，请刷新后重试'),{status:409});
  return post;
}
function postQuery(url) {return {name:url.searchParams.get('name')||'',draft:url.searchParams.get('draft')==='1'};}
function security(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(req.headers.host))throw Object.assign(new Error('非法 Host'),{status:403});
  if(req.headers.origin && ![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(req.headers.origin))throw Object.assign(new Error('拒绝跨站请求'),{status:403});
  if(req.headers['sec-fetch-site']==='cross-site')throw Object.assign(new Error('拒绝跨站请求'),{status:403});
  if(!['GET','HEAD'].includes(req.method) && req.headers['x-hexo-token']!==token)throw Object.assign(new Error('请求令牌失效，请刷新页面'),{status:403});
}
function siteInfo() {
  if(!BLOG)return {ok:true,configured:false,blog:'',port:PORT,pid:process.pid,token,previewPort:settings.previewPort||4000,counts:{total:0,drafts:0,published:0}};
  const cfg=lib.readSiteConfig(BLOG),posts=lib.listPosts(BLOG),drafts=posts.filter(p=>p.draft).length;
  return {ok:true,configured:true,blog:BLOG,port:PORT,pid:process.pid,token,...cfg,hexo:hexoCmd(),
    counts:{total:posts.length,drafts,published:posts.length-drafts},previewPort:settings.previewPort||4000,
    lastDeploy:lastDeploy&&lastDeploy.blog===BLOG ? lastDeploy : null};
}
/* 表里的路径一律相对 APP（应用根），不是相对本文件 ——
   这条约定让"把 server.js 挪进 src/"变成零成本，也避免 ../ 满天飞。 */
const STATIC = new Map([
  ['/','web/index.html'],['/index.html','web/index.html'],['/styles.css','web/styles.css'],['/app.js','web/app.js'],['/editor.js','web/editor.js'],
  ['/theme.js','web/theme.js'],
  /* Markdown 编辑快捷键：纯逻辑表 + 键位表，editor.js 依赖它，必须排在前面加载 */
  ['/mdkeys.js','web/mdkeys.js'],
  /* 单篇文章的独立编辑页。精确匹配，跟 /api/post 不冲突；它读的仍然是同一套 /api/*。 */
  ['/post','web/post.html'],['/post.html','web/post.html'],['/post.js','web/post.js'],
  ['/preview','web/preview.html'],['/preview.js','web/preview.js'],
  ['/marked.js','vendor/marked.min.js'],['/yaml.js','vendor/js-yaml.js'],['/purify.js','vendor/purify.min.js'],
]);
const server = http.createServer(async (req,res)=>{
  try {
    security(req,res);
    const url=new URL(req.url,'http://127.0.0.1'),p=decodeURIComponent(url.pathname);
    if(req.method==='GET' && STATIC.has(p))return sendFile(res,path.join(APP,STATIC.get(p)));
    if(p==='/api/info' && req.method==='GET')return sendJSON(res,200,siteInfo());
    if(p==='/api/settings' && req.method==='GET')return sendJSON(res,200,{ok:true,blog:BLOG,toolPort:settings.toolPort||PORT,currentPort:PORT,previewPort:settings.previewPort||4000});
    if(p==='/api/settings' && req.method==='POST') {
      if(runningJobs().length)throw Object.assign(new Error('请先停止运行中的任务，再修改设置'),{status:409});
      const data=await readJSONBody(req);
      const value=data.blog===undefined?BLOG:String(data.blog).trim();
      if(!value)throw Object.assign(new Error('请填写 Hexo 博客目录'),{status:400});
      const blog=path.resolve(value);
      if(!lib.isBlogRoot(blog))throw Object.assign(new Error('博客目录必须包含 _config.yml 和 source/_posts'),{status:400});
      lib.readSiteConfig(blog);
      /* 端口只在"没传"时才回退到当前值。写成 `data.toolPort || PORT` 会把 0 也当没传，
         结果是用户在前端填 0 却收到"已保存"而端口纹丝不动 —— 这里必须显式判空。 */
      const portOf = (value, fallback) => (value === undefined || value === null || value === '') ? fallback : value;
      const next={blog,toolPort:validPort(portOf(data.toolPort,PORT)),previewPort:validPort(portOf(data.previewPort,settings.previewPort||4000))};
      if(next.toolPort===next.previewPort)throw Object.assign(new Error('写作台端口与预览端口不能相同'),{status:400});
      lib.atomicWrite(SETTINGS_FILE,JSON.stringify(next,null,2));settings=next;BLOG=blog;
      return sendJSON(res,200,{ok:true,...next,restartRequired:next.toolPort!==PORT});
    }
    if(!BLOG && ((p.startsWith('/api/') && p!=='/api/shutdown') || p.startsWith('/media/')))throw Object.assign(new Error('请先在网页「设置」中选择博客目录'),{status:409});
    if(p==='/api/pages' && req.method==='GET')return sendJSON(res,200,{ok:true,blog:BLOG,files:pages.listPages(BLOG)});
    if(p==='/api/page' && req.method==='GET')return sendJSON(res,200,{ok:true,blog:BLOG,...pages.readPage(BLOG,url.searchParams.get('name'))});
    if(p==='/api/page' && req.method==='POST') {
      const data=await readJSONBody(req);
      if(runningJobs().some(j=>!j.long))throw Object.assign(new Error('生成或部署过程中暂不能修改页面，请稍后保存'),{status:409});
      if(data.blog!==BLOG)throw Object.assign(new Error('博客目录已切换，请重新打开页面文件'),{status:409});
      return sendJSON(res,200,{ok:true,blog:BLOG,...pages.writePage(BLOG,data.name,data.content,data.revision)});
    }
    if(p==='/api/configs' && req.method==='GET')return sendJSON(res,200,{ok:true,blog:BLOG,files:lib.listConfigFiles(BLOG)});
    if(p==='/api/config' && req.method==='GET')return sendJSON(res,200,{ok:true,blog:BLOG,...lib.readConfig(BLOG,url.searchParams.get('name'))});
    if(p==='/api/config' && req.method==='POST') {
      if(runningJobs().length)throw Object.assign(new Error('请先停止预览或等待生成、部署完成，再修改配置'),{status:409});
      const data=await readJSONBody(req);
      if(data.blog!==BLOG)throw Object.assign(new Error('博客目录已切换，请重新打开配置文件'),{status:409});
      return sendJSON(res,200,{ok:true,blog:BLOG,...lib.writeConfig(BLOG,data.name,data.content,data.revision)});
    }
    if(p==='/api/posts' && req.method==='GET')return sendJSON(res,200,{ok:true,blog:BLOG,port:PORT,pid:process.pid,posts:lib.listPosts(BLOG,url.searchParams.get('q')||'')});
    if(p==='/api/post' && req.method==='GET') {
      const {name,draft}=postQuery(url);const post=lib.readPost(BLOG,name,url.searchParams.has('draft')?draft:undefined);
      return sendJSON(res,200,{ok:true,...post,file:undefined});
    }
    /* 编译完成后，前端拿这个把"这篇文章生成到哪了"显示出来并给个直达链接。
       路径是照 _config.yml 的 permalink 模板算的，所以在 public/ 下验证过才算数。 */
    if(p==='/api/post-url' && req.method==='GET') {
      const {name,draft}=postQuery(url);
      if(!name)throw Object.assign(new Error('缺少文章名'),{status:400});
      const out=lib.resolvePostOutput(BLOG,name,draft);
      return sendJSON(res,200,{ok:true,...out,file:undefined});
    }
    if(!['GET','HEAD'].includes(req.method) && /^\/api\/(post|posts|publish|upload|assets|trash)/.test(p) && runningJobs().some(j=>!j.long))throw Object.assign(new Error('生成或部署过程中暂不能改动博客文件，请稍后保存；编辑缓存仍会保留'),{status:409});
    if(p==='/api/post' && req.method==='POST') {
      const data=await readJSONBody(req);
      const title=String(data.title||'').trim();if(!title)throw Object.assign(new Error('标题不能为空'),{status:400});
      if(data.originalName && !data.revision)throw Object.assign(new Error('缺少文章版本，请重新打开文章'),{status:428});
      const name=lib.sanitizeName(data.name||title);
      const meta={title,date:data.date||lib.formatDate(),categories:data.categories||[],tags:data.tags||[],
        description:data.description||'',keywords:data.keywords||'',cover:data.cover||'',mathjax:!!data.mathjax,top:data.top||'',draft:!!data.draft};
      lib.writePost(BLOG,{name,meta,body:data.body||'',originalName:data.originalName||'',originalDraft:!!data.originalDraft,
        revision:data.revision,changedFields:data.changedFields,frontMatter:data.frontMatter});
      const post=lib.readPost(BLOG,name,meta.draft);
      return sendJSON(res,200,{ok:true,...post,file:undefined});
    }
    if(p==='/api/publish' && req.method==='POST') {
      const data=await readJSONBody(req);assertRevision(data.name,!!data.draft,data.revision);
      lib.publishPost(BLOG,data.name,!!data.draft,data.publish!==false,data.revision);
      return sendJSON(res,200,{ok:true,...lib.readPost(BLOG,data.name,data.publish===false),file:undefined});
    }
    if(p==='/api/post' && req.method==='DELETE') {
      const {name,draft}=postQuery(url);assertRevision(name,draft,url.searchParams.get('revision'));
      return sendJSON(res,200,{ok:true,trashed:lib.moveToTrash(BLOG,name,draft)});
    }
    if(p==='/api/posts/delete' && req.method==='POST') {
      const data=await readJSONBody(req);if(!Array.isArray(data.items)||!data.items.length)throw Object.assign(new Error('没有选中文章'),{status:400});
      const done=[],failed=[];
      for(const item of data.items)try{assertRevision(item.name,!!item.draft,item.revision);done.push(lib.moveToTrash(BLOG,item.name,!!item.draft));}catch(e){failed.push({name:item.name,error:e.message});}
      return sendJSON(res,200,{ok:true,deleted:done.length,done,failed});
    }
    if(p==='/api/trash' && req.method==='GET')return sendJSON(res,200,{ok:true,items:lib.listTrash(BLOG),dir:lib.trashDir(BLOG)});
    if(p==='/api/trash/restore' && req.method==='POST') {const {id}=await readJSONBody(req);return sendJSON(res,200,{ok:true,restored:lib.restoreFromTrash(BLOG,id)});}
    if(p==='/api/trash/delete' && req.method==='POST') {const {id}=await readJSONBody(req);return sendJSON(res,200,{ok:true,deleted:lib.deleteFromTrash(BLOG,id)});}
    if(p==='/api/trash/empty' && req.method==='POST')return sendJSON(res,200,{ok:true,count:lib.emptyTrash(BLOG)});
    if(p==='/api/history' && req.method==='GET') {const {name,draft}=postQuery(url);return sendJSON(res,200,{ok:true,items:lib.listHistory(BLOG,name,draft)});}
    if(p==='/api/history/version' && req.method==='GET') {
      const {name,draft}=postQuery(url);const {raw}=lib.readHistory(BLOG,name,draft,url.searchParams.get('id'));
      const parsed=lib.parseFrontMatter(raw);return sendJSON(res,200,{ok:true,body:parsed.body,meta:parsed.data,frontMatter:parsed.header});
    }
    if(p==='/api/assets' && req.method==='GET') {
      const {name,draft}=postQuery(url);return sendJSON(res,200,{ok:true,items:lib.listAssets(BLOG,name,draft),archived:lib.listArchivedImages(BLOG,name,draft)});
    }
    if(p==='/api/assets' && req.method==='DELETE') {
      const {name,draft}=postQuery(url),asset=url.searchParams.get('asset');const post=lib.readPost(BLOG,name,draft);
      if(!asset)throw Object.assign(new Error('缺少图片文件名'),{status:400});
      const dir=lib.resolveInside(lib.postDir(BLOG,draft),name,'');const file=lib.resolveInside(dir,asset,'');
      if(path.basename(asset)!==asset)throw Object.assign(new Error('非法图片名'),{status:400});
      if(post.body.includes(asset)||String(post.meta.cover||'').includes(asset))throw Object.assign(new Error('图片仍被已保存正文或封面引用，请先移除引用并保存'),{status:409});
      if(!fs.existsSync(file))throw Object.assign(new Error('图片不存在'),{status:404});
      lib.archiveImage(BLOG,name,draft,file);return sendJSON(res,200,{ok:true});
    }
    if(p==='/api/assets/restore' && req.method==='POST') {
      const data=await readJSONBody(req);lib.readPost(BLOG,data.name,!!data.draft);
      lib.restoreImage(BLOG,data.name,!!data.draft,data.id,lib.resolveInside(lib.postDir(BLOG,!!data.draft),data.name,''));return sendJSON(res,200,{ok:true});
    }
    if(p==='/api/upload' && req.method==='PUT') {
      const name=url.searchParams.get('post'),draft=url.searchParams.get('draft')==='1';if(!name)throw Object.assign(new Error('缺少文章名'),{status:400});
      if(!lib.readSiteConfig(BLOG).postAssetFolder)throw Object.assign(new Error('请先在博客 _config.yml 中启用 post_asset_folder: true，再使用本文图片'),{status:400});
      lib.readPost(BLOG,name,draft);const dir=lib.resolveInside(lib.postDir(BLOG,draft),name,'');
      const buf=await readRawBody(req),ext=lib.detectImage(buf);
      const original=url.searchParams.get('name')||'image';const fileName=lib.assetName(buf,'image.'+ext),target=lib.resolveInside(dir,fileName,'');
      const reused=fs.existsSync(target);if(reused && !fs.readFileSync(target).equals(buf))throw Object.assign(new Error('图片哈希冲突，未覆盖文件'),{status:409});
      if(!reused)lib.atomicWrite(target,buf);
      return sendJSON(res,200,{ok:true,name:fileName,path:fileName,reused,markdown:lib.assetTag(fileName,original)});
    }
    /* PDF → Markdown 导入。解析**在服务端**做：pdf.js 连 cmaps / standard_fonts
       一起放在 vendor/，浏览器只把文件字节 POST 上来、把返回的 markdown 填进编辑器。
       放在服务端的另一个好处是同一份代码能在命令行复现、能被测试脚本驱动。
       这里**不占博客写锁** —— 它只算不改，生成/部署跑着的时候也能用。 */
    if(p==='/api/import-pdf' && req.method==='POST') {
      const buf=await readRawBody(req,PDF_MAX,'PDF');
      /* 先看一眼魔数：用户选错文件（比如传了张图片）时给出人话提示，
         而不是把二进制丢给 pdf.js 之后抛一个 InvalidPDFException。 */
      if(buf.length<5||buf.slice(0,5).toString('latin1')!=='%PDF-')throw Object.assign(new Error('这不是 PDF 文件（文件头不是 %PDF-）'),{status:400});
      const qTitle=url.searchParams.get('title')||'',qDraft=url.searchParams.get('draft')==='1';
      /* 单篇页（post.js）是把 PDF **插进现有文章**，所以它能给出明确的 post 名和
         草稿位；首页（app.js）导入的是一篇新文章，只能给标题 —— 这时候资源目录名
         由服务端按保存时的同一条规则算出来并回传。 */
      const qPost=url.searchParams.get('post')||'';
      const wantImages=url.searchParams.get('images')!=='0';
      const assetFolder=!!lib.readSiteConfig(BLOG).postAssetFolder;
      /* 目录名怎么算、为什么必须和保存时算出来的那个一致：见 importAssetDir。 */
      const assetDraft=qPost?url.searchParams.get('draft')==='1':qDraft;
      const target=(wantImages && assetFolder) ? importAssetDir(qPost,qTitle,assetDraft) : {name:'',dir:null};
      const assetName=target.name,assetDir=target.dir;
      let written=0;
      const images=assetDir ? (async (im,i)=>{
        const original=`pdf-第${im.page}页图${i+1}.${im.ext}`;   // 只用来生成 alt，文件名是内容哈希
        const fileName=lib.assetName(im.data,original);
        if(!fs.existsSync(assetDir))fs.mkdirSync(assetDir,{recursive:true});
        const target=lib.resolveInside(assetDir,fileName,'');
        if(!fs.existsSync(target))lib.atomicWrite(target,im.data);
        written++;
        return lib.assetTag(fileName,original);
      }) : null;
      const r=await pdfimport.convert({buffer:buf,title:qTitle,images});
      if(!r.markdown.trim())throw Object.assign(new Error('这份 PDF 里没有可提取的文字。如果它是扫描件或整页截图，需要先做 OCR 才能转成文字。'),{status:422});
      /* assets 只回**目录名**（前端要拿它填 f-name，好让保存时算出的目录一致）。
         服务端算出来的绝对路径（assetDir）**一个字都不往外吐** —— 那是本机内部结构，
         前端也用不上，没有理由出现在响应里。 */
      return sendJSON(res,200,{ok:true,title:r.title,markdown:r.markdown,stats:r.stats,
        assets:assetName?{name:assetName,count:written,draft:assetDraft}:null,assetFolder});
    }
    /* Markdown 导入：一份 .md（以及跟着一起选进来的图片）变成一篇文章。
       正文不用猜版式 —— 直接读原文，只把图片引用换成 Hexo 原生 {% asset_img %}，
       并把引用到的图片字节**复制**进文章的同名资源目录。
       图片和 md 走同一个 multipart 请求：只有字节都在服务端，资源名（内容哈希）
       才算得出来；分开发的话浏览器还得先问"这篇文章叫什么"，顺序就绕了。
       这里和 PDF 导入一样**不占博客写锁** —— 它只往资源目录里添文件，
       生成或部署跑着的时候也能先整理素材。 */
    if(p==='/api/import-md' && req.method==='POST') {
      const raw=await readRawBody(req,MD_MAX,'Markdown');
      /* 先看 Content-Type：浏览器用 FormData 发的时候会自己带上 boundary，
         少了它整个请求就是一堆没法切分的字节，得在门口说清楚。 */
      const ct=String(req.headers['content-type']||'');
      const bm=/boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
      if(!/multipart\/form-data/i.test(ct)||!bm)throw Object.assign(new Error('请求格式不对：需要 multipart/form-data'),{status:400});
      const parts=mdimport.parseMultipart(raw,(bm[1]||bm[2]).trim());
      /* 字段名约定（见 web/editor.js 的 buildImportForm）：
           md     → Markdown 原文      mdrel → md 在上传时的相对路径（用来解析相对引用）
           f:xxx  → 一张图片，xxx 是它的相对路径（子目录里的图靠它对上号） */
      let mdText='',mdRel='',mdMode='auto';const files=new Map();
      for(const part of parts) {
        if(part.name==='md')mdText=part.data.toString('utf8');
        else if(part.name==='mdrel')mdRel=part.data.toString('utf8');
        else if(part.name==='mdmode')mdMode=part.data.toString('utf8');
        else if(part.name.startsWith('f:')){const key=part.name.slice(2);if(key)files.set(key,part.data);}
      }
      mdText=mdText.replace(/^\uFEFF/,'');
      if(!['auto','markdown','obsidian'].includes(mdMode))throw Object.assign(new Error('Markdown 导入模式无效'),{status:400});
      if(!mdText.trim())throw Object.assign(new Error('这个 Markdown 文件是空的'),{status:422});
      const qTitle=url.searchParams.get('title')||'',qDraft=url.searchParams.get('draft')==='1';
      const qPost=url.searchParams.get('post')||'';
      const assetFolder=!!lib.readSiteConfig(BLOG).postAssetFolder;
      const assetDraft=qPost?url.searchParams.get('draft')==='1':qDraft;
      const target=assetFolder ? importAssetDir(qPost,qTitle,assetDraft) : {name:'',dir:null};
      const written=new Set();
      const images=target.dir ? (async (img)=>{
        const fileName=lib.assetName(img.data,img.name);       // 与手动上传同一套：内容哈希
        if(!fs.existsSync(target.dir))fs.mkdirSync(target.dir,{recursive:true});
        const p=lib.resolveInside(target.dir,fileName,'');
        if(!fs.existsSync(p))lib.atomicWrite(p,img.data);      // 同一张图重复引用只会写一次
        written.add(fileName);
        /* alt 用原文里写的那个（mdimport 从 ![alt](…) / <img alt> 里取出来），
           没有才退回文件名 —— 作者写的"图一"比"image-20240101"有用得多。 */
        return lib.assetTagAlt(fileName, img.alt || lib.altFromName(img.name));
      }) : null;
      /* 允许读本机绝对路径上的图片（Typora 等"粘贴图片"会写 `file:///C:/.../xxx.png`）。
         写作台是跑在**用户自己机器上**的本地服务，导入的是用户自己选的 md，
         所以这条路的代价可接受；但边界必须卡死：
           · 只认图片后缀（lib.assetExt 有白名单）—— 不会把别的类型吸进博客；
           · 只认绝对路径 —— 相对路径是"随 md 上传的文件"那条路，不能混；
           · 读不到（换了机器、路径失效）就返回 null，如实算缺图，不假装成功。 */
      const readLocal=async (abs)=>{
        if(!path.isAbsolute(abs))return null;
        if(!lib.assetExt(abs,''))return null;          // 非图片后缀：一律不读
        try{ if(!fs.existsSync(abs))return null; const st=fs.statSync(abs); if(!st.isFile())return null;
          if(st.size>IMG_MAX)return null; return fs.readFileSync(abs); }
        catch{ return null; }
      };
      const r=await mdimport.convert({text:mdText,files,mdPath:mdRel,images,readLocal,mode:mdMode});
      if(!r.markdown.trim())throw Object.assign(new Error('这份 Markdown 里没有正文'),{status:422});
      /* 标题的优先级：front-matter 里写的 > 文件名。
         md 的标题是作者自己写进去的，可信；没有 front-matter 时才退回文件名
         （和 PDF 一样，之后在标题框里改就是了）。 */
      const title=String((r.meta&&r.meta.title)||qTitle||'').trim();
      return sendJSON(res,200,{ok:true,title,markdown:r.markdown,meta:r.meta||{},stats:r.stats,
        missing:r.missing||[],assets:target.name?{name:target.name,count:written.size,draft:assetDraft}:null,assetFolder});
    }
    if(p.startsWith('/media/') && req.method==='GET') {
      const seg=p.slice(7).split('/');const mode=seg.shift();
      if(!['p','d'].includes(mode)||seg.length<2)throw Object.assign(new Error('图片路径无效'),{status:404});
      const name=seg.shift(),asset=seg.join('/');if(!lib.assetExt(asset,''))throw Object.assign(new Error('仅提供图片文件'),{status:404});
      const dir=lib.resolveInside(lib.postDir(BLOG,mode==='d'),name,'');const file=lib.resolveInside(dir,asset,'');
      res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");return sendFile(res,file);
    }
    if(p==='/api/jobs' && req.method==='GET')return sendJSON(res,200,{ok:true,jobs:[...jobs.values()].map(jobInfo),lastDeploy:lastDeploy&&lastDeploy.blog===BLOG?lastDeploy:null});
    if(p==='/api/run' && req.method==='POST') {
      const data=await readJSONBody(req);if(data.kind==='serve')await checkPort(validPort(data.port||settings.previewPort||4000));
      const job=startJob(data.kind,{port:data.port||settings.previewPort||4000,clean:!!data.clean,allowDrafts:!!data.allowDrafts});
      return sendJSON(res,200,{ok:true,...jobInfo(job)});
    }
    if(p==='/api/logs' && req.method==='GET') {
      const job=jobs.get(url.searchParams.get('id'));if(!job)throw Object.assign(new Error('任务不存在'),{status:404});
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write('retry: 2000\n\n');const after=Number(req.headers['last-event-id']||url.searchParams.get('after')||0);
      for(const evt of job.logs)if(evt.seq>after)res.write(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`);
      if(job.status!=='running'){res.write(`data: ${JSON.stringify({type:'end',text:job.status,seq:job.sequence})}\n\n`);return res.end();}
      job.clients.add(res);const ka=setInterval(()=>res.write(': ka\n\n'),15000);
      req.on('close',()=>{clearInterval(ka);job.clients.delete(res);});return;
    }
    if(p==='/api/stop' && req.method==='POST') {
      const {id}=await readJSONBody(req),job=jobs.get(id);if(!job||job.status!=='running')return sendJSON(res,200,{ok:true,noop:true});
      job.status='stopped';if(job.child?.pid)killTree(job.child.pid);if(job.long)clearServePid();
      /* 部署任务被中止 → 兜底清锁。任务循环里那条 return 前也会清，两条路都留着是
         因为它们覆盖的时机不同：如果用户在 `git push` 那一步中止，进程秒退，
         循环里那条能正常走完；但如果中止发生在 `hexo generate` 阶段（还没到 deploy），
         循环走到 stopped 分支也一样会清。**这条兜底是为了另一种情况**：
         任务循环因为别的原因没走到 finally（例如 push 的客户端断了导致异常先冒出去）。
         重复清是幂等的，清不到东西就是空数组，不会误伤。 */
      if(job.kind==='deploy')clearGitLocksAfterStop((t,msg)=>console.log('[*]',msg),{quiet:true});
      return sendJSON(res,200,{ok:true});
    }
    if(p==='/api/shutdown' && req.method==='POST') {
      const active=runningJobs();if(active.some(j=>!j.long))throw Object.assign(new Error('生成或部署正在运行，请先中止或等待完成'),{status:409});
      for(const job of active){job.status='stopped';if(job.child?.pid)killTree(job.child.pid);}
      sendJSON(res,200,{ok:true,pid:process.pid});if(shuttingDown)return;shuttingDown=true;
      setTimeout(()=>{for(const job of jobs.values())for(const client of job.clients)client.end();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();},100);return;
    }
    return sendJSON(res,404,{ok:false,error:'not found'});
  } catch(e) {if(!res.headersSent)sendErr(res,e);else res.end();}
});
function sendFile(res,file) {
  fs.readFile(file,(err,buf)=>{if(err){res.writeHead(404);return res.end('404');}res.writeHead(200,{'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream'});res.end(buf);});
}
function openBrowser() {
  if(process.argv.includes('--open')) {
    const url=`http://127.0.0.1:${PORT}/`;
    if(process.platform==='win32')spawn('explorer.exe',[url],{windowsHide:true}).on('error',e=>console.warn(e.message));
    else if(process.platform==='darwin')spawn('open',[url]).on('error',e=>console.warn(e.message));
  }
}
const PID_FILE=path.join(DATA,`.server-${PORT}.pid`);
let ownsPort=false;
server.on('listening',()=>{
  ownsPort=true;
  try{lib.atomicWrite(PID_FILE,`${process.pid}\n${Date.now()}\n`);}catch{/* 非致命 */}
  openBrowser();
});
server.on('error',async e=>{
  if(e.code==='EADDRINUSE' && process.argv.includes('--open')) {
    try {
      const response=await fetch(`http://127.0.0.1:${PORT}/api/info`,{signal:AbortSignal.timeout(1500)});
      const info=await response.json();
      const pid=Number(fs.readFileSync(PID_FILE,'utf8').split('\n')[0]);
      // 仅复用本应用的存活实例，不能把其他占用端口的服务当成写作台。
      if(response.ok && info.ok && pid>0 && info.pid===pid && info.port===PORT && info.blog===BLOG) {
        console.log('[*] 已有写作台正在运行，打开现有页面');
        openBrowser();
        // 等浏览器启动子进程完成，不能在 spawn 仍有异步事件时强制退出。
        process.exitCode=0;
        return;
      }
    } catch { /* 仍按端口冲突报告 */ }
  }
  console.error('[x] '+(e.code==='EADDRINUSE'?`端口 ${PORT} 已被占用，请关闭旧写作台或设置 PORT`:e.message));
  process.exit(1);
});
server.listen(PORT,'127.0.0.1');
process.on('exit',()=>{
  for(const job of jobs.values())if(job.child?.pid)killTree(job.child.pid);
  if(ownsPort)clearServePid();
  try{removeOwnPidFile(PID_FILE);}catch{/* 非致命 */}
});
process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
