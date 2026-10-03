/* ui-mdkeys.js —— Markdown 快捷键的真浏览器验收
 *
 *   node tests/ui-mdkeys.js
 *
 * 为什么单独一个脚本：mdkeys.test.js 测的是纯函数，而"按键到底有没有接上"
 * 只有真按下去才知道 —— 脚本没注册、CSP 拦了、textarea 没焦点、
 * execCommand 被降级成硬写（撤销栈丢），这些单测一个都发现不了。
 *
 * 服务在这里自己起、自己收，不用外部先跑 server.js：
 * 本沙箱会在"一条命令结束时回收子进程"，外挂的后台服务活不到浏览器起来。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { launch, sleep } = require('./cdp');

const TOOL = path.join(__dirname, '..');
const BLOG = path.join(os.tmpdir(), 'hexo-tool-mdkeys-blog');
const PORT = Number(process.env.UI_PORT || 4831);
const URL = 'http://127.0.0.1:' + PORT + '/';
const OUT = path.join(__dirname, 'ui-mdkeys.out');

const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
let fail = 0;
const check = (cond, label, detail) => {
  if (cond) log('  PASS  ' + label);
  else { fail++; log('  FAIL  ' + label + (detail !== undefined ? '  → ' + detail : '')); }
};
const section = (t) => log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 46 - t.length)));

/* ── 假博客（照 e2e.js 的最小配置，够起首页就行） ─────────────────────── */
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) rmrf(path.join(p, e)); fs.rmdirSync(p); }
  else fs.unlinkSync(p);
}
rmrf(BLOG);
fs.mkdirSync(path.join(BLOG, 'source', '_posts'), { recursive: true });
fs.mkdirSync(path.join(BLOG, 'source', '_drafts'), { recursive: true });
fs.writeFileSync(path.join(BLOG, '_config.yml'), [
  'title: 快捷键验收', 'url: https://example.test', 'post_asset_folder: true',
  'render_drafts: false', 'default_layout: post', '',
].join('\n'), 'utf8');

function get(p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (resp) => {
      let b = ''; resp.on('data', (d) => { b += d; }); resp.on('end', () => res({ status: resp.statusCode, body: b }));
    });
    r.on('error', rej); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end();
  });
}

(async () => {
  section('起服务');
  const srv = spawn(process.execPath, [path.join(TOOL, 'src', 'server.js'), BLOG], {
    env: { ...process.env, PORT: String(PORT) }, cwd: TOOL, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srvErr = [];
  srv.stderr.on('data', (d) => srvErr.push(String(d)));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await get('/api/info')).status === 200; } catch { await sleep(200); }
  }
  check(up, '服务起来了 ' + URL, srvErr.join('').slice(0, 200));
  if (!up) { srv.kill('SIGKILL'); process.exit(1); }

  let br = null;
  try {
    section('开浏览器');
    br = await launch({ out: path.join(TOOL, '.workbuddy', 'shots'), profile: 'hexo-mdkeys', freshProfile: true, port: 9341 });
    const { evaluate, key } = br;

    /* 报错钩子要在导航前装、并且能活过导航 ——
       装在页面里的话，第二次 goto 就把 window.__err 重置成 undefined 了
       （第一版就是这么踩的，报了个假的"Uncaught"）。 */
    await br.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__err=[];window.addEventListener("error",function(e){window.__err.push(String(e.message))});',
    });

    /* 每轮从干净状态开始：清掉上一轮留在 localStorage 的草稿缓存，
       否则载入时会弹"恢复未保存文章吗"，自动确认后把旧正文塞回编辑区。 */
    await br.goto(URL);
    await evaluate(`(() => {
      for (const k of Object.keys(localStorage)) if (k.indexOf('hexo-tool-cache:') === 0) localStorage.removeItem(k);
      return true;
    })()`);
    await br.goto(URL);
    await br.waitFor('typeof window.MdKeys === "object" && typeof window.Editor === "object"');

    /* 设置正文与选区。用 JS 赋值不触发 input 事件，不会把页面标脏 */
    const setBody = (text, s, e) => evaluate(`(() => {
      const ta = document.getElementById('body');
      ta.value = ${JSON.stringify(text)};
      ta.focus();
      ta.setSelectionRange(${s == null ? 0 : s}, ${e == null ? (s == null ? 0 : s) : e});
      return true;
    })()`);
    const readBody = () => evaluate(`(() => {
      const ta = document.getElementById('body');
      return { v: ta.value, s: ta.selectionStart, e: ta.selectionEnd };
    })()`);

    section('① 脚本加载');
    const loaded = await evaluate(`(() => ({
      mdkeys: typeof window.MdKeys === 'object',
      n: window.MdKeys ? window.MdKeys.SHORTCUTS.length : 0,
      btn: !!document.getElementById('btnKeys'),
      modal: !!document.getElementById('keysModal'),
    }))()`);
    check(loaded.mdkeys, '/mdkeys.js 被页面加载到了（没有 404 / 没被 CSP 拦）');
    check(loaded.n === 22, '键位表 22 条', loaded.n);
    check(loaded.btn, '工具栏有快捷键按钮');
    check(loaded.modal, '页面有快捷键速查面板');

    section('② 标题（Alt+1：浏览器抢 Ctrl+1 时的替身键）');
    await setBody('hello world', 3, 3);
    await key('Alt+Digit1');
    let r = await readBody();
    check(r.v === '# hello world', 'Alt+1 整行变一级标题', JSON.stringify(r.v));
    check(r.s === 5, '光标跟着前缀移动（原来在第 3 列）', r.s);

    await key('Alt+Digit1');
    r = await readBody();
    check(r.v === 'hello world', '再按一次还原（toggle）', JSON.stringify(r.v));

    section('③ 撤销栈必须活着');
    /* 这是"不能直接 ta.value = 新文本"的唯一理由：硬写会清空撤销栈。
       撤一步应该回到 '# hello world'，而不是什么都没发生、也不是整段消失。 */
    await key('Ctrl+KeyZ');
    r = await readBody();
    check(r.v === '# hello world', 'Ctrl+Z 撤回了上一次快捷键（撤销栈没被清空）', JSON.stringify(r.v));

    section('④ 代码块');
    await setBody('package main', 0, 0);
    await key('Alt+Shift+KeyK');
    r = await readBody();
    check(r.v === '```\npackage main\n```', 'Alt+Shift+K 包成围栏块', JSON.stringify(r.v));
    check(r.s === 3, '光标停在语言标注位置', r.s);
    await key('Alt+Shift+KeyK');
    r = await readBody();
    check(r.v === 'package main', '再按一次解开', JSON.stringify(r.v));

    section('⑤ 加粗（选中一段）');
    await setBody('abc', 0, 3);
    await key('Ctrl+KeyB');
    r = await readBody();
    check(r.v === '**abc**', 'Ctrl+B 加粗', JSON.stringify(r.v));

    section('⑥ 回车续列表 / Tab 缩进');
    await setBody('- a', 3, 3);
    await key('Enter');
    r = await readBody();
    check(r.v === '- a\n- ', '列表项末尾回车自动续行', JSON.stringify(r.v));
    await key('Enter');
    r = await readBody();
    check(r.v === '- a\n', '空列表项上回车退出列表（标记被删掉）', JSON.stringify(r.v));

    await setBody('- a', 0, 0);
    await key('Tab');
    r = await readBody();
    check(r.v === '  - a', '列表项上 Tab 整行缩进', JSON.stringify(r.v));
    await key('Shift+Tab');
    r = await readBody();
    check(r.v === '- a', 'Shift+Tab 反缩进', JSON.stringify(r.v));

    await setBody('普通段落', 2, 2);
    await key('Tab');
    r = await readBody();
    check(r.v === '普通  段落', '普通段落中间按 Tab 只插两个空格（不顶整行）', JSON.stringify(r.v));

    section('⑦ 速查面板');
    await key('Ctrl+Slash');
    const panel = await evaluate(`(() => {
      const m = document.getElementById('keysModal');
      return { show: m.classList.contains('show'), rows: m.querySelectorAll('.krow').length };
    })()`);
    check(panel.show, 'Ctrl+/ 打开速查面板');
    check(panel.rows === 24, '面板列出 22 条快捷键 + 2 条说明', panel.rows);
    const shot = await br.shot('mdkeys-panel.png');
    log('  截图  ' + shot);
    await key('Ctrl+Slash');
    const closed = await evaluate('!document.getElementById("keysModal").classList.contains("show")');
    check(closed, '再按一次关闭');

    section('⑧ 没有 JS 报错');
    const errs = await evaluate('window.__err.join(" | ")');
    check(!errs, '整轮没有未捕获异常', errs);
  } catch (e) {
    fail++;
    log('  FAIL  脚本异常：' + (e && e.stack || e));
  } finally {
    if (br) await br.close().catch(() => { /* 忽略 */ });
    try { srv.kill('SIGKILL'); } catch { /* 忽略 */ }
    fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
    log('\n结果：' + (fail ? fail + ' 项失败' : '全部通过') + '（详见 ' + OUT + '）');
    process.exit(fail ? 1 : 0);
  }
})();
