'use strict';
/* mdkeys 是纯函数模块（不碰 DOM），所以能在 node 里直接跑。
   这里覆盖的是"按下去文本变成什么样"，键盘事件与撤销栈归 editor.js/浏览器。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../web/mdkeys.js');

/** 便捷断言：apply(action, text, [start, end]) → 只比 text（多数用例不关心选中区） */
function txt(action, text, s, e) {
  const r = M.apply(action, text, s == null ? 0 : s, e == null ? (s == null ? 0 : s) : e);
  assert.ok(r, '未知动作：' + action);
  return r.text;
}
/** 光标放在下标 c 处 */
const at = (action, text, c) => txt(action, text, c, c);

/* ── 1. 标题 ─────────────────────────────────────────────────────────── */
test('光标停在一行中间按 Ctrl+1，整行变标题（不是只给后半截加 #）', () => {
  assert.equal(at('h1', 'hello world', 3), '# hello world');
});
test('再按一次还原：标题是 toggle', () => {
  const once = at('h1', 'hello world', 3);
  assert.equal(at('h1', once, 3), 'hello world');
});
test('换级别是替换不是叠加：## a 按 Ctrl+1 得到 # a', () => {
  assert.equal(at('h1', '## a', 0), '# a');
  assert.equal(at('h3', '# a', 0), '### a');
});
test('光标跟着走：加 # 后仍停在同一列的文字上', () => {
  const r = M.apply('h1', 'hello world', 3, 3);
  assert.equal(r.text, '# hello world');
  assert.equal(r.start, 5);                       // 原第 3 列 → 多了两个字符的前缀
});
test('多行选区：每一行都变标题', () => {
  assert.equal(txt('h2', 'a\nb\nc', 0, 5), '## a\n## b\n## c');
});
test('多行：只要有一行不是标题就全部加上', () => {
  assert.equal(txt('h2', '## a\nb\n## c', 0, 11), '## a\n## b\n## c');
});
test('多行：全是标题时一起取消', () => {
  assert.equal(txt('h2', '## a\n## b', 0, 9), 'a\nb');
});
test('选区末尾带换行符时不会把下一行卷进来', () => {
  assert.equal(txt('h2', 'a\nzzz', 0, 2), '## a\nzzz');
});

/* ── 2. 正文 / 列表 / 引用 / 任务 ─────────────────────────────────────── */
test('Ctrl+0 一次抹掉标题、引用、列表、任务所有块级标记', () => {
  assert.equal(at('plain', '## a', 0), 'a');
  assert.equal(at('plain', '> a', 0), 'a');
  assert.equal(at('plain', '- a', 0), 'a');
  assert.equal(at('plain', '- [x] a', 0), 'a');
  assert.equal(at('plain', '1. a', 0), 'a');
  assert.equal(at('plain', '> > a', 0), 'a');          // 嵌套引用一层层扒
});
test('任务列表不会被 Ctrl+0 留下一半（`- [ ] a` 不能剩 `[ ] a`）', () => {
  assert.equal(at('plain', '- [ ] a', 0), 'a');
});
test('有序列表多行时序号递增', () => {
  assert.equal(txt('ol', 'a\nb\nc', 0, 5), '1. a\n2. b\n3. c');
});
test('无序列表：普通行加 `- `，已经是列表则取消', () => {
  assert.equal(at('ul', 'plain', 0), '- plain');
  assert.equal(at('ul', '- a', 0), 'a');
  assert.equal(at('ul', '* a', 0), 'a');
});
test('任务列表转普通列表：Ctrl+Shift+8 不把它当成"已经是列表"而跳过', () => {
  assert.equal(at('ul', '- [ ] a', 0), '- a');
  assert.equal(at('ul', '- [x] a', 0), '- a');
});
test('列表互转不叠标记（不能出现 `- - [ ] a` / `1. - a`）', () => {
  assert.equal(at('ul', '1. a', 0), '- a');
  assert.equal(at('ol', '- a', 0), '1. a');
  assert.equal(at('ol', '- [ ] a', 0), '1. a');
  assert.equal(at('task', '1. a', 0), '- [ ] a');
  assert.equal(at('task', '- a', 0), '- [ ] a');
});
test('引用：普通行加一层，已是引用则取消一层', () => {
  assert.equal(at('quote', 'a', 0), '> a');
  assert.equal(at('quote', '> a', 0), 'a');
  assert.equal(at('quote', '> > a', 0), '> a');
});
test('引用：多行全是引用时一起取消', () => {
  assert.equal(txt('quote', '> a\n> b', 0, 7), 'a\nb');
});
test('引用：多行里有的行不带 > 时整段套进引用', () => {
  assert.equal(txt('quote', '> a\nb', 0, 5), '> > a\n> b');
});

/* ── 3. 缩进 ─────────────────────────────────────────────────────────── */
test('缩进是整行两个空格，反缩进吃掉最多两个空格', () => {
  assert.equal(at('indent', 'a', 0), '  a');
  assert.equal(at('outdent', '    a', 0), '  a');
  assert.equal(at('outdent', 'a', 0), 'a');
});
test('多行缩进每一行都动', () => {
  assert.equal(txt('indent', 'a\nb', 0, 3), '  a\n  b');
});

/* ── 4. 代码块 ───────────────────────────────────────────────────────── */
test('Ctrl+Shift+K 用围栏包起来，光标停在语言标注位置', () => {
  const r = M.apply('code', 'go version', 0, 0);
  assert.equal(r.text, '```\ngo version\n```');
  assert.equal(r.start, 3);                       // 开围栏之后，接着打 go 就能直接覆盖
});
test('再按一次解开围栏', () => {
  const r = M.apply('code', '```\ngo version\n```', 0, 0);
  assert.equal(r.text, 'go version');
});
test('带语言标注的围栏也能解开', () => {
  assert.equal(txt('code', '```go\nfmt.Println()\n```', 0, 0), 'fmt.Println()');
});
test('内容里自带 ``` 时改用 ~~~~ 围栏，否则里面的 ``` 会把块提前闭掉', () => {
  const src = 'a\n```\nx\n```\nb';
  const r = M.apply('code', src, 0, src.length);
  assert.equal(r.text.split('\n')[0], '~~~~');
  assert.equal(r.text.split('\n').pop(), '~~~~');
});
test('普通内容仍然用 ```（不要一刀切改成 ~~~~）', () => {
  assert.equal(txt('code', 'abc', 0, 3).split('\n')[0], '```');
});
test('相邻两个代码块各自独立配对，不会交叉（上一个"两个代码块合并"的 bug 就出在这）', () => {
  const src = '```\na\n```\n```\nb\n```';
  const blocks = M.fenceBlocks(src);
  assert.equal(blocks.length, 2);
  assert.equal(src.slice(blocks[0].openEnd + 1, blocks[0].closeStart - 1), 'a');
  assert.equal(src.slice(blocks[1].openEnd + 1, blocks[1].closeStart - 1), 'b');
});
test('围栏按字符配对：~~~~ 里的 ``` 不算闭合', () => {
  assert.equal(M.fenceBlocks('~~~~\n```\nx\n~~~~').length, 1);
});
test('光标停在闭合围栏行上按 Ctrl+Shift+K 也是解开（不该再套一层）', () => {
  const src = '```\na\n```';
  assert.equal(txt('code', src, src.length, src.length), 'a');
  assert.equal(txt('code', src, 0, 0), 'a');
  assert.equal(txt('code', src, 5, 5), 'a');              // 光标在代码内容里
});
test('fenceFor 与 pdfmd 的规则一致：只有行首出现 ``` 才换围栏', () => {
  assert.equal(M.fenceFor('x ``` y'), '```');
  assert.equal(M.fenceFor('```\nx'), '~~~~');
});

/* ── 5. 行内标记 ─────────────────────────────────────────────────────── */
test('加粗：选中加标记，选中已有标记则去掉', () => {
  assert.equal(txt('bold', 'abc', 0, 3), '**abc**');
  assert.equal(txt('bold', '**abc**', 0, 7), 'abc');
});
test('选区在标记内部（光标放进 **abc** 里选中 abc）也能去掉外层', () => {
  assert.equal(txt('bold', '**abc**', 2, 5), 'abc');
});
test('**abc** 里选中 abc 按 Ctrl+I 是加斜体成 ***abc***，不是拆掉粗体', () => {
  assert.equal(txt('italic', '**abc**', 2, 5), '***abc***');
});
test('空选区插一对空标记，光标落在中间', () => {
  const r = M.apply('bold', '', 0, 0);
  assert.equal(r.text, '****');
  assert.equal(r.start, 2);
});
test('删除线与行内代码各自独立 toggle', () => {
  assert.equal(txt('strike', 'abc', 0, 3), '~~abc~~');
  assert.equal(txt('strike', '~~abc~~', 0, 7), 'abc');
  assert.equal(txt('codeInline', 'abc', 0, 3), '`abc`');
  assert.equal(txt('codeInline', '`abc`', 0, 5), 'abc');
});

/* ── 6. 链接 / 图片 ──────────────────────────────────────────────────── */
test('Ctrl+K 有选区时把 url 选中，直接打字就覆盖', () => {
  const r = M.apply('link', 'Hexo', 0, 4);
  assert.equal(r.text, '[Hexo](url)');
  assert.equal(r.text.slice(r.start, r.end), 'url');
});
test('Ctrl+K 无选区时给出占位文字并选中它', () => {
  const r = M.apply('link', '', 0, 0);
  assert.equal(r.text, '[链接文字](url)');
  assert.equal(r.text.slice(r.start, r.end), '链接文字');
});
test('Ctrl+Shift+M 走图片语法（前面一个 !）', () => {
  const r = M.apply('image', '', 0, 0);
  assert.equal(r.text, '![图片描述](url)');
  assert.equal(r.text.slice(r.start, r.end), '图片描述');
});

/* ── 7. 分割线 / 表格 ────────────────────────────────────────────────── */
test('分割线插在当前行之前，且保证前面有空行（否则 --- 会变成 setext 标题）', () => {
  assert.equal(at('hr', 'abc', 1), '---\n\nabc');
  assert.equal(at('hr', 'x\nabc', 3), 'x\n\n---\n\nabc');
  assert.equal(at('hr', 'x\n\nabc', 4), 'x\n\n---\n\nabc');   // 已经有空行就不再加
});
test('表格是三列模板，同样带空行', () => {
  assert.equal(at('table', 'abc', 0), M.TABLE_TPL + '\n\nabc');
  assert.equal(M.TABLE_TPL.split('\n').length, 3);
});

/* ── 8. 回车续列表 ───────────────────────────────────────────────────── */
test('列表项末尾回车自动带上下一个 -', () => {
  assert.deepEqual(M.continueOnEnter('- a', 3), { insert: '\n- ', from: 0, to: 3 });
});
test('有序列表序号递增', () => {
  assert.deepEqual(M.continueOnEnter('3. a', 4), { insert: '\n4. ', from: 0, to: 4 });
});
test('保留原符号：`* a` 回车还是 `*`', () => {
  assert.deepEqual(M.continueOnEnter('* a', 3).insert, '\n* ');
});
test('任务列表续出来的是未勾选项', () => {
  assert.deepEqual(M.continueOnEnter('- [x] a', 7).insert, '\n- [ ] ');
});
test('引用续行', () => {
  assert.deepEqual(M.continueOnEnter('> a', 3).insert, '\n> ');
});
test('空列表项上回车 = 退出列表', () => {
  assert.deepEqual(M.continueOnEnter('- ', 2), { endList: true, from: 0, to: 2 });
  assert.deepEqual(M.continueOnEnter('- [ ] ', 6).endList, true);
  assert.deepEqual(M.continueOnEnter('> ', 2).endList, true);
});
test('光标不在行尾 / 不是列表行时都不接管（交给浏览器插普通换行）', () => {
  assert.equal(M.continueOnEnter('- abc', 2), null);
  assert.equal(M.continueOnEnter('plain', 5), null);
  assert.equal(M.continueOnEnter('', 0), null);
});
test('嵌套列表的缩进被保留', () => {
  assert.deepEqual(M.continueOnEnter('  - a', 5).insert, '\n  - ');
});

/* ── 9. 键位映射 ─────────────────────────────────────────────────────── */
test('用户点名的两个快捷键必须存在：Ctrl+1 一级标题、Ctrl+Shift+K 代码块', () => {
  const one = M.SHORTCUTS.find(s => s.code === 'Digit1' && s.ctrl && !s.shift);
  assert.ok(one); assert.equal(one.action, 'h1'); assert.equal(one.label, '一级标题');
  const k = M.SHORTCUTS.find(s => s.code === 'KeyK' && s.ctrl && s.shift);
  assert.ok(k); assert.equal(k.action, 'code'); assert.equal(k.label, '代码块');
});
test('match 用 e.code 认键：输入法打开时 e.key 会变成 Process，靠 key 会失灵', () => {
  assert.equal(M.match({ code: 'Digit1', ctrlKey: true, shiftKey: false }), 'h1');
  assert.equal(M.match({ code: 'KeyK', ctrlKey: true, shiftKey: true }), 'code');
  assert.equal(M.match({ code: 'Tab', ctrlKey: false, shiftKey: false }), 'indent');
  assert.equal(M.match({ code: 'Tab', ctrlKey: false, shiftKey: true }), 'outdent');
});
test('macOS 上 Cmd 等价于 Ctrl', () => {
  assert.equal(M.match({ code: 'KeyB', metaKey: true, shiftKey: false }), 'bold');
});
test('Alt 是 Ctrl 的等价替身：浏览器抢走 Ctrl+1 / Ctrl+K 时换成 Alt 一样能触发', () => {
  assert.equal(M.match({ code: 'Digit1', altKey: true, shiftKey: false }), 'h1');
  assert.equal(M.match({ code: 'Digit0', altKey: true, shiftKey: false }), 'plain');
  assert.equal(M.match({ code: 'KeyK', altKey: true, shiftKey: false }), 'link');
  assert.equal(M.match({ code: 'KeyK', altKey: true, shiftKey: true }), 'code');
});
test('Alt 替身保留 Shift 的语义，不会串到别的动作', () => {
  assert.equal(M.match({ code: 'Digit7', altKey: true, shiftKey: true }), 'ol');
  assert.equal(M.match({ code: 'Digit7', altKey: true, shiftKey: false }), null);   // 没有 Alt+7 这条
  assert.equal(M.match({ code: 'KeyB', altKey: true, shiftKey: false }), 'bold');
});
test('没有修饰键时只有 Tab 归我们管，方向键/回车/字母不抢', () => {
  assert.equal(M.match({ code: 'KeyB', ctrlKey: false, shiftKey: false }), null);
  assert.equal(M.match({ code: 'Enter', ctrlKey: false }), null);
  assert.equal(M.match({ code: 'ArrowDown' }), null);
  assert.equal(M.match({ code: 'Tab', ctrlKey: true, shiftKey: false }), null);
});
test('不占用浏览器抢不回来的组合（Ctrl+U / Ctrl+Shift+T、I、R / Ctrl+W、N、T）', () => {
  const banned = [
    { code: 'KeyU', ctrl: true, shift: false }, { code: 'KeyT', ctrl: true, shift: true },
    { code: 'KeyI', ctrl: true, shift: true }, { code: 'KeyR', ctrl: true, shift: true },
    { code: 'KeyW', ctrl: true, shift: false }, { code: 'KeyN', ctrl: true, shift: false },
    { code: 'KeyT', ctrl: true, shift: false },
  ];
  for (const b of banned) {
    assert.equal(M.SHORTCUTS.filter(s => s.code === b.code && s.ctrl === b.ctrl && s.shift === b.shift).length, 0,
      '撞了浏览器保留键：' + b.code);
  }
});
test('键位表没有重复组合（否则 match 只会命中第一条，另一条永远按不出来）', () => {
  const seen = new Set();
  for (const s of M.SHORTCUTS) {
    const k = s.code + '|' + s.ctrl + '|' + s.shift;
    assert.ok(!seen.has(k), '重复键位：' + s.keys);
    seen.add(k);
  }
});
test('键位表里每个 action 都有实现', () => {
  for (const s of M.SHORTCUTS) assert.ok(M.ACTIONS[s.action], '没有实现的动作：' + s.action);
  for (const a of Object.keys(M.ACTIONS)) {
    assert.ok(M.SHORTCUTS.some(s => s.action === a), '没有任何键位能触发：' + a);
  }
});
test('apply 对越界下标有容错（不会写出 NaN 或截断字符串）', () => {
  assert.equal(txt('h1', 'abc', 99, 99), '# abc');
  assert.equal(txt('bold', 'abc', -5, 99), '**abc**');
});
test('未知动作返回 null', () => {
  assert.equal(M.apply('nope', 'abc', 0, 0), null);
});
