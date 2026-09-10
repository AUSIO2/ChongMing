import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'chongming-data-tools'
export const inject = ['tools']

const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

async function call(path, body, signal) {
  const baseUrl = process.env.CHONGMING_DATA_API ?? 'http://127.0.0.1:4320'
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const result = await response.json()
  if (!response.ok || result.ok !== true) {
    throw new Error(result.error?.message ?? `Data API returned ${response.status}`)
  }
  return result.data
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'data_read',
    description: 'Read the Claim, existing reports, and Review for one assigned verification operation.',
    parameters: {
      mapId: { type: 'string', required: true },
      operationId: { type: 'string', required: true },
    },
    output,
    execute: (args, exec) => call('/internal/v1/data/read', args, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'data_propose',
    description: 'Submit one structured verification report for an assigned operation and slot.',
    parameters: {
      mapId: { type: 'string', required: true },
      operationId: { type: 'string', required: true },
      report: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          slotId: { type: 'string', required: true },
          score: { type: 'number', required: true, enum: [0, 0.5, 1] },
          reason: { type: 'string', required: true },
        },
      },
    },
    output,
    execute: (args, exec) => call('/internal/v1/data/propose', args, exec.signal),
  }))
}
