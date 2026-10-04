/* 两种 Markdown 导入模式的浏览器回归。只使用独立临时博客，不修改实际博客。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { launch, sleep } = require('./cdp');

const TOOL = path.join(__dirname, '..');
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-import-modes-'));
const BLOG = path.join(FIXTURE, 'blog');
const VAULT = path.join(FIXTURE, 'vault');
const PORT = Number(process.env.UI_IMPORT_PORT || 4844);
const URL = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, 'ui-import-md.out');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64');
const HASH = crypto.createHash('md5').update(PNG).digest('hex') + '.png';
const out = [];
let fail = 0;
const log = (s) => { out.push(s); console.log(s); };
const check = (ok, label, detail) => {
  if (!ok) fail++;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`);
};
fs.mkdirSync(path.join(BLOG, 'source', '_posts'), { recursive: true });
fs.mkdirSync(path.join(BLOG, 'source', '_drafts'), { recursive: true });
fs.writeFileSync(path.join(BLOG, '_config.yml'), 'title: 导入验收\nurl: https://example.test\npost_asset_folder: true\n');
fs.mkdirSync(path.join(VAULT, 'assets'), { recursive: true });
const PIC = 'Pasted image 20260101120000.png';
fs.writeFileSync(path.join(VAULT, 'assets', PIC), PNG);
const WIKI = path.join(VAULT, '我的笔记.md');
fs.writeFileSync(WIKI, `---\ntitle: 我的笔记\ntags:\n  - 测试\n---\n\n正文第一段。\n![[${PIC}]]\n![[${PIC}|300]]\n![[另一篇笔记]]\n`);
fs.writeFileSync(path.join(VAULT, '另一篇.md'), '不应导入这篇\n');
// 大目录不能因无关图片超过 300 张而拒绝这一篇只引用一张图的文章。
for (let i = 0; i < 301; i++) fs.writeFileSync(path.join(VAULT, 'assets', `unused-${i}.png`), PNG);
const LOCALPNG = path.join(FIXTURE, '本机 图片 (1).png');
fs.writeFileSync(LOCALPNG, PNG);
const PLAIN = path.join(FIXTURE, '普通.md');
fs.writeFileSync(PLAIN, `普通正文\n![截图](${LOCALPNG})\n![内嵌](data:image/png;base64,${PNG.toString('base64')})\n![外链](https://example.test/a.png)\n`);
const RELATIVE = path.join(VAULT, '相对路径.md');
fs.writeFileSync(RELATIVE, `相对路径正文\n![说明][img]\n\n[img]: <assets/${PIC}>\n`);
const CODE = path.join(FIXTURE, '代码示例.md');
fs.writeFileSync(CODE, '```md\n![示例](missing.png)\n![[missing.png]]\n```\n');

(async () => {
  const srv = spawn(process.execPath, [path.join(TOOL, 'src', 'server.js'), BLOG], {
    env: { ...process.env, PORT: String(PORT) }, cwd: TOOL, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let br, info;
  try {
    log('启动独立测试服务');
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch(URL + '/api/info')).json(); } catch { await sleep(200); }
    }
    if (!info) throw new Error('测试服务未启动');
    log('启动浏览器');
    br = await launch({ out: path.join(TOOL, '.workbuddy', 'shots'), profile: 'hexo-import-modes', freshProfile: true, port: Number(process.env.UI_IMPORT_CDP_PORT || 9345) });
    const { evaluate } = br;
    await br.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__err=[]; window.addEventListener('error', e=>window.__err.push(e.message));
      window.__imports=[];
      const originalOpen=window.open;
      window.open=function(...args){
        const tab=originalOpen.apply(this,args);
        if(args[0]==='/preview') window.__previewTab=tab;
        return tab;
      };
      const originalFetch=window.fetch;
      window.fetch=async function(url,opts){
        const response=await originalFetch.apply(this,arguments);
        if(String(url).includes('/api/import-md')) window.__imports.push({
          mode:opts.body.get('mdmode'), images:[...opts.body.keys()].filter(k=>k.startsWith('f:')).length,
          response:await response.clone().json()
        });
        return response;
      };
    ` });
    await br.goto(URL + '/');
    await br.waitFor('typeof Editor === "object" && !document.getElementById("btnMd").disabled');
    async function feedFile(selector, file) {
      const { root } = await br.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await br.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await br.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    }
    // Chromium 的 CDP 不填 webkitRelativePath，目录测试构造等价的真实 FileList。
    async function feedDirectory() {
      const items = fs.readdirSync(path.join(VAULT, 'assets')).map(name => ({
        rel: 'vault/assets/' + name, data: PNG.toString('base64'), type: 'image/png',
      }));
      for (const name of ['我的笔记.md', '另一篇.md', '相对路径.md']) items.push({
        rel: 'vault/' + name, data: fs.readFileSync(path.join(VAULT, name)).toString('base64'), type: 'text/markdown',
      });
      await evaluate(`(() => {
        const dt=new DataTransfer();
        for(const it of ${JSON.stringify(items)}) {
          const bytes=Uint8Array.from(atob(it.data),c=>c.charCodeAt(0));
          const file=new File([bytes],it.rel.split('/').pop(),{type:it.type});
          Object.defineProperty(file,'webkitRelativePath',{value:it.rel}); dt.items.add(file);
        }
        const input=document.getElementById('mdImportImages');
        input.files=dt.files; input.dispatchEvent(new Event('change'));
      })()`);
    }
    const state = () => evaluate(`({title:document.getElementById('f-title').value,
      name:document.getElementById('f-name').value,body:document.getElementById('body').value,
      error:document.getElementById('mdImportError').hidden?'':document.getElementById('mdImportError').textContent,
      imports:window.__imports})`);
    const open = (mode) => evaluate(`document.getElementById('btnMd').click();
      document.getElementById('mdImportMode').value=${JSON.stringify(mode)};
      document.getElementById('mdImportMode').dispatchEvent(new Event('change'));`);
    const submit = () => evaluate(`document.getElementById('btnConfirmMdImport').click()`);
    async function done() {
      check(await br.waitFor(`!document.getElementById('mdImportModal').classList.contains('show')`, 10000), '导入完成，弹窗关闭');
      return state();
    }
    async function previewImages(name, draft, count) {
      const prefix = '/media/' + (draft ? 'd' : 'p') + '/' + encodeURIComponent(name) + '/';
      return br.waitFor(`window.__previewTab && !window.__previewTab.closed && (() => {
        const imgs=[...window.__previewTab.document.querySelectorAll('#preview img')]
          .filter(img=>new URL(img.src).pathname.startsWith(${JSON.stringify(prefix)}));
        return imgs.length===${count} && imgs.every(img=>img.complete && img.naturalWidth===1);
      })()`, 5000);
    }
    check(await evaluate(`document.querySelectorAll('#btnMd').length===1`), '页面只有一个导入 MD 入口');
    await open('markdown');
    check(await evaluate(`document.getElementById('mdImportMode').options.length===2`), '同一弹窗提供两种文档类型');
    await submit(); await sleep(150);
    let s = await state();
    check(/选择.*Markdown/.test(s.error) && s.imports.length===0, '未选文档时阻止提交并给出提示', s.error);
    await feedFile('#mdImportFile', WIKI);
    await submit(); await sleep(150);
    s = await state();
    check(/Obsidian/.test(s.error) && s.imports.length===0, '类型选错时提示切换，不静默漏掉 wiki 图片', s.error);
    await open('obsidian');
    await submit(); await sleep(150);
    s = await state();
    check(/图片所在的文件夹/.test(s.error) && s.imports.length===0, 'Obsidian 未选图片目录时保留文档，等待补图', s.error);
    await feedDirectory();
    check(await evaluate(`document.getElementById('mdImportFile').files[0].name==='我的笔记.md'`), '补选目录不会改掉已选文档');
    await submit(); s = await done();
    check(s.title==='我的笔记' && /^正文第一段/.test(s.body), '补选目录含多篇笔记仍只导入原文档，front-matter 正确拆分', s);
    check(s.imports.length===1 && s.imports[0].mode==='obsidian', '全过程只提交一次，并传递 Obsidian 模式', s.imports);
    check(s.imports[0].images===1, '只上传被引用图片，301 张无关图片不占限额', s.imports[0]);
    check((s.body.match(/asset_img/g)||[]).length===2 && !s.body.includes('![[Pasted'), '两处 wiki 图片均转换，含宽度的语法也支持', s.body);
    check(s.body.includes('![[另一篇笔记]]') && s.imports[0].response.stats.missing===0, '笔记嵌入不误报为缺失图片', s.body);
    check(s.imports[0].response.assets.count===1, '同一图片重复引用，落盘与提示按一张计数', s.imports[0].response);
    const assetDir=path.join(BLOG,'source','_drafts',s.name);
    check(fs.readdirSync(assetDir).length===1 && fs.readFileSync(path.join(assetDir,HASH)).equals(PNG), '图片复制到文章资源目录，字节一致');
    await br.send('Runtime.evaluate', { expression: `document.getElementById('btnPreview').click()`, userGesture: true });
    check(await previewImages(s.name, true, 2), '首次保存之前，真实预览标签能显示两张导入图片');
    check(!fs.existsSync(path.join(BLOG,'source','_drafts',s.name+'.md')), '实时预览不会为了显示图片偷偷保存文章');
    check(await evaluate(`(async()=>{const img=new Image();img.src=${JSON.stringify('/media/d/' + encodeURIComponent(s.name) + '/' + HASH)};
      await new Promise((ok,no)=>{img.onload=ok;img.onerror=no});return img.naturalWidth===1})()`), '浏览器能通过资源路由加载并解码导入图片');
    await evaluate(`document.getElementById('f-draft').checked=false;
      document.getElementById('f-draft').dispatchEvent(new Event('change'));`);
    check(await previewImages(s.name, true, 2), '首次保存前切换草稿勾选，预览仍使用图片实际所在目录');
    check(await br.waitFor(`JSON.parse(localStorage.getItem('hexo-tool-cache:new')||'{}').importedAssets?.name==='我的笔记'`),
      '未保存编辑缓存包含导入图片的目录信息');
    await evaluate(`window.__previewTab.close()`);
    await br.goto(URL + '/');
    check(await br.waitFor(`document.getElementById('f-title').value==='我的笔记'`), '刷新后可以恢复未保存的导入文章');
    await br.send('Runtime.evaluate', { expression: `document.getElementById('btnPreview').click()`, userGesture: true });
    check(await previewImages('我的笔记', true, 2), '恢复缓存后，真实预览仍能显示导入图片');

    await open('markdown'); await feedFile('#mdImportFile', PLAIN); await submit(); s = await done();
    const plainResult=s.imports[s.imports.length-1].response;
    check(s.title==='普通' && !s.body.includes(LOCALPNG) && !s.body.includes('data:image'), '普通模式直接导入本机路径和 base64，无需图片目录', s.body);
    check(plainResult.stats.localPath===1 && plainResult.stats.embedded===1 && plainResult.stats.missing===0, '两种本地图源计数正确', plainResult.stats);
    check(s.body.includes('https://example.test/a.png') && plainResult.stats.remote===1, '外链保留原地址');
    check(await previewImages(s.name, true, 2), '普通 MD 未保存时，已打开的预览也能同步新文章图片目录');

    await open('markdown'); await feedFile('#mdImportFile', RELATIVE); await feedDirectory(); await submit(); s = await done();
    check(s.title==='相对路径' && s.body.includes(`asset_img ${HASH} 说明`), '普通相对路径及引用式图片也能导入', s.body);
    await evaluate(`document.getElementById('btnSave').click()`); await sleep(700);
    check(fs.existsSync(path.join(BLOG,'source','_drafts',s.name+'.md')), '导入后可以保存文章');
    check(fs.readFileSync(path.join(BLOG,'source','_drafts',s.name,HASH)).equals(PNG), '保存后图片目录仍与文章同名');
    check(await previewImages(s.name, true, 1), '首次保存后，预览仍能显示同名目录图片');

    await open('markdown'); await feedFile('#mdImportFile', CODE); await submit(); s = await done();
    check(s.body.includes('![示例](missing.png)') && s.imports[s.imports.length-1].response.stats.missing===0, '代码块图片示例不触发补图要求，也不被改写', s.body);
    await open('obsidian');
    await evaluate(`document.getElementById('btnCancelMdImport').click()`);
    check(await evaluate(`!document.getElementById('mdImportModal').classList.contains('show') && document.activeElement.id==='btnMd'`), '取消不提交，焦点返回导入按钮');

    await br.goto(URL + '/post?name=' + encodeURIComponent('相对路径') + '&draft=1');
    check(await br.waitFor(`document.getElementById('f-title').value==='相对路径'`), '独立编辑页载入已保存文章');
    await open('obsidian'); await feedFile('#mdImportFile', WIKI); await feedDirectory(); await submit(); s = await done();
    check(s.title==='相对路径' && s.body.includes('正文第一段'), '独立页同样支持两种模式，插入正文但不覆盖文章标题', s);
    const postResult=s.imports[s.imports.length-1].response;
    check(postResult.assets.name==='相对路径' && postResult.stats.images===1, '独立页图片进入当前文章自己的目录', postResult.assets);
    check((await evaluate('window.__err')).length===0, '页面没有未捕获错误');
    await open('obsidian');
    await br.shot('import-md.png');
  } catch(e) { fail++; log('  FAIL  ' + (e.stack || e)); }
  finally {
    if(br) try { await br.close(); } catch { /* 已关闭 */ }
    if(info) try { await fetch(URL+'/api/shutdown',{method:'POST',headers:{'x-hexo-token':info.token,'Content-Type':'application/json'},body:'{}'}); await sleep(300); } catch { /* 已退出 */ }
    if(srv.exitCode===null) srv.kill();
    log(fail ? `有 ${fail} 项未通过` : '导入 MD 前端验收全部通过');
    fs.writeFileSync(OUT,out.join('\n'),'utf8');
  }
  process.exit(fail ? 1 : 0);
})();
