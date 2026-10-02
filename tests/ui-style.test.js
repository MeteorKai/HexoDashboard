/* 柔和主题的浏览器回归：临时博客，真实保存，桌面 / 窄屏 / 独立页截图。
 * 用法：node tests/ui-style.test.js [截图目录]
 * 不连接真实博客，也不执行部署。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { launch, sleep } = require('./cdp');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '.workbuddy/preview-tabs/after'));
const PORT = 4478;
const BASE = `http://127.0.0.1:${PORT}`;
const BODY = '## 给自己一段安静的时间\n\n打开写作台，记录今天的小小发现。不必急着完成，让想法慢慢生长。\n\n> 写作，是把平凡的日子重新看见。\n\n### 从一个小习惯开始\n\n- 留意窗外的光\n- 记下读到的句子\n- 给每个想法留一点空间\n\n```bash\nhexo clean && hexo generate\n```\n';
const LEGACY_FIELDS = 'description: 原文章简介 # 保留简介\ncover: /images/original.jpg # 保留封面\ntop: 8 # 保留置顶\n';

(async () => {
  const blog = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-soft-ui-'));
  const posts = path.join(blog, 'source/_posts');
  fs.mkdirSync(posts, { recursive: true });
  fs.mkdirSync(path.join(blog, 'source/_drafts'), { recursive: true });
  fs.writeFileSync(path.join(blog, '_config.yml'), 'title: 我的写作日常\npost_asset_folder: true\n');
  fs.writeFileSync(path.join(posts, '写作日常.md'), '---\ntitle: 在日常里，收集一点灵感\ndate: 2026-10-01 09:30:00\ncategories: [生活随笔]\ntags: [写作, 日常, 写作]\n' + LEGACY_FIELDS + '---\n\n' + BODY);
  fs.writeFileSync(path.join(posts, '阅读笔记.md'), '---\ntitle: 十月的阅读笔记\ndate: 2026-09-29 10:00:00\ntags: Hexo\n---\n\n把值得记住的文字留在这里。\n');
  fs.writeFileSync(path.join(blog, 'source/_drafts/未完成的想法.md'), '---\ntitle: 一些还未完成的想法\ntags: [草稿独有, 写作]\n---\n\n灵感备忘。\n');
  fs.mkdirSync(path.join(posts, '写作日常'));
  fs.writeFileSync(path.join(posts, '写作日常/插图.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=', 'base64'));
  const server = spawn(process.execPath, ['src/server.js', blog], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe', windowsHide: true,
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  let br;
  const passed = [];
  const check = (condition, name) => { assert.ok(condition, name); passed.push(name); console.log('PASS ' + name); };
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = (await fetch(BASE + '/api/info')).ok; if (ready) break; } catch { /* 等待服务启动 */ }
      if (server.exitCode !== null) break;
      await sleep(200);
    }
    assert.ok(ready, 'Test server did not start: ' + serverLog);
    br = await launch({ out: OUT, freshProfile: true, port: 9348 });
    const eval_ = br.evaluate;
    const click = async selector => {
      await br.send('Page.bringToFront');
      const p = await eval_(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        e.scrollIntoView({ block: 'nearest' });
        const r = e.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return { x, y, hit: r.width > 0 && r.height > 0 && e.contains(top), blocker: top && (top.id || top.className || top.tagName) };
      })()`);
      if (!p.hit) await br.shot('failure.png');
      check(p.hit, '可点击 ' + selector + (p.hit ? '' : ' ' + JSON.stringify(p)));
      await br.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await br.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    };
    const viewport = (width, height) => br.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const noOverflow = async label => check(await eval_('document.documentElement.scrollWidth <= innerWidth'), label + ' 无横向溢出');
    const edit = text => eval_(`(() => {
      const e = document.getElementById('body'); e.value += ${JSON.stringify(text)};
      e.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const tagOptions = () => eval_(`(() => {
      const input = document.getElementById('f-tags'), value = input.value;
      input.value = ''; input.dispatchEvent(new Event('focus'));
      const tags = [...document.getElementById('tagSuggestions').children].map(o => o.dataset.tag);
      input.value = value; input.dispatchEvent(new Event('focus'));
      document.getElementById('tagSuggestions').hidden = true;
      input.setAttribute('aria-expanded', 'false');
      return tags;
    })()`);
    const key = async name => {
      await br.send('Input.dispatchKeyEvent', { type: name === 'Enter' ? 'keyDown' : 'rawKeyDown', key: name, code: name, text: name === 'Enter' ? '\r' : undefined, windowsVirtualKeyCode: name === 'ArrowDown' ? 40 : 13 });
      await br.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: name === 'ArrowDown' ? 40 : 13 });
    };
    let previewSession;
    const armPreview = () => eval_(`(() => {
      const original = window.open;
      window.open = function (...args) {
        const tab = original.apply(window, args);
        if (args[0] === '/preview') window.__previewTab = tab;
        return tab;
      };
    })()`);
    const previewEval = async expression => {
      const r = await br.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, previewSession);
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const previewWait = expression => br.waitFor(`window.__previewTab && !window.__previewTab.closed && (() => {
      const document = window.__previewTab.document; return ${expression};
    })()`);
    const openPreview = async () => {
      await click('#btnPreview');
      check(await previewWait('document.getElementById("previewStatus")?.textContent.includes("实时同步")'), '预览标签页握手完成');
      const { targetInfos } = await br.send('Target.getTargets');
      const tab = targetInfos.find(t => t.url === BASE + '/preview' && t.openerId === br.targetId);
      assert.ok(tab, 'Preview browser tab not found');
      const attached = await br.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
      previewSession = attached.sessionId;
      await br.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }, previewSession);
    };
    const previewShot = async name => {
      await br.send('Page.bringToFront', {}, previewSession);
      const { data } = await br.send('Page.captureScreenshot', { format: 'png' }, previewSession);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
      await br.send('Page.bringToFront');
    };

    await br.media('light');
    await br.goto(BASE, 'document.querySelectorAll("#postlist .t").length === 3');
    await br.sleep(600); // 等入场动画结束，再按真实屏幕坐标点击。
    check(await eval_('document.querySelector(".fields").open'), '文章属性默认展开');
    check(await eval_('!document.querySelector("#f-description, #f-cover, #f-top")'), '主界面移除简介、封面和置顶输入项');
    check(await eval_('!document.querySelector("#f-title").closest("details")'), '标题始终可编辑');
    check(await eval_('getComputedStyle(document.querySelector("#btnPublish")).display === "none"'), '新文章隐藏发表按钮');
    check(await eval_('document.querySelector("#body").getBoundingClientRect().height >= 400'), '正文获得完整工作区高度');
    check(await eval_('document.querySelector("#body").getBoundingClientRect().width >= 700'), '正文宽度增加');
    check(await eval_('document.querySelector(".article-settings").getBoundingClientRect().width >= 350'), '文章属性独立宽栏');
    check(await eval_('!document.querySelector("#preview, .panel--preview")'), '编辑页不再常驻预览');
    check(await eval_('document.querySelector("#f-categories").tagName === "SELECT" && [...document.querySelector("#f-categories").options].map(o => o.value).join(",") === ",tech_article,life_article"'), '新文章分类下拉框提供两种分类和空选项');
    check(await eval_('document.querySelector("#f-tags").getAttribute("role") === "combobox" && document.querySelector("#btnTags") && document.querySelector("#tagSuggestions").getAttribute("role") === "listbox"'), '标签为可自由输入的下拉建议框');
    assert.deepEqual(new Set(await tagOptions()), new Set(['Hexo', '写作', '日常']));
    check(true, '标签建议来自全部已发布文章，去重且排除草稿专有标签');
    check(!(await br.send('Target.getTargets')).targetInfos.some(t => t.url === BASE + '/preview'), '不自动打开预览标签');
    await br.shot('desktop-empty.png');
    await click('#postlist li:has(input[aria-label="选择 在日常里，收集一点灵感"])');
    check(await br.waitFor('document.querySelector("#body").value.includes("给自己")'), '文章载入');
    check(await eval_('document.querySelector("#f-categories").value === "生活随笔"'), '已有的其他分类原样显示');
    await eval_(`const tags = document.getElementById('f-tags'); tags.value = ''; tags.dispatchEvent(new Event('input')); tags.focus()`);
    await br.send('Input.insertText', { text: '写' });
    await key('ArrowDown'); await key('Enter');
    check(await eval_('document.getElementById("f-tags").value === "写作"'), '键盘可选择已有标签');
    await br.send('Input.insertText', { text: '， H' });
    await key('ArrowDown'); await key('Enter');
    check(await eval_('document.getElementById("f-tags").value === "写作， Hexo"'), '选择第二个标签保留第一个，支持中文逗号');
    await eval_('document.getElementById("f-tags").value = "写作， "; document.getElementById("f-tags").dispatchEvent(new Event("input")); document.getElementById("f-title").focus()');
    check(await eval_('document.getElementById("tagSuggestions").hidden'), '离开标签输入框关闭建议');
    await click('#btnTags');
    check(await eval_(`!document.getElementById('tagSuggestions').hidden && document.getElementById('f-tags').getAttribute('aria-expanded') === 'true' && !document.querySelector('#tagSuggestions [data-tag="写作"]')`), '点击展开建议，排除前面已经选择的标签');
    await br.shot('tags-dropdown-light.png');
    await click('#tagSuggestions [data-tag="Hexo"]');
    check(await eval_('document.getElementById("f-tags").value === "写作， Hexo" && document.getElementById("tagSuggestions").hidden'), '鼠标可选择标签且不会覆盖前面的标签');
    await key('ArrowUp');
    check(await eval_(`!!document.getElementById('f-tags').getAttribute('aria-activedescendant') && !!document.querySelector('#tagSuggestions [aria-selected="true"]')`), '方向键提供当前选项的辅助功能状态');
    await key('Escape');
    check(await eval_('document.getElementById("tagSuggestions").hidden && document.getElementById("f-tags").value === "写作， Hexo"'), 'Escape 关闭建议，不改动标签');
    await br.send('Input.insertText', { text: ', 自定义标签' });
    check(await eval_('document.getElementById("f-tags").value.endsWith(", 自定义标签")'), '标签可手动输入新值');
    await br.shot('desktop-light.png');
    await armPreview();
    await openPreview();
    check(await previewEval('!!document.querySelector("#preview h2") && !!document.querySelector("#preview blockquote")'), '新标签页 Markdown 预览渲染');
    await previewShot('preview-light.png');
    await click('#btnPreview');
    check((await br.send('Target.getTargets')).targetInfos.filter(t => t.url === BASE + '/preview').length === 1, '重复点击复用预览标签');
    await edit('\n\n预览尚未保存的文字。\n');
    check(await previewWait('document.getElementById("preview")?.textContent.includes("预览尚未保存")'), '未保存正文实时同步');
    check(!fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8').includes('预览尚未保存'), '打开预览不自动保存');
    await eval_('document.querySelector("#f-title").value = "标题同步测试"; document.querySelector("#f-title").dispatchEvent(new Event("input"))');
    check(await previewWait('document.getElementById("previewTitle")?.textContent === "标题同步测试"'), '未保存标题实时同步');
    await eval_('document.querySelector("#f-title").value = "在日常里，收集一点灵感"; document.querySelector("#f-title").dispatchEvent(new Event("input"))');
    await edit('\n{% asset_img 插图.png 示例 %}\n');
    check(await previewWait('document.querySelector("#preview img")?.naturalWidth === 1'), '预览标签中真实加载文章资源图片');
    check(await previewEval('decodeURIComponent(new URL(document.querySelector("#preview img").src).pathname) === "/media/p/写作日常/插图.png"'), 'Hexo 图片路径保持正确');
    await edit('\nHTML 安全测试。<img src="x" onerror="window.__previewXss = true"><script>window.__previewXss = true</script>\n');
    check(await previewWait('document.getElementById("preview")?.textContent.includes("HTML 安全测试")'), 'HTML 输入到达预览');
    check(await previewEval('!document.querySelector("#preview script, #preview [onerror]") && !window.__previewXss'), '新标签页仍清洗不安全 HTML');
    await previewEval(`window.dispatchEvent(new MessageEvent('message', { origin: 'https://untrusted.invalid', source: window.opener, data: { type: 'hexo-preview-update', title: '错误标题', markdown: '错误内容' } }))`);
    check(await previewEval('document.getElementById("previewTitle").textContent !== "错误标题"'), '拒绝非同源预览消息');
    await previewEval(`window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data: { type: 'hexo-preview-update', title: '错误标题', markdown: '错误内容' } }))`);
    check(await previewEval('document.getElementById("previewTitle").textContent !== "错误标题"'), '拒绝非打开者的预览消息');
    await eval_(`document.querySelector('#body').value = ${JSON.stringify(BODY + '\n预览尚未保存的文字。\n')}; document.querySelector('#body').dispatchEvent(new Event('input'))`);
    await edit('\n\n## 视觉回归保存\n\n柔和界面，功能不变。\n');
    await click('#btnSave');
    check(await br.waitFor('!document.querySelector("#editorTitle").textContent.endsWith(" •")'), '保存状态复位');
    check(fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8').includes('视觉回归保存'), '主界面保存真实落盘');
    check(fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8').includes('categories: [生活随笔]'), '不改分类时保存保留原分类');
    check(fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8').includes(LEGACY_FIELDS), '主界面保存保留旧简介、封面、置顶及其注释');
    assert.deepEqual(require('../src/frontmatter').parseFrontMatter(fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8')).data.tags, ['写作', 'Hexo', '自定义标签']);
    check((await tagOptions()).includes('自定义标签'), '已有与自定义标签正确保存，新标签自动加入建议');
    check(await eval_('getComputedStyle(document.querySelector("#toast")).pointerEvents === "none"'), '保存通知不拦截点击');
    check(await eval_('["f-date", "f-categories", "f-tags"].every(id => document.getElementById(id).getBoundingClientRect().height >= 40)'), '精简后属性输入框仍有舒适高度');
    await br.sleep(400);
    await br.shot('desktop-fields.png');
    await click('.fields > summary');
    check(await eval_('!document.querySelector(".fields").open'), '文章属性可收起');
    await click('.fields > summary');
    await click('[data-view="draft"]');
    check(await eval_('document.querySelectorAll("#postlist .t").length === 1 && !!document.querySelector(".tag-draft")'), '草稿筛选');
    await click('[data-view="all"]');
    await eval_('document.querySelector("#search").value = "阅读"; document.querySelector("#search").dispatchEvent(new Event("input"))');
    check(await br.waitFor('document.querySelectorAll("#postlist .t").length === 1 && document.querySelector("#postlist .t").textContent.includes("阅读")'), '文章搜索');
    check((await tagOptions()).includes('自定义标签'), '搜索文章不缩小可选择的已发布标签范围');
    await eval_('document.querySelector("#search").value = ""; document.querySelector("#search").dispatchEvent(new Event("input"))');
    check(await br.waitFor('document.querySelectorAll("#postlist .t").length === 3'), '搜索清除');
    await click('#btnTheme');
    check(await eval_('document.documentElement.dataset.theme === "dark"'), '深色切换');
    await br.sleep(400);
    check(await previewWait('document.documentElement.dataset.theme === "dark"'), '预览同步深色主题');
    await previewShot('preview-dark.png');
    await br.waitFor('document.querySelector("#toast").children.length === 0', 8000);
    await br.shot('desktop-dark.png');
    const consoleBefore = await eval_('document.querySelector("#consolePanel").getBoundingClientRect().height');
    await eval_('document.querySelector("#consoleGrip").focus()');
    await br.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
    await br.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
    check(await eval_('document.querySelector("#consolePanel").getBoundingClientRect().height') >= consoleBefore + 15, '键盘可调整编译窗口');
    await click('#btnConsoleMax');
    check(await eval_('document.querySelector(".app").classList.contains("console-max")'), '编译窗口放大');
    await click('#btnConsoleMax');
    await click('#btnSettings');
    check(await eval_('document.querySelector("#settingsModal").classList.contains("show")'), '设置弹窗打开');
    await br.shot('settings-dark.png');
    await click('#btnCloseSettings');
    await click('#btnTheme');
    await previewEval('window.close()');
    await eval_('window.__openBeforeBlock = window.open; window.open = () => null');
    await click('#btnPreview');
    check(await eval_('document.querySelector("#toast").textContent.includes("浏览器拦下")'), '弹出窗口被阻止时明确提示');
    await eval_('window.open = window.__openBeforeBlock');
    await openPreview();
    check(await previewEval('document.getElementById("preview").textContent.includes("视觉回归保存")'), '关闭后可重新打开预览');
    for (const [width, height] of [[1280, 800], [1024, 768], [390, 844]]) {
      await viewport(width, height);
      await br.sleep(200);
      await noOverflow(String(width));
      if (width === 390) check(await eval_('document.querySelector(".panel--list > .scroll").clientHeight >= 100'), '窄屏文章列表仍可浏览');
      await click('#btnSave');
      check(await br.waitFor('document.querySelector("#toast").lastElementChild?.textContent.startsWith("已保存")'), String(width) + ' 保存完成');
      await br.waitFor('document.querySelector("#toast").children.length === 0', 8000);
      await eval_('window.scrollTo(0, 0)');
      await br.shot(`layout-${width}.png`);
    }
    await viewport(1440, 900);
    await previewEval('window.close()');
    await br.goto(BASE + '/post?name=' + encodeURIComponent('写作日常'), 'document.querySelector("#ppState").textContent === "已保存"');
    check(await eval_('document.querySelector("#body").value.includes("视觉回归保存")'), '独立页读入已保存内容');
    await noOverflow('独立页桌面');
    await br.shot('post-light.png');
    check(await eval_('!document.querySelector("#preview") && document.querySelector("#ppFields").open'), '独立页同样按需预览与完整属性');
    check(await eval_('!document.querySelector("#f-description, #f-cover, #f-top")'), '独立页同样移除三个输入项');
    check(await eval_('document.querySelector("#f-categories").tagName === "SELECT" && document.querySelector("#f-categories").value === "生活随笔"'), '独立页同样显示分类下拉框并保留原分类');
    check(await br.waitFor('document.getElementById("tagSuggestions")?.children.length > 0'), '独立页读取已发布文章标签');
    check((await tagOptions()).includes('自定义标签') && !(await tagOptions()).includes('草稿独有'), '独立页标签建议同样排除草稿');
    await eval_('document.getElementById("f-tags").value += ", 独立自定义标签"; document.getElementById("f-tags").dispatchEvent(new Event("input"))');
    await eval_('document.querySelector("#f-categories").value = "tech_article"; document.querySelector("#f-categories").dispatchEvent(new Event("change", { bubbles: true }))');
    check(await eval_('document.querySelector("#ppState").textContent !== "已保存"'), '选择分类会标记未保存');
    await armPreview();
    await openPreview();
    await edit('\n独立编辑页保存验证。\n');
    check(await previewWait('document.getElementById("preview")?.textContent.includes("独立编辑页保存验证")'), '独立页未保存正文同步预览');
    await click('#btnSave');
    check(await br.waitFor('document.querySelector("#ppState").textContent === "已保存"'), '独立页保存状态');
    check(fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8').includes('独立编辑页保存验证'), '独立页保存真实落盘');
    check(fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8').includes(LEGACY_FIELDS), '独立页保存保留旧简介、封面、置顶及其注释');
    check(require('../src/frontmatter').parseFrontMatter(fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8')).data.categories[0] === 'tech_article', '分类选择写入 front-matter');
    check(require('../src/frontmatter').parseFrontMatter(fs.readFileSync(path.join(posts, '写作日常.md'), 'utf8')).data.tags.includes('独立自定义标签') && (await tagOptions()).includes('独立自定义标签'), '独立页新增标签保存后立即可供选择');
    await click('#btnFields');
    check(await eval_('!document.querySelector("#ppFields").open && document.querySelector("#body").getBoundingClientRect().width >= 1300'), '收起独立页属性后正文全宽');
    await click('#btnFields');
    await click('#btnTheme');
    await br.sleep(400);
    await br.waitFor('document.querySelector("#toast").children.length === 0', 8000);
    await br.shot('post-dark.png');
    await viewport(390, 844);
    await noOverflow('独立页手机');
    await click('#btnSave');
    await br.waitFor('document.querySelector("#toast").lastElementChild?.textContent.startsWith("已保存")');
    await br.waitFor('document.querySelector("#toast").children.length === 0', 8000);
    await br.shot('post-mobile.png');
    await br.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, previewSession);
    check(await previewEval('document.documentElement.scrollWidth <= innerWidth'), '预览标签手机无横向溢出');
    await previewShot('preview-mobile.png');
    await previewEval('window.close()');
    await br.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    check(await eval_('getComputedStyle(document.querySelector("#body")).opacity === "1"'), '减少动效时内容可见');
    await br.goto(BASE, 'document.querySelectorAll("#postlist .t").length === 3');
    check(await eval_('[...document.querySelectorAll(".panel")].every(e => getComputedStyle(e).opacity === "1")'), '减少动效时主界面面板可见');
    await viewport(1440, 900);
    await click('#postlist li:has(input[aria-label="选择 在日常里，收集一点灵感"])');
    check(await br.waitFor('document.querySelector("#f-name").value === "写作日常"'), '文章切换回归载入已有文章');
    await click('#btnNew');
    const cleanNew = 'document.querySelector("#f-name").value === "" && document.querySelector("#body").value === "" && ["title", "categories", "tags"].every(k => document.getElementById("f-" + k).value === "") && !document.querySelector("#f-mathjax").checked && !document.querySelector("#f-draft").checked';
    check(await eval_(cleanNew), '从已有文章新建清空正文和所有属性，包括文件名');
    const newFields = { title: '临时新文章', name: '临时新文章文件', date: '2026-10-01 12:34:56', categories: 'life_article', tags: '临时, 备忘' };
    const fillNew = `for (const [k, v] of Object.entries(${JSON.stringify(newFields)})) {
      const e = document.getElementById('f-' + k); e.value = v;
      e.dispatchEvent(new Event(k === 'categories' ? 'change' : 'input', { bubbles: true }));
    }
    for (const k of ['mathjax', 'draft']) { const e = document.getElementById('f-' + k); e.checked = true; e.dispatchEvent(new Event('change')); }
    document.getElementById('body').value = '来不及等待防抖的临时正文。'; document.getElementById('body').dispatchEvent(new Event('input'));`;
    // 在同一个 JS 任务里编辑并切换，确保没有等到 700ms 的缓存防抖。
    await eval_(`(() => { ${fillNew} document.querySelector('#postlist li:has(input[aria-label="选择 在日常里，收集一点灵感"])').click(); })()`);
    check(await br.waitFor('document.querySelector("#f-name").value === "写作日常"'), '新文章输入后可立即查看已有文章');
    const newCache = await eval_('localStorage.getItem("hexo-tool-cache:new")');
    check(JSON.parse(newCache || 'null')?.body === '来不及等待防抖的临时正文。', '切换前立即缓存新文章，不丢失最新输入');
    await br.sleep(850);
    check(await eval_('localStorage.getItem("hexo-tool-cache:new")') === newCache, '延迟缓存不会串写切换后的文章');
    await edit('\n查看已有文章时的正常编辑。\n');
    await click('#btnSave');
    check(await br.waitFor('!document.querySelector("#editorTitle").textContent.endsWith(" •")'), '查看已有文章后仍可保存');
    check(await eval_('localStorage.getItem("hexo-tool-cache:new")') === newCache, '保存已有文章不删除临时新文章');
    await eval_(`(() => {
      const c = JSON.parse(localStorage.getItem('hexo-tool-cache:new'));
      Object.assign(c.fields, { description: '旧版缓存简介', cover: '/old-cache.jpg', top: '3' });
      localStorage.setItem('hexo-tool-cache:new', JSON.stringify(c));
    })()`);
    await click('#btnNew');
    check(await eval_(`Object.entries(${JSON.stringify(newFields)}).every(([k, v]) => document.getElementById('f-' + k).value === v) && document.getElementById('body').value === '来不及等待防抖的临时正文。' && document.getElementById('f-mathjax').checked && document.getElementById('f-draft').checked`), '返回新建完整恢复标题、正文、文件名和全部属性');
    check(await eval_('document.querySelector("#editorTitle").textContent.startsWith("新建文章") && document.querySelector("#editorTitle").textContent.endsWith(" •") && document.querySelector("#btnPublish").hidden'), '恢复的是未保存新文章，不继承已有文章身份');
    await br.shot('categories-and-new.png');
    check((await tagOptions()).includes('独立自定义标签') && !(await tagOptions()).includes('临时'), '未保存的新文章标签不会提前进入已发布标签建议');
    await click('#btnSave');
    check(await br.waitFor('!document.querySelector("#editorTitle").textContent.endsWith(" •")'), '恢复的新文章可保存');
    const newPost = require('../src/frontmatter').parseFrontMatter(fs.readFileSync(path.join(blog, 'source/_drafts/临时新文章文件.md'), 'utf8'));
    check(newPost.data.categories[0] === 'life_article' && newPost.body.includes('临时正文'), 'life_article 与临时正文保存为独立新文件');
    check(['description', 'cover', 'top'].every(k => !Object.hasOwn(newPost.data, k)), '旧缓存仍可恢复，新文章不写入已移除的字段');
    await br.sleep(850);
    check(await eval_('localStorage.getItem("hexo-tool-cache:new") === null'), '保存成功清理新文章缓存，延迟任务不重新写回');
    await click('#btnNew');
    check(await eval_(cleanNew), '保存之后再次新建使用干净属性');
    await eval_(`(() => {
      document.querySelector('#f-name').value = '只填文件名的临时文章';
      document.querySelector('#f-name').dispatchEvent(new Event('input'));
      document.querySelector('#postlist li:has(input[aria-label="选择 在日常里，收集一点灵感"])').click();
    })()`);
    check(await br.waitFor('document.querySelector("#f-name").value === "写作日常"'), '只有文件名的新文章也可暂时离开');
    await click('#btnNew');
    check(await eval_('document.querySelector("#f-name").value === "只填文件名的临时文章" && document.querySelector("#body").value === ""'), '只编辑文件名也保留临时新文章');
    await br.send('Page.reload');
    check(await br.waitFor('document.querySelector("#f-name")?.value === "只填文件名的临时文章"'), '刷新可恢复没有标题正文的临时属性');
    await br.shot('properties-only-restored.png');
    const failure = path.join(OUT, 'failure.png');
    if (fs.existsSync(failure)) fs.unlinkSync(failure);
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed, screenshots: fs.readdirSync(OUT).filter(f => f.endsWith('.png')) }, null, 2));
    console.log(`\n${passed.length} 项通过；截图：${OUT}`);
  } catch (e) {
    if (br) {
      await br.shot('failure.png');
      console.error(await br.evaluate('({ title: document.querySelector("#editorTitle")?.textContent, body: document.querySelector("#body")?.value, tags: document.querySelector("#f-tags")?.value, suggestions: [...(document.querySelector("#tagSuggestions")?.children || [])].map(o => o.dataset.tag), first: document.querySelector("#postlist li")?.textContent })'));
    }
    throw e;
  } finally {
    if (br) await br.close();
    const exited = new Promise(resolve => server.once('exit', resolve));
    if (server.exitCode === null) { server.kill(); await exited; }
    /* 兜底清 pid：server.kill() 不保证跑得到服务端的 exit 钩子（Windows 上是强杀），
       文件可能还在。这里同样走**改名**而不是删除 —— unlinkSync 会被删除守卫
       接管（抛错还是小事，实测过它会把进程阻塞住），而测试结果不该被清理动作绑架。 */
    const pidFile = path.join(ROOT, 'data', `.server-${PORT}.pid`);
    try {
      if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').split('\n')[0] === String(server.pid)) {
        fs.renameSync(pidFile, pidFile + '.stale');
      }
    } catch { /* 兜底而已，清不掉不影响结论 */ }
    // blog 是本次 mkdtemp 创建的独立目录，不含 junction 或真实博客引用。
    try { fs.rmSync(blog, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
