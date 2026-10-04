'use strict';
// Isolated app copies: never overwrite the user's settings or real blog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const APP = path.join(__dirname, '..');

async function fixture(t, savedBlog) {
  const prefix=path.join(os.tmpdir(),'hexo-settings-'),root=fs.mkdtempSync(prefix);
  const app=path.join(root,'app'),blog=path.join(root,'博客 with spaces');
  for(const dir of ['src','web']) {
    fs.mkdirSync(path.join(app,dir),{recursive:true});
    for(const file of fs.readdirSync(path.join(APP,dir)))fs.copyFileSync(path.join(APP,dir,file),path.join(app,dir,file));
  }
  fs.mkdirSync(path.join(app,'vendor'));
  fs.copyFileSync(path.join(APP,'vendor','js-yaml.js'),path.join(app,'vendor','js-yaml.js'));
  fs.mkdirSync(path.join(blog,'source','_posts'),{recursive:true});
  fs.writeFileSync(path.join(blog,'_config.yml'),'# original\ntitle: test\npost_asset_folder: true\n');
  fs.writeFileSync(path.join(blog,'config.yaml'),'extra: true\n');
  const settingsFile=path.join(app,'data','.hexo-tool-settings.json');
  if(savedBlog!==undefined) {
    fs.mkdirSync(path.dirname(settingsFile),{recursive:true});
    fs.writeFileSync(settingsFile,JSON.stringify({blog:savedBlog==='valid'?blog:savedBlog}));
  }
  const probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,[path.join(app,'src','server.js')],{
    cwd:app,env:{...process.env,PORT:String(port),HEXO_BLOG:''},windowsHide:true,stdio:['ignore','pipe','pipe']
  });
  let log='',token='';
  child.stdout.on('data',b=>{log+=b;});child.stderr.on('data',b=>{log+=b;});
  const base=`http://127.0.0.1:${port}`;
  const request=async (url,data)=> {
    const r=await fetch(base+url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','x-hexo-token':token},body:JSON.stringify(data)});
    return {status:r.status,data:await r.json()};
  };
  t.after(async()=> {
    if(child.exitCode===null) {
      const exited=new Promise(resolve=>child.once('exit',resolve));
      try { await request('/api/shutdown',{}); } catch { child.kill(); }
      const timer=setTimeout(()=>child.kill(),3000);
      await exited;clearTimeout(timer);
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));
    fs.rmSync(root,{recursive:true,force:true});
  });
  let info;
  for(let i=0;i<60;i++) {
    if(child.exitCode!==null)throw new Error('Server exited before web setup: '+log);
    try { const r=await request('/api/info');if(r.status===200){info=r.data;break;} } catch { /* Starting. */ }
    await delay(100);
  }
  assert.ok(info,'Server did not become ready: '+log);
  token=info.token;
  return {root,app,blog,base,port,info,settingsFile,request};
}

test('web setup starts without a blog and configures it without restarting',async t=> {
  const f=await fixture(t);
  assert.equal(f.info.configured,false);
  assert.equal(f.info.blog,'');assert.ok(f.info.token);
  assert.equal((await fetch(f.base+'/')).status,200);
  assert.equal((await f.request('/api/posts')).status,409);
  assert.equal((await f.request('/api/run',{kind:'build'})).status,409);
  assert.equal((await f.request('/api/settings',{blog:''})).status,400);
  assert.equal((await f.request('/api/settings',{blog:path.join(f.root,'missing')})).status,400);
  assert.equal(fs.existsSync(f.settingsFile),false);
  const saved=await f.request('/api/settings',{blog:f.blog,toolPort:f.port,previewPort:f.port===4000?4001:4000});
  assert.equal(saved.status,200);
  const info=(await f.request('/api/info')).data;
  assert.equal(info.configured,true);assert.equal(info.pid,f.info.pid);
  assert.equal((await f.request('/api/posts')).status,200);
  assert.equal(JSON.parse(fs.readFileSync(f.settingsFile,'utf8')).blog,f.blog);
  assert.deepEqual((await f.request('/api/configs')).data.files,['_config.yml','config.yaml']);
  const current=(await f.request('/api/config?name=_config.yml')).data;
  const input={blog:f.blog,name:current.name,revision:current.revision,content:'# original\ntitle: edited\npost_asset_folder: false\n'};
  assert.equal((await fetch(f.base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
  assert.equal((await f.request('/api/config',{...input,content:'title: ['})).status,400);
  assert.equal((await f.request('/api/config',{...input,revision:''})).status,428);
  assert.equal((await f.request('/api/config',{...input,blog:f.root})).status,409);
  assert.equal((await f.request('/api/config?name=..%2F_config.yml')).status,400);
  const edited=await f.request('/api/config',input);
  assert.equal(edited.status,200);
  assert.equal(fs.readFileSync(path.join(f.blog,edited.data.backup),'utf8'),current.content);
  assert.equal((await f.request('/api/info')).data.postAssetFolder,false);
  assert.equal((await f.request('/api/config',input)).status,409);
  const extra=(await f.request('/api/config?name=config.yaml')).data;
  assert.equal((await f.request('/api/config',{...extra,content:'extra: false\n'})).status,200);
  const other=path.join(f.root,'another-blog');
  fs.mkdirSync(path.join(other,'source','_posts'),{recursive:true});
  fs.writeFileSync(path.join(other,'_config.yml'),'title: another\n');
  assert.equal((await f.request('/api/settings',{blog:other})).status,200);
  assert.equal((await f.request('/api/config',{...extra,content:'extra: switched\n'})).status,409);
  assert.equal(fs.readFileSync(path.join(f.blog,'config.yaml'),'utf8'),'extra: false\n');
  assert.equal((await f.request('/api/info')).data.blog,other);
});

test('web setup uses a saved valid blog and keeps stale paths recoverable',async t=> {
  const valid=await fixture(t,'valid');
  assert.equal(valid.info.configured,true);assert.equal(valid.info.blog,valid.blog);
  const stale=await fixture(t,path.join(os.tmpdir(),'hexo-settings-missing-blog'));
  assert.equal(stale.info.configured,false);assert.equal(stale.info.blog,'');
  assert.equal((await stale.request('/api/settings',{blog:stale.blog})).status,200);
});

test('web settings UI completes onboarding and edits config YAML safely', {skip:process.platform!=='win32'||process.env.HEXO_UI_TEST!=='1'}, async t=> {
  const f=await fixture(t);
  const probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const {launch}=require('./cdp');
  const br=await launch({out:path.join(f.root,'shots'),freshProfile:true,port});
  const wait=async expr=>assert.ok(await br.waitFor(expr),'UI did not reach: '+expr);
  const set=async (id,value,event='input')=>br.evaluate(`(() => {const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
  const click=async id=>br.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  try {
    await br.goto(f.base);
    await wait('document.getElementById("settingsModal").classList.contains("show") && document.getElementById("settingsNote").textContent.includes("首次使用")');
    const updateTarget=await br.evaluate(`(() => {
      const original=window.open; let target;
      try { window.open=(...args)=>{target=args;}; document.getElementById('btnCheckUpdate').click(); return target; }
      finally { window.open=original; }
    })()`);
    assert.deepEqual(updateTarget,['https://github.com/MeteorKai/HexoDashboard','_blank','noopener,noreferrer']);
    assert.equal(await br.evaluate('document.getElementById("settingsModal").classList.contains("show")'),true);
    assert.equal(await br.evaluate('document.getElementById("btnSave").disabled'),true);
    await set('s-blog',f.blog);
    await click('btnSaveSettings');
    await wait('!document.getElementById("settingsModal").classList.contains("show") && !document.getElementById("btnSave").disabled');
    assert.equal(await br.evaluate('document.getElementById("blogPath").textContent'),f.blog);
    await click('btnSettings');
    await wait('document.getElementById("s-config-content").value.includes("# original") && !document.getElementById("s-config-content").disabled');
    await br.evaluate('document.querySelector("#configEditor > summary").click()');
    const original=fs.readFileSync(path.join(f.blog,'_config.yml'),'utf8');
    await set('s-config-content','title: [');
    await click('btnSaveConfig');
    await wait('document.getElementById("configNote").textContent.includes("YAML 格式错误")');
    assert.equal(fs.readFileSync(path.join(f.blog,'_config.yml'),'utf8'),original);
    const edited='# original\ntitle: 网页配置修改\npost_asset_folder: true\n';
    await set('s-config-content',edited);
    await br.evaluate('document.getElementById("s-config-content").dispatchEvent(new KeyboardEvent("keydown", {key:"s",ctrlKey:true,bubbles:true,cancelable:true}))');
    await wait('document.getElementById("configNote").textContent.includes("已保存") && document.getElementById("btnSaveConfig").disabled');
    assert.equal(fs.readFileSync(path.join(f.blog,'_config.yml'),'utf8'),edited);
    const external='title: external\npost_asset_folder: true\n';
    fs.writeFileSync(path.join(f.blog,'_config.yml'),external);
    await set('s-config-content',edited+'language: zh-CN\n');
    await click('btnSaveConfig');
    await wait('document.getElementById("configNote").textContent.includes("外部修改")');
    assert.equal(fs.readFileSync(path.join(f.blog,'_config.yml'),'utf8'),external);
    await click('btnReloadConfig');
    await wait('document.getElementById("s-config-content").value.includes("title: external")');
    await set('s-config-file','config.yaml','change');
    await wait('document.getElementById("s-config-content").value === "extra: true\\n"');
    await set('s-config-content','extra: false\n');
    await click('btnCloseSettings');
    await wait('!document.getElementById("settingsModal").classList.contains("show")');
    assert.ok(br.dialogs.some(d=>d.message.includes('博客配置有未保存')));
    assert.equal(fs.readFileSync(path.join(f.blog,'config.yaml'),'utf8'),'extra: true\n');
  } finally { await br.close(); }
});
