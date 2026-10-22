// 会话状态测试：用可控事件流和虚拟时间验证视图隔离、重连与偏好保存。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientError, type ClientGateway, type CommandInputMap } from '../../contracts/client'
import type { AppBootstrap, WorkspaceView } from '../../contracts/control'
import type { DataTypeDefinition, ExecutionAgentDefinition, TransitionDefinition } from '../../contracts/data-definition'
import type { GraphStreamEvent } from '../../contracts/events'
import type { GraphSnapshot, GraphSuccess } from '../../contracts/graph-api'
import type { GraphSourceAnchor } from '../../contracts/graph'
import type { GraphCurrentRun } from '../../contracts/graph-run'
import type { EvidenceUseRef } from '../../contracts/evidence-library'
import { sessionCreateState } from '../../apps/ui/state/client-session'

vi.mock('../../apps/ui/transport/client-gateway', () => /* 替换默认应用网关，避免会话单元测试依赖真实传输环境。 */ ({ api: {} }))

const time = '2026-09-11T00:00:00.000Z'
const claimType: DataTypeDefinition = { id: 'demo.claim', version: 1, title: 'Claim', schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
  successorTypes: [], references: [], agentProjection: { include: ['/content'], mapEntryFilters: [] } }
const definitions = { workspaceId: 'workspace-a', catalog: { revision: 1, packages: [], index: [], dataTypes: [claimType], transitions: [] } }
const emptyPlan = { steps: [] }
/**
 * @param status 模拟 HTTP 错误状态，0 表示网络或本地失败。
 * @param code 模拟业务错误代码，同时用于 Error 的消息。
 * @param retryable 是否可重试，默认 false，网络重连用例可显式开启。
 */
const error = (
  status: number,
  code: string,
  retryable = false
) =>
  /* 网关 seam 按生产合同交付带诊断编号的客户端异常。 */
  new ClientError({ status, code, message: code, retryable })
function deferred<T>() {
  /**
   * 创建可手动完成或拒绝的 Promise，供测试安排异步先后顺序。
   *
   * @param value 测试手动交付的延迟 Promise 成功值。
   * @param reason 测试手动注入的任意 Promise 拒绝原因。
   */
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    // 保存 Promise 的完成与拒绝函数。
    resolve = yes; reject = no
  })
  return { promise, resolve, reject }
}
/**
 * 将测试业务数据包装为成功命令结果。
 *
 * @param data 要包装为命令成功响应的测试业务结果。
 */
function success<T>(/* 当前测试明确交付的业务数据，保留其真实返回类型。 */ data: T): GraphSuccess<T> {
  return { ok: true, requestId: 'request', replayed: false, data }
}
/**
 * 创建包含一个事实节点的指定工作区图快照。
 *
 * @param id 测试图身份，同时派生图名称和事实节点身份。
 * @param workspaceId 测试图所属工作区身份，默认 workspace-a。
 * @param revision 测试图版本，默认 1，用于安排新旧快照顺序。
 */
function map(
  id: string,
  workspaceId = 'workspace-a',
  revision = 1
): GraphSnapshot {
  return { mapId: id, workspaceId, revision, ownershipRevision: 0, ownerships: [], runControls: [], name: id, updatedAt: time, edges: [], runs: [],
    nodes: [{ id: `${id}-claim`, revision: 0, typeId: claimType.id, typeVersion: claimType.version, payload: { content: `${id} content` }, createdAt: time, updatedAt: time }] }
}
function branch(snapshot: GraphSnapshot, rootIds: string[]) {
  // 测试服务端按 successor 闭包返回稳定分支版本；图级 revision 不进入版本。
  const successors = new Map<string, string[]>()
  for (const edge of snapshot.edges) if (edge.kind === 'successor') successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to])
  const nodes = new Set<string>(), pending = [...rootIds]
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    if (nodes.has(id)) continue
    nodes.add(id); pending.push(...(successors.get(id) ?? []))
  }
  const nodeIds = [...nodes].sort(), edgeIds = snapshot.edges.filter(edge => edge.kind === 'successor' && nodes.has(edge.from) && nodes.has(edge.to)).map(edge => edge.id).sort()
  const versions = snapshot.nodes.filter(node => nodes.has(node.id)).map(node => `${node.id}:${node.revision}`).sort().join('|')
  return { scope: { rootIds: [...rootIds].sort(), nodeIds, edgeIds }, version: `branch:${versions}:${edgeIds.join('|')}`, mapRevision: snapshot.revision,
    rootRevisions: Object.fromEntries(rootIds.map(id => [id, snapshot.nodes.find(node => node.id === id)!.revision])) }
}
function claimed(snapshot: GraphSnapshot, rootIds: string[]) {
  const value = branch(snapshot, rootIds)
  return success({ status: 'claimed', grant: { leaseId: '11111111-1111-4111-8111-111111111111', kind: 'editor', rootIds: value.scope.rootIds,
    ownerUserId: 'user-a', holderId: '22222222-2222-4222-8222-222222222222', fence: 1,
    expiresAt: '2999-01-01T00:00:00.000Z', leaseMs: 30_000, scope: value.scope, branch: value, ownershipRevision: 1 } })
}
const runControl = { leaseId: '33333333-3333-4333-8333-333333333333', runId: 'run-a', ownerUserId: 'user-a',
  holderId: '22222222-2222-4222-8222-222222222222', fence: 2, expiresAt: '2999-01-01T00:00:00.000Z', leaseMs: 30_000 }
function controlled(
  /* 本次公开领取实际指定的Run，旧用例默认A。 */ runId = runControl.runId,
  /* 本次实际holder；旧单一响应夹具沿用固定测试值。 */ holderId = runControl.holderId,
  /* 同一lease再次确认的服务端占有序号。 */ ownershipRevision = 1,
) {
  // 返回完整类型授权；不同Run有不同lease，同Run可依法复用原lease/fence。
  return success({ status: 'claimed', grant: { ...runControl, runId, holderId, ownershipRevision,
    leaseId: runId === 'run-a' ? runControl.leaseId : '44444444-4444-4444-8444-444444444444' } })
}

function currentRun(
  /* 构造暂停或可继续的当前运行。 */ paused = false,
  /* 等待审核时保留已接纳阶段结果，运行中则保留待执行阶段。 */ status: 'running' | 'waiting' = 'waiting',
): GraphCurrentRun {
  // 使用现行计划、冻结规格与阶段结果构造会话快照，不混入旧 route/report 字段。
  const agent: ExecutionAgentDefinition = { ref: { id: 'session-agent', version: 1 }, profile: {
    id: 'session-agent', name: 'Session reviewer', description: 'Reviews a claim', content: 'Review the claim.',
    tools: [], provider: 'fixture', model: 'fixture',
  } }
  const type = { id: claimType.id, version: claimType.version }
  const transition: TransitionDefinition = {
    id: 'demo.review', version: 1, title: 'Review claim', cardinality: '1:1',
    group: { mode: 'explicit-members', ready: 'sealed-all-required' },
    ports: { input: [{ name: 'claim', inputType: type, count: { min: 1, max: 1 } }], context: [],
      output: [{ name: 'reviewed', outputType: type, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'claim' }] }] },
    execution: { stages: [{ id: 'assess', kind: 'agent', agentRef: agent.ref, dependsOn: [], ready: 'all-dependencies',
      resultMode: 'outputs', outputPorts: [{ port: 'reviewed', count: { min: 1, max: 1 } }] }], resultStage: 'assess' },
    review: { mode: 'required', at: 'result', onReject: 'fail' },
  }
  const input = { id: 'map-a-claim', revision: 0, type }
  const branchState = branch(map('map-a'), [input.id])
  const outputContract = { mode: 'outputs' as const, ports: [{ port: 'reviewed', type, count: { min: 1, max: 1 },
    schema: claimType.schema, references: [], successorOf: transition.ports.output[0].successorOf }] }
  return {
    id: 'run-a', scope: { nodeIds: [input.id] }, branchState, paused, regenerate: false, mode: 'human-in-loop', status,
    plan: { steps: [{ id: 'review', transitionRef: transition, dependsOn: [], input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail' }] },
    definitions: { ...definitions.catalog, dataTypes: [{ ...claimType, successorTypes: [type] }], transitions: [transition] },
    agents: [agent], tools: [], maxAgentSlots: 1, steps: [{ stepId: 'review', status: 'running', operationIds: ['operation-a'] }],
    operations: [{ id: 'operation-a', stepId: 'review', transitionRef: transition, status, specHash: 'session-spec',
      group: { id: 'group-a', inputRefs: [{ ...input, key: 'claim-a', port: 'claim' }], contextRefs: [], sealed: true },
      executionSpec: { transition, dataTypes: [claimType], inputs: { claim: [input] }, context: {}, resultStage: 'assess',
        stages: [{ id: 'assess', dependsOn: [], agent, tools: [], promptBindings: {}, outputContract }],
        review: transition.review, definitionDigests: [], specHash: 'session-spec' },
      externalInputs: {}, outputRefs: [], stages: [{ stageId: 'assess', expectedWorkIds: ['work-a'], planSlots: [], closed: status === 'waiting',
        results: status === 'waiting' ? [{ workId: 'work-a', stageId: 'assess', slotId: 'assess', acceptedAt: time, reason: 'Reviewed', mode: 'outputs',
          outputs: [{ key: 'reviewed-a', port: 'reviewed', typeRef: type, payload: { content: 'Reviewed claim' } }] }] : [] }],
      review: status === 'waiting' ? { id: 'review-a', revision: 0, kind: 'result', state: 'pending', decision: null, createdAt: time, answeredAt: null } : null,
    }], createdAt: time, updatedAt: time,
  }
}
/**
 * 创建等待结果审核的运行快照，并允许指定暂停状态和图版本。
 *
 * @param paused 测试运行是否暂停，默认 false。
 * @param revision 带运行测试图的版本，默认 2。
 */
function processingMap(paused = false, revision = 2): GraphSnapshot {
  return { ...map('map-a', 'workspace-a', revision), ownershipRevision: 1, runControls: [{ ...runControl }], runs: [currentRun(paused)] }
}
/**
 * 创建所有者视角的工作区与空偏好。
 *
 * @param id 测试工作区身份，同时用于名称和偏好所属范围。
 */
function workspace(id: string): WorkspaceView {
  return { id, name: id, description: '', revision: 0, role: 'owner', mapCount: 2, updatedAt: time, agents: [], members: [],
    preferences: { workspaceId: id, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} } }
}

function fakeGateway() {
  // 构造可控制快照、工作区、命令和事件流的内存网关夹具。
  let configured = false
  const snapshots = new Map([['map-a', map('map-a')], ['map-b', map('map-b')], ['map-c', map('map-c', 'workspace-b')]])
  const workspaces = new Map([['workspace-a', workspace('workspace-a')], ['workspace-b', workspace('workspace-b')]])
  const bootstrap: AppBootstrap = { identity: { userId: 'user-a', displayName: 'A', hostAdmin: false }, settings: {
    revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 3 },
  }, metadata: { capabilities: { mapRename: true }, variables: {} } }
  const readImplementation = async (
    method: string,
    params: any,
    _signal?: AbortSignal
  ): Promise<any> => {
    // 按公开查询方法从夹具读取启动信息、工作区或图副本。
    if (method === 'app.bootstrap') return structuredClone(bootstrap)
    if (method === 'workspace.list') return { items: [...workspaces.values()], nextCursor: null }
    if (method === 'workspace.get') return structuredClone(workspaces.get(params.workspaceId))
    if (method === 'map.list') return [...snapshots.values()].filter(snapshot =>
      /* 只列出请求工作区中的图。 */
      snapshot.workspaceId === params.workspaceId).map(snapshot =>
      /* 把完整图快照转换为列表摘要。 */
      ({
      id: snapshot.mapId, workspaceId: snapshot.workspaceId, revision: snapshot.revision, name: snapshot.name, nodeCount: snapshot.nodes.length,
      typeCounts: { 'demo.claim@1': 1 }, updatedAt: snapshot.updatedAt,
    }))
    if (method === 'definition.get') return structuredClone({ ...definitions, workspaceId: params.workspaceId })
    if (method === 'map.get') return structuredClone(snapshots.get(params.mapId))
    if (method === 'branch.get') return structuredClone(branch(snapshots.get(params.mapId)!, params.rootIds))
    throw new Error(`Unexpected query: ${method}`)
  }
  const read = vi.fn(readImplementation)
  const dispatchImplementation = async (
    _id: string,
    method: string,
    params: any,
    _signal?: AbortSignal
  ): Promise<any> => {
    // 只模拟图管理成功结果和偏好版本，权限、占用与版本仲裁由真实后端用例验证。
    if (method === 'preferences.set') return success({ workspaceId: params.workspaceId, revision: params.expectedRevision + 1,
      openMapIds: params.openMapIds, currentMapId: params.currentMapId, nodeSelection: params.nodeSelection })
    if (method === 'map.rename') {
      const current = snapshots.get(params.mapId)
      if (current) {
        const renamed = { ...current, name: params.name, revision: current.revision + 1 }
        snapshots.set(params.mapId, renamed)
        return success({ snapshot: structuredClone(renamed), createdNodeIds: [], createdEdgeIds: [] })
      }
    }
    if (method === 'map.delete') {
      snapshots.delete(params.mapId)
      return success({ mapId: params.mapId, deleted: true })
    }
    throw new Error(`Unexpected command: ${method}`)
  }
  const dispatch = vi.fn(dispatchImplementation)
  const connect = vi.fn(async () => {
    // 模拟登录并返回独立启动信息副本。
    configured = true; return structuredClone(bootstrap)
  })
  const disconnect = vi.fn(async () => {
    // 模拟退出登录并清除连接配置状态。
    configured = false
  })
  const getConnection = vi.fn(async () => /* 返回当前模拟连接的配置状态。 */ ({ baseUrl: 'http://fixture', configured, remembered: false, canRemember: false }))
  const streams: Array<{ mapId: string; signal?: AbortSignal; emit: (
    event: GraphStreamEvent
  ) => void; resolve: () => void; reject: (
    cause: unknown
  ) => void }> = []
  const watch = vi.fn((
    mapId: string,
    onEvent: (
      event: GraphStreamEvent
    ) => void,
    signal?: AbortSignal
  ) =>
    /* 创建可由测试主动推送、结束或拒绝的图订阅。 */
    new Promise<void>((resolve, reject) => {
    /**
     * 登记订阅控制入口，并令取消信号拒绝该订阅。
     *
     * @param event 测试主动推送的流事件，原样交给会话回调。
     */
    const emit = (event: GraphStreamEvent) => {
      // 把测试事件交给订阅者，回调抛错时结束订阅 Promise。
      try { onEvent(event) } catch (cause) { reject(cause) }
    }
    streams.push({ mapId, emit, signal, resolve, reject })
    signal?.addEventListener('abort', () => /* 取消发生时以请求取消错误拒绝订阅。 */ reject(error(0, 'REQUEST_ABORTED')), { once: true })
  }))
  const gateway = { watch, read, dispatch, connect, disconnect, getConnection } as unknown as ClientGateway
  return { gateway, watch, streams, read, dispatch, readImplementation, dispatchImplementation, connect, disconnect, getConnection, snapshots, workspaces, bootstrap }
}

const sessions: ReturnType<typeof sessionCreateState>[] = []
beforeEach(() => {
  // 每个用例前使用虚拟时间控制防抖与重连。
  vi.useFakeTimers()
})
afterEach(() => {
  // 每个用例后释放所有会话并恢复真实计时器。
  for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers()
})

describe('106 account session adoption', () => {
  it.each(['registerUsername', 'loginUsername'] as const)('username %s keeps the graph after failure and adopts only a current successful result', async (action) => {
    // 新入口复用旧会话边界；失败保留图，成功加载工作区，退出隔离迟到结果。
    const f = await opened(), original = f.session.snapshot.value
    const authenticate = vi.fn<() => Promise<AppBootstrap>>(async () => { throw error(401, 'INVALID_CREDENTIALS') })
    Object.assign(f.gateway, { account: { [action]: authenticate } })
    const input = { baseUrl: 'http://fixture', username: 'reader', displayName: '读者', password: 'username-password-2026', remember: false }
    expect(await f.session[action](input)).toBe(false)
    expect(f.session.snapshot.value).toBe(original)
    expect(f.disconnect).not.toHaveBeenCalled()
    authenticate.mockImplementationOnce(async () => structuredClone(f.bootstrap))
    expect(await f.session[action](input)).toBe(true)
    expect(f.session.workspace.value?.id).toBe('workspace-a')
    const pending = deferred<AppBootstrap>()
    authenticate.mockImplementationOnce(() => pending.promise)
    const old = f.session[action](input)
    await f.session.disconnect()
    pending.resolve(structuredClone(f.bootstrap))
    expect(await old).toBe(false)
    expect(f.session.workspace.value).toBeNull()
  })

  it('keeps the current graph and branch authority when account authentication fails', async () => {
    // 错误密码属于新登录尝试，不能清除已打开用户的图、选择、租约或订阅。
    const f = await opened()
    await f.session.selectNode('map-a-claim')
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a') ?? map('map-a'), ['map-a-claim']))
    expect(await f.session.claimBranch()).toBe(true)
    const snapshot = f.session.snapshot.value, branch = f.session.selectedBranchGrant.value
    const streamCount = f.streams.length
    const login = vi.fn(async () => { /* 网关只有验证成功后才允许替换旧连接。 */ throw error(401, 'INVALID_CREDENTIALS') })
    Object.assign(f.gateway, { account: { login } })
    expect(await f.session.login({ baseUrl: 'http://new-service', email: 'member@example.test', password: 'incorrect-password', remember: false })).toBe(false)
    expect(f.session.snapshot.value).toBe(snapshot)
    expect(f.session.selectedBranchGrant.value).toBe(branch)
    expect(f.session.selectedId.value).toBe('map-a-claim')
    expect(f.session.bootstrap.value?.identity.userId).toBe(f.bootstrap.identity.userId)
    expect(f.session.error.value?.code).toBe('INVALID_CREDENTIALS')
    expect(f.disconnect).not.toHaveBeenCalled()
    expect(f.streams).toHaveLength(streamCount)
    expect(f.streams.every((/* 原会话持有的订阅。 */ stream) => /* 认证失败不能中断旧用户的流。 */ !stream.signal?.aborted)).toBe(true)
  })

  it('adopts account login through the existing workspace lifecycle and ignores a result after logout', async () => {
    // 成功登录正常打开工作区；退出后的迟到成功不能复活旧账户数据。
    const f = fakeGateway()
    const login = vi.fn(async () => /* 网关交付已认证且已激活的独立bootstrap。 */ structuredClone(f.bootstrap))
    Object.assign(f.gateway, { account: { login } })
    const session = sessionCreateState(f.gateway, 100)
    sessions.push(session)
    expect(await session.login({ baseUrl: 'http://fixture', email: 'member@example.test', password: 'correct-password', remember: false })).toBe(true)
    expect(session.bootstrap.value?.identity.userId).toBe(f.bootstrap.identity.userId)
    expect(session.workspace.value?.id).toBe('workspace-a')
    const pending = deferred<AppBootstrap>()
    login.mockImplementationOnce(() => /* 延后交付原登录意图的结果。 */ pending.promise)
    const oldLogin = session.login({ baseUrl: 'http://fixture', email: 'member@example.test', password: 'correct-password', remember: false })
    await session.disconnect()
    pending.resolve(structuredClone(f.bootstrap))
    expect(await oldLogin).toBe(false)
    expect(session.bootstrap.value).toBeNull()
    expect(session.workspace.value).toBeNull()
    expect(session.snapshot.value).toBeNull()
  })

  it('rotates the account password without clearing the same user graph or selection', async () => {
    // 改密轮换同一账户的凭据，不重建工作区、编辑草稿或图订阅。
    const f = await opened()
    await f.session.selectNode('map-a-claim')
    const snapshot = f.session.snapshot.value, workspace = f.session.workspace.value
    const streamCount = f.streams.length
    const changePassword = vi.fn(async () => /* 网关已原地轮换同一身份的新凭据。 */ structuredClone(f.bootstrap))
    Object.assign(f.gateway, { account: { changePassword } })
    expect(await f.session.changePassword({ currentPassword: 'old-account-password', newPassword: 'new-account-password', remember: false })).toBe(true)
    expect(f.session.snapshot.value).toBe(snapshot)
    expect(f.session.workspace.value).toBe(workspace)
    expect(f.session.selectedId.value).toBe('map-a-claim')
    expect(f.streams).toHaveLength(streamCount)
    expect(f.connect).toHaveBeenCalledOnce()
    expect(f.disconnect).not.toHaveBeenCalled()
  })
})

async function opened(
  /* 证据元信息用例显式启用能力与无租约网关，其他原用例保持原装配。 */ evidenceLibrary = false,
) {
  // 创建并登录测试会话，打开默认图并登记清理。
  const f = fakeGateway()
  if (evidenceLibrary) {
    f.bootstrap.metadata.capabilities = { ...f.bootstrap.metadata.capabilities, evidenceLibrary: true }
    f.bootstrap.metadata.clientLeases = 'none'
  }
  const session = sessionCreateState(f.gateway, 100)
  sessions.push(session)
  await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
  await session.openMap('map-a', false)
  return { ...f, session }
}

async function openedSource(clientLeases: 'none' | 'required' = 'none') {
  const f = fakeGateway()
  if (clientLeases === 'none') f.bootstrap.metadata.clientLeases = 'none'
  const snapshot = map('map-a')
  snapshot.nodes.push({ ...snapshot.nodes[0], id: 'source', revision: 2, payload: { content: 'News line one\nNews line two\nNews line three' } })
  snapshot.edges.push({ id: 'source-edge', kind: 'successor', from: 'source', to: 'map-a-claim', revision: 3, label: 'derived from news', createdAt: time, updatedAt: time })
  f.snapshots.set('map-a', snapshot)
  const session = sessionCreateState(f.gateway, 100)
  sessions.push(session)
  await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
  await session.openMap('map-a', false)
  return { ...f, session }
}

describe('C19 workspace initial Agent configuration', () => {
  // 两个页面入口共用同一会话创建动作；这里只核对实际命令及原请求确认。
  it.each(['library', 'empty'] as const)('passes the explicitly chosen %s configuration to workspace creation', async (
    /* 用户已经核对的精确初始配置策略。 */ agentSource,
  ) => {
    // 新增参数必须进入真实会话dispatch，而不是仅保存在表单标签中。
    const f = await opened()
    const attempts: Array<{ id: string; params: unknown }> = []
    f.dispatch.mockImplementation(async (
      /* 会话分配且重放时必须稳定的原请求身份。 */ id: string,
      /* 当前公共写命令。 */ method: string,
      /* 会话实际发往网关的参数，不用类型断言伪造可靠DTO。 */ params: unknown,
      /* 非本例命令继续沿原取消信号执行。 */ signal?: AbortSignal,
    ): Promise<unknown> => {
      // 只为创建提供保存结果，其他偏好和图动作仍使用已有夹具。
      if (method !== 'workspace.create' || params === null || typeof params !== 'object'
        || !('id' in params) || typeof params.id !== 'string') return f.dispatchImplementation(id, method, params, signal)
      attempts.push({ id, params: structuredClone(params) })
      const created = { ...workspace(params.id), name: 'C19 显式创建', description: '创建方式须送到服务端' }
      f.workspaces.set(created.id, created)
      return success(created)
    })
    expect(await f.session.createWorkspace('C19 显式创建', '创建方式须送到服务端', agentSource)).toBe(true)
    expect(attempts).toEqual([{ id: expect.any(String), params: { id: f.session.workspace.value?.id,
      name: 'C19 显式创建', description: '创建方式须送到服务端', agentSource } }])
  })

  it('keeps existing string callers on the library default', async () => {
    // 原两参数入口仍按共享库创建，不要求旧调用方使用包装函数。
    const f = await opened()
    f.dispatch.mockImplementation(async (
      /* 实际公共请求身份。 */ id: string,
      /* 实际公共方法。 */ method: string,
      /* 会话独立复制后的写入参数。 */ params: unknown,
      /* 原会话的取消信号。 */ signal?: AbortSignal,
    ): Promise<unknown> => {
      // 服务端返回的新身份进入原目录和工作区选择流程。
      if (method !== 'workspace.create' || params === null || typeof params !== 'object'
        || !('id' in params) || typeof params.id !== 'string') return f.dispatchImplementation(id, method, params, signal)
      const created = { ...workspace(params.id), name: 'C19 原字符串调用' }
      f.workspaces.set(created.id, created)
      return success(created)
    })
    expect(await f.session.createWorkspace('C19 原字符串调用', '')).toBe(true)
    expect(f.dispatch).toHaveBeenCalledWith(expect.any(String), 'workspace.create', {
      id: f.session.workspace.value?.id, name: 'C19 原字符串调用', description: '', agentSource: 'library',
    }, expect.any(AbortSignal))
  })

  it('rejects another creation while the original source choice awaits confirmation and replays the original request', async () => {
    // 从实际创建丢回包形成待确认状态，不能靠新模式清掉原意图。
    const f = await opened()
    const attempts: Array<{ id: string; params: unknown }> = []
    let accepted: WorkspaceView | null = null
    f.dispatch.mockImplementation(async (
      /* 原请求和最终确认必须共用的身份。 */ id: string,
      /* 只改变工作区创建命令的首次交付。 */ method: string,
      /* 已送往真实会话网关的独立参数。 */ params: unknown,
      /* 其它现有命令使用原信号。 */ signal?: AbortSignal,
    ): Promise<unknown> => {
      // 先把原工作区放进夹具存储，再丢失回包，重试不重复创建。
      if (method !== 'workspace.create' || params === null || typeof params !== 'object'
        || !('id' in params) || typeof params.id !== 'string') return f.dispatchImplementation(id, method, params, signal)
      attempts.push({ id, params: structuredClone(params) })
      if (!accepted) {
        accepted = { ...workspace(params.id), name: 'C19 原空配置意图', description: '等待原请求确认' }
        f.workspaces.set(accepted.id, accepted)
        throw error(0, 'NETWORK_ERROR', true)
      }
      return { ...success(accepted), replayed: true }
    })
    expect(await f.session.createWorkspace('C19 原空配置意图', '等待原请求确认', 'empty')).toBe(false)
    expect(f.session.canRetry.value).toBe(true)
    const originalError = f.session.error.value, original = structuredClone(attempts[0])
    const originalWorkspace = f.session.workspace.value
    expect(await f.session.createWorkspace('C19 不得覆盖的新意图', '不同说明', 'library')).toBe(false)
    expect(attempts).toEqual([original])
    expect(f.session.canRetry.value).toBe(true)
    expect(f.session.error.value).toBe(originalError)
    expect(f.session.workspace.value).toBe(originalWorkspace)
    expect(await f.session.retry()).toBe(true)
    expect(attempts).toEqual([original, original])
    expect(original.params).toMatchObject({ name: 'C19 原空配置意图', description: '等待原请求确认', agentSource: 'empty' })
    expect(f.session.workspace.value).toMatchObject({ name: 'C19 原空配置意图' })
    expect(f.workspaces.size).toBe(3)
    expect(f.session.canRetry.value).toBe(false)
  })
})

function reviewAnswerInput(): Omit<CommandInputMap['review.answer'], 'control'> {
  // 固定当前页面已展示的审核身份与发布版本，供新意图和原请求确认对照。
  return { mapId: 'map-a', runId: 'run-a', operationId: 'operation-a', reviewId: 'review-a',
    expectedReviewRevision: 0, decision: 'approve', expectedPublicationVersion: 'publication-a' }
}

async function openedReview(
  /* 本机不领取客户端控制租约；协作路径用于安排等待期间的视图变化。 */ local = true,
  /* 默认声明真实服务的发布预览能力；旧服务用例显式关闭。 */ publicationPreview = true,
) {
  // 打开待审核的真实会话状态，命令响应仍由各用例控制，不绕过 answerReview 入口。
  const f = fakeGateway()
  f.bootstrap.metadata.capabilities = { ...f.bootstrap.metadata.capabilities, publicationPreview }
  if (local) f.bootstrap.metadata.clientLeases = 'none'
  f.snapshots.set('map-a', processingMap())
  const session = sessionCreateState(f.gateway, 100)
  sessions.push(session)
  await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
  await session.openMap('map-a', false)
  return { ...f, session }
}

const sourceAnchors: GraphSourceAnchor[] = [
  { path: '/content', sourceRevision: 2, startLine: 1, endLine: 1, quote: 'News line one' },
  { path: '/content', sourceRevision: 2, startLine: 3, endLine: 3, quote: 'News line three' },
]

type ChildInput = Parameters<ReturnType<typeof sessionCreateState>['createChildNode']>[0]

const childType: DataTypeDefinition = { ...claimType, id: 'demo.child', version: 2, title: '子材料' }
const parentType: DataTypeDefinition = { ...claimType, id: 'demo.parent', version: 3, title: '父材料',
  schema: { type: 'object', properties: { content: { type: 'string' }, linkedIds: { type: 'array', items: { type: 'string' } } },
    required: ['content', 'linkedIds'], additionalProperties: false },
  successorTypes: [{ id: childType.id, version: childType.version }],
  references: [{ path: '/linkedIds/*', target: { kind: 'node', types: [{ id: childType.id, version: childType.version }] } }],
}

enum ChildSessionTestMessage {
  SNAPSHOT_MISSING = '子节点会话夹具缺少已打开的图快照。',
  ATOMIC_WRITE_MISSING = '子节点创建必须同时提交节点和固定父节点的后继边。',
}

async function openedChildren(
  /* 本机直接写入，协作模式验证既有或临时的父分支授权。 */ clientLeases: 'none' | 'required' = 'none',
) {
  // 复用脚注图并发布自包含的父子类型与引用声明，避免把产品类型名写进会话规则。
  const f = await openedSource(clientLeases)
  if (!f.session.snapshot.value) throw new Error(ChildSessionTestMessage.SNAPSHOT_MISSING)
  const initial = structuredClone(f.session.snapshot.value)
  initial.revision++
  initial.nodes = initial.nodes.map((
    /* 原脚注夹具中的来源与事实。 */ node,
  ) => /* 给来源一个精确父类型，既有事实改为该目录允许的子类型。 */ node.id === 'source'
    ? { ...node, typeId: parentType.id, typeVersion: parentType.version, payload: { ...node.payload, linkedIds: [] } }
    : { ...node, typeId: childType.id, typeVersion: childType.version })
  initial.nodes.push({ ...map('map-a').nodes[0], id: 'wrong-target' })
  const normalRead = f.readImplementation
  f.read.mockImplementation(async (
    /* 用公开定义查询发布本用例的自包含目录。 */ method,
    /* 其余查询保持原工作区和图身份。 */ params,
    /* 会话持有的读取取消信号。 */ signal,
  ) => {
    // 不更换整个网关，只替换合法父子类型和引用字段的目录响应。
    if (method === 'definition.get') return { ...definitions, workspaceId: params.workspaceId,
      catalog: { ...definitions.catalog, dataTypes: [claimType, parentType, childType] } }
    return normalRead(method, params, signal)
  })
  f.snapshots.set('map-a', initial)
  f.streams[0].emit({ type: 'snapshot', snapshot: initial })
  await f.session.refreshWorkspace()
  return { ...f, initial }
}

function childWriteSnapshot(
  /* 写入前固定的真实形状快照，不修改调用方数据。 */ initial: GraphSnapshot,
  /* 会话一次公开graph.apply提交的节点及后继边。 */ params: CommandInputMap['graph.apply'],
): GraphSnapshot {
  // 为会话交付预置的原子写入结果，实际类型和来源约束由后端验收负责。
  const node = params.changes.nodes?.put?.[0]
  const edge = params.changes.edges?.put?.[0]
  if (!node || !edge) throw new Error(ChildSessionTestMessage.ATOMIC_WRITE_MISSING)
  const next = structuredClone(initial)
  next.revision++
  next.nodes.push({ ...node, revision: 0, createdAt: time, updatedAt: time })
  next.edges.push({ ...edge, revision: 0, createdAt: time, updatedAt: time })
  return next
}

function nodeEvidenceRefs(): EvidenceUseRef[] {
  // 创建两份独立固定库引用，只给消费者保存库身份、摘要和本次使用理由。
  return [
    { entryId: '55555555-5555-4555-8555-555555555555', contentDigest: 'a'.repeat(64), reason: '对照第一份固定材料。' },
    { entryId: '66666666-6666-4666-8666-666666666666', contentDigest: 'b'.repeat(64), reason: '对照第二份固定材料。' },
  ]
}

describe('Client session state and subscriptions', () => {
  it('replaces service capabilities on reconnect and clears them for a legacy service or logout', async () => {
    // 能力属于本次 bootstrap，重新连接或退出不保留旧服务的支持声明。
    const f = fakeGateway(), session = sessionCreateState(f.gateway, 100)
    sessions.push(session)
    f.bootstrap.metadata.capabilities = { evidenceLibrary: true }
    await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
    expect(session.bootstrap.value?.metadata.capabilities?.evidenceLibrary).toBe(true)
    f.bootstrap.metadata.capabilities = { evidenceLibrary: false }
    await session.connect({ baseUrl: 'http://replacement', token: 'replacement-token', remember: false })
    expect(session.bootstrap.value?.metadata.capabilities?.evidenceLibrary).toBe(false)
    delete f.bootstrap.metadata.capabilities
    await session.connect({ baseUrl: 'http://legacy', token: 'legacy-token', remember: false })
    expect(session.bootstrap.value?.metadata.capabilities?.evidenceLibrary).toBeUndefined()
    await session.disconnect()
    expect(session.bootstrap.value).toBeNull()
  })

  it('saves complete source anchors locally without acquiring a branch lease or changing selection', async () => {
    const f = await openedSource()
    f.session.selectNode('map-a-claim')
    await vi.waitFor(() => expect(f.session.selectedBranch.value).not.toBeNull())
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation(async (id, method, params, signal) => {
      if (method !== 'graph.apply') return normalDispatch(id, method, params, signal)
      expect(params).not.toHaveProperty('lease')
      expect(params.branch.rootIds).toEqual(['source', 'map-a-claim'])
      expect(params.changes.edges.put).toEqual([{ id: 'source-edge', kind: 'successor', from: 'source', to: 'map-a-claim',
        label: 'derived from news', sourceAnchors }])
      const next = structuredClone(f.snapshots.get('map-a')!)
      next.revision++; next.edges[0].revision++; next.edges[0].sourceAnchors = sourceAnchors
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [] })
    })
    expect(await f.session.saveSourceAnchors({ mapId: 'map-a', edgeId: 'source-edge', expectedEdgeRevision: 3, sourceAnchors })).toBe(true)
    expect(f.session.snapshot.value?.edges[0].sourceAnchors).toEqual(sourceAnchors)
    expect(f.session.selectedId.value).toBe('map-a-claim')
    expect(f.dispatch.mock.calls.filter(call => call[1].startsWith('branch.'))).toEqual([])
  })

  it('rejects an outdated source edge or source revision before reading a proof or submitting changes', async () => {
    const f = await openedSource()
    f.read.mockClear(); f.dispatch.mockClear()
    expect(await f.session.saveSourceAnchors({ mapId: 'map-a', edgeId: 'source-edge', expectedEdgeRevision: 2, sourceAnchors })).toBe(false)
    expect(await f.session.saveSourceAnchors({ mapId: 'map-a', edgeId: 'source-edge', expectedEdgeRevision: 3,
      sourceAnchors: sourceAnchors.map(anchor => ({ ...anchor, sourceRevision: 1 })) })).toBe(false)
    expect(f.session.error.value?.code).toBe('REVISION_CONFLICT')
    expect(f.read).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('preserves unchanged historical anchors while adding an anchor for the current source revision', async () => {
    const f = await openedSource()
    const historical = { path: '/headline', sourceRevision: 1, startLine: 1, endLine: 1, quote: 'Previous headline' }
    const initial = structuredClone(f.snapshots.get('map-a')!)
    initial.revision++; initial.edges[0].sourceAnchors = [historical]
    f.snapshots.set('map-a', initial)
    f.streams[0].emit({ type: 'snapshot', snapshot: initial })
    const anchors = [historical, sourceAnchors[0]]
    f.dispatch.mockImplementationOnce(async (_id, method, params) => {
      expect(method).toBe('graph.apply')
      expect(params.changes.edges.put[0].sourceAnchors).toEqual(anchors)
      const next = structuredClone(initial)
      next.revision++; next.edges[0].revision++; next.edges[0].sourceAnchors = anchors
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [] })
    })
    expect(await f.session.saveSourceAnchors({ mapId: 'map-a', edgeId: 'source-edge', expectedEdgeRevision: 3, sourceAnchors: anchors })).toBe(true)
    const count = f.dispatch.mock.calls.length
    expect(await f.session.saveSourceAnchors({ mapId: 'map-a', edgeId: 'source-edge', expectedEdgeRevision: 4,
      sourceAnchors: [{ ...historical, quote: 'Changed historic quote' }, sourceAnchors[0]] })).toBe(false)
    expect(f.dispatch.mock.calls).toHaveLength(count)
  })

  it('does not submit source anchors when their branch read returns after a Map switch', async () => {
    const f = await openedSource(), late = deferred<ReturnType<typeof branch>>()
    const old = structuredClone(f.snapshots.get('map-a')!)
    const normalRead = f.readImplementation
    f.read.mockImplementation((method, params, signal) => method === 'branch.get' && params.mapId === 'map-a'
      ? late.promise : normalRead(method, params, signal))
    const saving = f.session.saveSourceAnchors({ mapId: 'map-a', edgeId: 'source-edge', expectedEdgeRevision: 3, sourceAnchors })
    expect(f.session.busy.value).toBe(true)
    await f.session.openMap('map-b', false)
    late.resolve(branch(old, ['source', 'map-a-claim']))
    expect(await saving).toBe(false)
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.busy.value).toBe(false)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'graph.apply' || call[1] === 'branch.claim')).toBe(false)
  })

  it('rejects source content that changes while a branch proof is being read', async () => {
    const f = await openedSource(), late = deferred<ReturnType<typeof branch>>()
    const old = structuredClone(f.snapshots.get('map-a')!)
    f.read.mockImplementationOnce(() => late.promise)
    const saving = f.session.saveSourceAnchors({ mapId: 'map-a', edgeId: 'source-edge', expectedEdgeRevision: 3, sourceAnchors })
    const changed = structuredClone(old)
    changed.revision++; changed.nodes.find(node => node.id === 'source')!.revision++
    f.streams[0].emit({ type: 'snapshot', snapshot: changed })
    late.resolve(branch(old, ['source', 'map-a-claim']))
    expect(await saving).toBe(false)
    expect(f.session.error.value?.code).toBe('REVISION_CONFLICT')
    expect(f.dispatch.mock.calls.some(call => call[1] === 'graph.apply')).toBe(false)
  })

  it('uses and releases an isolated temporary source lease without replacing Inspector state', async () => {
    const f = await openedSource('required')
    f.session.selectNode('map-a-claim')
    await vi.waitFor(() => expect(f.session.selectedBranch.value).not.toBeNull())
    const selectedBranch = f.session.selectedBranch.value
    f.dispatch.mockImplementation(async (_id, method, params) => {
      if (method === 'branch.claim') return claimed(f.snapshots.get('map-a')!, params.rootIds)
      if (method === 'branch.release') return success({ released: true, ownershipRevision: 2 })
      if (method === 'graph.apply') {
        expect(params.lease).toMatchObject({ leaseId: '11111111-1111-4111-8111-111111111111', fence: 1 })
        const next = structuredClone(f.snapshots.get('map-a')!)
        next.revision++; next.edges[0].revision++; next.edges[0].sourceAnchors = sourceAnchors
        f.snapshots.set('map-a', next)
        return success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [] })
      }
      throw new Error(`Unexpected command: ${method}`)
    })
    expect(await f.session.saveSourceAnchors({ mapId: 'map-a', edgeId: 'source-edge', expectedEdgeRevision: 3, sourceAnchors })).toBe(true)
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['branch.claim', 'graph.apply', 'branch.release'])
    expect(f.session.selectedBranchGrant.value).toBeNull()
    expect(f.session.selectedId.value).toBe('map-a-claim')
    expect(f.session.selectedBranch.value?.scope.rootIds).toEqual(selectedBranch?.scope.rootIds)
  })

  // C05校正：自由改边的成功预期撤下，授权、版本和恢复保护改由固定父后继、脚注与声明引用验证。
  it('creates a child and its fixed successor in one local write with source anchors', async () => {
    // 旧父必须使用它的现有分支版本，节点与来源边原子提交，UI不伪造服务端人工来源标记。
    const f = await openedChildren()
    expect(f.session).toHaveProperty('createChildNode', expect.any(Function))
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation(async (
      /* 这次公开写入的幂等请求身份。 */ id,
      /* 只为子节点创建交付图写入结果。 */ method,
      /* 会话构造的单次节点和后继边差量。 */ params,
      /* 仍由会话持有的传输取消信号。 */ signal,
    ) => {
      // 从这一次原子提交交付完整快照，不在夹具中复制后端来源校验。
      if (method !== 'graph.apply') return normalDispatch(id, method, params, signal)
      const next = childWriteSnapshot(f.initial, params)
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [next.nodes[next.nodes.length - 1].id], createdEdgeIds: [next.edges[next.edges.length - 1].id] })
    })

    expect(await f.session.createChildNode({ mapId: 'map-a', parentId: 'source', expectedParentRevision: 2,
      childType: { id: childType.id, version: childType.version }, payload: { content: '手工补充的子材料' }, sourceAnchors })).toBe(true)

    expect(f.dispatch.mock.calls.map((
      /* 本次创建实际发出的公开命令。 */ call,
    ) => /* 本机不需要编辑租约，也不能分两次保存节点和边。 */ call[1])).toEqual(['graph.apply'])
    const params = f.dispatch.mock.calls[0][2]
    expect(params.branch).toEqual({ rootIds: ['source'], expectedVersion: branch(f.initial, ['source']).version })
    expect(params).not.toHaveProperty('lease')
    expect(params.changes.nodes.put).toHaveLength(1)
    expect(params.changes.edges.put).toHaveLength(1)
    const child = params.changes.nodes.put[0]
    expect(child).toMatchObject({ typeId: childType.id, typeVersion: childType.version, payload: { content: '手工补充的子材料' } })
    expect(child).not.toHaveProperty('manualOrigin')
    expect(params.changes.edges.put[0]).toMatchObject({ kind: 'successor', from: 'source', to: child.id, sourceAnchors })
    expect(f.session.snapshot.value?.nodes).toHaveLength(f.initial.nodes.length + 1)
    expect(f.session.snapshot.value?.edges).toHaveLength(f.initial.edges.length + 1)
    expect(f.session.selectedId.value).toBe(child.id)
  })

  it.each(['type', 'type version', 'parent revision'] as const)('refuses an invalid child %s before a graph write', async (
    /* 用户确认的哪个精确类型或父版本事实不符合当前目录与图。 */ invalid,
  ) => {
    // 不允许把陈旧父版本或任意类型伪装成合法后继，也不先创建孤立节点。
    const f = await openedChildren()
    expect(f.session).toHaveProperty('createChildNode', expect.any(Function))
    f.dispatch.mockClear()
    const requestedType = invalid === 'type' ? claimType : childType
    const requestedVersion = invalid === 'type version' ? 1 : requestedType.version

    expect(await f.session.createChildNode({ mapId: 'map-a', parentId: 'source', expectedParentRevision: invalid === 'parent revision' ? 1 : 2,
      childType: { id: requestedType.id, version: requestedVersion },
      payload: { content: '不应写入的子材料' } })).toBe(false)

    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.session.snapshot.value).toEqual(f.initial)
  })

  it.each([false, true])('releases temporary parent authority after a child write rejects: %s', async (
    /* 已取得父分支授权后，后端是否拒绝本次原子提交。 */ rejected,
  ) => {
    // 成功与失败都释放临时授权，拒绝时没有半个子节点或半条后继边。
    const f = await openedChildren('required')
    expect(f.session).toHaveProperty('createChildNode', expect.any(Function))
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation(async (
      /* 每一步公开命令的原始身份。 */ id,
      /* 按父分支领取、原子写入、释放分别交付结果。 */ method,
      /* 会话构造的冻结命令参数。 */ params,
      /* 会话持有的请求取消信号。 */ signal,
    ) => {
      // 只在单次写入成功时更新夹具快照，失败不产生节点或关系。
      if (method === 'branch.claim') return claimed(f.initial, params.rootIds)
      if (method === 'branch.release') return success({ released: true, ownershipRevision: 2 })
      if (method !== 'graph.apply') return normalDispatch(id, method, params, signal)
      if (rejected) throw error(422, 'INVALID_RELATION')
      const next = childWriteSnapshot(f.initial, params)
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [next.nodes[next.nodes.length - 1].id], createdEdgeIds: [next.edges[next.edges.length - 1].id] })
    })

    expect(await f.session.createChildNode({ mapId: 'map-a', parentId: 'source', expectedParentRevision: 2,
      childType: { id: childType.id, version: childType.version }, payload: { content: '临时授权下的子材料' } })).toBe(!rejected)

    expect(f.dispatch.mock.calls.map((
      /* 本次子节点意图的完整命令顺序。 */ call,
    ) => /* 临时授权必须在finally释放，不成为Inspector的长期授权。 */ call[1])).toEqual(['branch.claim', 'graph.apply', 'branch.release'])
    expect(f.dispatch.mock.calls[0][2].rootIds).toEqual(['source'])
    expect(f.dispatch.mock.calls[1][2].lease).toEqual(f.dispatch.mock.calls[2][2].lease)
    expect(f.session.selectedBranchGrant.value).toBeNull()
    expect(f.session.busy.value).toBe(false)
    if (rejected) {
      expect(f.session.snapshot.value).toEqual(f.initial)
      expect(f.snapshots.get('map-a')).toEqual(f.initial)
      expect(f.session.selectedId.value).toBeNull()
    }
  })

  it.each([false, true])('reuses Inspector authority only when it covers the fixed parent; partial: %s', async (
    /* 当前Inspector是否只拥有父分支里的旧子节点。 */ partial,
  ) => {
    // 父范围已有授权可直接复用；部分授权须显式释放，不能悄悄替换它。
    const f = await openedChildren('required')
    expect(f.session).toHaveProperty('createChildNode', expect.any(Function))
    const selected = partial ? 'map-a-claim' : 'source'
    f.session.selectNode(selected)
    await vi.waitFor(() => expect(f.session.selectedBranch.value).not.toBeNull())
    f.dispatch.mockResolvedValueOnce(claimed(f.initial, [selected]))
    expect(await f.session.claimBranch([selected])).toBe(true)
    const grant = f.session.selectedBranchGrant.value
    f.dispatch.mockClear()
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation(async (
      /* 写入或既有Inspector授权释放的公开身份。 */ id,
      /* 固定父创建不应额外领取另一份租约。 */ method,
      /* 原命令参数。 */ params,
      /* 会话拥有的取消信号。 */ signal,
    ) => {
      // 选择新子节点可以结束旧Inspector授权，创建本身仍复用原租约。
      if (method === 'branch.release') return success({ released: true, ownershipRevision: 2 })
      if (method !== 'graph.apply') return normalDispatch(id, method, params, signal)
      const next = childWriteSnapshot(f.initial, params)
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [next.nodes[next.nodes.length - 1].id], createdEdgeIds: [next.edges[next.edges.length - 1].id] })
    })

    expect(await f.session.createChildNode({ mapId: 'map-a', parentId: 'source', expectedParentRevision: 2,
      childType: { id: childType.id, version: childType.version }, payload: { content: '原父授权下的子材料' } })).toBe(!partial)

    if (partial) {
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.session.selectedBranchGrant.value).toEqual(grant)
      expect(f.session.error.value?.message).toContain('释放')
    } else {
      const writes = f.dispatch.mock.calls.filter((
        /* 创建完成后所有公开命令。 */ call,
      ) => /* 只核对这次原子图写入，节点选中后的释放另由会话管理。 */ call[1] === 'graph.apply')
      expect(writes).toHaveLength(1)
      expect(writes[0][2].lease).toMatchObject({ leaseId: grant?.leaseId, fence: grant?.fence })
      expect(f.dispatch.mock.calls.some((
        /* 原授权被复用后的命令记录。 */ call,
      ) => /* 创建不应请求第二份父分支租约。 */ call[1] === 'branch.claim')).toBe(false)
    }
  })

  it('ignores a child creation proof arriving after a Map switch', async () => {
    // 旧父证明晚到不能创建子节点，也不能改变新图的选择或忙碌状态。
    const f = await openedChildren()
    expect(f.session).toHaveProperty('createChildNode', expect.any(Function))
    const pending = deferred<ReturnType<typeof branch>>()
    f.read.mockImplementationOnce(() => /* 只暂停当前父分支证明。 */ pending.promise)
    const creating = f.session.createChildNode({ mapId: 'map-a', parentId: 'source', expectedParentRevision: 2,
      childType: { id: childType.id, version: childType.version }, payload: { content: '旧图的子材料' } })
    expect(f.session.busy.value).toBe(true)
    await f.session.openMap('map-b', false)

    pending.resolve(branch(f.initial, ['source']))
    expect(await creating).toBe(false)

    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.session.busy.value).toBe(false)
  })

  it('does not replace a later selection when child creation confirms', async () => {
    // 创建在途时用户可转向另一个节点，成功只刷新数据，不抢回选择。
    const f = await openedChildren()
    const pending = deferred<ReturnType<typeof success>>()
    const started = deferred<void>()
    const normalDispatch = f.dispatchImplementation
    let write: CommandInputMap['graph.apply'] | undefined
    f.dispatch.mockImplementation(async (
      /* 本次创建的原请求身份。 */ id,
      /* 只暂停真实写入确认。 */ method,
      /* 本次原子差量。 */ params,
      /* 会话取消信号。 */ signal,
    ) => {
      // 其他分支或偏好操作保持正常，仅控制创建确认与用户切选的先后。
      if (method !== 'graph.apply') return normalDispatch(id, method, params, signal)
      write = params; started.resolve(undefined)
      return pending.promise
    })
    const creating = f.session.createChildNode({ mapId: 'map-a', parentId: 'source', expectedParentRevision: 2,
      childType: { id: childType.id, version: childType.version }, payload: { content: '晚到的子节点' } })
    await started.promise
    f.session.selectNode('wrong-target')
    if (!write) throw new Error(ChildSessionTestMessage.ATOMIC_WRITE_MISSING)
    const next = childWriteSnapshot(f.initial, write)
    f.snapshots.set('map-a', next)
    pending.resolve(success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [] }))
    expect(await creating).toBe(true)
    expect(f.session.snapshot.value?.nodes).toHaveLength(f.initial.nodes.length + 1)
    expect(f.session.selectedId.value).toBe('wrong-target')
  })

  it('retries uncertain child creation with its original node, edge and request identities', async () => {
    // 未确认写入不能换一组节点和边编号绕过原请求，恢复成功后仍选中原子节点。
    const f = await openedChildren()
    expect(f.session).toHaveProperty('createChildNode', expect.any(Function))
    const normalDispatch = f.dispatchImplementation
    let attempts = 0
    f.dispatch.mockImplementation(async (
      /* 初次提交与原请求重放应保持相同的身份。 */ id,
      /* 只控制这次子节点图写入的首次网络失败。 */ method,
      /* 包含本意图固定节点、边身份和原正文的参数。 */ params,
      /* 会话持有的请求取消信号。 */ signal,
    ) => {
      // 在重放确认时才交付完整快照，首次不改任何半状态。
      if (method !== 'graph.apply') return normalDispatch(id, method, params, signal)
      attempts++
      if (attempts === 1) throw error(0, 'NETWORK_ERROR', true)
      const next = childWriteSnapshot(f.initial, params)
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [next.nodes[next.nodes.length - 1].id], createdEdgeIds: [next.edges[next.edges.length - 1].id] })
    })
    const input: ChildInput = { mapId: 'map-a', parentId: 'source', expectedParentRevision: 2,
      childType: { id: childType.id, version: childType.version }, payload: { content: '原始子节点正文' } }
    expect(await f.session.createChildNode(input)).toBe(false)
    expect(f.session.canRetry.value).toBe(true)
    expect(f.session.snapshot.value).toEqual(f.initial)
    const original = f.dispatch.mock.calls.map((
      /* 结果不确定的首次公开请求。 */ call,
    ) => /* 复制编号、方法、节点和边参数以核对原样重放。 */ structuredClone(call.slice(0, 3)))
    expect(original).toHaveLength(1)

    expect(await f.session.createChildNode({ ...input, payload: { content: '不得替换原意图的新正文' } })).toBe(false)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.session.canRetry.value).toBe(true)
    expect(await f.session.retry()).toBe(true)

    const writes = f.dispatch.mock.calls.filter((
      /* 初次发送与恢复确认后的命令记录。 */ call,
    ) => /* 排除异步偏好保存，只核对原子图请求。 */ call[1] === 'graph.apply').map((
      /* 当前发送的请求编号、方法和参数。 */ call,
    ) => /* 本意图的节点、边和正文都不能在恢复时变化。 */ call.slice(0, 3))
    expect(writes).toEqual([original[0], original[0]])
    const child = f.session.snapshot.value?.nodes.find((
      /* 恢复后真实快照中的节点。 */ node,
    ) => /* 原正文而非被拒绝的新正文决定这次已确认子节点。 */ node.payload.content === '原始子节点正文')
    expect(child).toBeDefined()
    expect(f.session.selectedId.value).toBe(child?.id)
    expect(f.session.snapshot.value).toEqual(await f.gateway.read('map.get', { mapId: 'map-a' }))
    expect(f.session.canRetry.value).toBe(false)
  })

  it.each([false, true])('saves declared payload references without an explicit reference edge; wrong type: %s', async (
    /* 目标是否使用声明之外的精确数据类型。 */ wrongType,
  ) => {
    // 引用只更新已声明payload数组，派生索引由后端返回，不制造GraphEdge.reference。
    const f = await openedChildren()
    expect(f.session).toHaveProperty('saveNodeReferences', expect.any(Function))
    f.dispatch.mockImplementationOnce(async (
      /* 这次payload字段写入的公开身份。 */ _id,
      /* 已声明引用使用既有graph.apply。 */ method,
      /* 仅更新引用字段而保留原正文的差量。 */ params,
    ) => {
      // 仅为合法目标交付带派生索引的服务端快照，不接受UI自带派生字段。
      expect(method).toBe('graph.apply')
      expect(params.changes).not.toHaveProperty('edges')
      expect(params.changes.nodes.put).toHaveLength(1)
      const saved = params.changes.nodes.put[0]
      expect(saved).toMatchObject({ id: 'source', typeId: parentType.id, typeVersion: parentType.version,
        payload: { content: 'News line one\nNews line two\nNews line three', linkedIds: ['map-a-claim'] } })
      expect(saved).not.toHaveProperty('payloadReferences')
      const next = structuredClone(f.initial)
      next.revision++
      next.nodes = next.nodes.map((
        /* 原图中的真实节点。 */ node,
      ) => /* 服务端只替换引用来源节点，其他节点和来源边保持原值。 */ node.id === 'source'
        ? { ...node, ...saved, revision: node.revision + 1, payloadReferences: [{ path: '/linkedIds/*', targetId: 'map-a-claim' }] } : node)
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [] })
    })

    expect(await f.session.saveNodeReferences({ mapId: 'map-a', nodeId: 'source', expectedNodeRevision: 2,
      path: '/linkedIds', targetIds: [wrongType ? 'wrong-target' : 'map-a-claim'] })).toBe(!wrongType)

    if (wrongType) {
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.session.snapshot.value).toEqual(f.initial)
    } else {
      expect(f.dispatch).toHaveBeenCalledTimes(1)
      expect(f.session.snapshot.value?.edges).toEqual(f.initial.edges)
      expect(f.session.snapshot.value?.nodes.find((
        /* 返回快照中的引用来源节点。 */ node,
      ) => /* 使用稳定来源身份核对后端派生索引。 */ node.id === 'source')?.payloadReferences).toEqual([{ path: '/linkedIds/*', targetId: 'map-a-claim' }])
    }
  })

  it('adds, revises, removes and explicitly clears node library references using only consumer authority', async () => {
    // 库引用是消费者元信息；每次保存原正文和类型，仅授权消费者，不创建来源节点或边。
    const f = await opened(true)
    expect(f.session).toHaveProperty('saveNodeEvidence', expect.any(Function))
    let current = map('map-a')
    f.dispatch.mockImplementation(async (
      /* 本次消费者元信息提交的公开身份。 */ _id,
      /* 库引用沿用既有graph.apply命令。 */ method,
      /* 原正文及完整引用数组的差量。 */ params,
    ) => {
      // 只交付消费者节点的新版本，不模拟库原图、条目校验或使用账本。
      expect(method).toBe('graph.apply')
      expect(params.branch.rootIds).toEqual(['map-a-claim'])
      expect(params.branch.expectedVersion).not.toBeNull()
      expect(params.changes).not.toHaveProperty('edges')
      expect(params.changes.nodes.put).toHaveLength(1)
      const saved = params.changes.nodes.put[0]
      expect(saved).toMatchObject({ id: 'map-a-claim', typeId: claimType.id, typeVersion: claimType.version, payload: { content: 'map-a content' } })
      expect(saved).not.toHaveProperty('producer')
      expect(saved).not.toHaveProperty('manualOrigin')
      current = { ...structuredClone(current), revision: current.revision + 1,
        nodes: [{ ...current.nodes[0], ...saved, revision: current.nodes[0].revision + 1 }] }
      f.snapshots.set('map-a', current)
      return success({ snapshot: current, createdNodeIds: [], createdEdgeIds: [] })
    })
    const added = nodeEvidenceRefs()
    const revised = added.map((
      /* 首次提交的两个固定引用。 */ ref,
      /* 第一个引用只修改本次使用理由。 */ index,
    ) => /* 固定entry与digest不随理由编辑改变。 */ ({ ...ref, reason: index === 0 ? '补充第一份材料的使用理由。' : ref.reason }))
    const transitions: EvidenceUseRef[][] = [added, revised, [revised[1]], []]

    for (const refs of transitions) {
      const expectedNodeRevision = current.nodes[0].revision
      expect(await f.session.saveNodeEvidence({ mapId: 'map-a', nodeId: 'map-a-claim', expectedNodeRevision, refs })).toBe(true)
      expect(f.session.snapshot.value?.nodes[0].libraryClaimRefs).toEqual(refs)
    }

    expect(f.dispatch).toHaveBeenCalledTimes(4)
    expect(f.session.snapshot.value?.nodes[0].payload).toEqual({ content: 'map-a content' })
    expect(f.session.snapshot.value?.nodes[0].libraryClaimRefs).toEqual([])
    expect(f.session.snapshot.value?.edges).toEqual([])
  })

  it('omits library references during ordinary payload saving so the server preserves them', async () => {
    // 正文保存不把未编辑的库引用解释成清空，显式清除仅由独立引用意图提交[]。
    const f = await opened(true)
    const initial = map('map-a', 'workspace-a', 2)
    initial.nodes[0].libraryClaimRefs = nodeEvidenceRefs()
    f.snapshots.set('map-a', initial)
    f.streams[0].emit({ type: 'snapshot', snapshot: initial })
    f.dispatch.mockImplementationOnce(async (
      /* 正文保存本身的原始请求身份。 */ _id,
      /* 正文仍沿既有图写入路径。 */ method,
      /* 只包含用户正在编辑的payload字段。 */ params,
    ) => {
      // 返回后端保留旧元信息的新版本，测试客户端不发送空数组覆盖旧引用。
      expect(method).toBe('graph.apply')
      const saved = params.changes.nodes.put[0]
      expect(saved).not.toHaveProperty('libraryClaimRefs')
      const next = { ...structuredClone(initial), revision: 3,
        nodes: [{ ...initial.nodes[0], ...saved, revision: 1 }] }
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [] })
    })

    expect(await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: branch(initial, ['map-a-claim']).version },
      nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: claimType.version, payload: { content: '更新后的正文' } })).toBe(true)

    expect(f.session.snapshot.value?.nodes[0]).toMatchObject({ payload: { content: '更新后的正文' }, libraryClaimRefs: nodeEvidenceRefs() })
  })

  it.each(['revision', 'viewer', 'capability'] as const)('rejects node evidence changes when the %s does not allow them', async (
    /* 原节点版本、用户角色或服务能力中的拒绝条件。 */ blocked,
  ) => {
    // 不用新证明提升旧节点版本，也不能从会话绕过只读或服务能力限制。
    const f = await opened(true)
    expect(f.session).toHaveProperty('saveNodeEvidence', expect.any(Function))
    if (blocked === 'viewer') {
      f.workspaces.set('workspace-a', { ...workspace('workspace-a'), role: 'viewer' })
      await f.session.refreshWorkspace()
    }
    if (blocked === 'capability') {
      f.bootstrap.metadata.capabilities = { mapRename: true, evidenceLibrary: false }
      await f.session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
      await f.session.openMap('map-a', false)
    }
    f.dispatch.mockClear()

    expect(await f.session.saveNodeEvidence({ mapId: 'map-a', nodeId: 'map-a-claim', expectedNodeRevision: blocked === 'revision' ? 99 : 0,
      refs: nodeEvidenceRefs() })).toBe(false)

    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.session.snapshot.value).toEqual(map('map-a'))
  })

  it('retries frozen node evidence references without replacing the original request or reason', async () => {
    // 不确定结果保持原身份和完整引用副本，新理由不能越过已有原请求恢复。
    const f = await opened(true)
    expect(f.session).toHaveProperty('saveNodeEvidence', expect.any(Function))
    const refs = nodeEvidenceRefs()
    const normalDispatch = f.dispatchImplementation
    let attempts = 0
    f.dispatch.mockImplementation(async (
      /* 首次与重放应保持相同的幂等身份。 */ id,
      /* 只让被测消费者图写入首次网络失败。 */ method,
      /* 包含独立引用和理由副本的完整冻结参数。 */ params,
      /* 会话持有的传输取消信号。 */ signal,
    ) => {
      // 重放成功才交付消费者新版本，库状态和索引由真实后端测试覆盖。
      if (method !== 'graph.apply') return normalDispatch(id, method, params, signal)
      attempts++
      if (attempts === 1) throw error(0, 'NETWORK_ERROR', true)
      const saved = params.changes.nodes.put[0]
      const next = map('map-a', 'workspace-a', 2)
      next.nodes[0] = { ...next.nodes[0], ...saved, revision: 1 }
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [] })
    })
    expect(await f.session.saveNodeEvidence({ mapId: 'map-a', nodeId: 'map-a-claim', expectedNodeRevision: 0, refs })).toBe(false)
    expect(f.session.canRetry.value).toBe(true)
    const original = f.dispatch.mock.calls.map((
      /* 首次发送的请求编号、方法及引用参数。 */ call,
    ) => /* 复制首次真实请求，不从后续可变草稿重建预期。 */ structuredClone(call.slice(0, 3)))
    expect(original).toHaveLength(1)
    refs[0].reason = '后续草稿不能进入原收据。'

    expect(await f.session.saveNodeEvidence({ mapId: 'map-a', nodeId: 'map-a-claim', expectedNodeRevision: 0, refs: [] })).toBe(false)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.session.canRetry.value).toBe(true)
    expect(await f.session.retry()).toBe(true)

    expect(f.dispatch.mock.calls.map((
      /* 原请求首次发送和确认重放记录。 */ call,
    ) => /* 请求身份、完整payload和引用理由一起保持原值。 */ call.slice(0, 3))).toEqual([original[0], original[0]])
    expect(f.session.snapshot.value?.nodes[0].libraryClaimRefs).toEqual(nodeEvidenceRefs())
    expect(f.session.canRetry.value).toBe(false)
  })

  it('drops a node evidence write when its consumer proof arrives after a Map switch', async () => {
    // 只读证明晚到不能写入已离开的消费者，也不能污染新图的选择或错误。
    const f = await opened(true)
    expect(f.session).toHaveProperty('saveNodeEvidence', expect.any(Function))
    const pending = deferred<ReturnType<typeof branch>>()
    f.read.mockImplementationOnce(() => /* 暂停消费者自己的分支证明。 */ pending.promise)
    const saving = f.session.saveNodeEvidence({ mapId: 'map-a', nodeId: 'map-a-claim', expectedNodeRevision: 0, refs: nodeEvidenceRefs() })
    await f.session.openMap('map-b', false)

    pending.resolve(branch(map('map-a'), ['map-a-claim']))
    expect(await saving).toBe(false)

    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.session.error.value).toBeNull()
    expect(f.session.busy.value).toBe(false)
  })

  it('uses local capabilities to edit, start and control without any client lease commands or timers', async () => {
    const f = fakeGateway()
    f.bootstrap.metadata.clientLeases = 'none'
    const session = sessionCreateState(f.gateway, 100)
    sessions.push(session)
    await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
    await session.openMap('map-a', false)
    expect(session.clientLeasesRequired.value).toBe(false)
    const edited = map('map-a', 'workspace-a', 2)
    edited.nodes[0].revision++
    edited.nodes[0].payload.content = 'Local edit'
    f.dispatch.mockResolvedValueOnce(success({ snapshot: edited, createdNodeIds: [], createdEdgeIds: [] }))
    expect(await session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' },
      nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: 'Local edit' } })).toBe(true)
    f.snapshots.set('map-a', edited)
    let runId = ''
    f.dispatch.mockImplementationOnce(async (_id, method, params) => {
      expect(method).toBe('run.start'); expect(params).not.toHaveProperty('lease')
      runId = params.id
      const running = processingMap(false, 3)
      running.nodes = edited.nodes; running.runControls = []; running.runs[0].id = runId
      f.snapshots.set('map-a', running)
      return success({ snapshot: running, createdNodeIds: [], createdEdgeIds: [] })
    })
    expect(await session.startRun({ scope: { nodeIds: ['map-a-claim'] }, plan: emptyPlan, mode: 'human-in-loop' })).toBe(true)
    const paused = structuredClone(f.snapshots.get('map-a')!)
    paused.revision++; paused.runs[0].paused = true
    f.dispatch.mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [] }))
    await session.pauseRun({ mapId: 'map-a', runId })
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['graph.apply', 'run.start', 'run.pause'])
    expect(f.dispatch.mock.calls[0][2]).not.toHaveProperty('lease')
    expect(f.dispatch.mock.calls[2][2]).not.toHaveProperty('control')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.dispatch.mock.calls.some(call => call[1].startsWith('branch.') || call[1].startsWith('run.control.'))).toBe(false)
    expect(session.selectedBranchGrant.value).toBeNull()
    expect(session.selectedRunControl.value).toBeNull()
  })

  // 覆盖会话隔离、实时流、版本仲裁、原命令重试和视图清理。
  it('loads and refreshes the workspace definition catalog as session state', async () => {
    const f = await opened()
    expect(f.session.definitions.value).toMatchObject({ workspaceId: 'workspace-a', catalog: { revision: 1 } })
    definitions.catalog.revision = 2
    await f.session.refreshWorkspace()
    expect(f.session.catalog.value?.revision).toBe(2)
    expect(f.read.mock.calls.some(call => call[0] === 'definition.get' && call[1].workspaceId === 'workspace-a')).toBe(true)
    definitions.catalog.revision = 1
  })
  it('replaces unexpected client exceptions with a safe message and a diagnostic id', async () => {
    // 验证意外异常被替换为安全提示和诊断编号，不泄露原始私密信息。
    const f = await opened()
    f.read.mockRejectedValueOnce(new Error('private-token at /Users/private/file'))
    await f.session.refresh()
    expect(f.session.error.value).toMatchObject({ code: 'CLIENT_ERROR', message: '操作失败，请根据错误编号查看诊断。', errorId: expect.any(String) })
    expect(JSON.stringify(f.session.error.value)).not.toMatch(/private-token|\/Users\/private/)
  })
  it.each(['toString', 'constructor', '__proto__'])('原型名称错误码 %s 仍保留远端字符串文案', async (
    /* 远端允许传入、但与对象原型属性同名的稳定错误码。 */ code,
  ) => {
    // 错误文案表只翻译实际登记的码，不能把继承属性当成提示文案。
    const f = await opened()
    f.read.mockRejectedValueOnce(new ClientError({ code, message: '远端业务失败', status: 422, retryable: false }))
    await f.session.refresh()
    expect(f.session.error.value).toMatchObject({ code, message: '远端业务失败', status: 422 })
  })
  it('keeps activity separate from snapshot revision and clears it on pause, disconnect and map switch', async () => {
    // 验证活动摘要不修改快照版本，暂停、断流和切图会清空失效活动。
    const f = await opened()
    const next = processingMap()
    next.runs[0].status = 'running'
    next.runs[0].operations[0].status = 'running'
    const activity = { mapId: next.mapId, runId: next.runs[0].id, operationId: 'operation-a', nodeId: 'map-a-claim', workId: 'work',
      stageId: 'route', slotId: 'route', agentName: 'Router', status: 'model' as const, fence: 1, sequence: 1, updatedAt: time }
    f.streams[0].emit({ type: 'snapshot', snapshot: next })
    f.streams[0].emit({ type: 'activity', items: [activity] })
    expect(f.session.activities.value).toEqual([activity])
    expect(f.session.snapshot.value?.revision).toBe(next.revision)
    f.streams[0].emit({ type: 'snapshot', snapshot: { ...next, revision: 3, runs: [{ ...next.runs[0], paused: true }] } })
    f.streams[0].emit({ type: 'activity', items: [activity] })
    expect(f.session.activities.value).toEqual([])
    f.streams[0].emit({ type: 'snapshot', snapshot: { ...next, revision: 4 } })
    f.streams[0].emit({ type: 'activity', items: [activity] })
    f.streams[0].reject(error(0, 'NETWORK_ERROR', true))
    await vi.advanceTimersByTimeAsync(1)
    expect(f.session.activities.value).toEqual([])
    await f.session.openMap('map-b', false)
    f.streams[0].emit({ type: 'activity', items: [activity] })
    expect(f.session.activities.value).toEqual([])
  })

  it.each(['capability', 'version', 'blank-version'] as const)('requires a publication preview before approving when %s is missing', async (
    /* 当前用例缺失的能力或已展示版本。 */ missing,
  ) => {
    // 独立证明旧入口确实会批准缺版本的结果，而非只因新增模块缺失得到红灯。
    const f = await openedReview(true, missing !== 'capability')
    const input = reviewAnswerInput()
    if (missing === 'version') delete input.expectedPublicationVersion
    if (missing === 'blank-version') input.expectedPublicationVersion = '   '
    f.dispatch.mockResolvedValueOnce(success({ snapshot: processingMap(), createdNodeIds: [], createdEdgeIds: [] }))

    await f.session.answerReview(input)

    expect(f.dispatch, missing).not.toHaveBeenCalled()
  })

  it.each(['map', 'run', 'selection', 'operation', 'operation-running', 'review', 'revision', 'answered', 'completed'] as const)(
    'checks the current review before claiming control when %s differs', async (
      /* 与当前页面审核不一致的身份或状态。 */ mismatch,
    ) => {
      // 每个身份差异都从可正常审核的状态出发，保证旧入口实际向服务提交而新入口提前停止。
      const f = await openedReview(false)
      const input = reviewAnswerInput()
      const run = f.session.selectedRun.value
      if (mismatch === 'map') input.mapId = 'map-b'
      if (mismatch === 'run') input.runId = 'run-b'
      if (mismatch === 'selection') f.session.selectedRunId.value = null
      if (mismatch === 'operation') input.operationId = 'operation-b'
      if (mismatch === 'operation-running' && run) run.operations[0].status = 'running'
      if (mismatch === 'review') input.reviewId = 'review-b'
      if (mismatch === 'revision') input.expectedReviewRevision = 1
      if (mismatch === 'answered' && run?.operations[0].review) run.operations[0].review.state = 'answered'
      if (mismatch === 'completed' && run) run.status = 'completed'
      f.dispatch.mockResolvedValueOnce(controlled()).mockResolvedValueOnce(success({ snapshot: processingMap(), createdNodeIds: [], createdEdgeIds: [] }))

      await f.session.answerReview(input)

      expect(f.dispatch, mismatch).not.toHaveBeenCalled()
  })

  it.each(['readonly', 'busy', 'retry'] as const)('blocks new review intents while %s', async (
    /* 当前会话不接受新写入的原因。 */ blocker,
  ) => {
    // 新审核不能绕过只读身份，也不能用新请求覆盖在途或结果未知的原命令。
    const f = await openedReview(false)
    if (blocker === 'readonly') {
      const current = f.workspaces.get('workspace-a')
      if (current) current.role = 'viewer'
      await f.session.refreshWorkspace()
    }
    if (blocker === 'busy') f.session.busy.value = true
    if (blocker === 'retry') f.session.canRetry.value = true
    f.dispatch.mockResolvedValueOnce(controlled()).mockResolvedValueOnce(success({ snapshot: processingMap(), createdNodeIds: [], createdEdgeIds: [] }))

    await f.session.answerReview(reviewAnswerInput())

    expect(f.dispatch, blocker).not.toHaveBeenCalled()
    if (blocker === 'retry') expect(f.session.canRetry.value).toBe(true)
  })

  it('copies the displayed review version before waiting for Run control', async () => {
    // 调用方在领取期间复用同一个表单对象时，本次批准仍固定点击时看到的发布版本。
    const f = await openedReview(false)
    const pending = deferred<ReturnType<typeof controlled>>()
    f.dispatch.mockImplementationOnce(() => /* 暂停控制权确认，留出修改外部表单的时机。 */ pending.promise)
      .mockResolvedValueOnce(success({ snapshot: processingMap(false, 3), createdNodeIds: [], createdEdgeIds: [] }))
    const input = reviewAnswerInput()
    const saving = f.session.answerReview(input)
    input.expectedPublicationVersion = 'publication-after-click'
    pending.resolve(controlled())
    await saving

    const answer = f.dispatch.mock.calls.find((/* 本次公开写命令记录。 */ call) => /* 提取实际审核提交。 */ call[1] === 'review.answer')
    expect(answer?.[2]).toMatchObject({ expectedPublicationVersion: 'publication-a', reviewId: 'review-a', control: { leaseId: runControl.leaseId } })
  })

  it.each(['map', 'selection', 'review', 'permission'] as const)('drops a review intent when %s changes while claiming Run control', async (
    /* 控制权等待期间失效的当前页面目标。 */ changed,
  ) => {
    // 迟到控制权不能替已经离开的 Run 或已换版的审核继续批准。
    const f = await openedReview(false)
    const pending = deferred<ReturnType<typeof controlled>>()
    f.dispatch.mockImplementationOnce(() => /* 保持旧目标控制权请求在途。 */ pending.promise)
      .mockResolvedValueOnce(success({ snapshot: processingMap(), createdNodeIds: [], createdEdgeIds: [] }))
    const saving = f.session.answerReview(reviewAnswerInput())
    if (changed === 'map') await f.session.openMap('map-b', false)
    if (changed === 'selection') await f.session.selectRun(null)
    if (changed === 'permission' && f.session.workspace.value) f.session.workspace.value = { ...f.session.workspace.value, role: 'viewer' }
    if (changed === 'review') {
      const review = f.session.selectedRun.value?.operations[0].review
      if (review) review.revision++
    }
    pending.resolve(controlled())
    await saving

    expect(f.dispatch.mock.calls.some((/* 领取后的全部公开命令。 */ call) => /* 旧意图不得发出审核写入。 */ call[1] === 'review.answer'), changed).toBe(false)
    if (changed === 'selection') expect(f.session.selectedRunId.value).toBeNull()
    if (changed === 'map') expect(f.session.activeMapId.value).toBe('map-b')
  })

  it('drops the old review click after selecting Run A, B and A while its claim is pending', async () => {
    // 返回同一个运行也属于新的查看意图，不能借迟到控制权恢复离开前的批准点击。
    const f = await openedReview(false)
    const multi = processingMap()
    multi.runs.push({ ...currentRun(), id: 'run-b', scope: { nodeIds: ['map-a-claim-b'] } })
    f.snapshots.set('map-a', multi)
    await f.session.refresh()
    const pending = deferred<ReturnType<typeof controlled>>()
    f.dispatch.mockImplementationOnce(() => /* 暂停第一次查看 A 时的控制权确认。 */ pending.promise)
      .mockResolvedValueOnce(success({ snapshot: multi, createdNodeIds: [], createdEdgeIds: [] }))
    const saving = f.session.answerReview(reviewAnswerInput())
    await f.session.selectRun('run-b')
    await f.session.selectRun('run-a')
    pending.resolve(controlled())
    await saving

    expect(f.session.selectedRunId.value).toBe('run-a')
    expect(f.dispatch.mock.calls.some((/* 本次点击后的所有公开命令。 */ call) => /* 旧点击不应恢复成审核提交。 */ call[1] === 'review.answer')).toBe(false)
  })

  it('never borrows a control proof from another Run for a review answer', async () => {
    // 即使同会话遗留另一个 Run 的租约，也必须为本次目标重新确认控制权。
    const f = await openedReview(false)
    f.session.selectedRunControl.value = { ...runControl, runId: 'run-b', leaseId: '44444444-4444-4444-8444-444444444444', ownershipRevision: 1 }
    f.dispatch.mockImplementation(async (
      /* 网关接收的幂等编号，由会话生成。 */ _requestId,
      /* 根据真实命令选择有效响应，避免顺序错误退化为畸形夹具异常。 */ method,
    ) => {
      // 所有路径都返回各自有效响应，使旧入口真正借用错误控制证明后由断言揭露。
      if (method === 'run.control.claim') return controlled()
      if (method === 'run.control.release') return success({ released: true })
      return success({ snapshot: processingMap(false, 3), createdNodeIds: [], createdEdgeIds: [] })
    })

    await f.session.answerReview(reviewAnswerInput())

    expect(f.dispatch.mock.calls.map((/* 控制权交接及审核提交的有序记录。 */ call) => /* 比较公开动作顺序。 */ call[1]))
      .toEqual(['run.control.release', 'run.control.claim', 'review.answer'])
    expect(f.dispatch.mock.calls[2]?.[2]).toMatchObject({ runId: 'run-a', control: { leaseId: runControl.leaseId } })
  })

  it.each(['paused-approve', 'plan-approve', 'reject'] as const)('keeps local %s independent of client leases', async (
    /* 原有本机审核语义：暂停批准、规划批准或拒绝。 */ decision,
  ) => {
    // 发布预览只约束新结果批准，暂停和规划/拒绝原有语义保留，本机不领取控制租约。
    const f = await openedReview(true, decision === 'paused-approve')
    const input = reviewAnswerInput()
    const run = f.session.selectedRun.value
    if (decision === 'paused-approve' && run) run.paused = true
    if (decision === 'plan-approve' && run?.operations[0].review) run.operations[0].review.kind = 'plan'
    if (decision !== 'paused-approve') delete input.expectedPublicationVersion
    if (decision === 'reject') input.decision = 'reject'
    f.dispatch.mockResolvedValueOnce(success({ snapshot: processingMap(decision === 'paused-approve', 3), createdNodeIds: [], createdEdgeIds: [] }))

    await f.session.answerReview(input)

    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.dispatch.mock.calls[0][1]).toBe('review.answer')
    expect(f.dispatch.mock.calls[0][2]).not.toHaveProperty('control')
    expect(f.dispatch.mock.calls[0][2]).toMatchObject(input)
  })

  it('confirms the original review request and version after publication already became terminal', async () => {
    // 成功丢回包后，终态推送不能阻止原编号确认，也不能将后续表单版本替换进原请求。
    const f = await openedReview()
    f.dispatch.mockRejectedValueOnce(error(0, 'RESPONSE_LOST', true))
    const input = reviewAnswerInput()
    await f.session.answerReview(input)
    const original = f.dispatch.mock.calls[0].slice(0, 3)
    expect(f.session.canRetry.value).toBe(true)
    const completed = processingMap(false, 3)
    completed.runs[0].status = 'completed'
    const review = completed.runs[0].operations[0].review
    if (review) { review.state = 'answered'; review.decision = 'approve'; review.revision++ }
    f.snapshots.set('map-a', completed)
    f.streams[0].emit({ type: 'snapshot', snapshot: completed })
    input.expectedPublicationVersion = 'another-version'
    f.dispatch.mockResolvedValueOnce(success({ snapshot: completed, createdNodeIds: ['published-a'], createdEdgeIds: [] }))

    expect(await f.session.retry()).toBe(true)

    expect(f.dispatch.mock.calls.map((/* 首次审核与原请求确认。 */ call) => /* 比较编号、方法和完整参数。 */ call.slice(0, 3))).toEqual([original, original])
    expect(f.session.snapshot.value?.runs[0].status).toBe('completed')
    expect(f.session.canRetry.value).toBe(false)
  })

  it('keeps a paused run branch protected while allowing an independent new root', async () => {
    // 验证暂停运行仍保护自己的范围，但不会把同图中新建的独立根降级为整图锁。
    const f = await opened()
    f.snapshots.set('map-a', processingMap())
    await f.session.refresh()
    const late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => /* 延迟旧图读取，供暂停命令先返回较新快照。 */ late.promise)
    const poll = f.session.refresh()
    const paused = processingMap(true, 3)
    f.snapshots.set('map-a', paused)
    f.dispatch.mockResolvedValueOnce(controlled()).mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.pauseRun({ mapId: 'map-a', runId: 'run-a' })
    late.resolve(processingMap(false, 2))
    await poll
    expect(f.session.snapshot.value?.runs[0]?.paused).toBe(true)
    expect(f.session.active.value).toBe(true)
    const withIndependentRoot = processingMap(true, 4)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: withIndependentRoot, createdNodeIds: ['new-root'], createdEdgeIds: [],
      branch: { scope: { rootIds: ['new-root'], nodeIds: ['new-root'], edgeIds: [] }, version: 'new-root-v1', rootRevisions: { 'new-root': 0 }, mapRevision: 4 } }))
    expect(await f.session.createNode(claimType, { content: 'Independent edit' })).toBe(true)
    expect(f.dispatch.mock.calls.find(call => call[1] === 'graph.apply')?.[2]).toMatchObject({ branch: { expectedVersion: null } })
    await f.session.startRun({ scope: { nodeIds: ['map-a-claim'] }, plan: emptyPlan, mode: 'auto' })
    expect(f.dispatch).toHaveBeenCalledTimes(3)
    const approved = processingMap(true, 5)
    approved.runs[0].operations[0].review!.state = 'answered'
    f.dispatch.mockResolvedValueOnce(success({ snapshot: approved, createdNodeIds: [], createdEdgeIds: [] }))
    const bootstrap = f.session.bootstrap.value
    if (bootstrap) bootstrap.metadata.capabilities = { ...bootstrap.metadata.capabilities, publicationPreview: true }
    await f.session.answerReview({ mapId: 'map-a', runId: 'run-a', operationId: 'operation-a', reviewId: 'review-a', expectedReviewRevision: 0,
      decision: 'approve', expectedPublicationVersion: 'paused-publication' })
    expect(f.session.snapshot.value?.runs[0]?.paused).toBe(true)
    expect(f.dispatch.mock.calls.find(call => call[1] === 'review.answer')?.[2]).toMatchObject({ operationId: 'operation-a', control: { leaseId: runControl.leaseId } })
    const reads = f.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)
    expect(f.read.mock.calls).toHaveLength(reads)
    f.streams[0].emit({ type: 'snapshot', snapshot: approved })
    expect(f.session.snapshot.value?.runs[0]?.paused).toBe(true)
    await f.session.closeMap('map-a')
    expect(f.dispatch.mock.calls.some(call =>
      /* 检测关闭标签时是否错误发出了取消或恢复运行命令。 */
      call[1] === 'run.cancel' || call[1] === 'run.resume')).toBe(false)
  })

  it('submits explicit node scope and resumes the same Run with its accepted state', async () => {
    // 验证新运行提交显式节点范围，恢复保留同一 Run 与审核状态，权限刷新后阻止写操作。
    const f = await opened()
    const paused = processingMap(true)
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
      .mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [], runControl: { ...runControl, ownershipRevision: 1 } }))
    await f.session.startRun({ scope: { nodeIds: ['map-a-claim'] }, plan: emptyPlan, mode: 'human-in-loop', regenerate: true })
    const startCall = f.dispatch.mock.calls.find(call => call[1] === 'run.start')!
    expect(startCall[2]).toMatchObject({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' },
      scope: { nodeIds: ['map-a-claim'] }, plan: emptyPlan, regenerate: true })
    expect(startCall[2]).not.toHaveProperty('targetId')
    expect(startCall[2]).not.toHaveProperty('expectedRevision')
    const resumed = processingMap(false, 3)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: resumed, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.resumeRun({ mapId: 'map-a', runId: 'run-a' })
    expect(f.session.snapshot.value?.runs[0]).toMatchObject({ id: 'run-a', paused: false, operations: [{ id: 'operation-a', review: { id: 'review-a', state: 'pending' } }] })
    f.workspaces.get('workspace-a')!.role = 'viewer'
    await f.session.refreshWorkspace()
    await f.session.pauseRun({ mapId: 'map-a', runId: 'run-a' })
    expect(f.dispatch).toHaveBeenCalledTimes(3)
  })

  it('keeps Run controls read-only while occupied and enables them after takeover', async () => {
    const f = await opened(), running = processingMap(false, 2)
    f.snapshots.set('map-a', running)
    await f.session.refresh()
    f.dispatch.mockResolvedValueOnce(success({ status: 'busy', control: { ...runControl } }))
    await f.session.pauseRun({ mapId: 'map-a', runId: 'run-a' })
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['run.control.claim'])
    expect(f.session.selectedRunControl.value).toBeNull()

    const available = { ...running, ownershipRevision: 2, runControls: [] }
    f.streams[0].emit({ type: 'snapshot', snapshot: available })
    const paused = { ...processingMap(true, 3), ownershipRevision: 3 }
    f.dispatch.mockResolvedValueOnce(controlled()).mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.pauseRun({ mapId: 'map-a', runId: 'run-a' })
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['run.control.claim', 'run.control.claim', 'run.pause'])
    expect(f.dispatch.mock.calls[2][2]).toMatchObject({ control: { leaseId: runControl.leaseId, fence: runControl.fence } })
    expect(f.session.snapshot.value?.runs[0]?.paused).toBe(true)
  })

  it('selects one of multiple Runs and releases the previous control', async () => {
    const f = await opened(), multi = processingMap(false, 2)
    multi.runs.push({ ...structuredClone(multi.runs[0]), id: 'run-b', scope: { nodeIds: ['map-a-claim-b'] } })
    f.snapshots.set('map-a', multi)
    await f.session.refresh()
    expect(f.session.selectedRun.value?.id).toBe('run-a')
    f.dispatch.mockResolvedValueOnce(controlled())
      .mockResolvedValueOnce(success({ released: true, ownershipRevision: 2 }))
    expect(await f.session.claimRunControl('run-a')).toBe(true)
    await f.session.selectRun('run-b')
    expect(f.session.selectedRun.value?.id).toBe('run-b')
    expect(f.session.selectedRunControl.value).toBeNull()
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['run.control.claim', 'run.control.release'])
  })

  it('releases a late Run A claim after selecting B without ending B claim busy ownership', async () => {
    // 后端先确认A但延迟回应，B领取仍在途时旧A清理只交回A，不能抢回选择或结束B任务。
    const f = await openedReview(false)
    const multi = processingMap(false, 3)
    multi.runControls = []
    multi.nodes.push({ ...multi.nodes[0], id: 'map-a-claim-b' })
    multi.runs.push(JSON.parse(JSON.stringify(currentRun()).replaceAll('run-a', 'run-b')
      .replaceAll('map-a-claim', 'map-a-claim-b').replaceAll('operation-a', 'operation-b')))
    f.snapshots.set('map-a', multi)
    await f.session.refresh()
    const old = deferred<ReturnType<typeof controlled>>(), next = deferred<ReturnType<typeof controlled>>()
    let oldReply: ReturnType<typeof controlled> | undefined, nextReply: ReturnType<typeof controlled> | undefined
    f.dispatch.mockImplementation(async (/* 请求身份。 */ _id, /* 实际公开方法。 */ method, /* 固定原参数。 */ params) => {
      // 只暂停两次领取回应，精确释放仍正常完成。
      if (method === 'run.control.release') return success({ released: true, ownershipRevision: 3 })
      expect(method).toBe('run.control.claim')
      if (params.runId === 'run-a') { oldReply = controlled(params.runId, params.holderId); return old.promise }
      nextReply = controlled(params.runId, params.holderId, 2)
      return next.promise
    })
    const first = f.session.claimRunControl('run-a')
    await vi.advanceTimersByTimeAsync(0)
    await f.session.selectRun('run-b')
    const latest = f.session.claimRunControl('run-b')
    await vi.advanceTimersByTimeAsync(0)
    if (!oldReply || !nextReply) throw new Error('Expected both public Run claim calls')
    old.resolve(oldReply)
    expect(await first).toBe(false)
    expect(f.session.selectedRunId.value).toBe('run-b')
    expect(f.session.selectedRunControl.value).toBeNull()
    expect(f.session.busy.value).toBe(true)
    expect(f.dispatch.mock.calls.filter((/* 真实请求记录。 */ call) => /* 旧A只清理自己的授权。 */ call[1] === 'run.control.release')
      .map((/* 精确释放参数。 */ call) => /* 观察被释放的Run。 */ call[2].runId)).toEqual(['run-a'])
    next.resolve(nextReply)
    expect(await latest).toBe(true)
    expect(f.session.selectedRunControl.value).toMatchObject({ runId: 'run-b' })
    expect(f.session.busy.value).toBe(false)
  })

  it.each(['accepted', 'pending'] as const)('keeps a newer same-lease A confirmation when its acknowledgement is %s', async (
    /* 新A确认已到达或仍在途中，两者都不能被旧A清理撤销。 */ timing,
  ) => {
    // A→B→A是新意图；同holder同Run合法复用lease/fence，旧ack需等待新确认明确后再决定释放。
    const f = await openedReview(false)
    const multi = processingMap(false, 3)
    multi.runControls = []
    multi.nodes.push({ ...multi.nodes[0], id: 'map-a-claim-b' })
    multi.runs.push(JSON.parse(JSON.stringify(currentRun()).replaceAll('run-a', 'run-b')
      .replaceAll('map-a-claim', 'map-a-claim-b').replaceAll('operation-a', 'operation-b')))
    f.snapshots.set('map-a', multi)
    await f.session.refresh()
    const old = deferred<ReturnType<typeof controlled>>(), next = deferred<ReturnType<typeof controlled>>()
    let calls = 0, firstReply: ReturnType<typeof controlled> | undefined, secondReply: ReturnType<typeof controlled> | undefined
    f.dispatch.mockImplementation(async (/* 请求身份。 */ _id, /* 当前公开方法。 */ method, /* 当时领取参数。 */ params) => {
      // 两次真实同Run领取先形成各自确认，只延迟运输结果。
      expect(method).toBe('run.control.claim')
      const reply = controlled(params.runId, params.holderId, ++calls)
      if (calls === 1) { firstReply = reply; return old.promise }
      secondReply = reply
      return next.promise
    })
    const first = f.session.claimRunControl('run-a')
    await vi.advanceTimersByTimeAsync(0)
    await f.session.selectRun('run-b')
    await f.session.selectRun('run-a')
    const latest = f.session.claimRunControl('run-a')
    await vi.advanceTimersByTimeAsync(0)
    if (!firstReply || !secondReply) throw new Error('Expected two same-lease Run confirmations')
    expect(firstReply.data.grant.leaseId).toBe(secondReply.data.grant.leaseId)
    if (timing === 'accepted') { next.resolve(secondReply); expect(await latest).toBe(true) }
    old.resolve(firstReply)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.dispatch.mock.calls.some((/* 此意图的全部请求。 */ call) => /* 旧确认不能撤销新确认或在途同Run领取。 */ call[1] === 'run.control.release')).toBe(false)
    if (timing === 'pending') {
      expect(f.session.busy.value).toBe(true)
      next.resolve(secondReply)
      expect(await latest).toBe(true)
    }
    expect(await first).toBe(false)
    expect(f.session.selectedRunControl.value).toEqual(secondReply.data.grant)
    expect(f.session.busy.value).toBe(false)
  })

  it.each(['run-a', 'run-c'])('keeps the newer %s selection when an earlier switch waits for release', async (
    /* B释放等待期间用户最后明确选择的运行，含返回A的意图。 */ latestRunId,
  ) => {
    // B先等待旧A释放，C或新A应立即成为当前选择，旧B的释放完成不再写回选择。
    const f = await openedReview(false)
    const multi = processingMap(false, 3)
    multi.runControls = []
    for (const suffix of ['b', 'c']) {
      multi.nodes.push({ ...multi.nodes[0], id: `map-a-claim-${suffix}` })
      multi.runs.push(JSON.parse(JSON.stringify(currentRun()).replaceAll('run-a', `run-${suffix}`)
        .replaceAll('map-a-claim', `map-a-claim-${suffix}`).replaceAll('operation-a', `operation-${suffix}`)))
    }
    f.snapshots.set('map-a', multi)
    await f.session.refresh()
    const pending = deferred<GraphSuccess<{ released: boolean; ownershipRevision: number }>>()
    f.dispatch.mockImplementation(async (/* 请求身份。 */ _id, /* 实际公开方法。 */ method, /* 原领取或释放参数。 */ params) => {
      // 只扣住已发送的旧A释放；当前选择不由夹具写入。
      if (method === 'run.control.claim') return controlled(params.runId, params.holderId)
      expect(method).toBe('run.control.release')
      return pending.promise
    })
    expect(await f.session.claimRunControl('run-a')).toBe(true)
    const selectingB = f.session.selectRun('run-b')
    await vi.advanceTimersByTimeAsync(0)
    await f.session.selectRun(latestRunId)
    expect(f.session.selectedRunId.value).toBe(latestRunId)
    pending.resolve(success({ released: true, ownershipRevision: 2 }))
    await selectingB
    expect(f.session.selectedRunId.value).toBe(latestRunId)
    expect(f.session.selectedRunControl.value).toBeNull()
  })

  it('changes the Run holder after an uncertain release so its late commit cannot revoke a reused grant', async () => {
    // 运输失败后旧释放仍可提交；新holder先遇旧占有只读，待旧释放完成才取得不同lease。
    const f = await openedReview(false)
    const current = processingMap(false, 3)
    current.runControls = []
    f.snapshots.set('map-a', current)
    await f.session.refresh()
    let authority: ReturnType<typeof controlled>['data']['grant'] | null = null
    let lateRelease: CommandInputMap['run.control.release'] | undefined
    let ownershipRevision = 0
    f.dispatch.mockImplementation(async (/* 原请求身份。 */ _id, /* 精确公开方法。 */ method, /* 原领取或释放参数。 */ params) => {
      // 服务端事实与运输结果分开：首次release结束运输，但尚未修改权威grant。
      if (method === 'run.control.release') {
        if (!lateRelease) { lateRelease = structuredClone(params); throw error(0, 'NETWORK_ERROR', true) }
        authority = null
        return success({ released: true, ownershipRevision: ++ownershipRevision })
      }
      expect(method).toBe('run.control.claim')
      if (authority) return authority.holderId === params.holderId
        ? success({ status: 'claimed', grant: authority }) : success({ status: 'busy', control: authority })
      authority = { ...controlled(params.runId, params.holderId, ++ownershipRevision).data.grant, leaseId: crypto.randomUUID() }
      return success({ status: 'claimed', grant: authority })
    })
    expect(await f.session.claimRunControl('run-a')).toBe(true)
    const first = f.session.selectedRunControl.value
    if (!first) throw new Error('Expected current Run grant')
    await f.session.releaseRunControl()
    expect(f.session.selectedRunControl.value).toBeNull()
    expect(await f.session.claimRunControl('run-a')).toBe(false)
    expect(f.session.error.value?.code).toBe('RUN_CONTROL_BUSY')
    expect(f.dispatch.mock.calls.at(-1)?.[2].holderId).not.toBe(first.holderId)
    if (!lateRelease) throw new Error('Expected uncertain release to remain in flight')
    expect(lateRelease.control).toEqual({ leaseId: first.leaseId, holderId: first.holderId, fence: first.fence })
    // 原proof现在才真正提交；此前新holder未获得授权，因此不会被这次晚释放撤销。
    authority = null
    ownershipRevision++
    expect(await f.session.claimRunControl('run-a')).toBe(true)
    expect(f.session.selectedRunControl.value?.leaseId).not.toBe(first.leaseId)
    expect(f.session.selectedRunControl.value?.holderId).not.toBe(first.holderId)
  })

  it('does not send delayed old Run grant cleanup to a newly connected service', async () => {
    // 两个服务可复用Map/Run身份；旧响应的精确释放也只能属于原连接。
    const f = await openedReview(false)
    const pending = deferred<ReturnType<typeof controlled>>()
    let reply: ReturnType<typeof controlled> | undefined
    f.dispatch.mockImplementation(async (/* 原请求身份。 */ _id, /* 只允许旧服务的领取。 */ method, /* 旧Run领取参数。 */ params) => {
      // 旧服务已确认，响应在新连接之后才交付。
      expect(method).toBe('run.control.claim')
      reply = controlled(params.runId, params.holderId)
      return pending.promise
    })
    const old = f.session.claimRunControl('run-a')
    await vi.advanceTimersByTimeAsync(0)
    f.getConnection.mockResolvedValue({ baseUrl: 'http://new-service', configured: true, remembered: false, canRemember: false })
    await f.session.connect({ baseUrl: 'http://new-service', token: 'new-fixture-token', remember: false })
    await f.session.openMap('map-a', false)
    if (!reply) throw new Error('Expected old Run claim response')
    pending.resolve(reply)
    expect(await old).toBe(false)
    expect(f.session.connection.value?.baseUrl).toBe('http://new-service')
    expect(f.session.selectedRunControl.value).toBeNull()
    expect(f.dispatch.mock.calls.map((/* 所有服务路由上的公开请求。 */ call) => /* 旧释放不得被发送到新服务。 */ call[1])).toEqual(['run.control.claim'])
  })

  it('creates a node with its exact registered type and generic payload', async () => {
    const f = await opened()
    f.dispatch.mockImplementationOnce(async (_id, method, params: any) => {
      expect(method).toBe('graph.apply')
      const input = params.changes.nodes.put[0]
      expect(input).toMatchObject({ typeId: claimType.id, typeVersion: claimType.version, payload: { content: 'Registered data' } })
      expect(input).not.toHaveProperty('data')
      const next = map('map-a', 'workspace-a', 2)
      next.nodes.push({ id: input.id, revision: 0, typeId: input.typeId, typeVersion: input.typeVersion, payload: input.payload, createdAt: time, updatedAt: time })
      return success({ snapshot: next, createdNodeIds: [input.id], createdEdgeIds: [] })
    })
    expect(await f.session.createNode(claimType, { content: 'Registered data' })).toBe(true)
    expect(f.session.selectedId.value).toBe(f.session.snapshot.value?.nodes[1].id)
  })

  it('reads and submits the selected branch version instead of the whole Map revision', async () => {
    const f = await opened()
    f.session.selectNode('map-a-claim')
    await vi.waitFor(() => expect(f.session.selectedBranch.value).toMatchObject({
      scope: { rootIds: ['map-a-claim'], nodeIds: ['map-a-claim'] }, version: 'branch:map-a-claim:0:', rootRevisions: { 'map-a-claim': 0 },
    }))
    const proof = { rootIds: ['map-a-claim'], expectedVersion: f.session.selectedBranch.value!.version }
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
    f.dispatch.mockImplementationOnce(async (_id, method, params: any) => {
      expect(method).toBe('graph.apply')
      expect(params).toMatchObject({ branch: proof })
      expect(params).not.toHaveProperty('expectedRevision')
      const next = map('map-a', 'workspace-a', 9)
      next.nodes[0].revision = 1; next.nodes[0].payload = { content: 'Saved by branch' }
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [],
        branch: { scope: { rootIds: ['map-a-claim'], nodeIds: ['map-a-claim'], edgeIds: [] }, version: 'branch:map-a-claim:1:', rootRevisions: { 'map-a-claim': 1 }, mapRevision: 9 } })
    })
    expect(await f.session.saveNode({ branch: proof, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1,
      payload: { content: 'Saved by branch' } })).toBe(true)
    expect(f.session.selectedBranch.value?.version).toBe('branch:map-a-claim:1:')
  })

  it('ignores late Map replies after a different Map is opened and aborts the old view', async () => {
    // 验证切图会取消旧视图并忽略迟到的旧图响应。
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.readImplementation
    let oldSignal: AbortSignal | undefined
    f.read.mockImplementation(async (
      method,
      params,
      signal
    ) => {
      // 拦截旧图读取并记录取消信号，其他查询保持正常。
      if (method === 'map.get' && params.mapId === 'map-a') { oldSignal = signal; return late.promise }
      return normalRead(method, params, signal)
    })
    const opening = f.session.openMap('map-a', false)
    await f.session.openMap('map-b', false)
    expect(oldSignal?.aborted).toBe(true)
    late.resolve(map('map-a', 'workspace-a', 99))
    await opening
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.session.loading.value).toBe(false)
  })

  it('keeps a newer command snapshot when an earlier read arrives afterward', async () => {
    // 验证较早 HTTP 读取晚到时不会覆盖命令返回的新快照。
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.readImplementation
    f.read.mockImplementation((
      method,
      params,
      signal
    ) =>
      /* 延迟图快照读取，其他查询继续走正常夹具。 */
      method === 'map.get' ? late.promise : normalRead(method, params, signal))
    const polling = f.session.refresh()
    const newest = map('map-a', 'workspace-a', 3)
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
      .mockResolvedValueOnce(success({ snapshot: newest, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' }, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: 'Mine' } })
    late.resolve(map('map-a', 'workspace-a', 2))
    await polling
    expect(f.session.snapshot.value?.revision).toBe(3)
  })

  it('does not restore private state from pending requests after disconnect', async () => {
    // 验证退出后未完成请求不能恢复私有状态，也不会取消远端运行。
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => /* 保持图读取未完成，等待退出之后再返回。 */ late.promise)
    const polling = f.session.refresh()
    await f.session.disconnect()
    late.resolve(map('map-a', 'workspace-a', 8))
    await polling
    const reads = f.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.read.mock.calls).toHaveLength(reads)
    expect(f.session.bootstrap.value).toBeNull()
    expect(f.session.workspace.value).toBeNull()
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.online.value).toBe(false)
    expect(f.dispatch.mock.calls.some(call => /* 检查退出登录是否错误提交取消运行命令。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('ignores initialization connection metadata that arrives after a new login', async () => {
    // 验证新登录完成后忽略旧初始化返回的连接信息。
    const f = fakeGateway()
    const session = sessionCreateState(f.gateway, 100)
    sessions.push(session)
    const stale = deferred<Awaited<ReturnType<ClientGateway['getConnection']>>>()
    f.getConnection.mockImplementationOnce(() => /* 延迟初始化读取的旧连接配置。 */ stale.promise)
    const initializing = session.initialize()
    await session.connect({ baseUrl: 'http://fixture', token: 'new-token', remember: false })
    expect(session.connection.value?.configured).toBe(true)
    stale.resolve({ baseUrl: 'http://previous-host', configured: false, remembered: false, canRemember: false })
    await initializing
    expect(session.connection.value).toMatchObject({ baseUrl: 'http://fixture', configured: true })
    expect(session.bootstrap.value?.identity.userId).toBe('user-a')
  })

  it('reconnects ended streams with capped backoff without polling snapshots', async () => {
    // 验证断流按退避时间重连、不轮询快照，关闭标签后停止重连。
    const f = await opened()
    const reads = f.read.mock.calls.length
    expect(f.watch).toHaveBeenCalledTimes(1)
    f.streams[0].resolve()
    await vi.advanceTimersByTimeAsync(99)
    expect(f.watch).toHaveBeenCalledTimes(1)
    expect(f.session.streamState.value).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.watch).toHaveBeenCalledTimes(2)
    f.streams[1].reject(error(0, 'NETWORK_ERROR', true))
    await vi.advanceTimersByTimeAsync(199)
    expect(f.watch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.watch).toHaveBeenCalledTimes(3)
    f.streams[2].emit({ type: 'snapshot', snapshot: map('map-a', 'workspace-a', 8) })
    expect(f.session.streamState.value).toBe('live')
    expect(f.session.snapshot.value?.revision).toBe(8)
    expect(f.read.mock.calls).toHaveLength(reads)
    await f.session.closeMap('map-a')
    expect(f.streams[2].signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.watch).toHaveBeenCalledTimes(3)
    expect(f.dispatch.mock.calls.some(call => /* 检查关闭订阅时是否错误取消远端运行。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('adopts stream snapshots and summaries while ignoring old HTTP failures and old view callbacks', async () => {
    // 验证实时快照更新摘要并使旧 HTTP 错误失效，旧视图事件也不能覆盖新图。
    const f = await opened(), late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => /* 延迟 HTTP 读取，让实时流先提供较新快照。 */ late.promise)
    const reading = f.session.refresh()
    const next = map('map-a', 'workspace-a', 5)
    next.name = 'Live graph'
    f.streams[0].emit({ type: 'snapshot', snapshot: next })
    late.reject(error(404, 'MAP_NOT_FOUND'))
    await reading
    expect(f.session.snapshot.value?.revision).toBe(5)
    expect(f.session.mapList.value.find(map =>
      /* 查找已被实时快照更新的图摘要。 */
      map.id === 'map-a')).toMatchObject({ name: 'Live graph', revision: 5, nodeCount: 1 })
    expect(f.session.online.value).toBe(true)
    expect(f.session.error.value).toBeNull()
    await f.session.openMap('map-b', false)
    f.streams[0].emit({ type: 'snapshot', snapshot: map('map-a', 'workspace-a', 99) })
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.streams[0].signal?.aborted).toBe(true)
  })

  it('refreshes invalidated workspace and settings without another Map read', async () => {
    // 验证工作区和设置失效通知只刷新相应数据，不额外读取图。
    const f = await opened()
    const count = f.read.mock.calls.filter(call => /* 统计刷新前已经发生的图读取。 */ call[0] === 'map.get').length
    f.workspaces.get('workspace-a')!.revision = 2
    f.workspaces.get('workspace-a')!.name = 'Shared metadata'
    f.bootstrap.settings.revision = 2
    f.bootstrap.settings.llm.model = 'new model'
    f.streams[0].emit({ type: 'refresh', scope: 'workspace' })
    f.streams[0].emit({ type: 'refresh', scope: 'settings' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.workspace.value?.name).toBe('Shared metadata')
    expect(f.session.bootstrap.value?.settings.llm.model).toBe('new model')
    expect(f.read.mock.calls.filter(call => /* 统计刷新后图读取次数，检查没有多余请求。 */ call[0] === 'map.get')).toHaveLength(count)
  })

  it.each([401, 403, 404])('stops inaccessible subscriptions after %s without cancelling the Run', async status => {
    // 验证 401、403、404 会停止不可访问订阅，只有 401 退出登录，且不取消运行。
    const f = await opened()
    f.streams[0].emit({ type: 'error', error: { status, code: status === 401 ? 'UNAUTHORIZED' : 'MAP_NOT_FOUND', message: 'Access ended', retryable: false, errorId: crypto.randomUUID() } })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.activeMapId.value).toBeNull()
    expect(f.streams[0].signal?.aborted).toBe(true)
    expect(f.session.bootstrap.value === null).toBe(status === 401)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.watch).toHaveBeenCalledTimes(1)
    expect(f.dispatch.mock.calls.some(call => /* 检查访问失效处理是否错误发出运行取消命令。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('disconnects on 401, clears private data, and does not cancel remote execution', async () => {
    // 验证 401 清除私有会话数据并退出连接，同时保留远端执行。
    const f = await opened()
    f.read.mockRejectedValueOnce(error(401, 'UNAUTHORIZED'))
    await f.session.refresh()
    expect(f.disconnect).toHaveBeenCalledOnce()
    expect(f.session.bootstrap.value).toBeNull()
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.error.value?.status).toBe(401)
    expect(f.dispatch.mock.calls.some(call => /* 检查认证失效时是否错误取消远端运行。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('clears an inaccessible Workspace without signing the user out', async () => {
    // 验证工作区不可访问时清理其视图，但保留当前登录身份。
    const f = await opened()
    const normalRead = f.readImplementation
    f.read.mockImplementation(async (
      method,
      params,
      signal
    ) => {
      // 模拟图与工作区消失、工作区列表清空，其他查询仍可读取。
      if (method === 'map.get' || method === 'workspace.get') throw error(404, 'WORKSPACE_NOT_FOUND')
      if (method === 'workspace.list') return { items: [], nextCursor: null }
      return normalRead(method, params, signal)
    })
    await f.session.refresh()
    expect(f.session.workspace.value).toBeNull()
    expect(f.session.openMapIds.value).toEqual([])
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.bootstrap.value?.identity.userId).toBe('user-a')
    expect(f.disconnect).not.toHaveBeenCalled()
  })

  it('refreshes conflicts without auto-retrying or mutating the caller draft', async () => {
    // 验证分支版本冲突会刷新快照，而不会自动重试或改写调用方草稿。
    const f = await opened()
    const draft = { kind: 'claim' as const, content: 'Unsaved user edit', category: null }
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
      .mockRejectedValueOnce(error(409, 'BRANCH_VERSION_CONFLICT'))
    f.snapshots.set('map-a', map('map-a', 'workspace-a', 5))
    expect(await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' }, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: draft.content } })).toBe(false)
    expect(f.session.snapshot.value?.revision).toBe(5)
    expect(draft.content).toBe('Unsaved user edit')
    expect(f.session.canRetry.value).toBe(false)
    expect(f.dispatch.mock.calls.filter(call => call[1] === 'graph.apply')).toHaveLength(1)
  })

  it('retries the exact original mutation identity and payload even if the editor draft changes', async () => {
    // 验证网络失败后重试保持原请求身份与参数，即使编辑草稿已变化。
    const f = await opened()
    const sent: Array<{ id: string; method: string; params: any }> = []
    let failed = false
    f.dispatch.mockImplementation(async (
      id,
      method,
      params
    ) => {
      // 记录命令副本并只使首次调用网络失败，供比较重试内容。
      if (method === 'branch.claim') return claimed(f.snapshots.get('map-a')!, params.rootIds)
      sent.push(structuredClone({ id, method, params }))
      if (!failed) { failed = true; throw error(0, 'NETWORK_ERROR', true) }
      return success({ snapshot: map('map-a', 'workspace-a', 2), createdNodeIds: [], createdEdgeIds: [] })
    })
    const data = { kind: 'claim' as const, content: 'Original submitted edit', category: null }
    await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' }, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: data.content } })
    expect(f.session.canRetry.value).toBe(true)
    data.content = 'A newer unsaved draft'
    await f.session.retry()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
  })

  it('rejects a new Run while an earlier committed write awaits confirmation and still retries the exact original request', async () => {
    // 通过真实会话写入与丢回包形成待确认状态；新运行不能清掉它或先读分支再失败。
    const f = await opened()
    const renamed = { ...map('map-a', 'workspace-a', 2), name: '原请求确认后的名称' }
    const attempts: Array<{ id: string; params: unknown }> = []
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation(async (
      /* 会话实际分配且重试时应保持的请求身份。 */ id: string,
      /* 实际公共写命令，不以手改canRetry代替失败。 */ method: string,
      /* 网关收到的原业务参数；只复制，不将其断言成可信DTO。 */ params: unknown,
      /* 会话拥有的原取消信号，非本次改名时照常转交。 */ signal?: AbortSignal,
    ): Promise<unknown> => {
      // 首次改名已经提交到夹具存储但丢回包，重放返回同一次提交而不重复修改。
      if (method !== 'map.rename') return normalDispatch(id, method, params, signal)
      attempts.push({ id, params: structuredClone(params) })
      if (attempts.length === 1) {
        f.snapshots.set('map-a', renamed)
        throw error(0, 'NETWORK_ERROR', true)
      }
      return success({ snapshot: renamed, createdNodeIds: [], createdEdgeIds: [] })
    })
    expect(await f.session.renameMap(renamed.name)).toBe(false)
    expect(f.snapshots.get('map-a')?.name).toBe(renamed.name)
    expect(f.session.snapshot.value?.name).toBe('map-a')
    expect(f.session.canRetry.value).toBe(true)
    expect(f.session.error.value?.code).toBe('NETWORK_ERROR')
    const originalError = f.session.error.value
    const originalRequest = structuredClone(attempts[0])
    const readCount = f.read.mock.calls.length, dispatchCount = f.dispatch.mock.calls.length
    const originalSnapshot = f.session.snapshot.value

    expect(await f.session.startRun({ scope: { nodeIds: ['map-a-claim'] }, plan: structuredClone(currentRun().plan),
      mode: 'human-in-loop', regenerate: false })).toBe(false)
    expect(f.session.canRetry.value).toBe(true)
    expect(f.session.error.value).toBe(originalError)
    expect(f.session.snapshot.value).toBe(originalSnapshot)
    expect(f.read).toHaveBeenCalledTimes(readCount)
    expect(f.dispatch).toHaveBeenCalledTimes(dispatchCount)
    expect(attempts).toEqual([originalRequest])

    expect(await f.session.retry()).toBe(true)
    expect(attempts).toEqual([originalRequest, originalRequest])
    expect(f.session.snapshot.value).toMatchObject({ mapId: 'map-a', name: renamed.name, revision: 2 })
    expect(f.session.canRetry.value).toBe(false)
  })

  it('drops a retry belonging to a Workspace that the user has left', async () => {
    // 验证离开工作区后丢弃属于旧工作区的写入重试。
    const f = await opened()
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
      .mockRejectedValueOnce(error(0, 'NETWORK_ERROR', true))
    await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' }, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: 'Edit' } })
    expect(f.session.canRetry.value).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    expect(f.session.canRetry.value).toBe(false)
    await f.session.retry()
    expect(f.dispatch.mock.calls.filter(call => call[1] === 'graph.apply')).toHaveLength(1)
  })

  it('renames the current Map without changing its nodes, selection or open tabs', async () => {
    // 接纳改名返回的新版本，并同步当前图和侧栏摘要，不重建图或清除阅读位置。
    const f = await opened()
    expect(f.session).toHaveProperty('renameMap', expect.any(Function))
    f.session.selectNode('map-a-claim')
    const before = structuredClone(f.session.snapshot.value)
    expect(f.session.canRenameMap.value).toBe(true)

    expect(await f.session.renameMap('改名后的事实图')).toBe(true)

    expect(f.dispatch.mock.calls.filter((
      /* 会话发出的公开命令记录。 */ call,
    ) => /* 只检查本次图元数据命令。 */ call[1] === 'map.rename')).toEqual([
      [expect.any(String), 'map.rename', { mapId: 'map-a', expectedRevision: 1, name: '改名后的事实图' }, expect.any(AbortSignal)],
    ])
    expect(f.session.snapshot.value).toMatchObject({ mapId: 'map-a', name: '改名后的事实图', revision: 2 })
    expect(f.session.snapshot.value?.nodes).toEqual(before?.nodes)
    expect(f.session.snapshot.value?.edges).toEqual(before?.edges)
    expect(f.session.mapList.value.find((
      /* 刷新后侧栏实际持有的摘要。 */ item,
    ) => /* 使用稳定图身份查找改名结果。 */ item.id === 'map-a')).toMatchObject({ name: '改名后的事实图', revision: 2 })
    expect(f.session.activeMapId.value).toBe('map-a')
    expect(f.session.openMapIds.value).toEqual(['map-a'])
    expect(f.session.selectedId.value).toBe('map-a-claim')
  })

  it('keeps a rejected deletion open and removes only the confirmed Map from tabs and preferences', async () => {
    // 删除失败保留当前选择；确认成功后切到剩余标签，只移除被删图的持久偏好。
    const f = await opened()
    expect(f.session).toHaveProperty('deleteMap', expect.any(Function))
    await f.session.openMap('map-b', false)
    f.session.selectNode('map-b-claim')
    await f.session.openMap('map-a', false)
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    f.dispatch.mockClear()
    f.dispatch.mockRejectedValueOnce(error(409, 'REVISION_CONFLICT'))

    expect(await f.session.deleteMap()).toBe(false)
    expect(f.session.openMapIds.value).toEqual(['map-a', 'map-b'])
    expect(f.session.activeMapId.value).toBe('map-a')
    expect(f.session.selectedId.value).toBe('map-a-claim')
    expect(f.session.snapshot.value?.mapId).toBe('map-a')

    expect(await f.session.deleteMap()).toBe(true)
    await vi.advanceTimersByTimeAsync(250)

    expect(f.session.openMapIds.value).toEqual(['map-b'])
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.selectedId.value).toBe('map-b-claim')
    expect(f.session.snapshot.value).toEqual(map('map-b'))
    expect(f.session.mapList.value.map((
      /* 删除后仍可访问的工作区图摘要。 */ item,
    ) => /* 只核对稳定图身份，其他图应继续存在。 */ item.id)).toEqual(['map-b'])
    const saves = f.dispatch.mock.calls.filter((
      /* 删除前后会话发出的公开命令记录。 */ call,
    ) => /* 取得删除成功后持久化的视图偏好。 */ call[1] === 'preferences.set')
    expect(saves).toHaveLength(1)
    expect(saves[0][2]).toMatchObject({ workspaceId: 'workspace-a', openMapIds: ['map-b'], currentMapId: 'map-b', nodeSelection: { 'map-b': 'map-b-claim' } })
    expect(saves[0][2].nodeSelection).not.toHaveProperty('map-a')
    expect(f.dispatch.mock.calls.some((
      /* 本用例所有公开命令。 */ call,
    ) => /* 图管理不能隐式取消运行或提交节点正文。 */ call[1] === 'run.cancel' || call[1] === 'graph.apply')).toBe(false)
  })

  it.each(['rename', 'delete'] as const)('retries an uncertain Map %s with the original identity and completes its view update', async (
    /* 本次结果不确定但可以按原请求重放的图管理意图。 */ action,
  ) => {
    // 网络失败保留旧界面；重放同编号同参数后才接纳改名或清除被删图。
    const f = await opened()
    expect(f.session).toHaveProperty(action === 'rename' ? 'renameMap' : 'deleteMap', expect.any(Function))
    const method = action === 'rename' ? 'map.rename' : 'map.delete'
    f.dispatch.mockRejectedValueOnce(error(0, 'NETWORK_ERROR', true))

    expect(await (action === 'rename' ? f.session.renameMap('重试后确认的图名') : f.session.deleteMap())).toBe(false)
    expect(f.session.snapshot.value?.name).toBe('map-a')
    expect(f.session.openMapIds.value).toEqual(['map-a'])
    await f.session.openMap('map-a', false)
    expect(f.session.canRetry.value).toBe(true)
    expect(f.session.error.value?.code).toBe('NETWORK_ERROR')
    const original = f.dispatch.mock.calls.filter((
      /* 首次发送的公开命令记录。 */ call,
    ) => /* 排除不属于图管理的偏好写入。 */ call[1] === method).map((
      /* 原请求的编号、方法和冻结参数。 */ call,
    ) => /* 复制后比较，避免后续调用改变测试依据。 */ structuredClone(call.slice(0, 3)))
    expect(original).toHaveLength(1)

    expect(await f.session.retry()).toBe(true)

    const attempts = f.dispatch.mock.calls.filter((
      /* 首次和重试两次实际发送的命令。 */ call,
    ) => /* 只核对同一图管理意图。 */ call[1] === method).map((
      /* 本次编号、方法和参数，不比较传输取消信号。 */ call,
    ) => /* 以公开请求数据确认原样重放。 */ call.slice(0, 3))
    expect(attempts).toEqual([original[0], original[0]])
    expect(f.session.canRetry.value).toBe(false)
    if (action === 'rename') {
      expect(f.session.snapshot.value).toMatchObject({ mapId: 'map-a', name: '重试后确认的图名', revision: 2 })
      expect(f.session.mapList.value.find((
        /* 重试成功后侧栏持有的实际图摘要。 */ item,
      ) => /* 按原图身份核对已确认的新名称。 */ item.id === 'map-a')).toMatchObject({ name: '重试后确认的图名', revision: 2 })
    } else {
      expect(f.session.snapshot.value).toBeNull()
      expect(f.session.activeMapId.value).toBeNull()
      expect(f.session.openMapIds.value).toEqual([])
      expect(f.session.mapList.value.map((
        /* 原工作区删除后剩余的图摘要。 */ item,
      ) => /* 被删身份不应仍可打开。 */ item.id)).toEqual(['map-b'])
    }
  })

  it('accepts deletion confirmation after the deleted Map subscription has already closed its view', async () => {
    // 删除已提交后订阅可能先报告404；同工作区的原命令确认仍应完成标签与偏好清理。
    const f = await opened()
    expect(f.session).toHaveProperty('deleteMap', expect.any(Function))
    await f.session.openMap('map-b', false)
    f.session.selectNode('map-b-claim')
    await f.session.openMap('map-a', false)
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    f.dispatch.mockClear()
    const pending = deferred<ReturnType<typeof success>>()
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation(async (
      /* 原删除及其他命令各自的请求身份。 */ id,
      /* 只延迟删除命令，不替换订阅与偏好保存。 */ method,
      /* 原公开参数，其他命令保持夹具行为。 */ params,
      /* 会话持有的传输取消信号。 */ signal,
    ) => {
      // 保留真实会话处理顺序，让订阅404先于已提交删除的HTTP确认到达。
      if (method === 'map.delete') return pending.promise
      return normalDispatch(id, method, params, signal)
    })
    const deleting = f.session.deleteMap()
    f.snapshots.delete('map-a')
    f.streams[2].reject(error(404, 'MAP_NOT_FOUND'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.activeMapId.value).not.toBe('map-a')
    expect(f.session.openMapIds.value).toEqual(['map-b'])

    pending.resolve(success({ mapId: 'map-a', deleted: true }))
    expect(await deleting).toBe(true)
    await vi.advanceTimersByTimeAsync(250)

    expect(f.session.openMapIds.value).toEqual(['map-b'])
    expect(['map-b', null]).toContain(f.session.activeMapId.value)
    expect(f.session.mapList.value.map((
      /* 同工作区删除后继续存在的图。 */ item,
    ) => /* 订阅清理不能丢失其他图或恢复已删身份。 */ item.id)).toEqual(['map-b'])
    const saves = f.dispatch.mock.calls.filter((
      /* 删除开始后会话发出的公开命令。 */ call,
    ) => /* 原删除确认应补齐持久偏好清理。 */ call[1] === 'preferences.set')
    expect(saves).toHaveLength(1)
    expect(saves[0][2]).toMatchObject({ workspaceId: 'workspace-a', openMapIds: ['map-b'], currentMapId: f.session.activeMapId.value, nodeSelection: { 'map-b': 'map-b-claim' } })
    expect(saves[0][2].nodeSelection).not.toHaveProperty('map-a')
    expect(f.session.canRetry.value).toBe(false)
    expect(f.session.busy.value).toBe(false)
  })

  it('retains the original uncertain deletion after its subscription reports the Map is gone', async () => {
    // 删除响应丢失后订阅404不能抹掉原请求重试；确认后还需清理旧选择的持久偏好。
    const f = await opened()
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    f.dispatch.mockClear()
    f.dispatch.mockRejectedValueOnce(error(0, 'NETWORK_ERROR', true))
    expect(await f.session.deleteMap()).toBe(false)
    expect(f.session.canRetry.value).toBe(true)
    const original = f.dispatch.mock.calls.filter((
      /* 响应丢失前实际发出的命令。 */ call,
    ) => /* 记录需要原样确认的删除请求。 */ call[1] === 'map.delete').map((
      /* 删除原请求的编号、方法和参数。 */ call,
    ) => /* 复制请求，不依赖取消信号或后续可变引用。 */ structuredClone(call.slice(0, 3)))
    expect(original).toHaveLength(1)

    f.snapshots.delete('map-a')
    f.streams[0].reject(error(404, 'MAP_NOT_FOUND'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.canRetry.value).toBe(true)

    expect(await f.session.retry()).toBe(true)
    await vi.advanceTimersByTimeAsync(250)

    const attempts = f.dispatch.mock.calls.filter((
      /* 删除首次发送和重放的实际记录。 */ call,
    ) => /* 只核对这次删除的原请求身份。 */ call[1] === 'map.delete').map((
      /* 每次发送的编号、方法和参数。 */ call,
    ) => /* 传输信号不属于业务幂等输入。 */ call.slice(0, 3))
    expect(attempts).toEqual([original[0], original[0]])
    expect(f.session.openMapIds.value).toEqual([])
    expect(f.session.activeMapId.value).toBeNull()
    const saves = f.dispatch.mock.calls.filter((
      /* 删除重放确认后实际发送的命令。 */ call,
    ) => /* 清掉已删除图在持久偏好中的残留选择。 */ call[1] === 'preferences.set')
    expect(saves).toHaveLength(1)
    expect(saves[0][2]).toMatchObject({ openMapIds: [], currentMapId: null, nodeSelection: {} })
    expect(f.session.canRetry.value).toBe(false)
    expect(f.session.error.value).toBeNull()
  })

  it('does not confirm a rename retry after its success refresh belongs to an old Workspace', async () => {
    // 原改名已确认但目录刷新仍在等待时切工作区，旧恢复不能再向新窗口报告成功。
    const f = await opened()
    f.dispatch.mockRejectedValueOnce(error(0, 'NETWORK_ERROR', true))
    expect(await f.session.renameMap('旧工作区已提交的改名')).toBe(false)
    const pending = deferred<WorkspaceView>()
    const normalRead = f.readImplementation
    f.read.mockImplementation(async (
      /* 按方法只延迟成功回调中的工作区刷新。 */ method,
      /* 用工作区身份区分旧刷新与新工作区正常进入。 */ params,
      /* 原视图拥有的读取取消信号。 */ signal,
    ) => {
      // 只延迟A的目录刷新，B的公开读取仍使用既有夹具。
      if (method === 'workspace.get' && params.workspaceId === 'workspace-a') return pending.promise
      return normalRead(method, params, signal)
    })
    const retrying = f.session.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.snapshot.value?.name).toBe('旧工作区已提交的改名')
    expect(f.session.busy.value).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    await f.session.openMap('map-c', false)

    pending.resolve(workspace('workspace-a'))
    expect(await retrying).toBe(false)

    expect(f.session.workspace.value?.id).toBe('workspace-b')
    expect(f.session.snapshot.value).toEqual(map('map-c', 'workspace-b'))
    expect(f.session.openMapIds.value).toEqual(['map-c'])
    expect(f.session.busy.value).toBe(false)
    expect(f.session.error.value).toBeNull()
  })

  it('ignores a deletion confirmation after entering another Workspace', async () => {
    // 旧图删除结果即使晚到，也不能清掉新工作区当前图、标签和选择。
    const f = await opened()
    expect(f.session).toHaveProperty('deleteMap', expect.any(Function))
    const pending = deferred<ReturnType<typeof success>>()
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation(async (
      /* 本次公开命令的原始请求身份。 */ id,
      /* 用来只延迟被测删除的公开方法。 */ method,
      /* 保持其他命令原样交给既有夹具的参数。 */ params,
      /* 会话拥有的请求取消信号。 */ signal,
    ) => {
      // 只控制删除确认时机，工作区偏好等其余行为保持原夹具实现。
      if (method === 'map.delete') return pending.promise
      return normalDispatch(id, method, params, signal)
    })
    const deleting = f.session.deleteMap()
    await f.session.selectWorkspace('workspace-b')
    await f.session.openMap('map-c', false)
    f.session.selectNode('map-c-claim')
    f.snapshots.delete('map-a')
    pending.resolve(success({ mapId: 'map-a', deleted: true }))
    await deleting
    await vi.advanceTimersByTimeAsync(250)

    expect(f.session.workspace.value?.id).toBe('workspace-b')
    expect(f.session.activeMapId.value).toBe('map-c')
    expect(f.session.snapshot.value).toEqual(map('map-c', 'workspace-b'))
    expect(f.session.openMapIds.value).toEqual(['map-c'])
    expect(f.session.selectedId.value).toBe('map-c-claim')
    expect(f.session.mapList.value.map((
      /* 新工作区当前可访问的图摘要。 */ item,
    ) => /* 迟到删除不改变新工作区目录。 */ item.id)).toEqual(['map-c'])
    expect(f.session.error.value).toBeNull()
  })

  it('lets the new Workspace own command busy while an old deletion finishes late', async () => {
    // 离开工作区应释放旧命令占用；旧确认晚到也不能提前结束新工作区尚未完成的改名。
    const f = await opened()
    const oldDeletion = deferred<ReturnType<typeof success>>()
    const newRename = deferred<ReturnType<typeof success>>()
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation(async (
      /* 每次提交独立的公开请求身份。 */ id,
      /* 按方法分别控制旧删除和新改名的确认时机。 */ method,
      /* 其他命令仍交给原夹具的参数。 */ params,
      /* 仍由会话持有的传输取消信号。 */ signal,
    ) => {
      // 两个等待点只控制回包次序，不替会话管理busy或工作区切换。
      if (method === 'map.delete') return oldDeletion.promise
      if (method === 'map.rename') return newRename.promise
      return normalDispatch(id, method, params, signal)
    })
    const deleting = f.session.deleteMap()
    expect(f.session.busy.value).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    await f.session.openMap('map-c', false)
    const renaming = f.session.renameMap('新工作区等待确认的名称')
    const newRequestStarted = f.dispatch.mock.calls.some((
      /* 工作区切换前后实际发出的公开命令。 */ call,
    ) => /* 新工作区必须能开始自己的改名。 */ call[1] === 'map.rename' && call[2].mapId === 'map-c')

    f.snapshots.delete('map-a')
    oldDeletion.resolve(success({ mapId: 'map-a', deleted: true }))
    await deleting
    const busyBeforeNewConfirmation = f.session.busy.value
    const renamed = { ...map('map-c', 'workspace-b', 2), name: '新工作区等待确认的名称' }
    f.snapshots.set('map-c', renamed)
    newRename.resolve(success({ snapshot: renamed, createdNodeIds: [], createdEdgeIds: [] }))
    const renamedSuccessfully = await renaming

    expect(newRequestStarted).toBe(true)
    expect(busyBeforeNewConfirmation).toBe(true)
    expect(renamedSuccessfully).toBe(true)
    expect(f.session.busy.value).toBe(false)
    expect(f.session.workspace.value?.id).toBe('workspace-b')
    expect(f.session.snapshot.value).toEqual(renamed)
    expect(f.session.openMapIds.value).toEqual(['map-c'])
    expect(f.session.error.value).toBeNull()
  })

  it('refuses Map rename and deletion for a Viewer even when rename capability is declared', async () => {
    // 服务支持与用户权限独立；只读成员不能从会话入口发出任何图管理写入。
    const f = await opened()
    expect(f.session).toHaveProperty('renameMap', expect.any(Function))
    expect(f.session).toHaveProperty('deleteMap', expect.any(Function))
    f.workspaces.set('workspace-a', { ...workspace('workspace-a'), role: 'viewer' })
    await f.session.refreshWorkspace()

    expect(f.session.canRenameMap.value).toBe(false)
    expect(await f.session.renameMap('只读成员不得改名')).toBe(false)
    expect(await f.session.deleteMap()).toBe(false)
    expect(f.dispatch.mock.calls.some((
      /* 只读操作后所有实际发出的命令。 */ call,
    ) => /* 服务声明可用不能绕过用户角色。 */ call[1] === 'map.rename' || call[1] === 'map.delete')).toBe(false)
    expect(f.session.snapshot.value?.name).toBe('map-a')
  })

  it('does not send rename to a legacy service missing its capability declaration', async () => {
    // 切到旧服务后不能保留上个 bootstrap 的改名能力，也不尝试未知命令。
    const f = await opened()
    expect(f.session).toHaveProperty('renameMap', expect.any(Function))
    expect(f.session.canRenameMap.value).toBe(true)
    delete f.bootstrap.metadata.capabilities
    await f.session.connect({ baseUrl: 'http://legacy', token: 'legacy-token', remember: false })
    await f.session.openMap('map-a', false)

    expect(f.session.canRenameMap.value).toBe(false)
    expect(await f.session.renameMap('旧服务不得收到的新命令')).toBe(false)
    expect(f.dispatch.mock.calls.some((
      /* 旧服务连接期间实际发出的公开命令。 */ call,
    ) => /* 未声明支持时应停在会话入口。 */ call[1] === 'map.rename')).toBe(false)
    expect(f.session.snapshot.value?.name).toBe('map-a')
  })

  it.each(['NETWORK_ERROR', 'REQUEST_TIMEOUT'])('retries the original preferences after %s before saving newer selections', async (
    /* 首次偏好交付失败的稳定代码，网络断开与请求超时使用同一恢复合同。 */ failureCode,
  ) => {
    // 偏好失败保持图可操作；恢复先重放原请求，再用新版本保存等待期间的最新选择。
    const f = await opened()
    f.dispatch.mockRejectedValueOnce(error(0, failureCode, true))
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    const [originalId, originalMethod, originalParams] = f.dispatch.mock.calls[0]
    const original = structuredClone(originalParams)
    expect(f.session.online.value).toBe(true)
    expect(f.session.busy.value).toBe(false)
    expect(f.session.canRetry.value).toBe(false)
    expect(f.session.error.value).toBeNull()
    expect(f.session.preferenceSync.value).toBe('unsynced')

    await f.session.openMap('map-b', false)
    f.session.selectNode('map-b-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await f.session.retryPreferences()
    await vi.advanceTimersByTimeAsync(300)

    expect(f.dispatch).toHaveBeenCalledTimes(3)
    expect(f.dispatch.mock.calls[1].slice(0, 3)).toEqual([originalId, originalMethod, original])
    expect(f.dispatch.mock.calls[2][0]).not.toBe(originalId)
    expect(f.dispatch.mock.calls[2][2]).toEqual({
      workspaceId: 'workspace-a', expectedRevision: 1, openMapIds: ['map-a', 'map-b'], currentMapId: 'map-b',
      nodeSelection: { 'map-a': 'map-a-claim', 'map-b': 'map-b-claim' },
    })
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.selectedId.value).toBe('map-b-claim')
    expect(f.session.workspace.value?.preferences.revision).toBe(2)
    expect(f.session.preferenceSync.value).toBe('synced')
  })

  it.each(['server', 'local'] as const)('resolves a preferences conflict by choosing %s without changing the choice during refresh', async (
    /* 冲突后用户明确采用服务器偏好，或保留本窗口仍在使用的选择。 */ choice,
  ) => {
    // 版本冲突先保留本窗口界面，普通刷新不替用户选择；恢复动作分别采用远端或建立新请求。
    const f = await opened()
    f.workspaces.set('workspace-a', {
      ...workspace('workspace-a'),
      preferences: { workspaceId: 'workspace-a', revision: 4, openMapIds: ['map-b'], currentMapId: 'map-b', nodeSelection: { 'map-b': 'map-b-claim' } },
    })
    f.dispatch.mockRejectedValueOnce(error(409, 'REVISION_CONFLICT'))
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    const originalId = f.dispatch.mock.calls[0][0]
    expect(f.session.online.value).toBe(true)
    expect(f.session.busy.value).toBe(false)
    expect(f.session.error.value).toBeNull()
    expect(f.session.preferenceSync.value).toBe('conflict')
    expect(f.session.activeMapId.value).toBe('map-a')
    expect(f.session.selectedId.value).toBe('map-a-claim')

    await f.session.refreshWorkspace()
    expect(f.session.preferenceSync.value).toBe('conflict')
    expect(f.session.activeMapId.value).toBe('map-a')
    expect(f.session.selectedId.value).toBe('map-a-claim')
    await f.session.resolvePreferencesConflict(choice)
    await vi.advanceTimersByTimeAsync(300)

    if (choice === 'server') {
      expect(f.dispatch).toHaveBeenCalledTimes(1)
      expect(f.session.openMapIds.value).toEqual(['map-b'])
      expect(f.session.activeMapId.value).toBe('map-b')
      expect(f.session.selectedId.value).toBe('map-b-claim')
      expect(f.session.workspace.value?.preferences.revision).toBe(4)
    } else {
      expect(f.dispatch).toHaveBeenCalledTimes(2)
      expect(f.dispatch.mock.calls[1][0]).not.toBe(originalId)
      expect(f.dispatch.mock.calls[1][2]).toEqual({
        workspaceId: 'workspace-a', expectedRevision: 4, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: { 'map-a': 'map-a-claim' },
      })
      expect(f.session.openMapIds.value).toEqual(['map-a'])
      expect(f.session.activeMapId.value).toBe('map-a')
      expect(f.session.selectedId.value).toBe('map-a-claim')
      expect(f.session.workspace.value?.preferences.revision).toBe(5)
    }
    expect(f.session.preferenceSync.value).toBe('synced')
    expect(f.session.error.value).toBeNull()
  })

  it('preserves a newly started Map opening while the server conflict choice is still loading', async () => {
    // 采用服务器设置的读取在途时，已经发起且尚未读完的新切图也是有效本地意图。
    const f = await opened()
    f.dispatch.mockRejectedValueOnce(error(409, 'REVISION_CONFLICT'))
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.session.preferenceSync.value).toBe('conflict')
    const pendingServer = deferred<WorkspaceView>()
    const pendingMap = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => /* 暂扣采用服务器设置所需的工作区读取。 */ pendingServer.promise)
      .mockImplementationOnce(() => /* 同时暂扣用户随后发起的新图快照读取。 */ pendingMap.promise)
    const resolving = f.session.resolvePreferencesConflict('server')
    const opening = f.session.openMap('map-b')
    try {
      expect(f.session.activeMapId.value).toBe('map-b')
      expect(f.session.loading.value).toBe(true)
      pendingServer.resolve({
        ...workspace('workspace-a'),
        preferences: { workspaceId: 'workspace-a', revision: 4, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: { 'map-a': 'map-a-claim' } },
      })
      await resolving
      expect(f.session.activeMapId.value).toBe('map-b')
      expect(f.session.preferenceSync.value).toBe('conflict')
    } finally {
      pendingMap.resolve(map('map-b'))
      await opening
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.session.preferenceSync.value).toBe('conflict')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('requires a conflict choice when an original preference replay returns a newer different server selection', async () => {
    // 收据重放可能返回另一个客户端的新偏好；不能把它当作当前选择已同步或直接再写覆盖。
    const f = await opened()
    const remote = { workspaceId: 'workspace-a', revision: 7, openMapIds: ['map-b'], currentMapId: 'map-b', nodeSelection: { 'map-b': 'map-b-claim' } }
    f.dispatch.mockRejectedValueOnce(error(0, 'NETWORK_ERROR', true))
      .mockResolvedValueOnce({ ...success(remote), replayed: true })
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.session.preferenceSync.value).toBe('unsynced')
    const original = f.dispatch.mock.calls[0].slice(0, 3)
    f.session.selectNode(null)
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)

    await f.session.retryPreferences()
    await vi.advanceTimersByTimeAsync(300)
    expect(f.session.preferenceSync.value).toBe('conflict')
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.dispatch.mock.calls[1].slice(0, 3)).toEqual(original)
    expect(f.session.workspace.value?.preferences).toEqual(remote)
    expect(f.session.openMapIds.value).toEqual(['map-a'])
    expect(f.session.activeMapId.value).toBe('map-a')
    expect(f.session.selectedId.value).toBe('map-a-claim')
    expect(f.session.error.value).toBeNull()
  })

  it('keeps an idempotency rejection separate from revision conflicts and does not bypass it through new selections', async () => {
    // 相同请求身份的内容冲突是明确拒绝，本窗口的新选择不能自动换请求身份越过它。
    const f = await opened()
    f.dispatch.mockRejectedValueOnce(error(409, 'IDEMPOTENCY_CONFLICT'))
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.session.preferenceSync.value).toBe('error')
    expect(f.session.error.value).toBeNull()
    expect(f.dispatch).toHaveBeenCalledTimes(1)

    await f.session.openMap('map-b', false)
    f.session.selectNode('map-b-claim')
    f.session.selectNode(null)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.session.preferenceSync.value).toBe('error')
    await f.session.resolvePreferencesConflict('local')
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.session.preferenceSync.value).toBe('error')
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.selectedId.value).toBeNull()
    expect(f.session.online.value).toBe(true)
    expect(f.session.busy.value).toBe(false)
  })

  it('coalesces selections made while preferences are saving into one subsequent save', async () => {
    // 在真实保存边界暂扣回包，继续切图和选择，只把最后状态接续保存一次。
    const f = await opened()
    const pending = deferred<unknown>()
    f.dispatch.mockImplementationOnce(() => /* 仅暂扣首次偏好保存的原回包。 */ pending.promise)
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await f.session.openMap('map-b', false)
    f.session.selectNode('map-b-claim')
    f.session.selectNode(null)
    f.session.selectNode('map-b-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch).toHaveBeenCalledTimes(1)

    pending.resolve(success({ workspaceId: 'workspace-a', revision: 1, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: { 'map-a': 'map-a-claim' } }))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.dispatch.mock.calls[1][2]).toEqual({
      workspaceId: 'workspace-a', expectedRevision: 1, openMapIds: ['map-a', 'map-b'], currentMapId: 'map-b',
      nodeSelection: { 'map-a': 'map-a-claim', 'map-b': 'map-b-claim' },
    })
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.selectedId.value).toBe('map-b-claim')
    expect(f.session.workspace.value?.preferences).toMatchObject({ revision: 2, currentMapId: 'map-b' })
  })

  it.each(['success', 'conflict'] as const)('ignores an old preferences %s after leaving and reentering the same Workspace', async (
    /* 离开前的旧请求成功或明确冲突，均不属于返回后的新工作区视图。 */ outcome,
  ) => {
    // A→B→A 不能因工作区身份再次相同而接纳旧结果；新视图继续使用重新读取的偏好基线。
    const f = await opened()
    const pending = deferred<unknown>()
    f.dispatch.mockImplementationOnce(() => /* 保存离开前仍在途的第一轮偏好请求。 */ pending.promise)
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await f.session.selectWorkspace('workspace-b')
    await f.session.selectWorkspace('workspace-a')
    await f.session.openMap('map-b', false)
    f.session.selectNode('map-b-claim')
    await vi.advanceTimersByTimeAsync(250)

    if (outcome === 'success') {
      pending.resolve(success({ workspaceId: 'workspace-a', revision: 1, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: { 'map-a': 'map-a-claim' } }))
    } else {
      pending.reject(error(409, 'REVISION_CONFLICT'))
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(f.session.error.value).toBeNull()
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.dispatch.mock.calls[1][2]).toEqual({
      workspaceId: 'workspace-a', expectedRevision: 0, openMapIds: ['map-b'], currentMapId: 'map-b', nodeSelection: { 'map-b': 'map-b-claim' },
    })
    expect(f.session.workspace.value?.id).toBe('workspace-a')
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.selectedId.value).toBe('map-b-claim')
    expect(f.session.workspace.value?.preferences).toMatchObject({ revision: 1, currentMapId: 'map-b' })
  })

  it('persists the new Workspace preferences after an old Workspace save finishes late', async () => {
    // 验证旧工作区偏好保存迟到结束后仍会接续保存新工作区改动。
    const f = await opened()
    const pending = deferred<unknown>()
    const normalDispatch = f.dispatchImplementation
    f.dispatch.mockImplementation((
      id,
      method,
      params,
      signal
    ) => {
      // 仅延迟旧工作区的偏好写入，其他命令沿用正常夹具。
      if (method === 'preferences.set' && params.workspaceId === 'workspace-a') return pending.promise
      return normalDispatch(id, method, params, signal)
    })
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch.mock.calls.some(call =>
      /* 确认已开始保存旧工作区的偏好。 */
      call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-a')).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    await f.session.openMap('map-c', false)
    f.session.selectNode('map-c-claim')
    await vi.advanceTimersByTimeAsync(250)
    pending.resolve(success({ workspaceId: 'workspace-a', revision: 1, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: {} }))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch.mock.calls.some(call =>
      /* 确认旧保存结束后新工作区偏好也得到提交。 */
      call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-b')).toBe(true)
    expect(f.session.workspace.value?.id).toBe('workspace-b')
  })

  it('closes a tab without cancelling its remote Run and enforces refreshed Viewer permissions', async () => {
    // 验证关闭标签不取消运行，刷新为只读角色后拒绝图修改。
    const f = await opened()
    f.snapshots.get('map-a')!.runs = [currentRun(false, 'running')]
    f.snapshots.get('map-a')!.revision++
    await f.session.refresh()
    expect(f.session.active.value).toBe(true)
    await f.session.closeMap('map-a')
    expect(f.session.snapshot.value).toBeNull()
    await f.session.openMap('map-a', false)
    f.workspaces.get('workspace-a')!.role = 'viewer'
    await f.session.refreshWorkspace()
    expect(f.session.canEdit.value).toBe(false)
    expect(await f.session.createNode(claimType, { content: 'No write' })).toBe(false)
    expect(f.dispatch.mock.calls.some(call =>
      /* 检查关闭标签或只读写入尝试是否错误发出运行取消或图变更命令。 */
      call[1] === 'run.cancel' || call[1] === 'graph.apply')).toBe(false)
  })
})
