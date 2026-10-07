'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const pages=require('../src/pages');
function fixture(t) {
  const prefix=path.join(os.tmpdir(),'hexo-pages-'),blog=fs.mkdtempSync(prefix);
  t.after(()=>{assert.ok(path.resolve(blog).startsWith(path.resolve(prefix)));fs.rmSync(blog,{recursive:true,force:true});});
  const seed=(name,content)=>{const file=path.join(blog,'source',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file;};
  seed('about/index.md','---\ntitle: About\nlayout: page\ncustom: true\n# keep comment\n---\nOriginal about\n');
  seed('links/index.md','---\ntitle: Links\nlayout: links\n---\n');
  seed('_data/links.yml','- links_category: Friends\n  list:\n    - name: Example\n      link: https://example.test/\n');
  seed('_posts/article.md','Original article');seed('_drafts/draft.md','Original draft');
  seed('_private/index.md','private');seed('.hidden/index.md','hidden');seed('images/image.png','image');
  return {blog,seed};
}

test('lists standalone Markdown and YAML data, excluding posts and unrelated files',t=>{
  const {blog,seed}=fixture(t);
  seed('nested/page.markdown','Nested');seed('_data/nested/friends.yaml','name: Example\n');
  assert.deepEqual(pages.listPages(blog),[
    {name:'about/index.md',kind:'page'},{name:'links/index.md',kind:'page'},{name:'nested/page.markdown',kind:'page'},
    {name:'_data/links.yml',kind:'data'},{name:'_data/nested/friends.yaml',kind:'data'}
  ]);
});

test('saving an About page preserves raw metadata, BOM/EOL and backs up original bytes',t=>{
  const {blog,seed}=fixture(t);
  const raw='\uFEFF---\r\ntitle: About\r\nlayout: page\r\ncustom: true\r\n# keep comment\r\n---\r\nOriginal\r\n';
  const file=seed('about/index.md',raw),current=pages.readPage(blog,'about/index.md');
  const input=raw.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace('Original','Edited');
  const saved=pages.writePage(blog,current.name,input,current.revision);
  assert.equal(saved.content,raw.replace('Original','Edited'));
  assert.equal(fs.readFileSync(file,'utf8'),saved.content);
  assert.equal(fs.readFileSync(path.join(blog,saved.backup),'utf8'),raw);
  assert.notEqual(saved.revision,current.revision);
  assert.equal(pages.readPage(blog,current.name).revision,saved.revision);
  assert.equal(fs.readFileSync(path.join(blog,'source','_posts','article.md'),'utf8'),'Original article');
});

test('friend link YAML arrays are editable without removing comments or reformatting',t=>{
  const {blog}=fixture(t),current=pages.readPage(blog,'_data/links.yml');
  const content='# friends\n'+current.content.replace('Example','New friend');
  const saved=pages.writePage(blog,current.name,content,current.revision);
  assert.equal(saved.content,content);
  assert.equal(fs.readFileSync(path.join(blog,saved.backup),'utf8'),current.content);
});

test('rejects invalid YAML, unclosed front-matter, missing revisions, conflicts and oversized content',t=>{
  const {blog}=fixture(t),current=pages.readPage(blog,'about/index.md');
  for(const content of ['---\ntitle: [\n---\nBody','---\ntitle: about\nBody']) {
    assert.throws(()=>pages.writePage(blog,current.name,content,current.revision),{status:400});
  }
  assert.throws(()=>pages.writePage(blog,current.name,'New',''),{status:428});
  assert.throws(()=>pages.writePage(blog,current.name,'New','wrong'),{status:409});
  assert.throws(()=>pages.writePage(blog,current.name,'x'.repeat(1024*1024+1),current.revision),{status:400});
  const data=pages.readPage(blog,'_data/links.yml');
  for(const content of ['friends: [','loop: &loop [*loop]'])assert.throws(()=>pages.writePage(blog,data.name,content,data.revision),{status:400});
  assert.equal(pages.readPage(blog,current.name).content,current.content);
  assert.equal(fs.existsSync(path.join(blog,'.hexo-tool-history')),false);
  fs.writeFileSync(path.join(blog,'source',current.name),'External edit');
  assert.throws(()=>pages.writePage(blog,current.name,'Overwrite',current.revision),{status:409});
  assert.equal(pages.readPage(blog,current.name).content,'External edit');
});

test('only existing permitted source files can be read or saved',t=>{
  const {blog}=fixture(t);
  for(const name of ['../_config.yml','/about/index.md','about\\index.md','_posts/article.md','_drafts/draft.md',
    '_private/index.md','.hidden/index.md','images/image.png','_data/links.json','about/../../outside.md','about/index.md:stream','CON.md','about/./index.md']) {
    assert.throws(()=>pages.readPage(blog,name),{status:400},name);
    assert.throws(()=>pages.writePage(blog,name,'overwrite','revision'),{status:400},name);
  }
  assert.throws(()=>pages.readPage(blog,'missing/index.md'),{status:404});
  assert.throws(()=>pages.writePage(blog,'missing/index.md','new','revision'),{status:404});
});

test('does not list or follow linked source directories',t=>{
  const {blog}=fixture(t),outside=path.join(blog,'outside');fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'index.md'),'Outside source');
  try {fs.symlinkSync(outside,path.join(blog,'source','linked'),process.platform==='win32'?'junction':'dir');}
  catch(e) {if(e.code==='EPERM')return t.skip('Cannot create a symlink');throw e;}
  assert.ok(!pages.listPages(blog).some(file=>file.name.startsWith('linked/')));
  assert.throws(()=>pages.readPage(blog,'linked/index.md'),{status:400});
  assert.throws(()=>pages.writePage(blog,'linked/index.md','overwrite','revision'),{status:400});
  assert.equal(fs.readFileSync(path.join(outside,'index.md'),'utf8'),'Outside source');
});

test('page previews resolve only public source images and reject traversal and symlinks',t=>{
  const {blog,seed}=fixture(t);
  const local=seed('about/assets/local image.png','local'),shared=seed('images/avatar.png','shared');
  assert.equal(pages.pageImage(blog,'about/index.md','assets/local%20image.png'),local);
  assert.equal(pages.pageImage(blog,'about/index.md','../images/avatar.png?version=1#anchor'),shared);
  assert.equal(pages.pageImage(blog,'_data/links.yml','/images/avatar.png'),shared);
  for(const image of ['../../outside.png','%2e%2e/%2e%2e/outside.png','/_posts/secret.png','/_drafts/secret.png',
    '/_data/secret.png','/.hidden/secret.png','../_config.yml','C:/secret.png','assets/a.png%3astream','%zz.png','assets\\a.png']) {
    assert.throws(()=>pages.pageImage(blog,'about/index.md',image),{status:400},image);
  }
  assert.throws(()=>pages.pageImage(blog,'_posts/article.md','/images/avatar.png'),{status:400});
  const outside=path.join(blog,'outside-images');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'image.png'),'outside');
  try{fs.symlinkSync(outside,path.join(blog,'source','linked-images'),process.platform==='win32'?'junction':'dir');}
  catch(e){if(e.code==='EPERM')return t.skip('Cannot create a symlink');throw e;}
  assert.throws(()=>pages.pageImage(blog,'about/index.md','/linked-images/image.png'),{status:400});
});
