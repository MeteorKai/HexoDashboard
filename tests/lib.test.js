'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../src/lib');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-tool-test-'));
  fs.mkdirSync(path.join(root, 'source', '_posts'), {recursive:true});
  fs.mkdirSync(path.join(root, 'source', '_drafts'), {recursive:true});
  fs.writeFileSync(path.join(root, '_config.yml'), 'render_drafts: false\n');
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}
const sample = '---\ntitle: Original\ndate: 2026-09-30 10:00:00\ntags:\n  - Hexo\n  - "a,b"\ncustom:\n  nested: true\n# keep this comment\npassword: "keep-me"\n---\nOriginal body\n';
function seed(root, name='example', draft=false, raw=sample) {
  const dir = lib.postDir(root, draft);
  fs.writeFileSync(path.join(dir, name+'.md'), raw);
  fs.mkdirSync(path.join(dir, name), {recursive:true});
  fs.writeFileSync(path.join(dir, name, 'image.png'), Buffer.from('original image'));
}
function save(root, overrides={}) {
  const current = lib.readPost(root, 'example', false);
  return lib.writePost(root, {name:'example',originalName:'example',originalDraft:false,
    revision:current.revision,meta:{...current.meta,title:'Changed',draft:false},
    changedFields:['title'],body:'New body\n',...overrides});
}
test('YAML parser preserves nested structures and quoted commas', () => {
  assert.deepEqual(lib.parseFrontMatter(sample).data.tags, ['Hexo','a,b']);
  assert.deepEqual(lib.parseFrontMatter(sample).data.custom, {nested:true});
});
test('saving only title/body preserves unknown metadata and comments', t => {
  const root=fixture(t); seed(root); save(root);
  const raw=fs.readFileSync(path.join(lib.postDir(root,false),'example.md'),'utf8');
  assert.match(raw,/custom:\n  nested: true\n# keep this comment\npassword: "keep-me"/);
  assert.deepEqual(lib.readPost(root,'example',false).meta.tags,['Hexo','a,b']);
  assert.equal(lib.readPost(root,'example',false).meta.title,'Changed');
});
test('draft migration moves markdown and assets without leaving the original', t => {
  const root=fixture(t); seed(root); save(root,{meta:{title:'Original',draft:true},changedFields:[]});
  assert.equal(fs.existsSync(path.join(lib.postDir(root,false),'example.md')),false);
  assert.equal(fs.existsSync(path.join(lib.postDir(root,true),'example','image.png')),true);
});
test('same name in another directory is a conflict, not self-overwrite', t => {
  const root=fixture(t); seed(root); seed(root,'example',true,'---\ntitle: Other\n---\nOther body');
  assert.throws(()=>save(root,{meta:{title:'Original',draft:true},changedFields:[]}), e=>e.status===409);
  assert.equal(lib.readPost(root,'example',true).meta.title,'Other');
});
test('stale revisions do not overwrite external edits', t => {
  const root=fixture(t); seed(root); const previous=lib.readPost(root,'example',false);
  fs.appendFileSync(path.join(lib.postDir(root,false),'example.md'),'External edit');
  assert.throws(()=>save(root,{revision:previous.revision}),e=>e.status===409);
  assert.match(lib.readPost(root,'example',false).body,/External edit/);
});
test('failed asset migration rolls back markdown and keeps original assets', t => {
  const root=fixture(t); seed(root);
  fs.mkdirSync(path.join(lib.postDir(root,true),'example'),{recursive:true});
  fs.writeFileSync(path.join(lib.postDir(root,true),'example','image.png'),'another image');
  assert.throws(()=>save(root,{meta:{title:'Original',draft:true},changedFields:[]}),e=>e.status===409);
  assert.equal(lib.readPost(root,'example',false).body,'Original body\n');
  assert.equal(fs.existsSync(path.join(lib.postDir(root,true),'example.md')),false);
});
test('versions can be read after save and migration', t => {
  const root=fixture(t); seed(root); save(root,{meta:{title:'Changed',draft:true}});
  const entries=lib.listHistory(root,'example',true);
  assert.ok(entries.length>0);
  assert.equal(lib.readHistory(root,'example',true,entries[0].id).raw,sample);
});
test('trash and restore keep markdown and assets',t=>{
  const root=fixture(t);seed(root);const item=lib.moveToTrash(root,'example',false);
  assert.equal(fs.existsSync(path.join(lib.postDir(root,false),'example.md')),false);
  lib.restoreFromTrash(root,item.id);
  assert.equal(lib.readPost(root,'example',false).body,'Original body\n');
  assert.equal(fs.readFileSync(path.join(lib.postDir(root,false),'example','image.png'),'utf8'),'original image');
});
test('reserved Windows names and invalid dates are rejected',()=>{
  for(const name of ['CON','con.txt','LPT1','NUL']) assert.throws(()=>lib.sanitizeName(name),e=>e.status===400);
  assert.throws(()=>lib.validateDate('2026-02-30 10:00:00'),e=>e.status===400);
  assert.equal(lib.validateDate('2026-09-30 10:00:00'),'2026-09-30 10:00:00');
});
test('image signatures are checked instead of trusting extensions',()=>{
  assert.throws(()=>lib.detectImage(Buffer.from('not an image')),e=>e.status===415);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0YQAAAAASUVORK5CYII=','base64');
  assert.equal(lib.detectImage(png),'png');
});
test('permalink 模板能算出产物路径，遇到不认识的占位符就如实放弃',()=>{
  const d=new Date(2026,9,1,8,5,3);                    // 2026-10-01 08:05:03（本地时区）
  assert.equal(lib.permalinkPath(':year/:month/:day/:title/',{date:d,slug:'某篇'}),'2026/10/01/某篇/');
  assert.equal(lib.permalinkPath(':year/:i_month/:i_day/:name/',{date:d,slug:'a'}),'2026/10/1/a/');
  assert.equal(lib.permalinkPath('posts/:hour:minute/',{date:d,slug:'a'}),'posts/0805/');
  // 不认识的占位符 / 非法日期一律返回 null，绝不编一个看起来合理其实 404 的路径
  assert.equal(lib.permalinkPath(':abbrlink/',{date:d,slug:'a'}),null);
  assert.equal(lib.permalinkPath(':year/:category/:title/',{date:d,slug:'a'}),null);
  assert.equal(lib.permalinkPath(':year/:month/:day/:title/',{date:new Date('nope'),slug:'a'}),null);
});
test('resolvePostOutput 只在 public 下真有产物时才算 exists',t=>{
  const root=fixture(t);seed(root);                     // front-matter date = 2026-09-30
  const before=lib.resolvePostOutput(root,'example',false);
  assert.equal(before.ok,true);
  assert.equal(before.url,'/2026/09/30/example/');
  assert.equal(before.exists,false);                    // 还没编译过
  const html=path.join(root,'public','2026','09','30','example','index.html');
  fs.mkdirSync(path.dirname(html),{recursive:true});
  fs.writeFileSync(html,'<html></html>');
  const after=lib.resolvePostOutput(root,'example',false);
  assert.equal(after.exists,true);
  assert.ok(after.mtime>0);
});
test('permalink 用了本工具不支持的写法时，宁可说"推不出来"',t=>{
  const root=fixture(t);seed(root);
  fs.writeFileSync(path.join(root,'_config.yml'),'render_drafts: false\npermalink: posts/:abbrlink/\n');
  const out=lib.resolvePostOutput(root,'example',false);
  assert.equal(out.ok,false);
  assert.match(out.reason,/permalink/);
});

test('configuration editor lists existing root config YAML files only', t => {
  const root=fixture(t);
  fs.writeFileSync(path.join(root,'config.yaml'),'title: extra\n');
  fs.writeFileSync(path.join(root,'_config.butterfly.yml'),'theme: test\n');
  fs.writeFileSync(path.join(root,'notes.yml'),'private: true\n');
  assert.deepEqual(lib.listConfigFiles(root),['_config.yml','_config.butterfly.yml','config.yaml']);
  for(const name of ['../_config.yml','source/_config.yml','notes.yml','package.json']) {
    assert.throws(()=>lib.readConfig(root,name),e=>e.status===400);
  }
});

test('configuration editor preserves comments, BOM and CRLF and backs up exact old content', t => {
  const root=fixture(t),file=path.join(root,'_config.yml');
  const original='\uFEFF# keep this comment\r\ntitle: old\r\npost_asset_folder: false\r\n';
  fs.writeFileSync(file,original);
  const current=lib.readConfig(root,'_config.yml');
  const saved=lib.writeConfig(root,current.name,'# keep this comment\ntitle: new\npost_asset_folder: true\n',current.revision);
  assert.equal(fs.readFileSync(file,'utf8'),'\uFEFF# keep this comment\r\ntitle: new\r\npost_asset_folder: true\r\n');
  assert.equal(fs.readFileSync(path.join(root,saved.backup),'utf8'),original);
  assert.notEqual(saved.revision,current.revision);
  assert.equal(lib.readSiteConfig(root).postAssetFolder,true);
});

test('configuration editor rejects invalid YAML, oversized input and stale or missing revisions', t => {
  const root=fixture(t),file=path.join(root,'_config.yml'),current=lib.readConfig(root,'_config.yml');
  for(const content of ['title: [','- a\n- b\n','false','loop: &x {self: *x}','text: '+ 'x'.repeat(1048576)]) {
    assert.throws(()=>lib.writeConfig(root,current.name,content,current.revision),e=>e.status===400);
  }
  assert.throws(()=>lib.writeConfig(root,current.name,'title: new\n',''),e=>e.status===428);
  assert.equal(fs.readFileSync(file,'utf8'),current.content);
  assert.equal(fs.existsSync(path.join(root,'.hexo-tool-history')),false);
  fs.appendFileSync(file,'# external change\n');
  assert.throws(()=>lib.writeConfig(root,current.name,'title: new\n',current.revision),e=>e.status===409);
  assert.match(fs.readFileSync(file,'utf8'),/# external change/);
  assert.throws(()=>lib.readConfig(root,'_config.missing.yml'),e=>e.status===404);
});

test('configuration editor refuses a backup directory redirected through a junction', t => {
  const root=fixture(t),outside=path.join(root,'other');
  fs.mkdirSync(outside);
  try { fs.symlinkSync(outside,path.join(root,'.hexo-tool-history'),'junction'); }
  catch(e) { if(e.code==='EPERM')return t.skip('Junctions are unavailable');throw e; }
  const current=lib.readConfig(root,'_config.yml');
  assert.throws(()=>lib.writeConfig(root,current.name,'title: new\n',current.revision),e=>e.status===400);
  assert.equal(fs.readFileSync(path.join(root,current.name),'utf8'),current.content);
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test('configuration size limit includes preserved CRLF line endings', t => {
  const root=fixture(t),file=path.join(root,'_config.yml');
  fs.writeFileSync(file,'title: old\r\n');
  const current=lib.readConfig(root,'_config.yml');
  const content='title: new\n'+'# padding\n'.repeat(100000);
  assert.ok(Buffer.byteLength(content)<1048576);
  assert.throws(()=>lib.writeConfig(root,current.name,content,current.revision),e=>e.status===400);
  assert.equal(fs.readFileSync(file,'utf8'),current.content);
  assert.equal(fs.existsSync(path.join(root,'.hexo-tool-history')),false);
});
