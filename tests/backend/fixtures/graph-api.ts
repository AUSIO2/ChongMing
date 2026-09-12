import { randomUUID } from 'node:crypto'
import { apiCreateServer } from '../../../backend/api'
import { applicationCreateService } from '../../../backend/application'
import { storeCreateConnection } from '../../../backend/store'
import type { ContextField, GraphNodeData, GraphRunConfiguration, GraphWorkGrant } from '../../../contracts/graph'
import type { AgentInput, PromptKind } from '../../../contracts/control'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { expect } from 'vitest'
import { verificationConfiguration } from './verification'

export function grantHeaders(grant: GraphWorkGrant) {
  return { 'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence) }
}

export async function createGraphApi(leaseMs = 60_000, seedConfiguration = verificationConfiguration()) {
  const token = 'test-work-token'
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const uri = mongo.getUri('chongming_work_test')
  const connection = await storeCreateConnection(uri)
  const application = applicationCreateService(connection, { leaseMs })
  await application.initialize()
  const { store, auth, control } = application
  await control.seed(seedConfiguration)
  const owner = await auth.createUser({ id: randomUUID(), displayName: 'Fixture Owner', hostAdmin: true })
  const { token: userToken } = await auth.createToken(owner.userId)
  const server = apiCreateServer(application, { internalToken: token })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test Graph API did not bind')
  const url = `http://127.0.0.1:${address.port}`

  async function rawPost(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return rawPost(path, body, { ...(path.startsWith('/api/v1/') ? { authorization: `Bearer ${userToken}` } : {}), ...headers })
  }
  function command(method: string, params: unknown, requestId = randomUUID()) {
    return post('/api/v1/command', { requestId, method, params })
  }
  async function snapshot(mapId: string) {
    const result = await post('/api/v1/query', { method: 'map.get', params: { mapId } })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  function work(method: string, params: unknown) {
    return post('/internal/v1/work', { method, params }, { authorization: `Bearer ${token}` })
  }
  async function claim(mapId: string, hostId = 'test-host', holderId = randomUUID()): Promise<GraphWorkGrant | null> {
    const result = await work('claim', { mapId, hostId, holderId })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  async function read(grant: GraphWorkGrant) {
    const result = await post('/internal/v1/data/read', { mapId: grant.mapId, operationId: grant.operationId }, {
      authorization: `Bearer ${token}`, ...grantHeaders(grant),
    })
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    return result.body.data
  }
  function propose(grant: GraphWorkGrant, proposal: unknown) {
    return post('/internal/v1/data/propose', proposal, { authorization: `Bearer ${token}`, ...grantHeaders(grant) })
  }
  async function proposal(grant: GraphWorkGrant, input: Record<string, unknown>) {
    const data = await read(grant)
    return {
      mapId: grant.mapId, operationId: grant.operationId, id: data.proposalId,
      ...(input.kind === 'route' ? {} : { routeRevision: data.route.revision }),
      ...(input.kind === 'report' && grant.actor.role === 'worker' ? { slotId: grant.actor.slotId } : {}),
      ...input,
    }
  }
  async function createWorkspace(configuration: GraphRunConfiguration = verificationConfiguration()) {
    const profile = (input: GraphRunConfiguration['router'], kind: PromptKind, promptPath: string): AgentInput => ({
      ...input, id: randomUUID(), kind, promptPath, promptVars: input.promptVars ?? [],
      defaultPriority: input.defaultPriority ?? 'medium', claimCategory: input.claimCategory ?? null,
    })
    const agents = [profile(configuration.router, 'verifyRoute', 'fact-verifier/main-agent-route'),
      profile(configuration.merger, 'verifyMerge', 'fact-verifier/main-agent-merge'),
      ...configuration.agents.map(agent => profile(agent, 'verifySubAgent', `fact-verifier/sub-agents/${agent.id}`))]
    return auth.transact(userToken, async ctx => {
      const bootstrap = await control.read(ctx, { method: 'app.bootstrap', params: {} }) as { settings: { revision: number } }
      await control.dispatch(ctx, { requestId: randomUUID(), method: 'settings.update', params: {
        expectedRevision: bootstrap.settings.revision,
        llm: { provider: configuration.router.provider, model: configuration.router.model },
        tools: configuration.tools, limits: { maxAgentSlots: configuration.maxSlots },
      } })
      return control.createWorkspace(ctx, { id: randomUUID(), name: 'Fixture workspace', description: '', agentSource: 'empty' }, agents)
    })
  }
  async function createRun(mode: 'auto' | 'human-in-loop' = 'auto', configuration = verificationConfiguration(),
    news?: { content: string; context: Record<string, ContextField> }) {
    const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
    const workspace = await createWorkspace(configuration)
    expect(await command('map.create', {
      workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Dynamic verification',
    })).toMatchObject({ status: 201 })
    const nodes: Array<{ id: string; data: GraphNodeData }> = [{ id: claimId, data: { kind: 'claim', content: 'Fixture claim', category: 'data' } }]
    const newsId = randomUUID()
    if (news) nodes.push({ id: newsId, data: { kind: 'news', ...news } })
    expect(await command('graph.apply', { mapId, expectedRevision: 0,
      changes: { nodes: { put: nodes }, ...(news ? { edges: { put: [{ id: randomUUID(), kind: 'mentions', from: newsId, to: claimId }] } } : {}) },
    })).toMatchObject({ status: 200 })
    const result = await command('run.start', { mapId, expectedRevision: 1, id: runId, targetId: claimId, mode })
    expect(result).toMatchObject({ status: 200, body: { data: { snapshot: { run: { id: runId, status: 'running' } } } } })
    return { mapId, claimId, runId, workspaceId: workspace.id,
      operationId: result.body.data.snapshot.run.operation.id as string,
      configuration: result.body.data.snapshot.run.configuration as GraphRunConfiguration }
  }
  async function answer(mapId: string, decision: 'approve' | 'reject' = 'approve') {
    const current = await snapshot(mapId)
    const review = current.run.operation.review
    const body = { requestId: randomUUID(), method: 'review.answer', params: {
      mapId, expectedRevision: current.revision, runId: current.run.id, reviewId: review.id,
      expectedReviewRevision: review.revision, decision,
    } }
    const result = await post('/api/v1/command', body)
    expect(result.status).toBe(200)
    return { body, snapshot: result.body.data.snapshot }
  }
  return {
    url, token, userToken, owner, application, auth, control, server, store, connection, mongo, uri,
    post, rawPost, command, snapshot, work, claim, read, propose, proposal, createWorkspace, createRun, answer,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await connection.close()
      await mongo.stop()
    },
  }
}

export type TestGraphApi = Awaited<ReturnType<typeof createGraphApi>>

export function proof(grant: GraphWorkGrant) {
  return { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence }
}

export function expectRejected(result: Awaited<ReturnType<TestGraphApi['post']>>) {
  expect(result.status).toBeGreaterThanOrEqual(400)
  expect(result.status).toBeLessThan(500)
  expect(result.body).toMatchObject({ ok: false, error: { code: expect.any(String) } })
}
