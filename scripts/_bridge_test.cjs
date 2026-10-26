/* 桥接层集成测试：真实 dev-ai Agent + 真实 ToolBox + mock provider
 * 验证：引擎循环跑通、工具经引擎执行、patch 提案生成、UI 事件齐全
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'devai-bridge-'));
fs.writeFileSync(path.join(WS, 'hello.txt'), 'original content\n');

const { Agent } = require('F:/dev-ai/dist/main/agents/agent.js');
const { ToolBox } = require('F:/dev-ai/dist/main/agents/tools.js');

/* mock provider：第一轮返回 write_file 工具调用（文本 JSON），第二轮返回总结 */
let round = 0;
const mockProvider = {
  kind: 'ollama',
  name: 'mock',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3:8b',
  probe: async () => ({ ok: true, message: 'mock' }),
  listModels: async () => [],
  chat: async (req) => {
    round += 1;
    const full = '```json\n{"tool":"write_file","args":{"path":"hello.txt","content":"modified by engine\\n"}}\n```';
    const content = round === 1 ? full : '已把 hello.txt 改成 "modified by engine"。';
    // 模拟流式
    for (const ch of content) req.onToken?.(ch);
    return { content, model: 'qwen3:8b', provider: 'ollama', durationMs: 1 };
  },
};
const mockRegistry = {
  create: () => mockProvider,
  resolveModel: async () => 'qwen3:8b',
};

(async () => {
  const events = [];
  const tools = new ToolBox(WS);
  const agent = new Agent({
    registry: mockRegistry,
    tools,
    workspace: WS,
    emit: (e) => events.push(e),
  });

  const result = await agent.run('s1', [], '把 hello.txt 的内容改成 modified by engine', new AbortController().signal);

  console.log('===== 运行结果 =====');
  console.log('最终内容:', JSON.stringify(result.content));
  console.log('错误:', result.error || '(无)');
  console.log('patch:', result.patch ? `${result.patch.title} | risk=${result.patch.risk} | changes=${result.patch.changes.length}` : '(无)');
  console.log('模型调用轮次:', round);

  console.log('\n===== 事件序列 =====');
  console.log(events.map(e => e.type).join(', '));

  console.log('\n===== 文件是否真被改 =====');
  const after = fs.readFileSync(path.join(WS, 'hello.txt'), 'utf8');
  console.log('hello.txt 现在内容:', JSON.stringify(after));

  console.log('\n===== 断言 =====');
  const a1 = !result.error;
  const a2 = round === 2;                                    // 引擎驱动了两轮
  const a3 = !!result.patch && result.patch.changes[0].path === 'hello.txt';
  const a4 = result.patch?.changes[0].before === 'original content\n';
  const a5 = after === 'modified by engine\n';                // 文件真被写
  const a6 = events.some(e => e.type === 'tool' && e.toolCall.name === 'write_file');
  const a7 = events.some(e => e.type === 'tool_result');
  const a8 = events.some(e => e.type === 'patch');
  const a9 = events.some(e => e.type === 'end');
  console.log('① 无错误:', a1 ? 'PASS' : 'FAIL');
  console.log('② 引擎两轮循环:', a2 ? 'PASS' : 'FAIL');
  console.log('③ patch 提案生成:', a3 ? 'PASS' : 'FAIL');
  console.log('④ patch 含改前内容:', a4 ? 'PASS' : 'FAIL');
  console.log('⑤ 文件真实写入:', a5 ? 'PASS' : 'FAIL');
  console.log('⑥ tool 事件:', a6 ? 'PASS' : 'FAIL');
  console.log('⑦ tool_result 事件:', a7 ? 'PASS' : 'FAIL');
  console.log('⑧ patch 事件:', a8 ? 'PASS' : 'FAIL');
  console.log('⑨ end 事件:', a9 ? 'PASS' : 'FAIL');
  const all = [a1, a2, a3, a4, a5, a6, a7, a8, a9].every(Boolean);
  console.log('\n总结:', all ? '全部通过 ✅ 桥接层可用' : '存在失败 ❌');

  fs.rmSync(WS, { recursive: true, force: true });
  process.exit(all ? 0 : 1);
})().catch(e => { console.error('运行异常:', e); process.exit(2); });
