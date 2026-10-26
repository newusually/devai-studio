/* 引擎冒烟测试：验证 OpenClaw agent-core 循环在 dev-ai 里真实可跑
 * 场景：用户提问 → 模型调 echo 工具 → 结果回灌 → 模型给最终文本 → 循环终止
 */
const path = require('path');
const { Agent } = require(path.join('F:/dev-ai/dist/main/engine/agent-core/index.js'));
const { createAssistantMessageEventStream } = require(path.join('F:/dev-ai/dist/main/engine/llm-core/index.js'));
const { Type } = require('typebox');

const MODEL = {
  id: 'qwen3:8b', name: 'qwen3:8b', provider: 'ollama', api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:11434/v1', contextWindow: 32768, maxTokens: 4096,
};

let callCount = 0;
const streamFn = (model, context) => {
  const stream = createAssistantMessageEventStream();
  callCount += 1;
  const n = callCount;
  queueMicrotask(() => {
    if (n === 1) {
      // 第一轮：发起工具调用
      stream.push({ type: 'toolcall_start', contentIndex: 0, id: 'call_1', name: 'echo' });
      stream.push({ type: 'toolcall_delta', contentIndex: 0, argsDelta: '{"text":"引擎循环验证通过"}' });
      stream.push({ type: 'toolcall_end', contentIndex: 0 });
      stream.push({
        type: 'done', reason: 'toolUse',
        message: {
          role: 'assistant', stopReason: 'toolUse', timestamp: Date.now(),
          content: [{ type: 'toolCall', id: 'call_1', name: 'echo', arguments: { text: '引擎循环验证通过' } }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
                   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      });
    } else {
      // 第二轮：基于工具结果给最终答复
      stream.push({ type: 'text_delta', contentIndex: 0, delta: '工具返回：' });
      stream.push({
        type: 'done', reason: 'stop',
        message: {
          role: 'assistant', stopReason: 'stop', timestamp: Date.now(),
          content: [{ type: 'text', text: '工具返回：引擎循环验证通过。OpenClaw 引擎已在 DevAI Studio 内真实运行。' }],
          usage: { input: 30, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 42,
                   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      });
    }
    stream.end();
  });
  return stream;
};

const tools = [{
  name: 'echo',
  label: '回显',
  description: '原样返回传入的文本',
  parameters: Type.Object({ text: Type.String() }),
  execute: async (id, args) => ({
    content: [{ type: 'text', text: args.text }],
    details: { echoed: args.text },
  }),
}];

(async () => {
  const agent = new Agent({
    initialState: { systemPrompt: '你是 DevAI Studio 的引擎测试助手。', model: MODEL, tools },
    streamFn,
  });

  const events = [];
  agent.subscribe((event) => { events.push(event.type); });

  console.log('===== 启动 prompt =====');
  await agent.prompt('请用 echo 工具验证引擎循环');
  console.log('prompt 完成，模型调用轮次:', callCount);

  const msgs = agent.state.messages;
  console.log(' transcript 消息数:', msgs.length);
  for (const m of msgs) {
    const c = Array.isArray(m.content)
      ? m.content.map(b => b.type === 'text' ? `text("${(b.text || '').slice(0, 40)}")`
          : b.type === 'toolCall' ? `toolCall(${b.name})` : b.type).join(',')
      : String(m.content).slice(0, 40);
    console.log(`  [${m.role}] ${c}`);
  }

  const toolResults = msgs.filter(m => m.role === 'toolResult');
  const finalText = msgs.filter(m => m.role === 'assistant')
    .flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(b => b.type === 'text').map(b => b.text).join('');

  console.log('\n===== 断言 =====');
  const a1 = callCount === 2;                       // 两轮：工具调用 + 最终答复
  const a2 = toolResults.length === 1;              // 工具执行过且结果回灌
  const a3 = toolResults[0] && toolResults[0].content.some(b => (b.text || '').includes('引擎循环验证通过'));
  const a4 = finalText.includes('OpenClaw 引擎已在 DevAI Studio 内真实运行');
  const a5 = events.includes('tool_execution_start') || events.some(e => e.startsWith('tool'));
  console.log('① 两轮循环（工具+答复）:', a1 ? 'PASS' : 'FAIL');
  console.log('② 工具结果回灌:', a2 ? 'PASS' : 'FAIL');
  console.log('③ 工具返回内容正确:', a3 ? 'PASS' : 'FAIL');
  console.log('④ 最终答复生成:', a4 ? 'PASS' : 'FAIL');
  console.log('⑤ 工具执行事件:', a5 ? 'PASS' : 'FAIL', '| 事件序列:', [...new Set(events)].join(','));
  const allPass = a1 && a2 && a3 && a4 && a5;
  console.log('\n总结:', allPass ? '全部通过 ✅ 引擎可用' : '存在失败 ❌');
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error('运行异常:', e); process.exit(2); });
