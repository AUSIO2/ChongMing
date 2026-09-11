import { appendFile, readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'verification-evidence-fixture'
export const inject = ['tools']

export async function apply(ctx) {
  await appendFile(process.env.CHONGMING_E2E_RUNTIME_LOG, JSON.stringify({ event: 'runtime-start', pid: process.pid, hostId: process.env.CHONGMING_HOST_ID }) + '\n')
  ctx.on('agent/error', ({ agent, error }) => {
    appendFileSync(process.env.CHONGMING_E2E_RUNTIME_LOG, JSON.stringify({ event: 'agent-error', pid: process.pid,
      hostId: process.env.CHONGMING_HOST_ID, sessionId: agent.id, error: error instanceof Error ? error.stack : String(error) }) + '\n')
  })
  ctx.tools.register(defineTool({
    name: 'archive_lookup',
    description: 'Read deterministic primary evidence from the local verification fixture.',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute({ query }, exec) {
      const base = { pid: process.pid, sessionId: exec.agent.id, hostId: process.env.CHONGMING_HOST_ID, query }
      await appendFile(process.env.CHONGMING_E2E_TOOL_LOG, JSON.stringify({ ...base, event: 'start', at: Date.now() }) + '\n')
      const deadline = Date.now() + 10000
      while (process.env.CHONGMING_E2E_OVERLAP === '1') {
        const records = (await readFile(process.env.CHONGMING_E2E_TOOL_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        if (new Set(records.filter(record => record.event === 'start').map(record => record.hostId)).size >= 2) break
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
