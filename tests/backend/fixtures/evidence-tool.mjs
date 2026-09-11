import { appendFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'verification-evidence-fixture'
export const inject = ['tools']

export async function apply(ctx) {
  await appendFile(process.env.CHONGMING_E2E_RUNTIME_LOG, JSON.stringify({ pid: process.pid }) + '\n')
  ctx.tools.register(defineTool({
    name: 'archive_lookup',
    description: 'Read deterministic primary evidence from the local verification fixture.',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute({ query }, exec) {
      const evidence = { source: `archive:${query}`, score: 1, marker: 'custom-tool-executed' }
      await appendFile(process.env.CHONGMING_E2E_TOOL_LOG, JSON.stringify({ sessionId: exec.agent.id, query, evidence }) + '\n')
      return evidence
    },
  }))
}
