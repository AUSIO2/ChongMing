// DSH 集成测试工具：记录运行与调用时间，提供可控制延迟的确定性证据。
import { appendFile, readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'verification-evidence-fixture'
export const inject = ['tools']

export async function apply(/* DSH 插件注册事件和测试工具所使用的运行时上下文。 */ ctx) {
  // 注册确定性证据工具并记录运行时身份，供测试核对多个 Host 是否独立执行。
  await appendFile(process.env.CHONGMING_E2E_RUNTIME_LOG, JSON.stringify({ event: 'runtime-start', pid: process.pid, hostId: process.env.CHONGMING_HOST_ID }) + '\n')
  ctx.on('agent/error', (/* 发生错误的 Agent 会话及其未归一化失败原因。 */ { agent, error }) => {
    // 把 Agent 错误和所属进程、会话写入测试日志，便于定位运行失败。
    appendFileSync(process.env.CHONGMING_E2E_RUNTIME_LOG, JSON.stringify({ event: 'agent-error', pid: process.pid,
      hostId: process.env.CHONGMING_HOST_ID, sessionId: agent.id, error: error instanceof Error ? error.stack : String(error) }) + '\n')
  })
  ctx.tools.register(defineTool({
    name: 'archive_lookup',
    description: 'Read deterministic primary evidence from the local verification fixture.',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (/* 工具渲染器未使用的原始参数对象。 */ _args, /* 需要转换为模型可读 JSON 文本的工具结果。 */ value) => /* 将确定性证据对象渲染为模型可读的 JSON 文本。 */ [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => /* 声明此测试工具允许并行执行，以验证不同工作槽位能重叠运行。 */ true,
    async execute(/* 模型传入、用于生成确定性证据标记的查询字符串。 */ { query }, /* 提供当前 Agent 身份和取消信号的工具执行上下文。 */ exec) {
      // 记录调用起止，可等待第二个 Host 到达并接受取消，最后返回带固定标记的证据。
      const base = { pid: process.pid, sessionId: exec.agent.id, hostId: process.env.CHONGMING_HOST_ID, query }
      await appendFile(process.env.CHONGMING_E2E_TOOL_LOG, JSON.stringify({ ...base, event: 'start', at: Date.now() }) + '\n')
      const deadline = Date.now() + 10000
      while (process.env.CHONGMING_E2E_OVERLAP === '1') {
        const records = (await readFile(process.env.CHONGMING_E2E_TOOL_LOG, 'utf8')).trim().split('\n').map(/* 工具调用日志中的单行 JSON 记录。 */ line => /* 解析每条调用日志，以观察其他 Host 的到达情况。 */ JSON.parse(line))
        if (new Set(records.filter(/* 当前判断是否为开始事件的工具日志记录。 */ record => /* 只保留工具开始执行事件，避免结束事件干扰重叠判定。 */ record.event === 'start').map(/* 开始事件中当前提取 Host 身份的日志记录。 */ record => /* 提取参与执行的 Host 身份，确认至少两个独立 Host 同时到达。 */ record.hostId)).size >= 2) break
        if (Date.now() >= deadline) throw new Error('A second Host never reached its independent evidence slot')
        await delay(20, undefined, { signal: exec.signal })
      }
      await delay(Number(process.env.CHONGMING_E2E_TOOL_DELAY_MS ?? 150), undefined, { signal: exec.signal })
      const evidence = { source: `archive:${query}`, score: 1, marker: 'custom-tool-executed' }
      await appendFile(process.env.CHONGMING_E2E_TOOL_LOG, JSON.stringify({ ...base, event: 'end', at: Date.now(), evidence }) + '\n')
      return evidence
    },
  }))
}
