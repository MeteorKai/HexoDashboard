'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const lib=require('./lib');
const yaml=require('../vendor/js-yaml');
const MAX=1024*1024;
const markdown=/\.(md|markdown)$/i, dataFile=/\.ya?ml$/i;
const bad=message=>Object.assign(new Error(message),{status:400});

function pagePath(blog,name) {
  if(typeof name!=='string' || /[<>:"\\|?*\x00-\x1f]/.test(name))throw bad('非法页面路径');
  const parts=name.split('/'),data=parts[0]==='_data';
  if(parts.some((part,index)=>!part || part.startsWith('.') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
    (part.startsWith('_') && !(data && index===0))))throw bad('只能编辑独立页面或 _data 中的 YAML 文件');
  if(!(data ? dataFile : markdown).test(name))throw bad('只支持 Markdown 页面与 YAML 数据文件');
  return lib.resolveInside(path.join(blog,'source'),name,'');
}

function listPages(blog) {
  const source=lib.resolveInside(blog,'source',''),files=[];
  function scan(dir,prefix='',data=false) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(entry.name.startsWith('.') || (entry.name.startsWith('_') && !(prefix==='' && entry.name==='_data')))continue;
      const name=prefix+entry.name,isData=data || name==='_data';
      if(entry.isDirectory())scan(path.join(dir,entry.name),name+'/',isData);
      else if(entry.isFile() && (data ? dataFile : markdown).test(entry.name))files.push({name,kind:data?'data':'page'});
    }
  }
  scan(source);
  return files.sort((a,b)=>a.kind===b.kind ? a.name.localeCompare(b.name) : a.kind==='page' ? -1 : 1);
}

function readPage(blog,name) {
  const file=pagePath(blog,name);
  let stat;
  try {stat=fs.statSync(file);}catch(e) {if(e.code==='ENOENT')throw Object.assign(new Error('页面文件不存在'),{status:404});throw e;}
  if(!stat.isFile())throw Object.assign(new Error('页面文件不存在'),{status:404});
  if(stat.size>MAX)throw bad('页面文件不能超过 1MB');
  const content=fs.readFileSync(file,'utf8');
  return {name,kind:name.startsWith('_data/')?'data':'page',content,revision:lib.revision(content)};
}

function writePage(blog,name,content,revision) {
  if(typeof content!=='string' || Buffer.byteLength(content,'utf8')>MAX)throw bad('页面内容必须是文本，且不能超过 1MB');
  if(!revision)throw Object.assign(new Error('缺少页面版本，请重新读取文件'),{status:428});
  const current=readPage(blog,name);
  if(current.revision!==revision)throw Object.assign(new Error('页面已在外部修改，请重新读取后再保存'),{status:409});
  const eol=current.content.includes('\r\n')?'\r\n':'\n';
  content=(current.content.startsWith('\uFEFF')?'\uFEFF':'')+content.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\n/g,eol);
  if(Buffer.byteLength(content,'utf8')>MAX)throw bad('页面文件不能超过 1MB');
  if(current.kind==='data') {
    try {JSON.stringify(yaml.load(content,{schema:yaml.CORE_SCHEMA}));}
    catch(e) {throw bad('YAML 格式错误：'+e.message);}
  } else {
    if(/^\uFEFF?---[ \t]*\r?\n/.test(content) && !/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.test(content))throw bad('页面 Front-matter 缺少结束的 ---');
    lib.parseFrontMatter(content);
  }
  const backup='.hexo-tool-history/pages/'+name+'.'+Date.now()+'-'+crypto.randomBytes(6).toString('hex')+'.bak';
  const backupFile=lib.resolveInside(blog,backup,'');
  lib.ensureHistory(blog);
  lib.atomicWrite(backupFile,current.content);
  lib.atomicWrite(pagePath(blog,name),content);
  return {name,kind:current.kind,content,revision:lib.revision(content),backup};
}
function pageImage(blog,name,image) {
  pagePath(blog,name);
  if(typeof image!=='string' || /[\\:\x00-\x1f]/.test(image))throw bad('非法页面图片路径');
  let target;
  try {target=decodeURIComponent(image.split(/[?#]/)[0]);}catch{throw bad('非法页面图片路径');}
  if(/[\\:\x00-\x1f]/.test(target))throw bad('非法页面图片路径');
  target=path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(name),target));
  if(target.split('/').some(part=>part.startsWith('.') || part.startsWith('_')) || !lib.assetExt(target,''))throw bad('只能预览 source 下公开目录中的图片');
  return lib.resolveInside(path.join(blog,'source'),target,'');
}
module.exports={listPages,readPage,writePage,pageImage};
