/* pdf-fixture.js —— 造一个最小但**真能用**的 1 页 PDF，给导入相关的测试当输入。
 *
 * 为什么手写而不用现成的 PDF：e2e 和界面验收都要一份"内容确定、体积极小"的样本。
 * 抽成公用文件是因为两个测试脚本都要它，复制一份迟早会跑偏。
 *
 * 三个要点：
 *   - 只放 ASCII。中文要嵌 CID 字体，那体量不该塞进测试文件里。
 *   - **xref 偏移是边拼边算的**，不是手写的死数字。写错偏移 pdf.js 会走"修复模式"，
 *     那测到的就不是正常解析路径了（而且我们会误以为解析器很宽容）。
 *   - 每条 xref 记录必须正好 20 字节（`%010d %05d n \n`），少一个空格都会歪。
 */
'use strict';

/** @param {string} text 页面上唯一的一行文字（会被 pdf.js 原样抽出来） */
function tinyPdf(text) {
  const parts = [], offsets = [];
  let size = 0;
  const push = (s) => { const b = Buffer.from(s, 'latin1'); parts.push(b); size += b.length; };
  const obj = (body) => { offsets.push(size); push(body); };
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  push('%PDF-1.4\n');
  obj('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
  obj('2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n');
  obj('3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>\nendobj\n');
  obj('4 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n');
  obj(`5 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`);
  const xref = size;
  let x = 'xref\n0 6\n0000000000 65535 f \n';
  for (const o of offsets) x += String(o).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

module.exports = { tinyPdf };
