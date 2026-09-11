import path from 'node:path'
import { parseArgs } from 'node:util'
import { dshRunVerification } from './dsh-verify'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'map-id': { type: 'string' },
      'operation-id': { type: 'string' },
      'session-id': { type: 'string' },
      'data-api': { type: 'string' },
      'dsh-home': { type: 'string' },
      patch: { type: 'string', multiple: true },
      'max-rounds': { type: 'string' },
    },
  })
  if (!values['map-id'] || !values['operation-id']) {
    throw new Error('Usage: node --import tsx backend/dsh-verify-cli.ts --map-id ID --operation-id ID [--patch trusted-tools.patch.yml]')
  }
  const result = await dshRunVerification({
    mapId: values['map-id'],
    operationId: values['operation-id'],
    rootSessionId: values['session-id'],
    dataApiUrl: values['data-api'] ?? process.env.CHONGMING_DATA_API ?? 'http://127.0.0.1:4320',
    token: process.env.CHONGMING_DATA_TOKEN ?? '',
    dshHome: path.resolve(values['dsh-home'] ?? process.env.CHONGMING_DSH_HOME ?? '.dsh-runtime'),
    patches: values.patch?.map(patch => path.resolve(patch)),
    maxRounds: values['max-rounds'] ? Number(values['max-rounds']) : undefined,
  })
  console.log(JSON.stringify(result, null, 2))
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
