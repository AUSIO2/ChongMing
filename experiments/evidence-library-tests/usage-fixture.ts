// 复用真实 Mongo/公共 HTTP，在同一持久部署身份上开启内部 Work API，发布临时单阶段执行定义。
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'

import type { DefinitionPackage, DefinitionRef, PromptBinding } from '../../contracts/data-definition'
import type { EvidenceLibraryEntry, EvidenceLibraryRef } from '../../contracts/evidence-library'
import type { GraphNodeInput } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphWorkGrant } from '../../contracts/graph-work'

import { applicationCreateService } from '../../apps/graph-server/application'
import { apiCreateServer } from '../../backend/adapters/http/graph-http-server'
import { evidenceCreateRelationFixture, relationClaimRef, relationCollectParams } from './relations-fixture'

enum UsageFixtureMessage {
  ADDRESS_MISSING = 'Usage fixture did not bind its internal API port.',
  RESPONSE_INVALID = 'Usage fixture received an invalid HTTP response.',
  AGENT_MISSING = 'Usage fixture has no real producer Agent.',
  DEFINITION_MISSING = 'Usage fixture has no exact source definition.',
  WORK_MISSING = 'Usage fixture has no executable Work.',
  BRANCH_BUSY = 'Usage fixture did not obtain the edit branch.',
  MEMBER_MISSING = 'Usage fixture cannot find its actual viewer member.',
  CLEANUP_FAILED = 'Usage fixture cleanup failed.',
}

export interface UsageTestRef { entryId: string; contentDigest: string; reason: string }
export interface UsageTestScope { workspaceId: string; transitionRef: DefinitionRef; targetType: DefinitionRef; opinionType: DefinitionRef }
export interface UsageTestResponse { status: number; body: unknown }
export interface UsageTestRun {
  response: UsageTestResponse
  request: { requestId: string; method: 'run.start'; params: Record<string, unknown> }
  mapId: string
  runId: string
}

export async function evidenceCreateUsageFixture() {
  // 所有数据仍属于临时 relation fixture；内部应用使用同 Mongo 原生持久部署身份，不启用 broker。
  const shared = await evidenceCreateRelationFixture()
  const application = applicationCreateService(shared.connection)
  let server: ReturnType<typeof apiCreateServer> | undefined
  let closing: Promise<void> | undefined
  const internalToken = randomUUID()

  function close(): Promise<void> {
    // 先结束内部 API，再关闭共享公共 API/Mongo；各项失败都不截断后续资源释放。
    return closing ??= (async () => {
      // 清理由本包装层新增的服务与装配，shared 保持其原有所有权。
      const errors: unknown[] = []
      if (server) {
        server.beginShutdown()
        server.closeAllConnections()
        try { await closeServer(server) } catch (error) { errors.push(error) }
      }
      try { await application.closeMessaging() } catch (error) { errors.push(error) }
      try { await shared.close() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, UsageFixtureMessage.CLEANUP_FAILED)
    })()
  }

  try {
    await application.initialize()
    await application.startMessaging()
    server = apiCreateServer(application, { internalToken })
    const internalUrl = await listenServer(server)
    const identityWorkspaceId = await shared.createWorkspace()
    const viewer = (await shared.client.read('workspace.get', { workspaceId: identityWorkspaceId })).members.find(
      (/* 共享fixture实际授予成员。 */ member) => /* 找回已有真实只读身份。 */ member.role === 'viewer')
    if (!viewer) throw new Error(UsageFixtureMessage.MEMBER_MISSING)
    const viewerId = viewer.userId

    async function post(
      /* 真实公共或内部请求路由。 */ path: string,
      /* 测试明确构造的外部输入，不以泛型断言验证。 */ body: unknown,
      /* 身份令牌，默认本临时工作区 owner。 */ token = shared.ownerToken,
      /* 内部 Work 操作的完整真实 lease/fence 请求头。 */ headers: Record<string, string> = {},
    ): Promise<UsageTestResponse> {
      // 公共与内部 API 都访问同一临时数据库，所有写入仍走生产 HTTP 验证与事务。
      const baseUrl = path.startsWith('/internal/') ? internalUrl : shared.baseUrl
      const response = await fetch(`${baseUrl}${path}`, { method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) })
      const value: unknown = await response.json()
      return { status: response.status, body: value }
    }

    async function query(
      /* 公开查询名称，允许新接口先行测试。 */ method: string,
      /* 新查询的外部参数。 */ params: unknown,
      /* 可选 viewer/nonmember 真实令牌。 */ token = shared.ownerToken,
    ): Promise<UsageTestResponse> {
      // 不 stub 未实现接口，不把失败信封当查询数据。
      return post('/api/v1/query', { method, params }, token)
    }

    async function createScope(): Promise<UsageTestScope> {
      // 创建带真实默认 Agents 的工作区，发布仅属于本测试的单阶段定义包。
      const workspaceId = randomUUID()
      const workspace = (await shared.client.dispatch(randomUUID(), 'workspace.create', {
        id: workspaceId, name: '跨 Map 库引用验收', description: '', agentSource: 'library',
      })).data
      await shared.client.dispatch(randomUUID(), 'member.set', { workspaceId, expectedRevision: workspace.revision,
        userId: viewerId, role: 'viewer' })
      const agents = await shared.client.read('agent.list', { scope: { kind: 'workspace', workspaceId } })
      const agent = agents.items.find((/* 工作区实际复制的 Agent。 */ item) => /* 选取实际 producer。 */ item.kind === 'verifySubAgent')
      if (!agent) throw new Error(UsageFixtureMessage.AGENT_MISSING)
      const agentRef = { id: agent.id, version: agent.revision }
      const promptBindings: Record<string, PromptBinding> = {}
      for (const name of agent.promptVars) promptBindings[name] = { source: 'input', port: 'target', path: '/content', format: 'text' }
      const catalog = (await shared.client.read('definition.get', { workspaceId })).catalog
      const opinion = catalog.dataTypes.find((/* 实际不可变类型。 */ type) => /* 复用当前 Opinion schema。 */ type.id === 'factcheck.opinion')
      const claim = catalog.dataTypes.find((/* 实际不可变类型。 */ type) => /* 构造单独版本用于模型投影测试。 */ type.id === 'factcheck.claim')
      const packageRef = catalog.index.find((/* 定义目录真实所属包。 */ item) => /* 明确声明 Opinion 外部类型依赖。 */ item.kind === 'dataType' && item.ref.id === 'factcheck.opinion')?.packageRef
      if (!opinion || !claim || !packageRef) throw new Error(UsageFixtureMessage.DEFINITION_MISSING)
      const targetType = { id: 'test.evidence-target', version: 1 }
      const opinionType = { id: opinion.id, version: opinion.version }
      const transitionRef = { id: 'test.evidence-use', version: 1 }
      const definition: DefinitionPackage = { id: 'test.evidence-usage', version: 1, title: '临时库使用验收',
        schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes: [
          { ...targetType, title: '测试目标', schema: { type: 'object', properties: { content: { type: 'string', minLength: 1 } },
            required: ['content'], additionalProperties: false }, successorTypes: [opinionType], references: [],
            agentProjection: { include: ['/content'], mapEntryFilters: [] } },
          { ...structuredClone(claim), version: 2, agentProjection: { include: ['/content'], mapEntryFilters: [] } },
        ], transitions: [{ ...transitionRef, title: '单阶段库核查', ports: {
          input: [{ name: 'target', inputType: targetType, count: { min: 1, max: 1 } }], context: [],
          output: [{ name: 'opinions', outputType: opinionType, count: { min: 1, max: 1 },
            successorOf: [{ source: 'input', port: 'target' }] }],
        }, cardinality: '1:1', group: { mode: 'explicit-members', ready: 'sealed-all-required' }, execution: {
          stages: [{ id: 'assess', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
            outputPorts: [{ port: 'opinions', count: { min: 1, max: 1 } }], promptBindings }], resultStage: 'assess',
        }, review: { mode: 'none', at: 'result', onReject: 'fail' } }], dependencies: { packages: [packageRef], agents: [agentRef] } }
      const current = await shared.client.read('workspace.get', { workspaceId })
      await shared.client.dispatch(randomUUID(), 'definition.publish', { workspaceId, expectedRevision: current.revision, package: definition })
      return { workspaceId, targetType, opinionType, transitionRef }
    }

    async function createLibraryEntry(
      /* 真实工作区与本测试临时定义。 */ scope: UsageTestScope,
      /* 明确固定数字0/1。 */ confidence: 0 | 1,
      /* 原始 Claim 正文，允许预算用例构造大材料。 */ content = '独立来源 Map 中的固定陈述。',
      /* 实际 Claim 精确类型版本，2用于投影用例。 */ typeVersion = 1,
      /* 可指定跨Map与目标同名身份。 */ nodeId = randomUUID(),
    ): Promise<{ entry: EvidenceLibraryEntry; source: GraphSnapshot }> {
      // 单独来源 Map 的 Claim 被显式收录，不加入目标 Map 图范围。
      const input = await shared.nodeInput(scope.workspaceId, 'factcheck.claim', { content, category: 'quote' }, nodeId)
      input.typeVersion = typeVersion
      const source = await shared.createGraph(scope.workspaceId, [input])
      const entry = (await shared.client.dispatch(randomUUID(), 'evidence.collect',
        relationCollectParams(scope.workspaceId, relationClaimRef(source, nodeId), confidence))).data.entry
      return { entry, source }
    }

    async function createTarget(
      /* 测试工作区精确临时类型。 */ scope: UsageTestScope,
      /* 可指定同名身份，默认独立新身份。 */ nodeId = randomUUID(),
    ): Promise<GraphSnapshot> {
      // 创建没有库来源节点的实际目标 Map。
      return shared.createGraph(scope.workspaceId, [{ id: nodeId, typeId: scope.targetType.id, typeVersion: scope.targetType.version,
        payload: { content: '待核查目标陈述。' } }])
    }

    async function startRun(
      /* 目标工作区和临时单阶段转换。 */ scope: UsageTestScope,
      /* 实际目标 Map，scope不会加入其他来源Map节点。 */ target: GraphSnapshot,
      /* 本步骤显式所选固定库引用。 */ refs: EvidenceLibraryRef[],
      /* true 强制新计算，false 允许生产规格匹配复用。 */ regenerate = true,
      /* 可显式指定多个步骤用于整个Run预算。 */ stepCount = 1,
      /* 可为实际独立步骤分别指定库集合，不提供时各步使用refs。 */ stepSelections?: readonly EvidenceLibraryRef[][],
    ): Promise<UsageTestRun> {
      // 使用真实租约和版本启动；失败时释放编辑占有，成功时占有由 Run 接管。
      const rootIds = target.nodes.filter((/* 实际目标节点。 */ node) => /* 排除历史核查下游。 */ node.typeId === scope.targetType.id).map(
        (/* 实际目标根。 */ node) => /* 提交对应真实身份。 */ node.id)
      const claimed = (await shared.client.dispatch(randomUUID(), 'branch.claim', { mapId: target.mapId, rootIds, holderId: randomUUID() })).data
      if (claimed.status !== 'claimed') throw new Error(UsageFixtureMessage.BRANCH_BUSY)
      const grant = claimed.grant
      const lease = { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
      const runId = randomUUID()
      const steps = Array.from({ length: stepSelections?.length ?? stepCount }, (/* Array生成的占位值。 */ _value, /* 本步稳定位置。 */ index) => {
        // 每步仍显式绑定同一实际target，不将库源当作scope输入。
        const selectedRefs = (stepSelections?.[index] ?? refs).map((/* 本步骤选材输入身份。 */ ref) =>
          /* 选材协议只携带身份和摘要，产物理由属于另一个协议。 */ ({ entryId: ref.entryId, contentDigest: ref.contentDigest }))
        return { id: `assess-${index}`, transitionRef: scope.transitionRef, dependsOn: [],
          input: [{ port: 'target', source: { kind: 'scope', nodeIds: rootIds } }], context: [],
          grouping: { mode: 'each' }, onEmpty: 'fail', ...(selectedRefs.length ? { libraryClaimRefs: selectedRefs } : {}) }
      })
      const request = { requestId: randomUUID(), method: 'run.start' as const, params: { mapId: target.mapId, id: runId,
        branch: { rootIds: grant.branch.scope.rootIds, expectedVersion: grant.branch.version }, lease,
        scope: { nodeIds: rootIds }, plan: { steps }, regenerate, mode: 'auto' } }
      const response = await post('/api/v1/command', request)
      if (response.status !== 200) await shared.client.dispatch(randomUUID(), 'branch.release', { mapId: target.mapId, lease })
      return { response, request, mapId: target.mapId, runId }
    }

    async function claimWork(
      /* 已成功启动的真实运行身份。 */ run: UsageTestRun,
      /* 可指定某个实际步骤的Operation，默认单步骤第一份。 */ stepId?: string,
    ): Promise<GraphWorkGrant> {
      // expectedWorkIds 来自真实公共图，不用私有工作推导函数代替API行为。
      const snapshot = await shared.client.read('map.get', { mapId: run.mapId })
      const currentRun = snapshot.runs.find((/* 真实保存Run。 */ item) => /* 找回本轮Run。 */ item.id === run.runId)
      const operation = stepId === undefined ? currentRun?.operations[0]
        : currentRun?.operations.find((/* 真实Operation。 */ item) => /* 只领取指定步骤获权Work。 */ item.stepId === stepId)
      const workId = operation?.stages[0]?.expectedWorkIds[0]
      if (!workId) throw new Error(UsageFixtureMessage.WORK_MISSING)
      const response = await post('/internal/v1/work', { method: 'claim', params: { mapId: run.mapId, workId,
        hostId: 'usage-test-host', holderId: randomUUID(), deploymentId: application.messaging().deploymentId } }, internalToken)
      const data = usageResponseData(response)
      if (data.status !== 'claimed') throw new Error(UsageFixtureMessage.WORK_MISSING)
      return parseGrant(data.grant)
    }

    async function readWork(
      /* 真实Work领取响应给出的完整授权。 */ grant: GraphWorkGrant,
    ): Promise<Record<string, unknown>> {
      // 新libraryClaims仍按unknown外部字段读取，形状和选择集合由测试断言。
      return usageResponseData(await post('/internal/v1/data/read', { mapId: grant.mapId, operationId: grant.operationId },
        internalToken, grantHeaders(grant)))
    }

    async function outputProposal(
      /* 真实Work授权。 */ grant: GraphWorkGrant,
      /* 实际当前Opinion精确类型。 */ scope: UsageTestScope,
      /* 产物显式声明的库引用，允许恶意外部输入测试。 */ refs: unknown,
    ): Promise<Record<string, unknown>> {
      // 产物沿用当前已发布Opinion payload，库引用只位于通用候选元信息。
      const data = await readWork(grant)
      return { mapId: grant.mapId, operationId: grant.operationId, id: data.proposalId, specHash: data.specHash,
        kind: 'outputs', reason: '核查产物明确声明选材依据。', outputs: [{ key: 'opinion', port: 'opinions',
          typeRef: scope.opinionType, payload: { score: 0.5, reason: '保留意见原始0.5。', evidenceClaimIds: [] },
          ...(refs === undefined ? {} : { libraryClaimRefs: refs }) }] }
    }

    async function propose(
      /* 真实Work完整授权，重放须保持原holder/fence。 */ grant: GraphWorkGrant,
      /* 未知外部提案，生产端负责完整验证。 */ proposal: unknown,
    ): Promise<UsageTestResponse> {
      // 每次都发送真实内部HTTP；相同proposalId/input由原收据规则判重。
      return post('/internal/v1/data/propose', proposal, internalToken, grantHeaders(grant))
    }

    async function editMetadata(
      /* 当前目标Map。 */ mapId: string,
      /* 包含本次节点的真实结构根。 */ rootIds: string[],
      /* 节点可带尚未进入生产类型的外部libraryClaimRefs字段。 */ nodes: Array<GraphNodeInput & { libraryClaimRefs?: unknown }>,
      /* 可显式移除消费者节点。 */ remove: string[] = [],
    ): Promise<UsageTestResponse> {
      // 原图编辑照常取得实际lease/proof，refs不扩大写范围。
      const claimed = (await shared.client.dispatch(randomUUID(), 'branch.claim', { mapId, rootIds, holderId: randomUUID() })).data
      if (claimed.status !== 'claimed') throw new Error(UsageFixtureMessage.BRANCH_BUSY)
      const grant = claimed.grant, lease = { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
      try {
        return await post('/api/v1/command', { requestId: randomUUID(), method: 'graph.apply', params: { mapId, lease,
          branch: { rootIds: grant.branch.scope.rootIds, expectedVersion: grant.branch.version },
          changes: { nodes: { put: nodes, remove } } } })
      } finally { await shared.client.dispatch(randomUUID(), 'branch.release', { mapId, lease }) }
    }

    return { ...shared, createScope, createLibraryEntry, createTarget, startRun, claimWork, readWork, outputProposal,
      propose, editMetadata, query, post, close }
  } catch (error) {
    try { await close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], UsageFixtureMessage.CLEANUP_FAILED) }
    throw error
  }
}

export function usageRef(
  /* 实际已收录库条目，不计算摘要。 */ entry: EvidenceLibraryEntry,
  /* 产物明确解释本次使用理由。 */ reason = '本核查引用该条固定材料。',
): UsageTestRef {
  // 只转发实际身份和固定摘要。
  return { entryId: entry.id, contentDigest: entry.contentDigest, reason }
}

export function usageResponseData(
  /* 真实HTTP结果，尚未确认成功信封。 */ response: UsageTestResponse,
): Record<string, unknown> {
  // 失败不能成为fixture成功结果，保留真实信封便于定位首次失败。
  const body = usageRecord(response.body)
  if (response.status !== 200 || body.ok !== true) throw new Error(`${UsageFixtureMessage.RESPONSE_INVALID} ${JSON.stringify(response)}`)
  return usageRecord(body.data)
}

export function usageRecord(
  /* 真实HTTP/Mongo值，尚未确认字段对象形状。 */ value: unknown,
): Record<string, unknown> {
  // 只接受非数组对象，避免unknown通过断言绕过验证。
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(UsageFixtureMessage.RESPONSE_INVALID)
  return value as Record<string, unknown>
}

export function usageRecords(
  /* 外部数组，需逐项建立对象形状。 */ value: unknown,
): Array<Record<string, unknown>> {
  // 集合缺失和畸形均直接拒绝，不补成空集掩盖错误。
  if (!Array.isArray(value)) throw new Error(UsageFixtureMessage.RESPONSE_INVALID)
  return value.map((/* 数组内未知值。 */ item) => /* 建立每项字段对象入口。 */ usageRecord(item))
}

function parseGrant(
  /* 真实内部Work响应中的未知授权。 */ value: unknown,
): GraphWorkGrant {
  // 验证执行授权字段后才发送lease/fence证明。
  const grant = usageRecord(value)
  if (grant.priority !== 'high' && grant.priority !== 'medium' && grant.priority !== 'low') throw new Error(UsageFixtureMessage.RESPONSE_INVALID)
  return { workId: readString(grant.workId), mapId: readString(grant.mapId), runId: readString(grant.runId),
    operationId: readString(grant.operationId), stageId: readString(grant.stageId), slotId: readString(grant.slotId),
    specHash: readString(grant.specHash), priority: grant.priority, holderId: readString(grant.holderId),
    fence: readNumber(grant.fence), hostId: readString(grant.hostId), expiresAt: readString(grant.expiresAt), leaseMs: readNumber(grant.leaseMs) }
}

function grantHeaders(
  /* 已解析真实Work领取凭证。 */ grant: GraphWorkGrant,
): Record<string, string> {
  // 只发送当前grant给出的完整身份，不伪造holder/fence。
  return { 'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence) }
}

export function usageString(
  /* 外部DTO中待确认字符串值。 */ value: unknown,
): string {
  // 公共测试需要拼接cursor/id时明确验证形状。
  return readString(value)
}

function readString(
  /* 外部授权或查询DTO字符串。 */ value: unknown,
): string {
  // 保留字符串原值，缺失不使用默认值。
  if (typeof value !== 'string' || !value.length) throw new Error(UsageFixtureMessage.RESPONSE_INVALID)
  return value
}

function readNumber(
  /* 外部授权的fence或租期整数。 */ value: unknown,
): number {
  // 有效租期和fence必须是有限非负整数。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(UsageFixtureMessage.RESPONSE_INVALID)
  return value
}

async function listenServer(
  /* 新装配但尚未监听的内部HTTP服务。 */ server: Server,
): Promise<string> {
  // 回环端口绑定就绪后返回实际地址，失败有明确终点。
  await new Promise<void>((/* 监听成功解除等待。 */ resolve, /* 监听错误保留失败。 */ reject) => {
    // 启动期间错误与就绪由同一Promise拥有。
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { /* 就绪后取消启动错误监听。 */ server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(UsageFixtureMessage.ADDRESS_MISSING)
  return `http://127.0.0.1:${address.port}`
}

function closeServer(
  /* 本包装层拥有且开始关闭的内部服务。 */ server: Server,
): Promise<void> {
  // 可等待的Server关闭，重复调用直接结束。
  if (!server.listening) return Promise.resolve()
  return new Promise((/* 成功关闭解除等待。 */ resolve, /* 关闭错误保留失败。 */ reject) => {
    // 正常和异常关闭都结束当前等待。
    server.close((/* 实际关闭错误。 */ error) => /* 返回实际清理结果。 */ error ? reject(error) : resolve())
  })
}
