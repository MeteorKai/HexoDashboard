/* mdkeys.js —— Markdown 编辑快捷键的**纯逻辑**部分
 *
 * 只做"一段文本 + 一个选区 + 一个动作 → 新文本 + 新选区"的换算，
 * 一个 DOM API 都不碰。好处有两个：
 *   1. 能在 node 里直接 require 跑单测（tests/mdkeys.test.js），不用起浏览器；
 *   2. 键盘事件怎么接、改完怎么塞回 textarea 是 editor.js 的事 —— 那边关心
 *      撤销栈和输入法，这边只关心"字符变成什么样"。
 *
 *   node -e "console.log(require('./web/mdkeys').SHORTCUTS.length)"
 *
 * 设计上坚持的三条：
 *   · **可切换（toggle）**：每个动作按第二次都能还原。用户按错了不该自己去删标记。
 *   · **整行语义**：块级动作（标题/列表/引用/缩进）作用在"选区覆盖到的整行"上，
 *     光标停在一行中间也算整行 —— 按 Ctrl+1 只给光标后面那半行加 # 不合常理。
 *     但**光标模式**下改完只挪光标、不选中整行：否则用户按完 Ctrl+1 接着打字
 *     会把整行吃掉。
 *   · **不破坏上下文**：选区末尾正好落在换行符上时，不能把下一行也算进来
 *     （拖选"一整行"时末尾必然带一个 \n，算进来会多动一行）。
 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MdKeys = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {

  /* ── 行区间 ────────────────────────────────────────────────────────── */
  /** 选区覆盖到的**整行**在全文里的 [from, to)。 */
  function lineRange(text, start, end) {
    let e = Math.min(end, text.length);
    /* 选区末尾正好停在换行符上：那是"选到了这一行的末尾"，下一行不该被卷进来。
       不减掉的话拖选三行会得到四行，缩进/列表就会多动一行。 */
    if (e > start && text[e - 1] === '\n') e -= 1;
    if (e < start) e = start;
    const from = text.lastIndexOf('\n', start - 1) + 1;   // start=0 时得到 0
    let to = text.indexOf('\n', e);
    if (to < 0) to = text.length;
    return { from, to };
  }

  /* ── 各种行前缀的识别 ──────────────────────────────────────────────── */
  /** 标题：`#{1,6} `。七个 # 不是标题（CommonMark），所以上限写死 6。 */
  const HASH = /^#{1,6}[ \t]+/;
  /** 无序列表：`- ` / `* ` / `+ `，允许前置缩进（嵌套列表） */
  const UL = /^([ \t]*)([-*+])[ \t]+/;
  /** 有序列表：`1. `，允许前置缩进 */
  const OL = /^([ \t]*)(\d+)\.[ \t]+/;
  /** 任务列表：`- [ ] ` / `- [x] ` */
  const TASK = /^([ \t]*)([-*+][ \t]+)\[[ xX]\][ \t]*/;
  /** 引用：`> `，允许前置缩进 */
  const QUOTE = /^([ \t]*)>[ \t]?/;

  /* 标题的三件套。level 不同是**替换**不是叠加：`## a` 按 Ctrl+1 要变成 `# a`，
     不是 `# ## a`。所以判定"已经是"时，是拿"换成目标标记后字符串不变"来比的。 */
  function heading(level) {
    const want = '#'.repeat(level) + ' ';
    return {
      has: (l) => HASH.test(l) && l.replace(HASH, want) === l,
      add: (l) => (HASH.test(l) ? l.replace(HASH, want) : want + l),
      del: (l) => l.replace(HASH, ''),
    };
  }

  /** 抹掉一行上所有块级标记（Ctrl+0 用）。
   *  顺序有讲究：任务列表要在普通列表之前处理，否则 `- [ ] a` 会被 UL 先吃掉
   *  前半截，剩下 `[ ] a`。 */
  function stripAll(line) {
    let l = line;
    if (TASK.test(l)) l = l.replace(TASK, '$1');
    l = l.replace(UL, '$1').replace(OL, '$1');
    if (HASH.test(l)) l = l.replace(HASH, '');
    /* 引用可以嵌套（`> > a`），要一层层扒干净 */
    while (QUOTE.test(l)) l = l.replace(QUOTE, '$1');
    return l.replace(/^[ \t]+/, '');
  }

  /** 抹掉行上已有的列表标记，保留缩进和正文。
   *  列表之间互转靠它（`* a`→`- a`、`- [ ] a`→`- a`、`- a`→`1. a`）：
   *  不先拆掉旧标记就会叠成 `- - [ ] a` / `1. - a` 这种废标记。
   *  顺序同 stripAll：任务列表必须排在普通列表前面。 */
  function listBase(line) {
    let l = line;
    if (TASK.test(l)) l = l.replace(TASK, '$1');
    return l.replace(UL, '$1').replace(OL, '$1');
  }

  /* 每个块级动作都是 { has, add, del } 三件套：
       has(line)   → 这一行现在是不是这个样子
       add(line,i) → 变成这个样子（i 是行号，有序列表生成序号要用）
       del(line)   → 取消这个样子 */
  const BLOCKS = {
    h1: heading(1), h2: heading(2), h3: heading(3),
    h4: heading(4), h5: heading(5), h6: heading(6),

    /* 引用：普通行加一层 `> `；已经带 `>` 的行按一次是取消一层。
       多行选区里"有的行有、有的行没有"时统一加深一层 —— 那种情况通常是
       想整段套进引用里。 */
    quote: {
      has: (l) => QUOTE.test(l),
      add: (l) => l.replace(/^[ \t]*/, (m) => m + '> '),
      del: (l) => l.replace(QUOTE, '$1'),
    },

    /* 任务列表也算一种列表，但 Ctrl+Shift+8 不该把 `- [ ] a` 当成"已经是列表"
       而跳过 —— 所以 has 里排除掉它，这样按 8 能把任务项转成普通列表项。 */
    ul: {
      has: (l) => UL.test(l) && !TASK.test(l),
      add: (l) => listBase(l).replace(/^[ \t]*/, (m) => m + '- '),
      del: (l) => l.replace(UL, '$1'),
    },

    /* 有序列表：多行时序号递增（1. 2. 3.），所以 add 用行号 i。 */
    ol: {
      has: (l) => OL.test(l),
      add: (l, i) => listBase(l).replace(/^[ \t]*/, (m) => m + (i + 1) + '. '),
      del: (l) => l.replace(OL, '$1'),
    },

    task: {
      has: (l) => TASK.test(l),
      add: (l) => listBase(l).replace(/^[ \t]*/, (m) => m + '- [ ] '),
      del: (l) => l.replace(TASK, '$1'),
    },

    /** 正文：把标题/引用/列表/任务这些块级标记全抹掉，回到纯段落。
        它的 has 恒为 false —— "取消"这个动作永远可执行，没有 toggle 回去的道理。 */
    plain: { has: () => false, add: stripAll, del: (l) => l },

    /* 缩进用两个空格，不用 Tab：markdown 里 4 空格缩进会被当成代码块，
       而我们开着 breaks，空格最可控；而且 Tab 在 textarea 里本来是"跳焦点"，
       我们另外劫持了它。 */
    indent: { has: () => false, add: (l) => '  ' + l, del: (l) => l },
    outdent: { has: () => false, add: (l) => l.replace(/^[ \t]{1,2}/, ''), del: (l) => l },
  };

  /* ── 块级动作：对选区覆盖的每一行做 toggle ─────────────────────────── */
  function applyBlock(text, start, end, spec) {
    const { from, to } = lineRange(text, start, end);
    const lines = text.slice(from, to).split('\n');
    /* toggle 判据是"**每一行**都已经是" —— 只要有一行不是就全部加上。
       半加半减会让多行选区变成一堆残缺标记，没法再 toggle 回来。 */
    const allOn = lines.every((l) => spec.has(l));
    const out = lines.map((l, i) => (allOn ? spec.del(l) : spec.add(l, i)));
    const body = out.join('\n');
    const next = text.slice(0, from) + body + text.slice(to);

    /* 选区模式：选中改动后的整块。这样连着按第二个快捷键（先列表再加粗）很顺手。 */
    if (start !== end) return { text: next, start: from, end: from + body.length };

    /* 光标模式：只挪光标，跟着它所在那一行的变化走。
       不这么做的话，按完 Ctrl+1 整行被选中，接着打字会把整行吃掉。 */
    const before = text.slice(from, start);
    const row = before.split('\n').length - 1;
    if (row >= out.length) {
      const at = Math.min(next.length, from + body.length);
      return { text: next, start: at, end: at };
    }
    let base = from;
    for (let i = 0; i < row; i++) base += out[i].length + 1;
    const col = start - from - (before.lastIndexOf('\n') + 1);
    const grew = out[row].length - lines[row].length;
    const c = Math.max(0, Math.min(out[row].length, col + Math.max(0, grew)));
    return { text: next, start: base + c, end: base + c };
  }

  /* ── 代码块：``` 围栏包裹 / 解开 ────────────────────────────────────── */
  /** 内容里自带 ``` 时改用 ~~~~ 围栏 —— 否则一包裹，里面的 ``` 就把块提前闭掉了。
      （同一条规则 pdfmd.js 里也有：转出来的代码块同样会避开 ```。） */
  function fenceFor(content) {
    return /^[ \t]*```/m.test(content) ? '~~~~' : '```';
  }

  /* ── 围栏块定位 ────────────────────────────────────────────────────────
   * 按 CommonMark 的配对规则扫全文：开围栏后，只有**同字符且不更短**的围栏行
   * 才是闭围栏；不同字符或更短的围栏行只是代码块的内容。
   * 必须扫全文而不是只看"选区那几行" —— 光标停在 ``` 那一行时，选区只有一行，
   * 看局部会以为它是普通行，于是又给围栏行套一层，套出 ~~~~/```/~~~~ 这种废结构。 */
  function fenceBlocks(text) {
    const out = [];
    let open = null;
    let off = 0;
    for (const line of text.split('\n')) {
      const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (m) {
        const ch = m[1][0], len = m[1].length;
        if (!open) open = { start: off, openEnd: off + line.length, ch, len };
        else if (ch === open.ch && len >= open.len) {
          out.push({ start: open.start, end: off + line.length, openEnd: open.openEnd, closeStart: off });
          open = null;
        }                                   // 配不上的围栏行属于代码内容，忽略
      }
      off += line.length + 1;
    }
    return out;
  }

  /** 光标 / 选区整个落在某个围栏块里 → 返回那个块，否则 null。 */
  function fenceBlockAt(text, start, end) {
    return fenceBlocks(text).find((b) => start >= b.start && end <= b.end) || null;
  }

  function applyCode(text, start, end) {
    /* 已经在围栏块里（光标停在围栏行上或代码内容里都算）→ 解开整块 */
    const fb = fenceBlockAt(text, start, end);
    if (fb) {
      const inner = text.slice(fb.openEnd + 1, Math.max(fb.openEnd, fb.closeStart - 1));
      const next = text.slice(0, fb.start) + inner + text.slice(fb.end);
      return { text: next, start: fb.start, end: fb.start + inner.length };
    }

    const { from, to } = lineRange(text, start, end);
    const block = text.slice(from, to);
    const fence = fenceFor(block);
    const wrapped = fence + '\n' + block + '\n' + fence;
    const next = text.slice(0, from) + wrapped + text.slice(to);
    /* 光标落在开围栏**之后**：那里是语言标注的位置，按完通常马上想打
       `go` / `bash`，要能直接覆盖输入，不用先挪光标。 */
    const at = from + fence.length;
    return { text: next, start: at, end: at };
  }

  /* ── 行内包裹：**粗体** / *斜体* / ~~删除线~~ / `代码` ───────────────── */
  function applyInline(text, start, end, marker) {
    const sel = text.slice(start, end);
    const n = marker.length;

    /* ① 选区自己就带着标记 → 去掉 */
    if (sel.length >= n * 2 && sel.startsWith(marker) && sel.endsWith(marker)) {
      const inner = sel.slice(n, sel.length - n);
      return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
    }
    /* ② 选区在标记**里面**（光标放进 `**abc**` 里选中 abc）→ 去掉外面那对。
        但要先排掉"被更长的标记包含"的情况：在 `**abc**` 里选中 abc 按 Ctrl+I
        （斜体 `*`），外面紧贴的其实是 `**`（粗体）的一部分 —— 这时候该做的是
        **加上**斜体变成 `***abc***`，而不是拆掉粗体。判据是"再往前一个字符
        还是同样的符号"，那就是更长的标记，别动它。 */
    const longerLeft = start >= n + 1 && text[start - n - 1] === marker[0];
    if (!longerLeft && start >= n && end + n <= text.length
      && text.slice(start - n, start) === marker && text.slice(end, end + n) === marker) {
      return {
        text: text.slice(0, start - n) + sel + text.slice(end + n),
        start: start - n, end: start - n + sel.length,
      };
    }
    /* ③ 否则加上。空选区时插一对空标记、光标放中间，接着打字就落在里面。 */
    return {
      text: text.slice(0, start) + marker + sel + marker + text.slice(end),
      start: start + n, end: start + n + sel.length,
    };
  }

  /* ── 链接 / 图片 ───────────────────────────────────────────────────── */
  /** `[选中](url)` —— 加完把 url 那一段**选中**，用户直接打字就覆盖掉占位符。
   *  没选东西时给出占位文字并把"链接文字"选中，同样可以直接覆盖。 */
  function applyLink(text, start, end, bang) {
    const sel = text.slice(start, end);
    const label = sel || (bang ? '图片描述' : '链接文字');
    const url = 'url';
    const head = (bang ? '![' : '[') + label + '](';
    const next = text.slice(0, start) + head + url + ')' + text.slice(end);
    const uFrom = start + head.length;
    if (sel) return { text: next, start: uFrom, end: uFrom + url.length };
    const lFrom = start + (bang ? 2 : 1);
    return { text: next, start: lFrom, end: lFrom + label.length };
  }

  /* ── 插入型：分割线 / 表格 ──────────────────────────────────────────── */
  /** 两者都插在**当前行之前**，并保证前后各有一个空行。
      空行不是排版洁癖：`abc\n---\ndef` 里的 `---` 会被 markdown 当成
      `abc` 的 setext 二级标题，插了等于没插。 */
  function insertBlockBefore(text, start, end, payload) {
    const { from } = lineRange(text, start, end);
    const before = text.slice(0, from);
    const lead = !before ? ''
      : before.endsWith('\n\n') ? ''
        : before.endsWith('\n') ? '\n' : '\n\n';
    const insert = lead + payload + '\n\n';
    const next = text.slice(0, from) + insert + text.slice(from);
    return { text: next, start: from + lead.length, end: from + lead.length + payload.length };
  }

  /* 表格给三列：写起来够用，改起来也快（选中整块模板，直接覆盖即可） */
  const TABLE_TPL = [
    '| 列 1 | 列 2 | 列 3 |',
    '| --- | --- | --- |',
    '| 内容 | 内容 | 内容 |',
  ].join('\n');

  const applyHr = (t, s, e) => insertBlockBefore(t, s, e, '---');
  const applyTable = (t, s, e) => insertBlockBefore(t, s, e, TABLE_TPL);

  /* ── 回车自动续列表 ─────────────────────────────────────────────────── */
  /** 在列表项末尾按回车时，下一行自动带上同样的标记，不用手打 `- `。
   *
   *  返回 null → 这里不该接管回车（交给浏览器插普通换行）；
   *  返回 { endList:true, from, to } → 用户是在**空列表项**上按回车，
   *      意思是"列表写完了"，该把这一行的标记删掉、退回普通段落；
   *  返回 { insert, from, to } → 在光标处插入这段（含开头的 \n）。
   *
   *  只在**光标位于行尾**时接管：光标在行中间按回车是要把一项拆成两项，
   *  这时候插标记会把后半截变成孤立的列表项，反而添乱。 */
  function continueOnEnter(text, caret) {
    const { from, to } = lineRange(text, caret, caret);
    if (caret !== to) return null;                 // 光标不在行尾 → 不接管
    const line = text.slice(from, to);

    const task = TASK.exec(line);
    if (task) {
      if (!line.slice(task[0].length).trim()) return { endList: true, from, to };
      return { insert: '\n' + task[1] + '- [ ] ', from, to };
    }
    const ol = OL.exec(line);
    if (ol) {
      if (!line.slice(ol[0].length).trim()) return { endList: true, from, to };
      /* 序号递增：3. 后面回车是 4. */
      return { insert: '\n' + ol[1] + ((parseInt(ol[2], 10) || 0) + 1) + '. ', from, to };
    }
    const ul = UL.exec(line);
    if (ul) {
      if (!line.slice(ul[0].length).trim()) return { endList: true, from, to };
      /* 保留原来的符号：`* a` 回车还是 `* `，不强行改成 `- ` */
      return { insert: '\n' + ul[1] + ul[2] + ' ', from, to };
    }
    const q = QUOTE.exec(line);
    if (q) {
      if (!line.slice(q[0].length).trim()) return { endList: true, from, to };
      return { insert: '\n' + q[1] + '> ', from, to };
    }
    return null;
  }

  /* ── 动作总表 ───────────────────────────────────────────────────────── */
  const ACTIONS = {
    h1: (t, s, e) => applyBlock(t, s, e, BLOCKS.h1),
    h2: (t, s, e) => applyBlock(t, s, e, BLOCKS.h2),
    h3: (t, s, e) => applyBlock(t, s, e, BLOCKS.h3),
    h4: (t, s, e) => applyBlock(t, s, e, BLOCKS.h4),
    h5: (t, s, e) => applyBlock(t, s, e, BLOCKS.h5),
    h6: (t, s, e) => applyBlock(t, s, e, BLOCKS.h6),
    plain: (t, s, e) => applyBlock(t, s, e, BLOCKS.plain),
    quote: (t, s, e) => applyBlock(t, s, e, BLOCKS.quote),
    ul: (t, s, e) => applyBlock(t, s, e, BLOCKS.ul),
    ol: (t, s, e) => applyBlock(t, s, e, BLOCKS.ol),
    task: (t, s, e) => applyBlock(t, s, e, BLOCKS.task),
    indent: (t, s, e) => applyBlock(t, s, e, BLOCKS.indent),
    outdent: (t, s, e) => applyBlock(t, s, e, BLOCKS.outdent),
    code: applyCode,
    bold: (t, s, e) => applyInline(t, s, e, '**'),
    italic: (t, s, e) => applyInline(t, s, e, '*'),
    strike: (t, s, e) => applyInline(t, s, e, '~~'),
    codeInline: (t, s, e) => applyInline(t, s, e, '`'),
    link: (t, s, e) => applyLink(t, s, e, false),
    image: (t, s, e) => applyLink(t, s, e, true),
    hr: applyHr,
    table: applyTable,
  };

  /** 唯一入口。返回 {text,start,end}，或 null（不支持这个动作）。 */
  function apply(action, text, start, end) {
    const fn = ACTIONS[action];
    if (!fn) return null;
    const s = Math.max(0, Math.min(start == null ? 0 : start, text.length));
    const e = Math.max(s, Math.min(end == null ? s : end, text.length));
    return fn(text, s, e);
  }

  /* ── 快捷键表：界面上的速查面板和键盘监听共用同一份 ─────────────────────
   * 为什么用 e.code（物理键位）而不是 e.key：中文输入法打开时 keydown 的
   * e.key 会变成 'Process' 或某个中文字符，Ctrl+1 直接失灵；而 e.code 是
   * 'Digit1'，不受输入法和键盘布局影响。代价是"按键上印的符号"换了布局就对不上，
   * 但对 Ctrl+数字 这类组合，用户按的是位置，用 code 更符合直觉。
   *
   * 刻意避开这几个浏览器会抢在页面之前、preventDefault 拦不住的组合：
   *   Ctrl+U（查看源码）、Ctrl+Shift+T（恢复标签页）、Ctrl+Shift+I（开发者工具）、
   *   Ctrl+Shift+R（强制刷新）、Ctrl+W / Ctrl+N / Ctrl+T（标签页与窗口）。
   *
   * 剩下没躲开的（Ctrl+1..6 切标签页、Ctrl+0 重置缩放、Ctrl+K 跳地址栏、
   * Ctrl+Shift+K 火狐的 Web 控制台、Ctrl+Shift+M Chrome 切换用户）仍然登记在表里：
   * 一是用户点名要的就是 Ctrl+1 / Ctrl+Shift+K，二是浏览器换版本或开成独立
   * 应用窗口时这些键位是能到页面的。真被抢走时，把 Ctrl 换成 Alt 按同样的键即可
   * （见 match()），速查面板里也写着这条。 */
  const SHORTCUTS = [
    { code: 'Digit1', ctrl: true, shift: false, action: 'h1', keys: 'Ctrl 1', label: '一级标题' },
    { code: 'Digit2', ctrl: true, shift: false, action: 'h2', keys: 'Ctrl 2', label: '二级标题' },
    { code: 'Digit3', ctrl: true, shift: false, action: 'h3', keys: 'Ctrl 3', label: '三级标题' },
    { code: 'Digit4', ctrl: true, shift: false, action: 'h4', keys: 'Ctrl 4', label: '四级标题' },
    { code: 'Digit5', ctrl: true, shift: false, action: 'h5', keys: 'Ctrl 5', label: '五级标题' },
    { code: 'Digit6', ctrl: true, shift: false, action: 'h6', keys: 'Ctrl 6', label: '六级标题' },
    { code: 'Digit0', ctrl: true, shift: false, action: 'plain', keys: 'Ctrl 0', label: '正文（去掉标题等标记）' },

    { code: 'KeyB', ctrl: true, shift: false, action: 'bold', keys: 'Ctrl B', label: '加粗' },
    { code: 'KeyI', ctrl: true, shift: false, action: 'italic', keys: 'Ctrl I', label: '斜体' },
    { code: 'KeyX', ctrl: true, shift: true, action: 'strike', keys: 'Ctrl Shift X', label: '删除线' },
    { code: 'Backquote', ctrl: true, shift: true, action: 'codeInline', keys: 'Ctrl Shift `', label: '行内代码' },
    { code: 'KeyK', ctrl: true, shift: false, action: 'link', keys: 'Ctrl K', label: '链接' },
    { code: 'KeyM', ctrl: true, shift: true, action: 'image', keys: 'Ctrl Shift M', label: '图片' },

    { code: 'KeyK', ctrl: true, shift: true, action: 'code', keys: 'Ctrl Shift K', label: '代码块' },
    { code: 'KeyQ', ctrl: true, shift: true, action: 'quote', keys: 'Ctrl Shift Q', label: '引用' },
    { code: 'Digit8', ctrl: true, shift: true, action: 'ul', keys: 'Ctrl Shift 8', label: '无序列表' },
    { code: 'Digit7', ctrl: true, shift: true, action: 'ol', keys: 'Ctrl Shift 7', label: '有序列表' },
    { code: 'Digit9', ctrl: true, shift: true, action: 'task', keys: 'Ctrl Shift 9', label: '任务列表' },
    { code: 'KeyU', ctrl: true, shift: true, action: 'hr', keys: 'Ctrl Shift U', label: '分割线' },
    { code: 'KeyE', ctrl: true, shift: true, action: 'table', keys: 'Ctrl Shift E', label: '表格' },

    { code: 'Tab', ctrl: false, shift: false, action: 'indent', keys: 'Tab', label: '缩进' },
    { code: 'Tab', ctrl: false, shift: true, action: 'outdent', keys: 'Shift Tab', label: '反缩进' },
  ];

  /** 从键盘事件里查出对应动作。查不到返回 null（交给浏览器默认行为）。
   *  macOS 上用 Cmd（metaKey）代替 Ctrl —— 和页面里 Ctrl+S 的处理保持一致。
   *
   *  **Alt 是 Ctrl 的等价替身**：Ctrl+1（一级标题）、Ctrl+K（链接）这些
   *  在 Chrome / Edge 里是浏览器自己的键位（切标签页、跳地址栏），浏览器
   *  抢在页面之前就拿走了，preventDefault 拦不住。与其为每个动作背两套键位，
   *  不如统一允许"把 Ctrl 换成 Alt 按同样的键"：Alt+1、Alt+K 一样生效，
   *  而且 Alt+字母/数字在所有主流浏览器里都是空的。 */
  function match(e) {
    if (!e) return null;
    const code = e.code || '';
    const mod = !!(e.ctrlKey || e.metaKey);
    const alt = !!e.altKey;
    /* 一个修饰键都没有时只有 Tab 归我们管，别去动方向键、回车、字母这些 */
    if (!mod && !alt && code !== 'Tab') return null;
    if ((mod || alt) && !code) return null;   // 拿不到物理键位就不猜，免得乱触发
    const shift = !!e.shiftKey;
    const hit = SHORTCUTS.find((s) => s.code === code && s.shift === shift && (alt || s.ctrl === mod));
    return hit ? hit.action : null;
  }

  return {
    apply, match, continueOnEnter, lineRange, stripAll, fenceFor,
    fenceBlocks, fenceBlockAt,
    SHORTCUTS, ACTIONS, TABLE_TPL,
  };
});
