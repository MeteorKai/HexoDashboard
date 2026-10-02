'use strict';
// Windows: node --test tests/launchers.test.js
// To test .command with Git Bash, set BASH_EXE to its bash.exe path first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('node:timers/promises');
const APP = path.join(__dirname, '..');
const BASH = process.env.BASH_EXE || (process.platform === 'win32' ? null : '/bin/bash');

function fixture(t, launcher) {
  const prefix = path.join(os.tmpdir(), 'hexo-launch-');
  const root = fs.mkdtempSync(prefix);
  const app = path.join(root, '写作台 with spaces & test');
  const blog = path.join(root, '博客 with spaces & test');
  const record = path.join(root, 'record.json');
  fs.mkdirSync(path.join(app, 'src'), {recursive:true});
  fs.mkdirSync(path.join(app, 'data'));
  fs.mkdirSync(blog);
  fs.writeFileSync(path.join(blog, '_config.yml'), 'title: test\n');
  const launchers = launcher === '启动写作台.command' ? [launcher] : ['启动写作台.bat', '启动写作台.vbs'];
  for (const file of launchers) {
    fs.copyFileSync(path.join(APP, file), path.join(app, file));
  }
  // Default to a mock; the shutdown integration test replaces it with the real server.
  fs.writeFileSync(path.join(app, 'src', 'server.js'), `
    require('fs').writeFileSync(process.env.LAUNCH_RECORD, JSON.stringify({
      args:process.argv.slice(2), cwd:process.cwd(), exe:process.execPath,
      port:process.env.PORT || '', blog:process.env.HEXO_BLOG || ''
    }));
    process.exit(Number(process.env.LAUNCH_EXIT || 0));
  `);
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));
    fs.rmSync(root, {recursive:true, force:true});
  });
  return {root, app, blog, record, script:path.join(app, launcher)};
}

function run(exe, args, f, env={}, stdio='pipe') {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd:f.root, windowsHide:true, stdio,
      env:{...process.env, HEXO_BLOG:'', PORT:'', LAUNCH_RECORD:f.record, ...env},
      windowsVerbatimArguments:process.platform === 'win32' && exe === process.env.ComSpec
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Launcher timed out: '+output)); }, 15000);
    child.stdout?.on('data', b => output += b);
    child.stderr?.on('data', b => output += b);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({code, output}); });
    child.stdin?.on('error', () => {});
    child.stdin?.end('\r\n');
  });
}
function bat(f, arg, env) {
  return run(process.env.ComSpec, ['/d', '/s', '/c', `call "${f.script}"${arg ? ` "${arg}"` : ''}`], f, {HEXO_TOOL_BACKGROUND:'1', ...env});
}
function vbs(f, arg, env) {
  return run(path.join(process.env.SystemRoot, 'System32', 'cscript.exe'), ['//nologo', f.script, ...(arg ? [arg] : [])], f, env);
}
function command(f, arg, env) {
  return run(BASH, [f.script.replace(/\\/g, '/'), ...(arg ? [arg] : [])], f, env);
}
const readRecord = f => JSON.parse(fs.readFileSync(f.record, 'utf8'));
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Launcher did not reach the expected state');
}

test('Windows launcher runs hidden and never waits for a terminal keypress', {skip:process.platform !== 'win32'}, () => {
  const batSrc = fs.readFileSync(path.join(APP, '启动写作台.bat'), 'utf8');
  assert.doesNotMatch(batSrc, /^\s*pause\s*$/mi);
  assert.match(batSrc, /start "" .*wscript\.exe/);
  const vbsSrc = fs.readFileSync(path.join(APP, '启动写作台.vbs'), 'utf8');
  assert.match(vbsSrc, /shell\.Run\(command, 0, True\)/i);
});

test('BAT keeps quoted paths, uses system Node and preserves port/exit code', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.bat');
  fs.mkdirSync(path.join(f.app, 'node'));
  fs.writeFileSync(path.join(f.app, 'node', 'node.exe'), 'not a runtime');
  const result = await bat(f, f.blog, {PORT:'4950', LAUNCH_EXIT:'7'});
  assert.equal(result.code, 7, result.output);
  assert.deepEqual(readRecord(f), {args:[f.blog, '--open'], cwd:f.app, exe:process.execPath, port:'4950', blog:''});
});

test('BAT leaves default blog and port resolution to the server', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.bat');
  const result = await bat(f, '', {HEXO_BLOG:f.blog});
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(readRecord(f).args, ['', '--open']);
  assert.equal(readRecord(f).blog, f.blog);
  assert.equal(readRecord(f).port, '');
});

test('BAT falls back to bundled Node when PATH has none', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.bat');
  const bundled = path.join(f.app, 'node', 'node.exe');
  fs.mkdirSync(path.dirname(bundled));
  fs.copyFileSync(process.execPath, bundled);
  const result = await bat(f, f.blog, {PATH:path.join(process.env.SystemRoot, 'System32')});
  assert.equal(result.code, 0, result.output);
  assert.equal(readRecord(f).exe, bundled);
  assert.deepEqual(readRecord(f).args, [f.blog, '--open']);
});

test('BAT reports a missing runtime without starting the server', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.bat');
  const result = await bat(f, f.blog, {PATH:path.join(process.env.SystemRoot, 'System32')});
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /No node/);
  assert.equal(fs.existsSync(f.record), false);
});

test('Hidden launcher keeps quoted paths, port and server exit code', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.vbs');
  const result = await vbs(f, f.blog, {PORT:'4950', LAUNCH_EXIT:'7'});
  assert.equal(result.code, 7, result.output);
  assert.match(result.output, /launcher\.log/);
  assert.deepEqual(readRecord(f), {args:[f.blog, '--open'], cwd:f.app, exe:process.execPath, port:'4950', blog:''});
});

test('Hidden launcher leaves saved blog and port resolution to the server', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.vbs');
  const result = await vbs(f, '', {HEXO_BLOG:f.blog});
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(readRecord(f).args, ['', '--open']);
  assert.equal(readRecord(f).blog, f.blog);
  assert.equal(readRecord(f).port, '');
});

test('Hidden launcher reports startup errors via a saved log', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.vbs');
  const result = await vbs(f, f.blog, {PATH:path.join(process.env.SystemRoot, 'System32')});
  assert.equal(result.code, 1, result.output + fs.readFileSync(path.join(f.app, 'data', 'launcher.log'), 'utf8'));
  assert.match(result.output, /launcher\.log/);
  assert.match(fs.readFileSync(path.join(f.app, 'data', 'launcher.log'), 'utf8'), /No node/);
  assert.equal(fs.existsSync(f.record), false);
});

test('BAT hands off to the windowless host and exits without waiting', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.bat');
  // Keep the mock alive until the visible BAT has exited, then let it stop.
  const mock = fs.readFileSync(path.join(f.app, 'src', 'server.js'), 'utf8');
  fs.writeFileSync(path.join(f.app, 'src', 'server.js'), mock.replace(
    'process.exit(Number(process.env.LAUNCH_EXIT || 0));',
    `setInterval(() => { if (require('fs').existsSync(process.env.LAUNCH_RECORD + '.stop')) process.exit(0); }, 100);`
  ));
  try {
    const result = await run(process.env.ComSpec, ['/d', '/s', '/c', `call "${f.script}" "${f.blog}"`], f, {HEXO_TOOL_BACKGROUND:''}, 'ignore');
    assert.equal(result.code, 0, result.output);
    await waitFor(() => fs.existsSync(f.record));
    assert.deepEqual(readRecord(f).args, [f.blog, '--open']);
  } finally {
    fs.writeFileSync(f.record + '.stop', '');
    await waitFor(() => fs.existsSync(path.join(f.app, 'data', 'launcher.log')) &&
      /Server stopped/.test(fs.readFileSync(path.join(f.app, 'data', 'launcher.log'), 'utf8')));
  }
});

test('Page shutdown stops the real hidden server and its waiting launcher', {skip:process.platform !== 'win32'}, async t => {
  const f = fixture(t, '启动写作台.vbs');
  for (const file of fs.readdirSync(path.join(APP, 'src'))) {
    fs.copyFileSync(path.join(APP, 'src', file), path.join(f.app, 'src', file));
  }
  fs.mkdirSync(path.join(f.app, 'vendor'));
  fs.copyFileSync(path.join(APP, 'vendor', 'js-yaml.js'), path.join(f.app, 'vendor', 'js-yaml.js'));
  fs.mkdirSync(path.join(f.blog, 'source', '_posts'), {recursive:true});
  // Suppress only the copied server's browser opener; its APIs and shutdown are unchanged.
  const server = path.join(f.app, 'src', 'server.js');
  fs.writeFileSync(server, fs.readFileSync(server, 'utf8').replace("if(process.argv.includes('--open')) {", 'if(false) {'));
  const probe = require('net').createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const pidFile = path.join(f.app, 'data', `.server-${port}.pid`);
  let ended = false;
  const stopped = vbs(f, f.blog, {PORT:String(port)});
  stopped.then(() => { ended = true; }, () => { ended = true; });
  try {
    const info = await waitFor(async () => {
      try { return await (await fetch(base + '/api/info', {signal:AbortSignal.timeout(500)})).json(); }
      catch { return null; }
    });
    assert.equal(ended, false, 'Launcher waits while the server is running');
    assert.equal(fs.existsSync(pidFile), true);
    const response = await fetch(base + '/api/shutdown', {
      method:'POST', headers:{'Content-Type':'application/json', 'x-hexo-token':info.token}, body:'{}'
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pid, info.pid);
    const result = await stopped;
    assert.equal(result.code, 0, result.output);
    assert.equal(fs.existsSync(pidFile), false, 'Shutdown cleans up the server PID');
    await assert.rejects(fetch(base + '/api/info', {signal:AbortSignal.timeout(500)}));
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').split('\n')[0]);
      try { process.kill(pid); } catch { /* Already exited. */ }
    }
    await stopped;
  }
});

test('.command keeps quoted paths and preserves port/exit code', {skip:!BASH}, async t => {
  const f = fixture(t, '启动写作台.command');
  const result = await command(f, f.blog, {PORT:'4951', LAUNCH_EXIT:'8'});
  assert.equal(result.code, 8, result.output);
  assert.deepEqual(readRecord(f), {args:[f.blog, '--open'], cwd:f.app, exe:process.execPath, port:'4951', blog:''});
});

test('.command passes explicit blog or environment and leaves saved settings to the server', {skip:!BASH}, async t => {
  const f = fixture(t, '启动写作台.command');
  fs.writeFileSync(path.join(f.app, 'data', '.hexo-tool-settings.json'), JSON.stringify({blog:f.blog}));
  for (const [arg, env, expected] of [
    [f.blog, {HEXO_BLOG:'ignored-environment'}, f.blog],
    ['', {HEXO_BLOG:f.blog}, f.blog],
    ['', {}, '']
  ]) {
    const result = await command(f, arg, env);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(readRecord(f).args, [expected, '--open']);
  }
});

test('.command leaves stale blog paths recoverable through web settings', {skip:!BASH}, async t => {
  const f = fixture(t, '启动写作台.command');
  fs.writeFileSync(path.join(f.app, 'data', '.hexo-tool-settings.json'), JSON.stringify({blog:path.join(f.root, 'missing-blog')}));
  const result = await command(f);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(readRecord(f).args, ['', '--open']);
});
