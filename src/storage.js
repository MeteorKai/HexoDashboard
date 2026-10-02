'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  let fd;
  try {
    fd=fs.openSync(temp,'wx');fs.writeFileSync(fd,content);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp,file);
  } finally {
    if(fd!==undefined) fs.closeSync(fd);
    if(fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function revision(raw) {return crypto.createHash('sha256').update(raw).digest('hex');}
function bucket(root,name,draft) {
  return path.join(root,'.hexo-tool-history',revision((draft?'d:':'p:')+name));
}
function ensureHistory(root) {
  const dir=path.join(root,'.hexo-tool-history');fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(path.join(dir,'.gitignore')))atomicWrite(path.join(dir,'.gitignore'),'*\n');
}
function id() {return Date.now()+'-'+crypto.randomBytes(6).toString('hex');}
function safeId(value) {
  if(!/^\d+-[a-f0-9]+$/.test(String(value))) throw Object.assign(new Error('非法历史记录 ID'),{status:400});
  return value;
}
function backupPost(root,name,draft,raw) {
  ensureHistory(root);const dir=bucket(root,name,draft);fs.mkdirSync(dir,{recursive:true});
  const key=id();atomicWrite(path.join(dir,key+'.md'),raw);return key;
}
function moveHistory(root,oldName,oldDraft,name,draft) {
  const from=bucket(root,oldName,oldDraft),to=bucket(root,name,draft);
  if(from===to || !fs.existsSync(from))return;
  // 复制而非先移动：即使后续文章写入失败，原身份的历史仍然可用。
  fs.cpSync(from,to,{recursive:true,force:false});
}
function listHistory(root,name,draft) {
  const dir=bucket(root,name,draft);if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(f=>/^\d+-[a-f0-9]+\.md$/.test(f)).map(f=>({
    id:f.slice(0,-3),createdAt:new Date(Number(f.split('-')[0])).toISOString(),size:fs.statSync(path.join(dir,f)).size,
  })).sort((a,b)=>b.id.localeCompare(a.id));
}
function readHistory(root,name,draft,key) {
  const file=path.join(bucket(root,name,draft),safeId(key)+'.md');
  if(!fs.existsSync(file))throw Object.assign(new Error('历史版本不存在'),{status:404});
  return {raw:fs.readFileSync(file,'utf8')};
}
function archiveImage(root,name,draft,file) {
  ensureHistory(root);const dir=path.join(bucket(root,name,draft),'images',id());fs.mkdirSync(dir,{recursive:true});
  const filename=path.basename(file);
  atomicWrite(path.join(dir,'meta.json'),JSON.stringify({filename,createdAt:new Date().toISOString()}));
  fs.renameSync(file,path.join(dir,filename));
}
function listArchivedImages(root,name,draft) {
  const dir=path.join(bucket(root,name,draft),'images');if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(k=>/^\d+-[a-f0-9]+$/.test(k)).flatMap(k=>{
    try {return [{id:k,...JSON.parse(fs.readFileSync(path.join(dir,k,'meta.json'),'utf8'))}];}catch{return [];}
  }).sort((a,b)=>b.id.localeCompare(a.id));
}
function restoreImage(root,name,draft,key,targetDir) {
  const dir=path.join(bucket(root,name,draft),'images',safeId(key));
  let meta;try{meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8'));}catch{throw Object.assign(new Error('图片备份不存在'),{status:404});}
  if(typeof meta.filename!=='string' || /[\\/]/.test(meta.filename) || meta.filename==='.' || meta.filename==='..')throw new Error('非法图片备份');
  const target=path.join(targetDir,meta.filename);
  if(fs.existsSync(target))throw Object.assign(new Error('已有同名图片，不会覆盖'),{status:409});
  fs.mkdirSync(targetDir,{recursive:true});fs.renameSync(path.join(dir,meta.filename),target);
  fs.unlinkSync(path.join(dir,'meta.json'));fs.rmdirSync(dir);return meta;
}
module.exports={atomicWrite,revision,ensureHistory,backupPost,moveHistory,listHistory,readHistory,archiveImage,listArchivedImages,restoreImage};
