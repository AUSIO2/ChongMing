// 只读审计复现：隔离回环HTTP，无用户数据库、外网和受审文件写入。
import { randomUUID } from 'node:crypto'
import graphHttp from '../../backend/adapters/http/graph-http-server.ts'
import type { ApplicationService } from '../../backend/application/graph-application.ts'
import diagnosticHttp from '../../backend/adapters/http/dsh-diagnostic-server.ts'
import type { DshRuntimeAPI } from '../../contracts/dsh.ts'
import migration from '../../backend/adapters/storage/branch-migration.ts'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import configuration from '../../apps/config/local-settings.ts'

const { apiCreateServer } = graphHttp
const { dshHttpCreateServer } = diagnosticHttp
const received: unknown[] = []
const app = {
  graph: {},
  read: async (_token: string, query: unknown) => { received.push(query); return query },
  dispatch: async (_token: string, command: unknown) => { received.push(command); return { data: command, replayed: false } },
} as unknown as ApplicationService
const server = apiCreateServer(app)
const listen = async (target: typeof server) => {
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
  const address = target.address()
  if (!address || typeof address === 'string') throw new Error('Expected owned loopback port')
  return `http://127.0.0.1:${address.port}`
}
const close = async (target: typeof server) => {
  target.closeAllConnections()
  await new Promise<void>((resolve, reject) => target.close(error => error ? reject(error) : resolve()))
}
const originalKeys = Object.keys
const seen = new WeakMap<object, number>()
const envelopeVisits: Array<{ method: string; count: number }> = []
Object.keys = ((value: object) => {
  const result = originalKeys(value)
  if (value && typeof value === 'object' && 'method' in value && 'params' in value) {
    const count = (seen.get(value) ?? 0) + 1
    seen.set(value, count)
    envelopeVisits.push({ method: String((value as { method: unknown }).method), count })
  }
  return result
}) as typeof Object.keys

try {
  const base = await listen(server)
  for (const [path, body] of [
    ['/api/v1/query', { method: 'app.bootstrap', params: {} }],
    ['/api/v1/query', { method: 'evidence.get', params: { workspaceId: randomUUID(), entryId: randomUUID() } }],
    ['/api/v1/command', { requestId: randomUUID(), method: 'workspace.create', params: { id: randomUUID(), name: 'Audit', description: '', agentSource: 'empty' } }],
    ['/api/v1/command', { requestId: randomUUID(), method: 'asset.delete', params: { assetId: randomUUID(), expectedSha256: 'a'.repeat(64) } }],
  ] as const) {
    const response = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer audit-only' }, body: JSON.stringify(body) })
    await response.arrayBuffer()
  }
  const bytes = Buffer.concat([
    Buffer.from(JSON.stringify({ requestId: randomUUID(), method: 'map.rename', params: { mapId: randomUUID(), expectedRevision: 0, name: 'START' } }).replace('START', '')),
  ])
  const empty = Buffer.from('"name":""')
  const index = bytes.indexOf(empty) + Buffer.byteLength('"name":"')
  const invalid = Buffer.concat([bytes.subarray(0, index), Buffer.from([0xff]), bytes.subarray(index)])
  const response = await fetch(base + '/api/v1/command', { method: 'POST', headers: { authorization: 'Bearer audit-only' }, body: invalid })
  const body = await response.json()
  console.log(JSON.stringify({ case: 'actual-http-envelope-visits', visits: envelopeVisits }, null, 2))
  console.log(JSON.stringify({ case: 'invalid-utf8-http-command', sentByte: 255, status: response.status, decodedName: body.data?.params?.name, applicationReceived: (received.at(-1) as { params?: { name?: string } })?.params?.name }, null, 2))
} finally {
  Object.keys = originalKeys
  await close(server)
}

const diagnosticRuntime: DshRuntimeAPI = {
  start: async () => {}, close: async () => {},
  run: async input => ({ sessionId: 'audit', finalResponse: input.prompt, events: [] }),
}
const diagnostic = dshHttpCreateServer(diagnosticRuntime)
try {
  const base = await listen(diagnostic as typeof server)
  const body = Buffer.concat([Buffer.from('{"prompt":"'), Buffer.from([0xff]), Buffer.from('"}')])
  const response = await fetch(base + '/runtime/dsh/run', { method: 'POST', body })
  console.log(JSON.stringify({ case: 'invalid-utf8-diagnostic-prompt', status: response.status, response: await response.text() }, null, 2))
} finally { await close(diagnostic as typeof server) }

for (const value of [undefined, null, 0, '', false]) {
  const source = new AbortController()
  source.abort(value)
  const signal = AbortSignal.any([source.signal])
  console.log(JSON.stringify({ case: 'abort-reason-domain', input: value, aborted: signal.aborted, reasonIsNull: signal.reason === null, reasonIsUndefined: signal.reason === undefined }))
}

const { migrationPlanBranchGraph } = migration
const time = '2026-09-01T00:00:00.000Z'
const report = { id: 'audit-report', slotId: 'slot', agentId: 'agent', agentName: 'Agent', angle: '', tools: [], routeRevision: 0, score: 1, reason: 'Audit', createdAt: time }
const reportIds = [report.id]
const raw = {
  _id: 'audit-map', workspaceId: 'audit-workspace', revision: 0, name: 'Audit migration',
  nodes: [
    { id: 'claim', revision: 0, data: { kind: 'claim', content: 'Audit claim', category: null }, createdAt: time, updatedAt: time },
    { id: 'verification', revision: 0, data: { kind: 'verification', score: 1, reason: 'Audit', reportIds, opinions: [report] }, createdAt: time, updatedAt: time },
  ],
  edges: [{ id: 'edge', revision: 0, kind: 'verifies', from: 'verification', to: 'claim', createdAt: time, updatedAt: time }],
  runs: [], runHistory: [], leases: {}, receipts: [], createdAt: time, updatedAt: time,
}
const originalArrayIsArray = Array.isArray
let sameReportArrayChecks = 0
Array.isArray = ((value: unknown) => {
  if (value === reportIds) sameReportArrayChecks++
  return originalArrayIsArray(value)
}) as typeof Array.isArray
try {
  const plan = migrationPlanBranchGraph(raw, Date.parse('2026-10-01T00:00:00.000Z'))
  console.log(JSON.stringify({ case: 'migration-same-reportIds-array-checks', status: plan.status, sameReportArrayChecks, sourceUnchanged: JSON.stringify(raw.nodes[1].data.reportIds) === '["audit-report"]' }))
} finally { Array.isArray = originalArrayIsArray }

for (const id of ['ordinary-node', '__proto__']) {
  const producer = { operationId: 'legacy-operation', marker: 'must-retain' }
  const graph = { ...raw, nodes: [{ ...raw.nodes[0], id, producer }], edges: [] }
  const plan = migrationPlanBranchGraph(graph, Date.parse('2026-10-01T00:00:00.000Z'))
  console.log(JSON.stringify({ case: 'migration-producer-dictionary', id, status: plan.status, sourceProducer: graph.nodes[0].producer,
    migratedProducer: plan.status === 'migrate' ? plan.document.migration : undefined }))
}

const ownedDirectory = fileURLToPath(new URL('./runtime-repro-config/', import.meta.url))
const previousDirectory = process.env.CHONGMING_CONFIG_DIR
try {
  await mkdir(ownedDirectory)
  await writeFile(`${ownedDirectory}/settings.json`, Buffer.concat([Buffer.from('{"dshHome":"'), Buffer.from([0xff]), Buffer.from('"}')]))
  process.env.CHONGMING_CONFIG_DIR = ownedDirectory
  console.log(JSON.stringify({ case: 'invalid-utf8-local-settings', configuration: await configuration.localReadConfiguration() }))
} finally {
  if (previousDirectory === undefined) delete process.env.CHONGMING_CONFIG_DIR
  else process.env.CHONGMING_CONFIG_DIR = previousDirectory
  await rm(ownedDirectory, { recursive: true, force: true })
}
