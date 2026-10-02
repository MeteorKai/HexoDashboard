/* 单元测试：把 stdout 字节流切成一行行的缓冲逻辑（含跨 chunk 半行、CRLF、ANSI 转义）。
 *
 *   node tests/buffer-check.js
 *
 * 被测逻辑与 server.js 里 runStep 的 pipe() 完全一致——之所以要单独测，
 * 是因为 hexo 的输出经常把一行拆在两个 chunk 里到达（尤其 Windows 上），
 * 直接按 chunk 打日志会出现"半行 + 半行"错位。
 */
'use strict';
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');

// —— 被测逻辑：与 server.js 中 runStep 的 pipe() 保持一致 ——
function pipe(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    for (const line of parts) if (line.trim()) onLine(line.replace(/\u001b\[[0-9;]*m/g, ''), false);
  });
  stream.on('end', () => { if (buf.trim()) onLine(buf.trim(), false); });
}

const out = [];
const s = new PassThrough();
const done = new Promise((resolve) => {
  s.on('end', resolve);
  pipe(s, (line) => out.push(line));
});

/** 手动逐块喂数据：模拟 Node 真实的分块到达顺序 */
(async () => {
  const chunks = [
    'INFO  Hexo is runn',                                    // 半行
    'ning\r\n\x1b[32mINFO\x1b[0m  Generated: 38 files\n\n',  // 补齐上一行 + 一行 + 空行
    'WARN  no layout',                                       // 结尾没有换行符
  ];
  for (const c of chunks) {
    s.write(c);
    await new Promise((r) => setImmediate(r));   // 让 'data' 先派发，再写下一条
  }
  s.end();
  await done;

  const expect = [
    'INFO  Hexo is runnning',      // chunk1('runn') + chunk2 开头的 'ning'，被正确拼接
    'INFO  Generated: 38 files',
    'WARN  no layout',             // 结尾无换行的半行也在 end 时被吐出
  ];
  const pass = JSON.stringify(out) === JSON.stringify(expect);
  const report = [
    '实际: ' + JSON.stringify(out),
    '期望: ' + JSON.stringify(expect),
    pass ? '行缓冲逻辑通过 ✅' : '行缓冲逻辑失败 ❌',
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'buffer-check.out'), report + '\n', 'utf8');
  process.stdout.write(report + '\n');
  process.exit(pass ? 0 : 1);
})();
