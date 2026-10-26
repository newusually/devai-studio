/* ============================================================================
 * scripts/e2e.js —— 端到端功能实测（走真实主进程 + 真实 Ollama 模型）
 * 用法: electron scripts/e2e.js
 * ========================================================================== */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const wait = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'shots');

// 直接起主进程（它自己会开窗口），我们另开一个探针窗口
process.env.DEFAI_E2E = '1';

app.whenReady().then(async () => {
  await wait(3500);

  // 复用主进程已经开好的窗口（main/index.js 会自己建窗口）
  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) { console.error('[E2E] 主进程没有窗口'); app.exit(1); return; }
  const win = wins[0];
  await wait(1500);

  const api = (fn, ...args) => win.webContents.executeJavaScript(
    `window.api.${fn}(${args.map(a => JSON.stringify(a)).join(',')})`
  );

  const log = (k, v) => console.log(`[E2E] ${k} = ${JSON.stringify(v)}`);

  /* ① 应用信息 */
  const info = await api('appInfo()');
  log('appInfo', { version: info.version, electron: info.electron, node: info.node, provider: info.provider.kind, model: info.provider.model });

  /* ② Provider 探测 */
  const probes = await api('model.probe()');
  log('probes', probes.map(p => `${p.kind}:${p.ok ? 'OK' : 'NO'}`).join(' '));

  /* ③ 角色列表 */
  const roles = await api('role.list()');
  log('roles', { count: roles.length, names: roles.map(r => r.icon + r.name).join(' ') });

  /* ④ 创建会话 + 发消息（真实调用本地模型） */
  const sess = await api('session.create()', 'E2E 测试会话');
  log('session', { id: sess.id, title: sess.title });

  console.log('[E2E] 发送测试消息（真实调用 qwen3:4b，首次较慢）…');
  const t0 = Date.now();
  let reply = '';
  // 订阅流式事件
  await win.webContents.executeJavaScript(`
    window.__chunks = [];
    window.api.chat.onStream(e => {
      if (e.type === 'token') window.__chunks.push(e.text);
      if (e.type === 'tool') window.__tool = e.toolCall;
      if (e.type === 'tool_result') window.__toolRes = e.toolResult;
      if (e.type === 'end') window.__ended = true;
      if (e.type === 'error') window.__err = e.error;
    });
    true;
  `);

  const chatPromise = api('chat.send()', sess.id, '用一句话说明什么是闭包（closure）');
  // 最多等 180 秒
  let done = false;
  for (let i = 0; i < 180; i++) {
    await wait(1000);
    const st = await win.webContents.executeJavaScript(
      `({ ended: !!window.__ended, err: window.__err, len: (window.__chunks||[]).join('').length })`
    );
    if (st.ended || st.err) { done = true; break; }
    if (i % 15 === 14) console.log(`[E2E]   ...${i + 1}s 已收 ${st.len} 字符`);
  }
  const res = await chatPromise;
  const chunks = await win.webContents.executeJavaScript(`window.__chunks || []`);
  reply = chunks.join('');
  console.log(`[E2E] 回复长度=${reply.length} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s 结束=${done}`);
  console.log(`[E2E] 回复前 300 字：\n${reply.slice(0, 300)}`);
  console.log(`[E2E] chat.send 返回：${JSON.stringify({ ok: res?.ok, error: res?.error, model: res?.usage?.model })}`);

  /* ⑤ 静态分析（不消耗模型额度） */
  const diag = await api('analyze.workspace()');
  log('analyze', { count: diag.count, sample: (diag.diagnostics || []).slice(0, 3).map(d => `${d.file}:${d.line} ${d.message}`) });

  /* ⑥ 自动学习 */
  const mem = await api('memory.get()');
  log('memory', { sessions: mem.memory?.stats?.sessions, entries: mem.memory?.entries?.length, langs: mem.memory?.profile?.languages });

  /* ⑦ 短视频脚本（真实模型） */
  console.log('[E2E] 测试短视频脚本生成…');
  const vid = await api('video.script()', '用 Python 写一个快速排序');
  if (vid.ok) {
    log('video.script', { title: vid.script.title, scenes: vid.script.scenes.length, tags: vid.script.tags.length });
    const gen = await api('video.generate()', vid.script, 'e2e-test');
    log('video.generate', { ok: gen.ok, msg: gen.message, files: (gen.files || []).length, mp4: gen.mp4 || '(无 ffmpeg)' });
  } else {
    log('video.script', { ok: false, error: vid.error });
  }

  /* ⑧ 会话持久化验证 */
  const detail = await api('session.get()', sess.id);
  log('session.get', { messages: detail?.messages?.length, hasModel: !!detail?.messages?.[1]?.model });

  await win.webContents.capturePage().then(img => {
    fs.writeFileSync(path.join(OUT, '06-e2e.png'), img.toPNG());
  });

  console.log('[E2E] DONE');
  app.exit(0);
}).catch(e => {
  console.error('[E2E] FATAL', e);
  app.exit(1);
});
