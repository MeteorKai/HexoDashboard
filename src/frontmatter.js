'use strict';
const yaml = require('../vendor/js-yaml');   // vendor/ 在应用根，本文件在 src/
function bad(message) { return Object.assign(new Error(message), {status:400}); }
function parseYAML(header) {
  if (Buffer.byteLength(header, 'utf8') > 65536) throw bad('Front-matter 不能超过 64KB');
  let data;
  try { data = yaml.load(header, {schema:yaml.CORE_SCHEMA}) || {}; }
  catch (e) { throw bad('YAML 格式错误：' + e.message); }
  if (typeof data !== 'object' || Array.isArray(data)) throw bad('Front-matter 必须是 YAML 对象');
  for (const key of ['__proto__','constructor','prototype']) {
    if (Object.hasOwn(data,key)) throw bad('不支持的元数据字段：'+key);
  }
  try { JSON.stringify(data); } catch { throw bad('不支持循环引用的 YAML'); }
  return data;
}
function parseFrontMatter(raw) {
  const text = String(raw).replace(/^\uFEFF/,'');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return {data:{},body:text,header:'',eol:'\n'};
  return {data:parseYAML(m[1]),body:text.slice(m[0].length),header:m[1],eol:text.includes('\r\n')?'\r\n':'\n'};
}
function dump(data) { return yaml.dump(data,{schema:yaml.CORE_SCHEMA,noRefs:true,lineWidth:-1}).trimEnd(); }
// 未改动的字段、嵌套结构和注释保留原文；只替换显式改动的顶层字段。
function patchHeader(header, changes, eol='\n') {
  const current=parseYAML(header);
  if (/^\s*\{/.test(header)) {
    for(const [key,value] of Object.entries(changes)) value==null ? delete current[key] : current[key]=value;
    return dump(current).replace(/\n/g,eol);
  }
  let lines=header ? header.split(/\r?\n/) : [];
  for (const [key,value] of Object.entries(changes)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(key)) throw bad('非法元数据字段');
    if (value!=null && JSON.stringify(current[key])===JSON.stringify(value)) continue;
    const keyRE=new RegExp('^(?:'+key+'|"'+key+'"|\''+key+'\')\\s*:');
    const start=lines.findIndex(l=>keyRE.test(l));
    const replacement=value==null ? [] : dump({[key]:value}).split('\n');
    if(start<0) {lines.push(...replacement);continue;}
    let end=start+1;
    while(end<lines.length && !/^[^\s#][^\n]*:/.test(lines[end])) end++;
    // 字段后的独立注释不要随字段一起删掉。
    while(end>start+1 && /^(?:#|\s*$)/.test(lines[end-1])) end--;
    lines.splice(start,end-start,...replacement);
  }
  const out=lines.join(eol); parseYAML(out); return out;
}
function buildFrontMatter(meta) {
  const data={...meta.extra};
  for(const k of ['title','date','updated','categories','tags','description','keywords','cover','mathjax','top']) {
    if(meta[k]!==undefined && meta[k]!=='' && meta[k]!==false) data[k]=meta[k];
  }
  if(meta.draft) data.layout='draft';
  return '---\n'+dump(data)+'\n---';
}
module.exports={parseYAML,parseFrontMatter,patchHeader,buildFrontMatter};
