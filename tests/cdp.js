/* cdp.js —— 一次性 Chrome + DevTools Protocol 的最小封装
 *
 * 供 ui-style.test.js 与 shot-pdf.js 共用，连接/截图/求值这套样板没必要抄两遍。
 *
 * 为什么不用 agent-browser：本机它 0.34 的常驻 daemon 已经起不来了 ——
 * `open` 会挂死（daemon 的 pid 文件是陈的，新进程连上去就一直等一个不存在的进程），
 * 而本沙箱会在"一条命令结束时把子进程整体回收"，常驻 daemon 这条路必然断。
 * CDP 走的是"起一个一次性 Chrome → 连上 → 截完就退"，稳得多。
 *
 * 用法：
 *   const { launch } = require('./cdp');
 *   const b = await launch({ out: '某目录' });
 *   await b.goto('http://127.0.0.1:4466/');
 *   await b.shot('a.png');
 *   await b.close();
 *
 * 注意：user-data-dir 是复用的，上一轮存进 localStorage 的主题会留到这一轮，
 * 验收脚本里必须显式写死主题再重载，不能指望"这次没设就是浅色"。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 极简 CDP 客户端：够用就行，不引依赖（Node 22 自带全局 WebSocket） ──── */
class Client {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) { try { h(msg); } catch { /* 事件处理不要影响主流程 */ } }
      }
    });
  }
  /** 订阅 CDP 事件（只关心"没带 id 的通知"，比如 Page.javascriptDialogOpening） */
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 30000);
    });
  }
}

async function launch(opts) {
  const o = Object.assign({ port: 9333, width: 1440, height: 900, out: process.cwd() }, opts || {});
  if (!CHROME) throw new Error('找不到 Chrome / Edge');
  fs.mkdirSync(o.out, { recursive: true });

  /* 默认仍然复用同一个 profile（截图脚本串行跑，省一次冷启动）。
     但两个验收脚本并发时共用 user-data-dir 会互相踢掉对方的 target，
     所以留了 profile 选项给需要隔离的调用方。
     freshProfile 再进一步：每次换一个新目录 —— 万一上一轮是被 Ctrl+C 掐死的、
     profile 落在脏状态里，也不会把这一轮拖下水（脏 profile 的症状见下面 close()）。 */
  const base = o.profile || 'hexo-shot-profile';
  const profile = path.join(os.tmpdir(), o.freshProfile ? `${base}-${Date.now()}` : base);
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--remote-debugging-port=' + o.port,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${o.port}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!ver) { try { chrome.kill(); } catch { /* 忽略 */ } throw new Error('Chrome 的调试端口没起来'); }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const client = new Client(ws);

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const S = sessionId;
  const send = (m, p, session = S) => client.send(m, p || {}, session);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false });

  /* 原生 JS 对话框必须自动点掉，否则会**卡死整个渲染进程**：
   * 写作台在"有未保存改动"时会挂 beforeunload，导航到别的页面就弹框，
   * 框一弹出来，Runtime.evaluate 就再也不返回 —— 症状和"渲染进程死了"一模一样
   * （wasm 都没得看：/json/version 正常、Page.navigate 也返回 200，只有 evaluate 挂）。
   * 这里统一 accept，并把对话框文案记下来，验收报告里能看见"刚才弹过什么"。 */
  const dialogs = [];
  if (o.autoDialogs !== false) {
    client.on((msg) => {
      if (msg.method !== 'Page.javascriptDialogOpening') return;
      dialogs.push({ type: msg.params.type, message: String(msg.params.message || '').slice(0, 200) });
      client.send('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId || S)
        .catch(() => { /* 已经自己关了 */ });
    });
  }

  const api = {
    send, sleep, targetId, sessionId: S, out: o.out, dialogs,

    /** 求值。异常必须抛出来 —— 静默返回 undefined 会把断言变成假通过。 */
    async evaluate(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(expr + ' → ' + r.exceptionDetails.text);
      return r.result.value;
    },
    media: (scheme) => send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] }),

    async shot(name) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(o.out, name);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },

    async waitFor(expr, ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await api.evaluate(expr)) return true;
        await sleep(200);
      }
      return false;
    },

    /** 导航 + 等就绪。readyExpr 给了就一并等（等不到不算失败，交给调用方判断）。 */
    async goto(url, readyExpr, ms) {
      await send('Page.navigate', { url });
      await api.waitFor('document.readyState === "complete"');
      if (readyExpr) await api.waitFor(readyExpr, ms);
      await sleep(500);
    },

    async close() {
      try { await client.send('Target.closeTarget', { targetId }); } catch { /* 已经关了 */ }
      /* 优雅退出，别直接 kill。
       * 硬杀会把 user-data-dir 留成"上次异常退出"的状态，下次复用**同一个目录**起来时
       * 渲染进程会直接卡死 —— 症状极具迷惑性：/json/version 照常响应、Target.createTarget
       * 也成功，只有 Runtime.evaluate 永远不返回（于是 waitFor 之类的轮询全部 30 秒超时）。
       * 实测：同一个 profile 目录，第一次跑正常，第二次起必挂；换个新目录立刻好。
       * Browser.close 会让 Chrome 自己收尾写完 profile；它先退出、来不及回包，所以不 await 回包。 */
      const exited = new Promise((r) => { chrome.once('exit', () => r(true)); });
      client.send('Browser.close').catch(() => { /* 进程已经走了，没回包是正常的 */ });
      const graceful = await Promise.race([exited, sleep(6000).then(() => false)]);
      try { ws.close(); } catch { /* 忽略 */ }
      if (!graceful) { try { chrome.kill(); } catch { /* 忽略 */ } }
      await sleep(200);
    },
  };
  return api;
}

module.exports = { launch, sleep, CHROME };
