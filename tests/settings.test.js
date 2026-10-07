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

test('pasting images in both article editors stores native asset tags in the matching folder', {skip:process.platform!=='win32'||process.env.HEXO_UI_TEST!=='1'}, async t=>{
  const f=await fixture(t,'valid');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=','base64');
  const imageName=require('crypto').createHash('md5').update(png).digest('hex')+'.png';
  for(const file of ['marked.min.js','purify.min.js'])fs.copyFileSync(path.join(APP,'vendor',file),path.join(f.app,'vendor',file));
  for(const [name,dir] of [['Main article','_posts'],['Independent draft','_drafts']]) {
    fs.mkdirSync(path.join(f.blog,'source',dir),{recursive:true});
    fs.writeFileSync(path.join(f.blog,'source',dir,name+'.md'),`---\ntitle: ${name}\ndate: 2026-10-07 12:00:00\n---\nbefore\nafter\n`);
  }
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const {launch}=require('./cdp');const br=await launch({out:path.join(f.root,'shots'),freshProfile:true,port});
  await br.send('Page.addScriptToEvaluateOnNewDocument',{source:`const originalOpen=window.open;window.open=function(...args){const tab=originalOpen.apply(this,args);if(args[0]==='/preview')window.__previewTab=tab;return tab;};`});
  const wait=async expr=>assert.ok(await br.waitFor(expr),'UI did not reach: '+expr+'; '+await br.evaluate('document.getElementById("toast").textContent'));
  async function paste(mode,selected=false) {
    return br.evaluate(`(() => {
      const ta=document.getElementById('body');ta.value=${JSON.stringify(selected?'before\nselected\nafter':'before\nafter')};ta.focus();ta.setSelectionRange(7,${selected?15:7});
      const bytes=Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0));
      const file=new File([bytes],'clipboard.png',{type:${JSON.stringify(mode==='emptyMime'?'':'image/png')}});
      const dt=new DataTransfer();dt.items.add(file);
      if(${JSON.stringify(mode)}==='multi')dt.items.add(new File([bytes],'second.png',{type:'image/png'}));
      let event;
      if(['items','multi'].includes(${JSON.stringify(mode)}))event=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});
      else if(${JSON.stringify(mode)}==='htmlData') {const html=new DataTransfer();html.setData('text/html','<img src="data:image/png;base64,${png.toString('base64')}">');event=new ClipboardEvent('paste',{clipboardData:html,bubbles:true,cancelable:true});}
      else {event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{items:[],files:[file]}});}
      ta.dispatchEvent(event);return event.defaultPrevented;
    })()`);
  }
  try {
    for(const [name,dir,route] of [['Main article','_posts','/'],['Independent draft','_drafts','/post?name=Independent%20draft&draft=1']]) {
      await br.goto(f.base+route);
      if(route==='/') {
        await wait('document.getElementById("postlist").children.length===2');
        await br.evaluate(`[...document.querySelectorAll('#postlist li')].find(li=>li.textContent.includes('Main article')).click()`);
      }
      await wait(`document.getElementById('f-name').value===${JSON.stringify(name)} && !document.getElementById('body').disabled`);
      for(const mode of ['items','filesOnly','emptyMime','htmlData']) {
        assert.equal(await paste(mode),true,`${name}: ${mode} image paste is intercepted`);
        await wait('document.getElementById("body").value.includes("{% asset_img")');
        assert.match(await br.evaluate('document.getElementById("body").value'),new RegExp(imageName.replace('.','\\.')));
        assert.deepEqual(fs.readFileSync(path.join(f.blog,'source',dir,name,imageName)),png);
      }
      assert.equal(await paste('multi'),true);
      await wait('(document.getElementById("body").value.match(/\\{% asset_img /g)||[]).length===2');
      await paste('items',true);await wait('document.getElementById("body").value.includes("{% asset_img")');
      assert.equal(await br.evaluate('document.getElementById("body").value.includes("selected")'),false,'Pasted image replaces the selected text');
      await br.send('Runtime.evaluate',{expression:"document.getElementById('btnPreview').click()",userGesture:true});
      await wait(`window.__previewTab && !window.__previewTab.closed && (()=>{const img=window.__previewTab.document.querySelector('#preview img');return img && img.complete && img.naturalWidth>0 && img.getAttribute('src').startsWith(${JSON.stringify('/media/'+(dir==='_drafts'?'d':'p')+'/'+encodeURIComponent(name)+'/')});})()`);
      await br.evaluate('window.__previewTab.close()');
      await br.evaluate('document.getElementById("btnSave").click()');
      const saved=await br.waitFor(`!document.getElementById('btnSave').disabled && ${route==='/'?"!document.getElementById('editorTitle').textContent.endsWith(' •')":"document.getElementById('ppState').textContent==='已保存'"}`);
      assert.ok(saved);
      assert.match(fs.readFileSync(path.join(f.blog,'source',dir,name+'.md'),'utf8'),/\{% asset_img /);
      const response=await fetch(f.base+'/media/'+(dir==='_drafts'?'d':'p')+'/'+encodeURIComponent(name)+'/'+imageName);
      assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
      assert.deepEqual(fs.readdirSync(path.join(f.blog,'source',dir,name)),[imageName],'Pasting the same image reuses its file');
      assert.equal(await br.evaluate(`(()=>{const dt=new DataTransfer();dt.setData('text/plain','normal text');const event=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});document.getElementById('body').dispatchEvent(event);return event.defaultPrevented;})()`),false,'Ordinary text paste is not intercepted');
    }
    await br.goto(f.base+'/');await wait('!document.getElementById("btnSave").disabled');
    await br.evaluate(`document.getElementById('f-title').value='New paste';document.getElementById('f-draft').checked=true;`);
    await paste('multi');await wait('(document.getElementById("body").value.match(/\\{% asset_img /g)||[]).length===2');
    assert.deepEqual(fs.readFileSync(path.join(f.blog,'source','_drafts','New paste',imageName)),png);
    await br.evaluate('document.getElementById("btnSave").click()');await wait('!document.getElementById("editorTitle").textContent.endsWith(" •")');
    assert.equal((fs.readFileSync(path.join(f.blog,'source','_drafts','New paste.md'),'utf8').match(/\{% asset_img /g)||[]).length,2);
  } finally {await br.close();}
});

function seedPages(f) {
  const files={
    'about/index.md':'---\ntitle: About\nlayout: page\n# keep\n---\nOriginal about\n',
    'links/index.md':'---\ntitle: Links\nlayout: links\n---\n',
    '_data/links.yml':'- links_category: Friends\n  list:\n    - name: Example\n      link: https://example.test/\n'
  };
  for(const [name,content] of Object.entries(files)) {
    const file=path.join(f.blog,'source',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);
  }
  return files;
}

test('independent pages API edits About and friend data with tokens, revisions and backups',async t=>{
  const f=await fixture(t,'valid'),files=seedPages(f);
  assert.deepEqual((await f.request('/api/pages')).data.files.map(file=>file.name),['about/index.md','links/index.md','_data/links.yml']);
  for(const name of Object.keys(files)) {
    const current=(await f.request('/api/page?name='+encodeURIComponent(name))).data;
    const content=name==='links/index.md' ? current.content.replace('Links','My links') : current.content.replace('Original about','Edited about').replace('Example','New friend');
    const input={blog:f.blog,name,revision:current.revision,content};
    assert.equal((await fetch(f.base+'/api/page',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
    assert.equal((await f.request('/api/page',{...input,blog:f.root})).status,409);
    const saved=await f.request('/api/page',input);
    assert.equal(saved.status,200);
    assert.equal(fs.readFileSync(path.join(f.blog,'source',name),'utf8'),content);
    assert.equal(fs.readFileSync(path.join(f.blog,saved.data.backup),'utf8'),files[name]);
    assert.equal((await f.request('/api/page',input)).status,409);
  }
  assert.equal((await f.request('/api/page?name=_posts%2Farticle.md')).status,400);
  assert.equal((await f.request('/api/page?name=..%2F_config.yml')).status,400);
  assert.equal((await f.request('/api/page?name=missing%2Findex.md')).status,404);
  assert.deepEqual(fs.readdirSync(path.join(f.blog,'source','_posts')),[]);
});

test('web setup starts without a blog and configures it without restarting',async t=> {
  const f=await fixture(t);
  assert.equal(f.info.configured,false);
  assert.equal(f.info.blog,'');assert.ok(f.info.token);
  assert.equal((await fetch(f.base+'/')).status,200);
  assert.equal((await f.request('/api/posts')).status,409);
  assert.equal((await f.request('/api/pages')).status,409);
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

test('web pages UI edits Markdown and friend YAML without overwriting the article editor', {skip:process.platform!=='win32'||process.env.HEXO_UI_TEST!=='1'}, async t=>{
  const f=await fixture(t,'valid'),files=seedPages(f);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const {launch}=require('./cdp');const br=await launch({out:path.join(f.root,'shots'),freshProfile:true,port});
  const wait=async expr=>assert.ok(await br.waitFor(expr),'UI did not reach: '+expr);
  const set=async (id,value,event='input')=>br.evaluate(`(() => {const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
  const click=async id=>br.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  try {
    await br.goto(f.base);await wait('!document.getElementById("btnSave").disabled');
    await set('f-title','Unrelated unsaved article');await set('body','Keep the article editor');
    await click('btnPages');
    await wait('document.getElementById("pagesModal").classList.contains("show") && document.getElementById("pageContent").value.includes("Original about")');
    assert.equal(await br.evaluate('document.getElementById("pageFile").options.length'),3);
    await set('pageContent','---\ntitle: [\n---\nBody');await click('btnSavePage');
    await wait('document.getElementById("pageNote").textContent.includes("YAML 格式错误")');
    assert.equal(fs.readFileSync(path.join(f.blog,'source','about','index.md'),'utf8'),files['about/index.md']);
    const edited=files['about/index.md'].replace('Original about','Edited in UI');
    await set('pageContent',edited);
    await br.evaluate('document.getElementById("pageContent").dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,bubbles:true,cancelable:true}))');
    await wait('document.getElementById("pageNote").textContent.includes("已保存") && document.getElementById("btnSavePage").disabled');
    assert.equal(fs.readFileSync(path.join(f.blog,'source','about','index.md'),'utf8'),edited);
    assert.equal(await br.evaluate('document.getElementById("body").value'),'Keep the article editor');
    assert.deepEqual(fs.readdirSync(path.join(f.blog,'source','_posts')),[]);
    await set('pageFile','_data/links.yml','change');
    await wait('document.getElementById("pageContent").value.includes("name: Example")');
    const friends=files['_data/links.yml'].replace('Example','New friend');
    await set('pageContent',friends);await click('btnSavePage');
    await wait('document.getElementById("pageNote").textContent.includes("已保存") && document.getElementById("btnSavePage").disabled');
    assert.equal(fs.readFileSync(path.join(f.blog,'source','_data','links.yml'),'utf8'),friends);
    const external=friends.replace('New friend','External friend');
    fs.writeFileSync(path.join(f.blog,'source','_data','links.yml'),external);
    await set('pageContent',friends+'# pending\n');await click('btnSavePage');
    await wait('document.getElementById("pageNote").textContent.includes("外部修改")');
    assert.equal(fs.readFileSync(path.join(f.blog,'source','_data','links.yml'),'utf8'),external);
    await br.evaluate(`window.savedConfirm=window.confirm;window.confirm=()=>false;document.getElementById('pageFile').value='links/index.md';document.getElementById('pageFile').dispatchEvent(new Event('change'));document.getElementById('btnClosePages').click();window.confirm=window.savedConfirm;`);
    assert.equal(await br.evaluate('document.getElementById("pageFile").value'),'_data/links.yml');
    assert.equal(await br.evaluate('document.getElementById("pagesModal").classList.contains("show")'),true);
    await click('btnReloadPage');await wait('document.getElementById("pageContent").value.includes("External friend")');
    await set('pageContent',external+'# not saved\n');await click('btnClosePages');
    await wait('!document.getElementById("pagesModal").classList.contains("show")');
    assert.ok(br.dialogs.some(dialog=>dialog.message.includes('页面文件有未保存')));
    assert.equal(fs.readFileSync(path.join(f.blog,'source','_data','links.yml'),'utf8'),external);
  } finally {await br.close();}
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
