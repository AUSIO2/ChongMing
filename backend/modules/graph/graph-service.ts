// 协调通用数据图命令、有限 Run、幂等收据和逐 Work 租约，将合法局部变化原子提交到存储。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import type { DefinitionCatalog, DefinitionRef } from '../../../contracts/data-definition'
import type {
  GraphBranchClaimResult, GraphBranchGrant, GraphBranchLeaseProof, GraphBranchSnapshot, GraphChanges, GraphCommand, GraphDataProposal, GraphDataRead, GraphEdge, GraphMapSummary, GraphNode,
  GraphQuery, GraphRun, GraphRunControl, GraphRunControlClaimResult, GraphRunControlGrant, GraphRunControlProof, GraphSnapshot, GraphWorkCommand, GraphWorkGrant, GraphWorkProof, GraphWriteResult,
} from '../../../contracts/graph'
import type { GraphClaimResult } from '../../../contracts/events'
import type { GraphCommitGuard, GraphStore } from '../../ports/graph-store'
import { definitionsReadPayloadReferences, definitionsReadType, definitionsValidatePayload } from '../shared/data-definition'
import { GraphError } from '../shared/domain-error'
import {
  runAnswerReview, runCancelRun, runCreateRun, runReadData, runReadOperation, runReadRun, runUpdatePause, runUpdateProposal,
  type GraphRunStartContext,
} from './run-state'
import { storeCreateInputHash, type GraphBranchOwnershipRecord, type GraphDocument, type GraphOwnershipReceipt, type GraphReceipt, type GraphRunControlRecord } from './graph-record'
import { workReadGrant, workReadItems } from './work-state'
import { branchFindOwnershipConflict, branchPruneOwnerships, branchReadOwnerships, branchReadSnapshot, branchValidateMutation, branchValidateNewRoots } from './branch-state'
import { graphReadPayloadReferenceIndex, graphRefreshPayloadReferenceIndexes } from '../shared/data-reference-index'

/**
 * 租约、内部收据和历史 Run 不进入公开快照；节点已经保存可信 producer 投影。
 *
 * @param document 包含通用节点、关系和当前运行状态的持久化图。
 * @param now 用于过滤过期 editor 的当前时间。
 * @param clientLeasesRequired 本机不展示此前存储的客户端租约。
 */
export function graphReadSnapshot(document: GraphDocument, now = Date.now(),
  clientLeasesRequired = true): GraphSnapshot {
  return { mapId: document.id, workspaceId: document.workspaceId, revision: document.revision, name: document.name,
    nodes: structuredClone(document.nodes), edges: structuredClone(document.edges), runs: structuredClone(document.runs),
    ownershipRevision: document.ownershipRevision ?? 0, ownerships: branchReadOwnerships(document, now).filter(item => clientLeasesRequired || item.kind === 'run'),
    runControls: clientLeasesRequired ? graphReadRunControls(document, now) : [], updatedAt: document.updatedAt }
}

/**
 * @param document 当前图。
 * @param now 存储端当前时间。
 */
function graphReadRunControls(document: GraphDocument, now: number): GraphRunControl[] {
  return Object.values(document.branchOwnerships ?? {}).filter((item): item is GraphRunControlRecord => item.kind === 'control'
    && Date.parse(item.expiresAt) > now && document.runs.some(run => run.id === item.runId && ['running', 'waiting'].includes(run.status)))
    .map(item => { const { kind: _kind, ...control } = structuredClone(item); return control })
}

/**
 * 相同身份只有方法和输入摘要也相同才可重放，避免将新意图误认为旧成功。
 *
 * @param document 当前图及其已接受收据。
 * @param requestId 幂等身份。
 * @param method 公共命令或内部动作。
 * @param inputHash 当前输入的稳定摘要。
 */
function graphReadReceipt(document: GraphDocument, requestId: string,
  method: string, inputHash: string): GraphReceipt | null {
  const receipt = document.receipts.find(item => item.requestId === requestId)
  if (!receipt) return null
  if (receipt.method !== method || receipt.inputHash !== inputHash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_ALREADY_USED_WITH_DIFFERENT_INPUT)
  return receipt
}

/**
 * 收据与业务状态同次提交，响应丢失后可返回同一组正式身份。
 *
 * @param requestId 业务动作的幂等身份。
 * @param method 收据动作。
 * @param inputHash 输入摘要。
 * @param now 服务端时间。
 * @param createdNodeIds 新建节点。
 * @param createdEdgeIds 新建关系。
 * @param branch 分支写入成功时固定的提交后范围与版本。
 */
function graphCreateReceipt(requestId: string, method: string,
  inputHash: string, now: string, createdNodeIds: string[] = [],
  createdEdgeIds: string[] = [], branch?: GraphBranchSnapshot): GraphReceipt {
  return { requestId, method, inputHash, createdNodeIds, createdEdgeIds, ...(branch ? { branch: structuredClone(branch) } : {}), createdAt: now }
}

/**
 * 当前快照反映最新状态；只有仍与该快照同次的分支证明才返回，避免把旧 receipt proof 拼到新快照上。
 *
 * @param document 提交或重放后的当前图。
 * @param receipt 对应已接受收据。
 * @param runControl run.start 同次取得的控制权。
 * @param clientLeasesRequired 服务端客户端租约策略。
 */
function graphCreateWriteResult(document: GraphDocument, receipt: GraphReceipt,
  runControl?: GraphRunControlGrant,
  clientLeasesRequired = true): GraphWriteResult {
  let branch: GraphBranchSnapshot | undefined
  if (receipt.branch && receipt.branch.mapRevision === document.revision) {
    try {
      const current = branchReadSnapshot(document, receipt.branch.scope.rootIds)
      if (current.version === receipt.branch.version) branch = receipt.branch
    } catch { /* 分支根后来消失时只重放原创建身份，不返回不可用于当前快照的 proof。 */ }
  }
  return { snapshot: graphReadSnapshot(document, Date.now(), clientLeasesRequired), createdNodeIds: receipt.createdNodeIds, createdEdgeIds: receipt.createdEdgeIds,
    ...(branch ? { branch: structuredClone(branch) } : {}), ...(runControl ? { runControl: structuredClone(runControl) } : {}) }
}

/**
 * 同一补丁中的重复身份含义不清，必须在修改图前拒绝。
 *
 * @param values 待拒绝重复的身份。
 * @param label 错误字段名。
 */
function graphReadUnique(values: string[], label: string): Set<string> {
  const ids = new Set(values)
  if (ids.size !== values.length) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTAINS_DUPLICATE_IDS, label))
  return ids
}

/**
 * 将实例字段组合成目录引用。
 *
 * @param node 数据实例的精确类型。
 */
function graphRef(node: Pick<GraphNode, 'typeId' | 'typeVersion'>): DefinitionRef {
  return { id: node.typeId, version: node.typeVersion }
}

/**
 * successor 必须被上游精确类型版本许可；reference 不进入此规则。
 *
 * @param definitions 精确定义目录。
 * @param from 上游数据。
 * @param to 正式产物。
 */
function graphValidateSuccessor(definitions: DefinitionCatalog, from: GraphNode, to: GraphNode): void {
  const definition = definitionsReadType(definitions, graphRef(from))
  if (!definition.successorTypes.some(ref => ref.id === to.typeId && ref.version === to.typeVersion)) {
    throw new GraphError(422, 'TRANSITION_NOT_ALLOWED', RuntimeMessage.GRAPH_SUCCESSOR_TYPE_IS_NOT_ALLOWED)
  }
}

/**
 * successor 定义结构分支并保持无环；reference 允许普通关系环。
 *
 * @param nodes 修改后的节点索引。
 * @param edges 修改后的关系索引。
 */
function graphValidateSuccessorAcyclic(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): void {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges.values()) if (edge.kind === 'successor') {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.EDGE_REFERENCES_A_MISSING_NODE)
    const children = outgoing.get(edge.from) ?? []
    children.push(edge.to); outgoing.set(edge.from, children)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.SUCCESSOR_RELATIONS_MUST_NOT_CONTAIN_A_CYCLE)
    if (visited.has(id)) return
    visiting.add(id)
    for (const child of outgoing.get(id) ?? []) visit(child)
    visiting.delete(id); visited.add(id)
  }
  for (const id of nodes.keys()) visit(id)
}

/**
 * 用户修改或删除节点后，所有声明的节点引用都必须仍存在且匹配允许类型版本。
 *
 * @param nodes 修改后的完整节点索引。
 * @param definitions 精确类型目录。
 */
function graphValidateNodeReferences(nodes: Map<string, GraphNode>, definitions: DefinitionCatalog): void {
  for (const node of nodes.values()) for (const reference of definitionsReadPayloadReferences(definitions, graphRef(node), node.payload)) {
    if (reference.definition.target.kind !== 'node') continue
    const target = nodes.get(reference.value)
    if (!target || !reference.definition.target.types.some(type => type.id === target.typeId && type.version === target.typeVersion)) {
      throw new GraphError(422, 'OUTPUT_REFERENCE_INVALID', RuntimeMessage.GRAPH_NODE_REFERENCE_IS_NOT_VALID)
    }
  }
}

/**
 * 应用局部变化，按定义验证 payload/后继及结构无环，返回待提交草稿。
 *
 * @param document 修改前的当前图。
 * @param changes 局部补丁。
 * @param definitions 当前工作区定义目录。
 */
function graphUpdateChanges(document: GraphDocument, changes: GraphChanges,
  definitions: DefinitionCatalog): { document: GraphDocument; createdNodeIds: string[]; createdEdgeIds: string[] } {
  const now = new Date().toISOString()
  const nodePuts = changes.nodes?.put ?? [], nodeRemoves = graphReadUnique(changes.nodes?.remove ?? [], 'nodes.remove')
  const edgePuts = changes.edges?.put ?? [], edgeRemoves = graphReadUnique(changes.edges?.remove ?? [], 'edges.remove')
  graphReadUnique(nodePuts.map(item => item.id), 'nodes.put'); graphReadUnique(edgePuts.map(item => item.id), 'edges.put')
  if (nodePuts.some(item => nodeRemoves.has(item.id))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.A_NODE_CANNOT_BE_PUT_AND_REMOVED_TOGETHER)
  if (edgePuts.some(item => edgeRemoves.has(item.id))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.AN_EDGE_CANNOT_BE_PUT_AND_REMOVED_TOGETHER)
  if (changes.name === undefined && !nodePuts.length && !nodeRemoves.size && !edgePuts.length && !edgeRemoves.size) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.GRAPH_APPLY_CONTAINS_NO_CHANGES)
  const nodes = new Map(document.nodes.map(node => [node.id, structuredClone(node)])), edges = new Map(document.edges.map(edge => [edge.id, structuredClone(edge)]))
  const retiredNodeIds = new Set(document.retiredNodeIds ?? []), retiredEdgeIds = new Set(document.retiredEdgeIds ?? [])
  for (const id of nodeRemoves) {
    if (!nodes.delete(id)) throw new GraphError(404, 'NODE_NOT_FOUND', messageFormat(RuntimeMessage.NODE_NOT_FOUND_VALUE, id))
    retiredNodeIds.add(id)
    for (const [edgeId, edge] of edges) if (edge.from === id || edge.to === id) { edges.delete(edgeId); retiredEdgeIds.add(edgeId) }
  }
  const createdNodeIds: string[] = []
  for (const input of nodePuts) {
    const existing = nodes.get(input.id)
    if (!existing && retiredNodeIds.has(input.id)) throw new GraphError(409, 'NODE_ID_REUSED', RuntimeMessage.DELETED_NODE_IDS_CANNOT_BE_REUSED)
    if (existing && (existing.typeId !== input.typeId || existing.typeVersion !== input.typeVersion)) throw new GraphError(422, 'NODE_TYPE_CHANGED', RuntimeMessage.NODE_TYPE_CHANGE_REQUIRES_AN_EXPLICIT_TRANSITION)
    const payload = definitionsValidatePayload(definitions, { id: input.typeId, version: input.typeVersion }, input.payload)
    nodes.set(input.id, { ...existing, id: input.id, revision: existing ? existing.revision + 1 : 0, typeId: input.typeId,
      typeVersion: input.typeVersion, payload: payload as GraphNode['payload'],
      payloadReferences: graphReadPayloadReferenceIndex(definitions, { id: input.typeId, version: input.typeVersion }, payload as GraphNode['payload']),
      createdAt: existing?.createdAt ?? now, updatedAt: now })
    if (!existing) createdNodeIds.push(input.id)
  }
  for (const id of edgeRemoves) {
    if (!edges.delete(id)) throw new GraphError(404, 'EDGE_NOT_FOUND', messageFormat(RuntimeMessage.EDGE_NOT_FOUND_VALUE, id))
    retiredEdgeIds.add(id)
  }
  const createdEdgeIds: string[] = []
  for (const input of edgePuts) {
    const from = nodes.get(input.from), to = nodes.get(input.to)
    if (!from || !to) throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.EDGE_REFERENCES_A_MISSING_NODE)
    if (input.from === input.to) throw new GraphError(422, 'INVALID_RELATION', messageFormat(RuntimeMessage.SELF_EDGE_IS_NOT_ALLOWED_VALUE, input.id))
    if (input.kind === 'successor') graphValidateSuccessor(definitions, from, to)
    const existing = edges.get(input.id)
    if (!existing && retiredEdgeIds.has(input.id)) throw new GraphError(409, 'EDGE_ID_REUSED', RuntimeMessage.DELETED_EDGE_IDS_CANNOT_BE_REUSED)
    edges.set(input.id, { ...input, revision: existing ? existing.revision + 1 : 0, createdAt: existing?.createdAt ?? now, updatedAt: now })
    if (!existing) createdEdgeIds.push(input.id)
  }
  graphValidateNodeReferences(nodes, definitions)
  graphValidateSuccessorAcyclic(nodes, edges)
  return { document: { ...document, name: changes.name?.trim() || document.name, nodes: [...nodes.values()], edges: [...edges.values()],
    retiredNodeIds: [...retiredNodeIds].sort(), retiredEdgeIds: [...retiredEdgeIds].sort(), updatedAt: now }, createdNodeIds, createdEdgeIds }
}

export interface GraphServiceOptions {
  clientLeases?: 'required' | 'none'
  leaseMs?: number
  branchLeaseMs?: number
  runControlLeaseMs?: number
  now?: () => Promise<number>
  readSource?: (workspaceId: string, node: GraphNode, path: string) => Promise<string>
  assertOutputReferences?: (workspaceId: string, nodes: import('../../../contracts/graph').GraphNodeInput[], definitions: DefinitionCatalog) => Promise<void>
}
export interface GraphDispatchContext { definitions: DefinitionCatalog; run?: GraphRunStartContext; actorUserId?: string }

/**
 * 用户命令和 Work 复用同一图状态与最终裁决，队列只提供唤醒。
 *
 * @param store 图状态及最终写入条件。
 * @param options 租期和受限来源读取器。
 */
export function graphCreateService(store: GraphStore, options: GraphServiceOptions = {}) {
  const leaseMs = options.leaseMs ?? 15_000
  const branchLeaseMs = options.branchLeaseMs ?? 30_000
  const runControlLeaseMs = options.runControlLeaseMs ?? 30_000
  const readNow = options.now ?? (async () => Date.now())
  const clientLeasesRequired = options.clientLeases !== 'none'
  /**
   * @param document 当前图。
   * @param receipt 写入收据。
   * @param runControl 协作模式启动时授予的控制权。
   */
  function graphWriteResult(document: GraphDocument, receipt: GraphReceipt,
    runControl?: GraphRunControlGrant): GraphWriteResult {
    return graphCreateWriteResult(document, receipt, runControl, clientLeasesRequired)
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) throw new Error(RuntimeMessage.LEASEMS_MUST_BE_BETWEEN_100_AND_300000)
  if (!Number.isSafeInteger(branchLeaseMs) || branchLeaseMs < 1_000 || branchLeaseMs > 300_000) throw new Error(RuntimeMessage.BRANCH_LEASEMS_MUST_BE_BETWEEN_1000_AND_300000)
  if (!Number.isSafeInteger(runControlLeaseMs) || runControlLeaseMs < 1_000 || runControlLeaseMs > 300_000) throw new Error(RuntimeMessage.RUN_CONTROL_LEASEMS_MUST_BE_BETWEEN_1000_AND_300000)
  /**
   * @param mapId 未删除图身份。
   */
  async function graphReadMap(mapId: string): Promise<GraphDocument> {
    const document = await store.read(mapId)
    if (!document || document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, mapId))
    if (!clientLeasesRequired) document.branchOwnerships = Object.fromEntries(
      Object.entries(document.branchOwnerships ?? {}).filter(([, item]) => item.kind === 'run'))
    return document
  }
  /**
   * CAS 未命中后先查收据，区分响应丢失和真实竞争。
   *
   * @param original 原状态。
   * @param updated 业务草稿。
   * @param receipt 同次收据。
   * @param grant 可选最终 Work 授权。
   * @param guard 最终分支占有条件。
   */
  async function graphCommit(original: GraphDocument, updated: GraphDocument, receipt: GraphReceipt,
    grant?: GraphWorkGrant, guard?: GraphCommitGuard): Promise<{ document: GraphDocument; receipt: GraphReceipt; replayed: boolean }> {
    if (await store.commit(updated, original.revision, receipt, grant, guard ?? { ownershipRevision: original.ownershipRevision ?? 0 })) {
      const committed = await store.read(updated.id)
      if (!committed) throw new Error(messageFormat(RuntimeMessage.COMMITTED_MAP_DISAPPEARED_VALUE, updated.id))
      return { document: committed, receipt, replayed: false }
    }
    const latest = await store.read(updated.id)
    if (!latest) throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, updated.id))
    const replay = graphReadReceipt(latest, receipt.requestId, receipt.method, receipt.inputHash)
    if (replay) return { document: latest, receipt: replay, replayed: true }
    throw new GraphError(409, 'REVISION_CONFLICT', messageFormat(RuntimeMessage.MAP_REVISION_CHANGED_VALUE, updated.id), latest.revision)
  }

  /**
   * @param document 当前图。
   * @param actorUserId 用户身份。
   * @param requestId 请求身份。
   * @param method 方法。
   * @param inputHash 输入摘要。
   */
  function graphReadOwnershipReceipt(document: GraphDocument, actorUserId: string,
    requestId: string, method: GraphOwnershipReceipt['method'], inputHash: string): GraphOwnershipReceipt | null {
    const receipt = (document.ownershipReceipts ?? []).find(item => item.actorUserId === actorUserId && item.requestId === requestId)
    if (!receipt) return null
    if (receipt.method !== method || receipt.inputHash !== inputHash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_ALREADY_USED_WITH_DIFFERENT_INPUT)
    return receipt
  }

  /**
   * @param document 当前图。
   * @param actorUserId 用户身份。
   * @param proof 客户端租约 proof。
   * @param now 存储端当前时间。
   */
  function graphReadEditorOwnership(document: GraphDocument, actorUserId: string,
    proof: GraphBranchLeaseProof, now: number): GraphBranchOwnershipRecord {
    const ownership = document.branchOwnerships?.[proof.leaseId]
    if (!ownership || ownership.kind !== 'editor' || ownership.ownerUserId !== actorUserId || ownership.holderId !== proof.holderId
      || ownership.fence !== proof.fence || ownership.expiresAt === null || Date.parse(ownership.expiresAt) <= now) {
      throw new GraphError(409, 'BRANCH_LEASE_LOST', RuntimeMessage.BRANCH_EDIT_LEASE_WAS_LOST)
    }
    return ownership
  }

  /**
   * @param left 一侧根集合。
   * @param right 另一侧根集合。
   */
  function graphSameRoots(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index])
  }

  /**
   * @param document 已提交占有后的图状态。
   * @param ownership editor 占有。
   */
  function graphReadBranchGrant(document: GraphDocument, ownership: GraphBranchOwnershipRecord): GraphBranchGrant {
    const branch = branchReadSnapshot(document, ownership.rootIds)
    return { ...structuredClone(ownership), kind: 'editor', expiresAt: ownership.expiresAt!, leaseMs: ownership.leaseMs!,
      scope: branch.scope, branch, ownershipRevision: document.ownershipRevision ?? 0 }
  }
  /**
   * @param document 当前图。
   * @param actorUserId 用户身份。
   * @param runId Run 身份。
   * @param proof 客户端控制 proof。
   * @param now 存储端当前时间。
   */
  function graphReadRunControl(document: GraphDocument, actorUserId: string, runId: string,
    proof: GraphRunControlProof, now: number): GraphRunControlRecord {
    if (!proof) throw new GraphError(409, 'RUN_CONTROL_LEASE_REQUIRED', RuntimeMessage.A_VALID_RUN_CONTROL_LEASE_IS_REQUIRED)
    const control = document.branchOwnerships?.[proof.leaseId]
    if (!control || control.kind !== 'control' || control.runId !== runId || control.ownerUserId !== actorUserId
      || control.holderId !== proof.holderId || control.fence !== proof.fence || Date.parse(control.expiresAt) <= now) {
      throw new GraphError(409, 'RUN_CONTROL_LEASE_LOST', RuntimeMessage.RUN_CONTROL_LEASE_WAS_LOST)
    }
    return control
  }
  /**
   * @param document 已提交协调状态。
   * @param control 控制租约。
   */
  function graphReadRunControlGrant(document: GraphDocument, control: GraphRunControlRecord): GraphRunControlGrant {
    const { kind: _kind, ...grant } = structuredClone(control)
    return { ...grant, ownershipRevision: document.ownershipRevision ?? 0 }
  }
  /**
   * @param document 待提交文档。
   * @param runId 终态 Run。
   */
  function graphReleaseRunOwnerships(document: GraphDocument, runId: string): boolean {
    let changed = false
    for (const [id, ownership] of Object.entries(document.branchOwnerships ?? {})) {
      if ((ownership.kind === 'run' || ownership.kind === 'control') && ownership.runId === runId) {
        delete document.branchOwnerships![id]; changed = true
      }
    }
    return changed
  }
  /**
   * @param document 当前图。
   * @param runId Work 所属 Run。
   */
  function graphRequireRunOwnership(document: GraphDocument, runId: string): void {
    const ownership = document.branchOwnerships?.[runId]
    if (!ownership || ownership.kind !== 'run' || ownership.runId !== runId) {
      throw new GraphError(409, 'RUN_OWNERSHIP_LOST', RuntimeMessage.RUN_BRANCH_OWNERSHIP_IS_MISSING)
    }
  }

  /**
   * @param command 已解析的领取、续租或释放命令。
   * @param actorUserId 由认证事务绑定的用户身份。
   * @param inputHash 稳定输入摘要。
   */
  async function graphDispatchOwnership(
    command: Extract<GraphCommand, { method: 'branch.claim' | 'branch.renew' | 'branch.release' }>,
    actorUserId: string,
    inputHash: string,
  ): Promise<{ data: GraphBranchClaimResult | GraphBranchGrant | { released: boolean; ownershipRevision: number }; replayed: boolean }> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const document = await graphReadMap(command.params.mapId), replay = graphReadOwnershipReceipt(document, actorUserId,
        command.requestId, command.method, inputHash)
      if (replay) return { data: structuredClone(replay.result) as GraphBranchClaimResult | GraphBranchGrant | { released: boolean; ownershipRevision: number }, replayed: true }
      const now = await readNow(), ownerships = branchPruneOwnerships(document.branchOwnerships, now)
      let result: GraphBranchClaimResult | GraphBranchGrant | { released: boolean; ownershipRevision: number }
      let leaseId: string
      if (command.method === 'branch.claim') {
        const branch = branchReadSnapshot(document, command.params.rootIds)
        const existing = Object.values(ownerships).find((item): item is GraphBranchOwnershipRecord => item.kind === 'editor' && item.ownerUserId === actorUserId
          && item.holderId === command.params.holderId && JSON.stringify([...item.rootIds].sort()) === JSON.stringify([...branch.scope.rootIds].sort()))
        const conflict = branchFindOwnershipConflict({ ...document, branchOwnerships: ownerships }, branch.scope, now, existing?.leaseId)
        if (conflict) return { data: { status: 'busy', ownership: conflict }, replayed: false }
        leaseId = existing?.leaseId ?? randomUUID()
        const editor: GraphBranchOwnershipRecord = existing ?? { leaseId, kind: 'editor', rootIds: [...branch.scope.rootIds], ownerUserId: actorUserId,
          holderId: command.params.holderId, fence: (document.ownershipRevision ?? 0) + 1,
          expiresAt: new Date(now + branchLeaseMs).toISOString(), leaseMs: branchLeaseMs }
        editor.expiresAt = new Date(now + branchLeaseMs).toISOString()
        ownerships[leaseId] = editor
        const nextDocument = { ...document, branchOwnerships: ownerships, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }
        result = { status: 'claimed', grant: graphReadBranchGrant(nextDocument, editor) }
      } else if (command.method === 'branch.renew') {
        const ownership = graphReadEditorOwnership({ ...document, branchOwnerships: ownerships }, actorUserId, command.params.lease, now)
        leaseId = ownership.leaseId
        ownership.expiresAt = new Date(now + ownership.leaseMs!).toISOString()
        const nextDocument = { ...document, branchOwnerships: ownerships, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }
        result = graphReadBranchGrant(nextDocument, ownership)
      } else {
        const ownership = graphReadEditorOwnership({ ...document, branchOwnerships: ownerships }, actorUserId, command.params.lease, now)
        leaseId = ownership.leaseId
        delete ownerships[leaseId]
        result = { released: true, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }
      }
      const receipt: GraphOwnershipReceipt = { actorUserId, requestId: command.requestId, method: command.method, inputHash,
        leaseId, result: structuredClone(result), createdAt: new Date(now).toISOString() }
      if (await store.commitOwnership(document.id, document.revision, document.ownershipRevision ?? 0, ownerships, receipt)) {
        return { data: result, replayed: false }
      }
    }
    throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_BRANCH_OWNERSHIP_AFTER_CONCURRENT_UPDATES_SETTLE)
  }

  /**
   * @param command 控制权领取、续租或释放。
   * @param actorUserId 认证用户。
   * @param inputHash 稳定输入摘要。
   */
  async function graphDispatchRunControl(
    command: Extract<GraphCommand, { method: 'run.control.claim' | 'run.control.renew' | 'run.control.release' }>,
    actorUserId: string, inputHash: string,
  ): Promise<{ data: GraphRunControlClaimResult | GraphRunControlGrant | { released: boolean; ownershipRevision: number }; replayed: boolean }> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const document = await graphReadMap(command.params.mapId), replay = graphReadOwnershipReceipt(document, actorUserId,
        command.requestId, command.method, inputHash)
      if (replay) return { data: structuredClone(replay.result) as GraphRunControlClaimResult | GraphRunControlGrant | { released: boolean; ownershipRevision: number }, replayed: true }
      const run = document.runs.find(item => item.id === command.params.runId)
      if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.RUN_NOT_FOUND)
      if (!['running', 'waiting'].includes(run.status)) throw new GraphError(409, 'RUN_NOT_ACTIVE', RuntimeMessage.RUN_IS_TERMINAL)
      const now = await readNow(), ownerships = branchPruneOwnerships(document.branchOwnerships, now)
      let result: GraphRunControlClaimResult | GraphRunControlGrant | { released: boolean; ownershipRevision: number }
      let leaseId: string
      if (command.method === 'run.control.claim') {
        const current = Object.values(ownerships).find((item): item is GraphRunControlRecord => item.kind === 'control' && item.runId === run.id)
        if (current && (current.ownerUserId !== actorUserId || current.holderId !== command.params.holderId)) {
          const { kind: _kind, ...control } = structuredClone(current)
          return { data: { status: 'busy', control }, replayed: false }
        }
        leaseId = current?.leaseId ?? randomUUID()
        const control: GraphRunControlRecord = current ?? { leaseId, kind: 'control', runId: run.id, ownerUserId: actorUserId,
          holderId: command.params.holderId, fence: (document.ownershipRevision ?? 0) + 1,
          expiresAt: new Date(now + runControlLeaseMs).toISOString(), leaseMs: runControlLeaseMs }
        control.expiresAt = new Date(now + runControlLeaseMs).toISOString()
        ownerships[leaseId] = control
        result = { status: 'claimed', grant: graphReadRunControlGrant({ ...document,
          ownershipRevision: (document.ownershipRevision ?? 0) + 1 }, control) }
      } else if (command.method === 'run.control.renew') {
        const control = graphReadRunControl({ ...document, branchOwnerships: ownerships }, actorUserId, run.id, command.params.control, now)
        leaseId = control.leaseId
        control.expiresAt = new Date(now + control.leaseMs).toISOString()
        result = graphReadRunControlGrant({ ...document, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }, control)
      } else {
        const control = graphReadRunControl({ ...document, branchOwnerships: ownerships }, actorUserId, run.id, command.params.control, now)
        leaseId = control.leaseId
        delete ownerships[leaseId]
        result = { released: true, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }
      }
      const receipt: GraphOwnershipReceipt = { actorUserId, requestId: command.requestId, method: command.method, inputHash,
        leaseId, result: structuredClone(result), createdAt: new Date(now).toISOString() }
      if (await store.commitOwnership(document.id, document.revision, document.ownershipRevision ?? 0, ownerships, receipt)) {
        return { data: result, replayed: false }
      }
    }
    throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_BRANCH_OWNERSHIP_AFTER_CONCURRENT_UPDATES_SETTLE)
  }

  return {
    /**
     * @param query 已授权图查询。
     * @param definitions branch.get 可用的当前工作区定义，用于兼容重建派生引用索引。
     */
    async read(query: GraphQuery, definitions?: DefinitionCatalog): Promise<GraphSnapshot | GraphMapSummary[] | GraphRun | GraphBranchSnapshot> {
      if (query.method === 'map.list') return store.list(query.params.workspaceId)
      const stored = await graphReadMap(query.params.mapId)
      const document = query.method === 'branch.get' && definitions
        ? { ...stored, nodes: graphRefreshPayloadReferenceIndexes(definitions, stored.nodes) } : stored
      if (query.method === 'branch.get') return branchReadSnapshot(document, query.params.rootIds)
      if (query.method === 'run.get') {
        const run = document.runs.find(item => item.id === query.params.runId) ?? document.runHistory.find(item => item.id === query.params.runId)
        if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.RUN_NOT_FOUND)
        return structuredClone(run)
      }
      return graphReadSnapshot(document, await readNow(), clientLeasesRequired)
    },

    /**
     * @param command 用户级幂等图命令。
     * @param context 定义及可选冻结 Run 上下文。
     */
    async dispatch(command: GraphCommand, context?: GraphDispatchContext): Promise<{
      data: GraphWriteResult | { mapId: string; deleted: true } | GraphBranchClaimResult | GraphBranchGrant | GraphRunControlClaimResult | GraphRunControlGrant
        | { released: boolean; ownershipRevision: number }; replayed: boolean
    }> {
      const inputHash = storeCreateInputHash({ method: command.method, params: command.params }), now = new Date().toISOString()
      if (command.method === 'map.create') {
        const prior = await store.read(command.params.id)
        if (prior) {
          const replay = graphReadReceipt(prior, command.requestId, command.method, inputHash)
          if (!replay || prior.deletedAt) throw new GraphError(409, 'MAP_EXISTS', messageFormat(RuntimeMessage.MAP_ALREADY_EXISTS_VALUE, prior.id))
          return { data: graphWriteResult(prior, replay), replayed: true }
        }
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
        const document: GraphDocument = { id: command.params.id, workspaceId: command.params.workspaceId, revision: 0, name: command.params.name.trim(),
          nodes: [], edges: [], retiredNodeIds: [], retiredEdgeIds: [], ownershipRevision: 0, branchOwnerships: {}, ownershipReceipts: [],
          runs: [], runHistory: [], leases: {}, receipts: [receipt], createdAt: now, updatedAt: now }
        if (!document.name) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.MAP_NAME_MUST_NOT_BE_EMPTY)
        if (await store.create(document)) return { data: graphWriteResult(document, receipt), replayed: false }
        const existing = await store.read(document.id)
        if (!existing) throw new Error(messageFormat(RuntimeMessage.DUPLICATE_MAP_DISAPPEARED_VALUE, document.id))
        const replay = graphReadReceipt(existing, command.requestId, command.method, inputHash)
        if (!replay || existing.deletedAt) throw new GraphError(409, 'MAP_EXISTS', messageFormat(RuntimeMessage.MAP_ALREADY_EXISTS_VALUE, document.id))
        return { data: graphWriteResult(existing, replay), replayed: true }
      }
      if (command.method === 'branch.claim' || command.method === 'branch.renew' || command.method === 'branch.release') {
        if (!clientLeasesRequired) throw new GraphError(409, 'CLIENT_LEASES_DISABLED', RuntimeMessage.LOCAL_MODE_DOES_NOT_USE_CLIENT_LEASES)
        if (!context?.actorUserId) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
        return graphDispatchOwnership(command, context.actorUserId, inputHash)
      }
      if (command.method === 'run.control.claim' || command.method === 'run.control.renew' || command.method === 'run.control.release') {
        if (!clientLeasesRequired) throw new GraphError(409, 'CLIENT_LEASES_DISABLED', RuntimeMessage.LOCAL_MODE_DOES_NOT_USE_CLIENT_LEASES)
        if (!context?.actorUserId) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
        return graphDispatchRunControl(command, context.actorUserId, inputHash)
      }
      const document = await graphReadMap(command.params.mapId), prior = graphReadReceipt(document, command.requestId, command.method, inputHash)
      if (prior) return command.method === 'map.delete' ? { data: { mapId: document.id, deleted: true }, replayed: true }
        : { data: graphWriteResult(document, prior), replayed: true }
      if (command.method === 'map.delete') {
        if (document.runs.some(run => ['running', 'waiting'].includes(run.status))) throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.ACTIVE_RUN_MUST_BE_CANCELLED_BEFORE_DELETING_MAP)
        if (branchReadOwnerships(document, await readNow()).length) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.RELEASE_ACTIVE_BRANCHES_BEFORE_DELETING_MAP)
        if (document.revision !== command.params.expectedRevision) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.MAP_REVISION_CHANGED, document.revision)
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
        const result = await graphCommit(document, { ...document, deletedAt: now, updatedAt: now }, receipt)
        return { data: { mapId: result.document.id, deleted: true }, replayed: result.replayed }
      }
      if (!context) throw new GraphError(409, 'DEFINITION_NOT_FOUND', RuntimeMessage.GRAPH_WRITE_REQUIRES_A_DEFINITION_CATALOG)
      if (command.method === 'graph.apply') {
        // Map revision 只负责物理串行化；无关分支抢先提交时从最新图重放同一局部补丁。
        for (let attempt = 0; attempt < 64; attempt++) {
          const stored = attempt === 0 ? document : await graphReadMap(command.params.mapId)
          const current = { ...stored, nodes: graphRefreshPayloadReferenceIndexes(context.definitions, stored.nodes) }
          const replay = graphReadReceipt(current, command.requestId, command.method, inputHash)
          if (replay) return { data: graphWriteResult(current, replay), replayed: true }
          const proof = command.params.branch
          const before = proof.expectedVersion === null ? undefined : branchReadSnapshot(current, proof.rootIds)
          if (before && before.version !== proof.expectedVersion) {
            throw new GraphError(409, 'BRANCH_VERSION_CONFLICT', RuntimeMessage.BRANCH_VERSION_CHANGED)
          }
          const nowMs = await readNow(), activeOwnerships = branchPruneOwnerships(current.branchOwnerships, nowMs)
          let editor: GraphBranchOwnershipRecord | undefined
          if (before && clientLeasesRequired) {
            if (!context.actorUserId || !command.params.lease) throw new GraphError(409, 'BRANCH_LEASE_REQUIRED', RuntimeMessage.A_VALID_BRANCH_EDIT_LEASE_IS_REQUIRED)
            editor = graphReadEditorOwnership({ ...current, branchOwnerships: activeOwnerships }, context.actorUserId, command.params.lease, nowMs)
            if (!graphSameRoots(editor.rootIds, proof.rootIds)) throw new GraphError(409, 'BRANCH_LEASE_SCOPE_CONFLICT', RuntimeMessage.BRANCH_EDIT_LEASE_DOES_NOT_COVER_THE_REQUESTED_ROOTS)
          }
          // 删除整个根也必须先检查旧 scope，不能因修改后没有分支而绕过运行占有。
          if (before && branchFindOwnershipConflict({ ...current, branchOwnerships: activeOwnerships }, before.scope, nowMs, editor?.leaseId)) {
            throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
          }
          const change = graphUpdateChanges(structuredClone(current), command.params.changes, context.definitions)
          const branch = proof.expectedVersion === null
            ? branchValidateNewRoots(current, change.document, proof.rootIds, command.params.changes)
            : branchValidateMutation(current, change.document, command.params.changes, before!.scope)
          if (branch) {
            const conflict = branchFindOwnershipConflict({ ...change.document, branchOwnerships: activeOwnerships }, branch.scope, nowMs, editor?.leaseId)
            if (conflict) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
          }
          change.document.branchOwnerships = activeOwnerships
          change.document.ownershipReceipts = current.ownershipReceipts ?? []
          change.document.ownershipRevision = current.ownershipRevision ?? 0
          if (editor && !branch) {
            delete activeOwnerships[editor.leaseId]
            change.document.ownershipRevision++
          } else if (editor && branch && before && JSON.stringify(before.scope.nodeIds) !== JSON.stringify(branch.scope.nodeIds)) {
            change.document.ownershipRevision++
          }
          if (options.assertOutputReferences && change.createdNodeIds.length) {
            const ids = new Set(change.createdNodeIds)
            await options.assertOutputReferences(current.workspaceId, change.document.nodes.filter(node => ids.has(node.id)).map(node => ({
              id: node.id, typeId: node.typeId, typeVersion: node.typeVersion, payload: node.payload,
            })), context.definitions)
          }
          const committedBranch = branch ? { ...branch, mapRevision: current.revision + 1 } : undefined
          const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now,
            change.createdNodeIds, change.createdEdgeIds, committedBranch)
          try {
            const guard: GraphCommitGuard = { ownershipRevision: current.ownershipRevision ?? 0,
              ...(editor && command.params.lease && context.actorUserId ? { editor: { ...command.params.lease, ownerUserId: context.actorUserId } } : {}) }
            const result = await graphCommit(current, change.document, receipt, undefined, guard)
            return { data: graphWriteResult(result.document, result.receipt), replayed: result.replayed }
          } catch (error) {
            if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error
          }
        }
        throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_GRAPH_CHANGE_AFTER_CONCURRENT_UPDATES_SETTLE)
      }
      if (command.method === 'run.start') {
        if (!context.run) throw new GraphError(409, 'DEFINITION_NOT_FOUND', RuntimeMessage.RUN_START_REQUIRES_A_FROZEN_EXECUTION_CATALOG)
        for (let attempt = 0; attempt < 64; attempt++) {
          const stored = attempt === 0 ? document : await graphReadMap(command.params.mapId)
          const current = { ...stored, nodes: graphRefreshPayloadReferenceIndexes(context.definitions, stored.nodes) }
          const replay = graphReadReceipt(current, command.requestId, command.method, inputHash)
          if (replay) return { data: graphWriteResult(current, replay), replayed: true }
          const branch = branchReadSnapshot(current, command.params.branch.rootIds)
          if (branch.version !== command.params.branch.expectedVersion) {
            throw new GraphError(409, 'BRANCH_VERSION_CONFLICT', RuntimeMessage.BRANCH_VERSION_CHANGED)
          }
          const members = new Set(branch.scope.nodeIds)
          if (command.params.scope.nodeIds.some(id => !members.has(id))) {
            throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.RUN_SCOPE_MUST_BE_INSIDE_THE_VERSIONED_BRANCH)
          }
          if (!context.actorUserId) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
          const nowMs = await readNow(), activeOwnerships = branchPruneOwnerships(current.branchOwnerships, nowMs)
          let editor: GraphBranchOwnershipRecord | undefined
          if (clientLeasesRequired) {
            if (!command.params.lease) throw new GraphError(409, 'BRANCH_LEASE_REQUIRED', RuntimeMessage.A_VALID_BRANCH_EDIT_LEASE_IS_REQUIRED)
            editor = graphReadEditorOwnership({ ...current, branchOwnerships: activeOwnerships }, context.actorUserId, command.params.lease, nowMs)
            if (!graphSameRoots(editor.rootIds, command.params.branch.rootIds)) throw new GraphError(409, 'BRANCH_LEASE_SCOPE_CONFLICT', RuntimeMessage.BRANCH_EDIT_LEASE_DOES_NOT_COVER_THE_REQUESTED_ROOTS)
          }
          if (branchFindOwnershipConflict({ ...current, branchOwnerships: activeOwnerships }, branch.scope, nowMs, editor?.leaseId)) {
            throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
          }
          const updated = runCreateRun(structuredClone(current), command.params, context.run, now)
          const startedRun = runReadRun(updated, command.params.id)
          if (editor) delete activeOwnerships[editor.leaseId]
          let controlLeaseId: string | undefined
          if (['running', 'waiting'].includes(startedRun.status)) {
            activeOwnerships[startedRun.id] = { leaseId: startedRun.id, kind: 'run', rootIds: [...branch.scope.rootIds],
              ownerUserId: context.actorUserId, holderId: editor?.holderId ?? context.actorUserId, fence: (current.ownershipRevision ?? 0) + 1,
              expiresAt: null, leaseMs: null, runId: startedRun.id }
            if (editor) {
              controlLeaseId = randomUUID()
              activeOwnerships[controlLeaseId] = { leaseId: controlLeaseId, kind: 'control', runId: startedRun.id,
                ownerUserId: context.actorUserId, holderId: editor.holderId, fence: (current.ownershipRevision ?? 0) + 1,
                expiresAt: new Date(nowMs + runControlLeaseMs).toISOString(), leaseMs: runControlLeaseMs }
            }
          }
          updated.branchOwnerships = activeOwnerships
          updated.ownershipReceipts = current.ownershipReceipts ?? []
          updated.ownershipRevision = (current.ownershipRevision ?? 0) + 1
          const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now, [], [], { ...branch, mapRevision: current.revision + 1 })
          try {
            const result = await graphCommit(current, updated, receipt, undefined, { ownershipRevision: current.ownershipRevision ?? 0,
              ...(editor ? { editor: { leaseId: editor.leaseId, holderId: editor.holderId, fence: editor.fence, ownerUserId: context.actorUserId } } : {}) })
            const control = controlLeaseId ? result.document.branchOwnerships?.[controlLeaseId] : undefined
            return { data: graphWriteResult(result.document, result.receipt,
              control?.kind === 'control' ? graphReadRunControlGrant(result.document, control) : undefined), replayed: result.replayed }
          } catch (error) {
            if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error
          }
        }
        throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_GRAPH_CHANGE_AFTER_CONCURRENT_UPDATES_SETTLE)
      }
      if (!context.actorUserId) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
      for (let attempt = 0; attempt < 64; attempt++) {
        const current = attempt === 0 ? document : await graphReadMap(command.params.mapId)
        const replay = graphReadReceipt(current, command.requestId, command.method, inputHash)
        if (replay) return { data: graphWriteResult(current, replay), replayed: true }
        const controlNow = await readNow(), activeOwnerships = branchPruneOwnerships(current.branchOwnerships, controlNow)
        if (clientLeasesRequired && !command.params.control) throw new GraphError(409, 'RUN_CONTROL_LEASE_REQUIRED', RuntimeMessage.A_VALID_RUN_CONTROL_LEASE_IS_REQUIRED)
        const control = clientLeasesRequired ? graphReadRunControl({ ...current, branchOwnerships: activeOwnerships }, context.actorUserId,
          command.params.runId, command.params.control!, controlNow) : undefined
        let updated: GraphDocument, createdNodeIds: string[] = [], createdEdgeIds: string[] = []
        if (command.method === 'run.cancel') updated = runCancelRun(structuredClone(current), command.params.runId, now)
        else if (command.method === 'run.pause') updated = runUpdatePause(structuredClone(current), command.params.runId, true, now)
        else if (command.method === 'run.resume') updated = runUpdatePause(structuredClone(current), command.params.runId, false, now)
        else if (command.method === 'review.answer') {
          const answer = runAnswerReview(structuredClone(current), command.params, now)
          updated = answer.document; createdNodeIds = answer.nodeIds; createdEdgeIds = answer.edgeIds
        } else throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_COMMAND)
        const runId = command.params.runId, runOwnership = current.branchOwnerships?.[runId]
        if (!runOwnership || runOwnership.kind !== 'run' || runOwnership.runId !== runId) {
          throw new GraphError(409, 'RUN_OWNERSHIP_LOST', RuntimeMessage.RUN_BRANCH_OWNERSHIP_IS_MISSING)
        }
        updated.branchOwnerships = activeOwnerships
        updated.ownershipReceipts = structuredClone(current.ownershipReceipts ?? [])
        updated.ownershipRevision = current.ownershipRevision ?? 0
        const targetRun = runReadRun(updated, runId)
        if (['completed', 'failed', 'cancelled'].includes(targetRun.status)) {
          if (graphReleaseRunOwnerships(updated, runId)) updated.ownershipRevision++
        } else if (targetRun.branchState) {
          const conflict = branchFindOwnershipConflict(updated, targetRun.branchState.scope, controlNow, runId)
          if (conflict) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
        }
        if (options.assertOutputReferences && createdNodeIds.length) {
          const ids = new Set(createdNodeIds)
          await options.assertOutputReferences(current.workspaceId, updated.nodes.filter(node => ids.has(node.id)).map(node => ({
            id: node.id, typeId: node.typeId, typeVersion: node.typeVersion, payload: node.payload,
          })), context.definitions)
        }
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now, createdNodeIds, createdEdgeIds)
        try {
          const result = await graphCommit(current, updated, receipt, undefined, { ownershipRevision: current.ownershipRevision ?? 0, runId,
            ...(control ? { control: { leaseId: control.leaseId, holderId: control.holderId, fence: control.fence, ownerUserId: context.actorUserId, runId } } : {}) })
          return { data: graphWriteResult(result.document, result.receipt), replayed: result.replayed }
        } catch (error) { if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_GRAPH_CHANGE_AFTER_CONCURRENT_UPDATES_SETTLE)
    },

    /**
     * @param command 内部 Host 工作命令。
     */
    async dispatchWork(command: GraphWorkCommand) {
      if (command.method === 'claim') {
        const input = command.params
        for (let attempt = 0; attempt < 64; attempt++) {
          const document = await store.read(input.mapId)
          if (!document || document.deletedAt) return { status: 'obsolete' } satisfies GraphClaimResult
          const work = workReadItems(document).find(item => item.workId === input.workId)
          if (!work || !document.branchOwnerships?.[work.runId] || document.receipts.some(receipt => receipt.requestId === input.workId)) return { status: 'obsolete' } satisfies GraphClaimResult
          const prior = document.leases[input.workId]
          if (prior && prior.holderId === input.holderId && prior.hostId === input.hostId) {
            const current = await store.readLease(document.id, prior)
            if (current) return { status: 'claimed', grant: current.leases[input.workId] } satisfies GraphClaimResult
          }
          const grant = await store.claim(document, work, input.hostId, input.holderId, leaseMs)
          if (grant) return { status: 'claimed', grant } satisfies GraphClaimResult
          const retryAfterMs = await store.readLeaseDelay(input.mapId, input.workId)
          if (retryAfterMs > 0) return { status: 'busy', retryAfterMs } satisfies GraphClaimResult
        }
        throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_CLAIM_AFTER_CONCURRENT_UPDATES_SETTLE)
      }
      if (command.method === 'renew') {
        const document = await graphReadMap(command.params.mapId), grantBefore = workReadGrant(document, command.params)
        graphRequireRunOwnership(document, grantBefore.runId)
        const grant = await store.renew(command.params.mapId, command.params)
        if (!grant) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_EXPIRED_WAS_CANCELLED_OR_WAS_SUPERSEDED)
        return grant
      }
      if (command.method === 'read') {
        const input = command.params, document = await graphReadMap(input.mapId)
        if (document.leases[input.workId] && document.receipts.some(receipt => receipt.requestId === input.workId)) return { workId: input.workId, status: 'accepted' as const }
        const grant = workReadGrant(document, input)
        graphRequireRunOwnership(document, grant.runId)
        if (!await store.readLease(input.mapId, input)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        return { workId: input.workId, status: 'ready' as const }
      }
      if (command.method === 'release') return { released: await store.release(command.params.mapId, command.params) }
      const failure = command.params, failureId = `${failure.workId}:failure:${failure.fence}`
      const failureHash = storeCreateInputHash({ workId: failure.workId, message: failure.message })
      for (let attempt = 0; attempt < 64; attempt++) {
        const document = await graphReadMap(failure.mapId), grant = workReadGrant(document, failure)
        if (graphReadReceipt(document, failureId, 'work.fail', failureHash)) return { failed: true }
        if (document.receipts.some(receipt => receipt.requestId === failure.workId)) return { failed: false }
        if (!await store.readLease(failure.mapId, grant)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        const updated = structuredClone(document), run = updated.runs.find(item => item.id === grant.runId)
        if (!run) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_NO_LONGER_BELONGS_TO_THE_ACTIVE_RUN)
        graphRequireRunOwnership(document, grant.runId)
        const operation = runReadOperation(run, grant.operationId)
        operation.status = 'failed'; run.status = 'failed'; run.error = { code: 'WORK_FAILED', message: failure.message, workId: failure.workId }
        run.updatedAt = new Date().toISOString(); updated.updatedAt = run.updatedAt
        updated.ownershipRevision = document.ownershipRevision ?? 0
        if (graphReleaseRunOwnerships(updated, grant.runId)) updated.ownershipRevision++
        const receipt = graphCreateReceipt(failureId, 'work.fail', failureHash, run.updatedAt)
        try { await graphCommit(document, updated, receipt, grant, { ownershipRevision: document.ownershipRevision ?? 0, runId: grant.runId }); return { failed: true } }
        catch (error) { if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_CLAIM_AFTER_CONCURRENT_UPDATES_SETTLE)
    },

    /**
     * 来源正文只在缺失时通过受限读取器获取，并在返回模型前持久化到 Operation。
     *
     * @param mapId 内部 data_read 参数。
     * @param operationId Operation 身份。
     * @param proof 当前 Work 凭证。
     */
    async readData(mapId: string, operationId: string, proof: GraphWorkProof): Promise<GraphDataRead> {
      const fetched = new Map<string, string>()
      for (let attempt = 0; attempt < 64; attempt++) {
        let document = await graphReadMap(mapId), grant = workReadGrant(document, proof)
        if (!await store.readLease(mapId, grant)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        const run = document.runs.find(item => item.id === grant.runId)
        if (!run) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_NO_LONGER_BELONGS_TO_THE_ACTIVE_RUN)
        graphRequireRunOwnership(document, grant.runId)
        const operation = runReadOperation(run, operationId), stage = operation.executionSpec.stages.find(item => item.id === grant.stageId)
        if (!stage) throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.STAGE_WORK_IS_NOT_READY)
        const sourceBindings = Object.entries(stage.promptBindings).flatMap(([name, binding]) => {
          if (binding.source !== 'source-text') return []
          const refs = [...operation.group.inputRefs, ...operation.group.contextRefs].filter(item => item.port === binding.port)
          if (!refs.length) throw new GraphError(409, 'INPUT_STALE', RuntimeMessage.OPERATION_TARGET_IS_MISSING)
          return refs.map(ref => ({ name, binding, ref,
            cacheKey: storeCreateInputHash({ stageId: stage.id, name, port: binding.port, path: binding.path, id: ref.id, revision: ref.revision }) }))
        })
        const missing = sourceBindings.filter(item => operation.externalInputs[item.cacheKey] === undefined)
        for (const item of missing) {
          if (!options.readSource) throw new GraphError(422, 'SOURCE_UNREADABLE', RuntimeMessage.SOURCE_READER_IS_NOT_CONFIGURED)
          const node = document.nodes.find(node => node.id === item.ref.id && node.revision === item.ref.revision)
          if (!node) throw new GraphError(409, 'INPUT_STALE', messageFormat(RuntimeMessage.OPERATION_INPUT_CHANGED_VALUE, item.ref.id))
          if (!fetched.has(item.cacheKey)) fetched.set(item.cacheKey, await options.readSource(document.workspaceId, node, item.binding.path))
        }
        if (missing.length) {
          const updated = structuredClone(document), nextRun = runReadRun(updated, grant.runId), nextOperation = runReadOperation(nextRun, operationId)
          for (const item of missing) nextOperation.externalInputs[item.cacheKey] = fetched.get(item.cacheKey)!
          updated.updatedAt = new Date().toISOString(); nextRun.updatedAt = updated.updatedAt
          const values = Object.fromEntries(missing.map(item => [item.cacheKey, fetched.get(item.cacheKey)!]))
          const keys = Object.keys(values).sort()
          // 同一冻结来源集合以首次成功提交的正文为准；并发读取动态 URL 即使返回不同正文，也重放赢家而不是形成幂等冲突。
          const hash = storeCreateInputHash({ operationId, keys })
          const receipt = graphCreateReceipt(`${operationId}:source:${storeCreateInputHash(keys)}`, 'source.read', hash, updated.updatedAt)
          try { document = (await graphCommit(document, updated, receipt, grant,
            { ownershipRevision: document.ownershipRevision ?? 0, runId: grant.runId })).document }
          catch (error) { if (error instanceof GraphError && error.code === 'REVISION_CONFLICT') continue; throw error }
          grant = workReadGrant(document, proof)
        }
        const stored = runReadOperation(runReadRun(document, grant.runId), operationId).externalInputs
        const sourceText = Object.fromEntries(Object.entries(stage.promptBindings).flatMap(([name, binding]) => {
          if (binding.source !== 'source-text') return []
          const values = sourceBindings.filter(item => item.name === name).map(item => stored[item.cacheKey]).filter((value): value is string => value !== undefined)
          return [[name, values.join('\n\n')]]
        }))
        const data = runReadData(document, operationId, grant, sourceText)
        return { ...data, work: { id: grant.workId, stageId: grant.stageId, slotId: grant.slotId, specHash: grant.specHash, status: 'ready' } }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_CLAIM_AFTER_CONCURRENT_UPDATES_SETTLE)
    },

    /**
     * 按冻结定义、输入版本和最终租约复验；合法 CAS 竞争重放同一提案，不重跑模型。
     *
     * @param mapId 图身份。
     * @param operationId Operation 身份。
     * @param proposal 通用阶段提案。
     * @param proof 当前 Work 凭证。
     */
    async propose(mapId: string, operationId: string, proposal: GraphDataProposal,
      proof: GraphWorkProof): Promise<GraphWriteResult> {
      if (proposal.operationId !== operationId) throw new GraphError(409, 'PROPOSAL_CONFLICT', RuntimeMessage.PROPOSAL_DOES_NOT_BELONG_TO_THIS_WORK_GRANT)
      const inputHash = storeCreateInputHash(proposal)
      for (let attempt = 0; attempt < 64; attempt++) {
        const document = await graphReadMap(mapId), grant = workReadGrant(document, proof)
        const replay = graphReadReceipt(document, proposal.id, 'data.propose', inputHash)
        if (replay) return graphWriteResult(document, replay)
        if (!await store.readLease(mapId, grant)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        graphRequireRunOwnership(document, grant.runId)
        const result = runUpdateProposal(structuredClone(document), proposal, grant, new Date().toISOString())
        result.document.branchOwnerships = structuredClone(document.branchOwnerships ?? {})
        result.document.ownershipReceipts = structuredClone(document.ownershipReceipts ?? [])
        result.document.ownershipRevision = document.ownershipRevision ?? 0
        const run = runReadRun(result.document, grant.runId)
        if (['completed', 'failed', 'cancelled'].includes(run.status)) {
          if (graphReleaseRunOwnerships(result.document, run.id)) result.document.ownershipRevision++
        } else if (run?.branchState) {
          const conflict = branchFindOwnershipConflict(result.document, run.branchState.scope, await readNow(), run.id)
          if (conflict) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
        }
        if (options.assertOutputReferences && result.nodeIds.length) {
          const ids = new Set(result.nodeIds)
          await options.assertOutputReferences(document.workspaceId, result.document.nodes.filter(node => ids.has(node.id)).map(node => ({
            id: node.id, typeId: node.typeId, typeVersion: node.typeVersion, payload: node.payload,
          })), run.definitions)
        }
        const receipt = graphCreateReceipt(proposal.id, 'data.propose', inputHash, result.document.updatedAt, result.nodeIds, result.edgeIds)
        try {
          const committed = await graphCommit(document, result.document, receipt, grant,
            { ownershipRevision: document.ownershipRevision ?? 0, runId: grant.runId })
          return graphWriteResult(committed.document, committed.receipt)
        }
        catch (error) { if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_PROPOSAL_AFTER_CONCURRENT_UPDATES_SETTLE)
    },
  }
}
