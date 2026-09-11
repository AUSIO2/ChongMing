import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authCreateService } from '../../backend/auth'
import { createGraphApi, type TestGraphApi } from './fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi() }, 30_000)
afterAll(async () => { await api?.close() })

async function user(name: string, hostAdmin = false) {
  const identity = await api.auth.createUser({ id: randomUUID(), displayName: name, hostAdmin })
  return { ...identity, ...await api.auth.createToken(identity.userId) }
}

function as(token: string, path: 'query' | 'command', body: unknown) {
  return api.rawPost(`/api/v1/${path}`, body, { authorization: `Bearer ${token}` })
}

async function makeMap() {
  const workspace = await api.createWorkspace()
  const mapId = randomUUID(), claimId = randomUUID()
  expect((await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Private graph' })).status).toBe(201)
  expect((await api.command('graph.apply', { mapId, expectedRevision: 0,
    changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'Private claim', category: null } }] } },
  })).status).toBe(200)
  return { workspaceId: workspace.id, mapId, claimId }
}

async function member(workspaceId: string, userId: string, role: 'editor' | 'viewer' | null) {
  const workspace = await api.post('/api/v1/query', { method: 'workspace.get', params: { workspaceId } })
  const result = await api.command('member.set', { workspaceId, expectedRevision: workspace.body.data.revision, userId, role })
  expect(result.status).toBe(200)
  return result
}

function pauseAuthorizationRead(collectionName: string, id: string) {
  const prototype = Object.getPrototypeOf(api.connection.db!.collection(collectionName))
  const original = prototype.findOne
  let armed = true, enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const resumed = new Promise<void>(resolve => { release = resolve })
  prototype.findOne = async function (this: { collectionName: string }, ...args: any[]) {
    const result = await Reflect.apply(original, this, args)
    // Read real Mongo snapshot state, then let a competing revocation commit before its fence is touched.
    if (armed && this.collectionName === collectionName && args[1]?.session && result?._id === id) { armed = false; enter(); await resumed }
    return result
  }
  return { entered, release, restore() { release(); prototype.findOne = original } }
}

describe('Authenticated public Graph API', () => {
  it('requires user tokens and separates them from internal Host credentials', async () => {
    const bootstrap = { method: 'app.bootstrap', params: {} }
    expect((await api.rawPost('/api/v1/query', bootstrap)).status).toBe(401)
    expect((await as('not-a-user-token', 'query', bootstrap)).status).toBe(401)
    expect((await as(api.token, 'query', bootstrap)).status).toBe(401)
    expect(await as(api.userToken, 'query', bootstrap)).toMatchObject({ status: 200, body: { data: { identity: api.owner } } })
    expect((await api.rawPost('/internal/v1/work', { method: 'claim', params: { hostId: 'pretend-host', holderId: randomUUID() } }, {
      authorization: `Bearer ${api.userToken}`,
    })).status).toBe(401)
    const context = await makeMap()
    expect((await as(api.userToken, 'command', { requestId: randomUUID(), method: 'run.start', params: {
      mapId: context.mapId, expectedRevision: 1, id: randomUUID(), targetId: context.claimId, mode: 'auto',
      configuration: { agents: [] },
    } })).status).toBe(400)
    expect((await as(api.userToken, 'command', { requestId: randomUUID(), method: 'graph.apply', actorId: api.owner.userId,
      params: { mapId: context.mapId, expectedRevision: 1, changes: { name: 'Spoofed actor' } },
    })).status).toBe(400)
  })

  it('enforces Viewer, Editor and Owner boundaries and hides other Workspaces even from HostAdmin', async () => {
    const context = await makeMap()
    const editor = await user('Editor'), viewer = await user('Viewer'), outsider = await user('Outside owner')
    await member(context.workspaceId, editor.userId, 'editor')
    await member(context.workspaceId, viewer.userId, 'viewer')
    const query = { method: 'map.get', params: { mapId: context.mapId } }
    expect((await as(viewer.token, 'query', query)).status).toBe(200)
    expect((await as(outsider.token, 'query', query)).status).toBe(404)
    expect((await as(outsider.token, 'query', { method: 'map.list', params: { workspaceId: context.workspaceId } })).status).toBe(404)
    expect((await as(viewer.token, 'command', { requestId: randomUUID(), method: 'graph.apply',
      params: { mapId: context.mapId, expectedRevision: 1, changes: { name: 'Viewer cannot edit' } },
    })).status).toBe(403)
    expect((await as(editor.token, 'command', { requestId: randomUUID(), method: 'graph.apply',
      params: { mapId: context.mapId, expectedRevision: 1, changes: { name: 'Editor can edit' } },
    })).status).toBe(200)
    const workspace = (await api.post('/api/v1/query', { method: 'workspace.get', params: { workspaceId: context.workspaceId } })).body.data
    expect((await as(editor.token, 'command', { requestId: randomUUID(), method: 'workspace.update',
      params: { workspaceId: context.workspaceId, expectedRevision: workspace.revision, name: 'Editor cannot own', description: '' },
    })).status).toBe(403)
    expect((await as(editor.token, 'command', { requestId: randomUUID(), method: 'member.set',
      params: { workspaceId: context.workspaceId, expectedRevision: workspace.revision, userId: outsider.userId, role: 'owner' },
    })).status).toBe(403)
    const run = { requestId: randomUUID(), method: 'run.start', params: {
      mapId: context.mapId, expectedRevision: 2, id: randomUUID(), targetId: context.claimId, mode: 'human-in-loop',
    } }
    expect((await as(viewer.token, 'command', run)).status).toBe(403)
    expect((await as(editor.token, 'command', run)).status).toBe(200)
    const ownWorkspace = await as(outsider.token, 'command', { requestId: randomUUID(), method: 'workspace.create', params: {
      id: randomUUID(), name: 'Outside private Workspace', description: '', agentSource: 'empty',
    } })
    expect(ownWorkspace.status).toBe(201)
    expect((await as(api.userToken, 'query', { method: 'workspace.get', params: { workspaceId: ownWorkspace.body.data.id } })).status).toBe(404)
    await member(context.workspaceId, viewer.userId, null)
    expect((await as(viewer.token, 'query', query)).status).toBe(404)
  })

  it('stores only token hashes and restores a disabled Owner without reviving revoked tokens', async () => {
    const account = await user('Revocable user')
    const second = await api.auth.createToken(account.userId)
    const workspaceId = randomUUID()
    expect((await as(account.token, 'command', { requestId: randomUUID(), method: 'workspace.create', params: {
      id: workspaceId, name: 'Recoverable Owner workspace', description: '', agentSource: 'empty',
    } })).status).toBe(201)
    const stored = await api.connection.collection('control_tokens').findOne({ _id: account.tokenId })
    expect(stored?.hash).toBe(createHash('sha256').update(account.token).digest('hex'))
    expect(JSON.stringify(stored)).not.toContain(account.token)
    const independent = authCreateService(api.connection)
    expect((await independent.read(account.token)).actor.userId).toBe(account.userId)
    await api.auth.revokeToken(account.tokenId)
    expect((await as(account.token, 'query', { method: 'app.bootstrap', params: {} })).status).toBe(401)
    await expect(independent.read(account.token)).rejects.toMatchObject({ status: 401 })
    expect((await as(second.token, 'query', { method: 'app.bootstrap', params: {} })).status).toBe(200)
    await api.auth.disableUser(account.userId)
    expect((await as(second.token, 'query', { method: 'app.bootstrap', params: {} })).status).toBe(401)
    await expect(api.auth.createToken(account.userId)).rejects.toMatchObject({ status: 404 })
    await api.auth.enableUser(account.userId)
    expect((await as(account.token, 'query', { method: 'app.bootstrap', params: {} })).status).toBe(401)
    expect((await independent.read(second.token)).actor.userId).toBe(account.userId)
    expect(await as(second.token, 'query', { method: 'workspace.get', params: { workspaceId } })).toMatchObject({
      status: 200, body: { data: { id: workspaceId, role: 'owner', members: [{ userId: account.userId, role: 'owner' }] } },
    })
  })

  it.each(['token', 'user', 'membership'] as const)('revalidates %s revocation after a real transaction conflict before writing the graph', async (kind) => {
    const context = await makeMap()
    const editor = await user(`Racing ${kind}`)
    await member(context.workspaceId, editor.userId, 'editor')
    const pause = kind === 'token' ? pauseAuthorizationRead('control_tokens', editor.tokenId)
      : kind === 'user' ? pauseAuthorizationRead('control_users', editor.userId)
        : pauseAuthorizationRead('control_workspaces', context.workspaceId)
    const before = await api.snapshot(context.mapId)
    try {
      const pending = as(editor.token, 'command', { requestId: randomUUID(), method: 'graph.apply',
        params: { mapId: context.mapId, expectedRevision: before.revision, changes: { name: 'Revoked transaction must not commit' } },
      })
      await pause.entered
      if (kind === 'token') await api.auth.revokeToken(editor.tokenId)
      else if (kind === 'user') await api.auth.disableUser(editor.userId)
      else await member(context.workspaceId, editor.userId, null)
      pause.release()
      const result = await pending
      expect(result.status).toBe(kind === 'membership' ? 404 : 401)
      expect(await api.snapshot(context.mapId)).toEqual(before)
    } finally { pause.restore() }
  }, 15_000)

  it('namespaces user receipts and never lets a replay bypass removed membership', async () => {
    const context = await makeMap()
    const editor = await user('Receipt editor')
    await member(context.workspaceId, editor.userId, 'editor')
    const requestId = randomUUID()
    const ownerCommand = { requestId, method: 'graph.apply', params: { mapId: context.mapId,
      expectedRevision: 1, changes: { name: 'Owner write' } } }
    expect((await as(api.userToken, 'command', ownerCommand)).status).toBe(200)
    expect((await as(editor.token, 'command', ownerCommand)).status).toBe(409)
    const editorCommand = { ...ownerCommand, params: { ...ownerCommand.params, expectedRevision: 2, changes: { name: 'Editor write' } } }
    expect(await as(editor.token, 'command', editorCommand)).toMatchObject({ status: 200, body: { replayed: false } })
    expect(await as(editor.token, 'command', editorCommand)).toMatchObject({ status: 200, body: { replayed: true } })
    await member(context.workspaceId, editor.userId, null)
    expect((await as(editor.token, 'command', editorCommand)).status).toBe(404)
  })

  it('protects the last enabled HostAdmin under concurrent disables', async () => {
    const second = await user('Second HostAdmin', true)
    const results = await Promise.allSettled([api.auth.disableUser(api.owner.userId), api.auth.disableUser(second.userId)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(failure.reason).toMatchObject({ status: 409, code: 'LAST_ADMIN' })
    expect(await api.connection.collection('control_users').countDocuments({ hostAdmin: true, disabled: false })).toBe(1)
  })
})
