// 定义图的持久化文档和幂等收据，并为业务输入生成稳定摘要。
import { createHash } from 'node:crypto'
import { RuntimeMessage } from '../../../contracts/messages'
import type { GraphBranchOwnership, GraphBranchSnapshot } from '../../../contracts/graph-branch'
import type { GraphEdge, GraphNode } from '../../../contracts/graph'
import type { GraphRun } from '../../../contracts/graph-run'
import type { GraphWorkGrant } from '../../../contracts/graph-work'
import { GraphError } from '../shared/domain-error'
import { definitionsDigest } from '../shared/data-definition'
import { graphInputReadLibraryClaimRefs, graphInputReadLibraryUseRefs } from './library-claim-input'
import type { EvidenceLibraryRef, EvidenceUseRef } from '../../../contracts/evidence-library'

export interface GraphReceipt {
  requestId: string
  method: string
  inputHash: string
  createdNodeIds: string[]
  createdEdgeIds: string[]
  branch?: GraphBranchSnapshot
  createdAt: string
}

export type GraphBranchOwnershipRecord =
  | Omit<Extract<GraphBranchOwnership, { kind: 'editor' }>, 'scope'>
  | Omit<Extract<GraphBranchOwnership, { kind: 'run' }>, 'scope'>

export interface GraphRunControlRecord {
  leaseId: string
  kind: 'control'
  runId: string
  ownerUserId: string
  holderId: string
  fence: number
  expiresAt: string
  leaseMs: number
}

export type GraphOwnershipRecord = GraphBranchOwnershipRecord | GraphRunControlRecord

export interface GraphOwnershipReceipt {
  actorUserId: string
  requestId: string
  method: 'branch.claim' | 'branch.renew' | 'branch.release' | 'run.control.claim' | 'run.control.renew' | 'run.control.release'
  inputHash: string
  leaseId: string
  result: unknown
  createdAt: string
}

export interface GraphDocument {
  id: string
  workspaceId: string
  revision: number
  dataFormat?: number
  migration?: {
    kind: string
    migratedAt: string
    legacyReportIds: Record<string, string>
    legacyProducers?: Record<string, unknown>
  }
  name: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  retiredNodeIds?: string[]
  retiredEdgeIds?: string[]
  ownershipRevision?: number
  branchOwnerships?: Record<string, GraphOwnershipRecord>
  ownershipReceipts?: GraphOwnershipReceipt[]
  runs: GraphRun[]
  runHistory: GraphRun[]
  leases: Record<string, GraphWorkGrant>
  receipts: GraphReceipt[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export const GRAPH_COLLECTION = 'graphv3'

/**
 * 持久化协议中的记录必须是普通 JSON/BSON 对象，数组和 null 不属于记录。
 *
 * @param value 从持久化层读取、需要按记录字段检查的未知值。
 */
function storeIsObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 旧节点与旧 Run 只能由停机迁移命令改写，读取路径绝不猜测其新类型或执行阶段。
 *
 * @param code 需要区分节点和运行迁移错误的协议错误码。
 */
function storeRejectLegacy(code: 'NODE_SCHEMA_UNSUPPORTED' | 'RUN_SCHEMA_UNSUPPORTED'): never {
  throw new GraphError(409, code, RuntimeMessage.STOP_HOSTS_AND_RUN_THE_EXPLICIT_DATA_MIGRATE_BRANCHES_COMMAND)
}

function storeReadLibraryRefs(
  /* 已存Run或规格中尚未校验的库引用数组。 */ value: unknown,
): EvidenceLibraryRef[] {
  // 坏的新字段不能被解释成旧记录缺省值，统一用当前Run存储错误拒绝。
  try { return graphInputReadLibraryClaimRefs(value, 'stored.libraryClaimRefs') }
  catch { return storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED') }
}

function storeReadLibraryUses(
  /* 已存节点或阶段候选的未知使用元信息。 */ value: unknown,
  /* 损坏数据属于普通节点还是Run内部候选。 */ code: 'NODE_SCHEMA_UNSUPPORTED' | 'RUN_SCHEMA_UNSUPPORTED',
): EvidenceUseRef[] {
  // 解析新增元信息供后续授权核对复用，坏记录统一使用对应存储协议错误。
  try { return graphInputReadLibraryUseRefs(value, 'stored.libraryClaimRefs') }
  catch { return storeRejectLegacy(code) }
}

interface StoredLibrarySet { refs: EvidenceLibraryRef[]; snapshots: Map<string, string> }

function storeReadLibrarySets(
  /* 已存Run完整记录，必须将步骤材料与计划绑定。 */ run: Record<string, unknown>,
  /* 当前持久化图的工作区身份。 */ workspaceId: unknown,
): Map<string, StoredLibrarySet> {
  // 深检会影响材料授权和模型投影的新字段，旧Run没有字段时保留原行为。
  const result = new Map<string, StoredLibrarySet>()
  if (run.libraryClaimSets === undefined) return result
  if (!Array.isArray(run.libraryClaimSets) || run.libraryClaimSets.length > 64) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  let totalBytes = 0
  for (const raw of run.libraryClaimSets) {
    if (!storeIsObject(raw) || typeof raw.stepId !== 'string' || !raw.stepId || result.has(raw.stepId) || !Array.isArray(raw.claims) || raw.claims.length > 32) {
      storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    }
    const refs: EvidenceLibraryRef[] = []
    const snapshots = new Map<string, string>()
    for (const claim of raw.claims) {
      if (!storeIsObject(claim) || !storeIsObject(claim.ref) || !storeIsObject(claim.entry) || !storeIsObject(claim.definition)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      const ref = storeReadLibraryRefs([claim.ref])[0]
      if (snapshots.has(ref.entryId)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      if (typeof claim.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(claim.snapshotDigest)
        || claim.snapshotDigest !== definitionsDigest({ ref: claim.ref, entry: claim.entry, definition: claim.definition })) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      const entry = claim.entry, definition = claim.definition
      if (entry.id !== ref.entryId || entry.contentDigest !== ref.contentDigest || entry.workspaceId !== workspaceId || (entry.confidence !== 0 && entry.confidence !== 1)
        || !storeIsObject(entry.claim) || !storeIsObject(entry.claim.origin) || !storeIsObject(entry.claim.type) || !storeIsObject(entry.claim.nodeSnapshot)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      const source = entry.claim.nodeSnapshot, origin = entry.claim.origin, type = entry.claim.type
      if (source.id !== origin.nodeId || source.revision !== origin.revision || typeof origin.mapId !== 'string' || !origin.mapId
        || type.id !== definition.id || type.version !== definition.version || source.typeId !== definition.id || source.typeVersion !== definition.version
        || !Number.isSafeInteger(source.revision) || Number(source.revision) < 0 || !storeIsObject(source.payload)
        || !storeIsObject(definition.schema) || !storeIsObject(definition.agentProjection) || !Array.isArray(definition.agentProjection.include)
        || definition.agentProjection.include.some((/* 已存冻结投影路径。 */ path) => /* 路径只能是字符串。 */ typeof path !== 'string')
        || !Array.isArray(definition.agentProjection.mapEntryFilters)
        || definition.agentProjection.mapEntryFilters.some((/* 已存字典可见性过滤规则。 */ filter) => /* 缺少路径或条件不得扩大投影。 */
          !storeIsObject(filter) || typeof filter.path !== 'string' || typeof filter.visibleWhen !== 'string')
        || entry.claim.definitionDigest !== definitionsDigest(definition)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      if (source.libraryClaimRefs !== undefined) storeReadLibraryUses(source.libraryClaimRefs, 'RUN_SCHEMA_UNSUPPORTED')
      refs.push(ref)
      snapshots.set(ref.entryId, claim.snapshotDigest)
    }
    const bytes = Buffer.byteLength(JSON.stringify(raw.claims))
    totalBytes += bytes
    if (bytes > 1024 * 1024 || totalBytes > 4 * 1024 * 1024) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    result.set(raw.stepId, { refs, snapshots })
  }
  return result
}

function storeCompareLibraryRefs(
  /* 计划或Operation规格声明的精确引用。 */ declared: readonly EvidenceLibraryRef[],
  /* 相同步骤已保存的完整材料身份。 */ frozen: readonly EvidenceLibraryRef[],
): boolean {
  // 规范排序比较集合，UI先后顺序不改变授权身份。
  const sort = (/* 待比较的一组只读身份。 */ refs: readonly EvidenceLibraryRef[]) => /* 以内容绑定的完整身份排序，不修改输入。 */
    refs.map((/* 单项固定身份。 */ ref) => /* 组合无歧义身份和摘要。 */ JSON.stringify([ref.entryId, ref.contentDigest])).sort()
  return JSON.stringify(sort(declared)) === JSON.stringify(sort(frozen))
}

/** Refuse pre-077 node/run/work records instead of silently interpreting them as generic data. */
/**
 * 浅检查所有决定数据含义和执行授权的字段；更深的业务合同由图服务和冻结定义验证。
 *
 * @param value Mongo BSON 或 SQLite JSON 解码出的完整图记录。
 */
export function storeAssertCurrentGraphSchema(
  /* Mongo BSON或SQLite JSON交付的未知完整图记录。 */ value: unknown,
): void {
  // 拒绝旧协议和坏的新库授权字段，保留历史未声明库字段的原有读取行为。
  if (!storeIsObject(value) || !Array.isArray(value.nodes)) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
  for (const node of value.nodes) {
    if (!storeIsObject(node) || 'data' in node || typeof node.typeId !== 'string' || !node.typeId
      || !Number.isSafeInteger(node.typeVersion) || Number(node.typeVersion) < 1
      || !storeIsObject(node.payload)) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
    if (node.payloadReferences !== undefined && (!Array.isArray(node.payloadReferences) || node.payloadReferences.some(reference =>
      !storeIsObject(reference) || typeof reference.path !== 'string' || typeof reference.targetId !== 'string'))) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
    if (node.libraryClaimRefs !== undefined) storeReadLibraryUses(node.libraryClaimRefs, 'NODE_SCHEMA_UNSUPPORTED')
    if (node.manualOrigin !== undefined && (!storeIsObject(node.manualOrigin)
      || typeof node.manualOrigin.userId !== 'string' || !node.manualOrigin.userId.trim())) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
  }
  if (!Array.isArray(value.edges) || value.edges.some((/* 持久化图中的未知关系。 */ edge) =>
    /* 字符串数组等坏类型不能通过转换冒充合法关系种类。 */ !storeIsObject(edge) || edge.kind !== 'successor' && edge.kind !== 'reference')) {
    storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
  }
  if (value.retiredNodeIds !== undefined && (!Array.isArray(value.retiredNodeIds)
    || value.retiredNodeIds.some(id => typeof id !== 'string') || new Set(value.retiredNodeIds).size !== value.retiredNodeIds.length)) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
  if (value.retiredEdgeIds !== undefined && (!Array.isArray(value.retiredEdgeIds)
    || value.retiredEdgeIds.some(id => typeof id !== 'string') || new Set(value.retiredEdgeIds).size !== value.retiredEdgeIds.length)) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')

  if ('run' in value || !Array.isArray(value.runs)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  const runs = [...value.runs, ...(Array.isArray(value.runHistory) ? value.runHistory : [])]
  for (const run of runs) {
    if (!storeIsObject(run) || 'operation' in run || 'configuration' in run || !storeIsObject(run.plan)
      || !storeIsObject(run.definitions) || !Array.isArray(run.agents) || !Array.isArray(run.steps) || !Array.isArray(run.operations)) {
      storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    }
    const librarySets = storeReadLibrarySets(run, value.workspaceId)
    if (!Array.isArray(run.plan.steps)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    const stepIds = new Set<string>()
    for (const step of run.plan.steps) {
      if (!storeIsObject(step) || typeof step.id !== 'string') storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      stepIds.add(step.id)
      const refs = step.libraryClaimRefs === undefined ? [] : storeReadLibraryRefs(step.libraryClaimRefs)
      if (!storeCompareLibraryRefs(refs, librarySets.get(step.id)?.refs ?? [])) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    }
    if ([...librarySets.keys()].some((/* 已保存完整材料的步骤身份。 */ stepId) => /* 不允许计划之外的材料集合。 */ !stepIds.has(stepId))) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    if ((run.status === 'running' || run.status === 'waiting') && (!storeIsObject(run.branchState)
      || !storeIsObject(run.branchState.scope) || !Array.isArray(run.branchState.scope.rootIds) || typeof run.branchState.version !== 'string')) {
      storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    }
    for (const operation of run.operations) {
      if (!storeIsObject(operation) || 'kind' in operation || 'targetId' in operation || typeof operation.specHash !== 'string'
        || !operation.specHash || !storeIsObject(operation.transitionRef) || !storeIsObject(operation.executionSpec)
        || !storeIsObject(operation.group) || !Array.isArray(operation.stages) || !Array.isArray(operation.outputRefs)) {
        storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      }
      const refs = operation.executionSpec.libraryClaimRefs === undefined ? [] : storeReadLibraryRefs(operation.executionSpec.libraryClaimRefs)
      if (typeof operation.stepId !== 'string' || !storeCompareLibraryRefs(refs, librarySets.get(operation.stepId)?.refs ?? [])) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      const frozen = librarySets.get(operation.stepId)
      const snapshotDigests = operation.executionSpec.librarySnapshotDigests
      if (refs.length || snapshotDigests !== undefined) {
        if (!Array.isArray(snapshotDigests) || snapshotDigests.length !== refs.length
          || refs.some((/* 规格规范顺序的单项库身份。 */ ref, /* 对应快照标签的位置。 */ index) =>
            /* 每个规格标签必须等于已重算并验证的完整Run材料摘要。 */ snapshotDigests[index] !== frozen?.snapshots.get(ref.entryId))) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      }
      if (operation.executionSpec.libraryClaimRefs !== undefined || operation.executionSpec.librarySnapshotDigests !== undefined) {
        const { specHash, ...body } = operation.executionSpec
        if (operation.specHash !== specHash || definitionsDigest(body) !== specHash) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      }
      for (const stage of operation.stages) {
        if (!storeIsObject(stage) || !Array.isArray(stage.results)) continue
        for (const result of stage.results) {
          if (!storeIsObject(result) || result.mode !== 'outputs' || !Array.isArray(result.outputs)) continue
          for (const output of result.outputs) {
            if (!storeIsObject(output) || output.libraryClaimRefs === undefined) continue
            const uses = storeReadLibraryUses(output.libraryClaimRefs, 'RUN_SCHEMA_UNSUPPORTED')
            if (uses.some((/* 已存候选的显式库使用。 */ use) => /* 候选不能越过Operation冻结集合。 */
              !refs.some((/* Operation获权引用。 */ ref) => /* 身份与摘要必须一致。 */ ref.entryId === use.entryId && ref.contentDigest === use.contentDigest))) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
          }
        }
      }
    }
  }

  if (!storeIsObject(value.leases)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  for (const lease of Object.values(value.leases)) {
    if (!storeIsObject(lease) || !['workId', 'mapId', 'runId', 'operationId', 'stageId', 'slotId', 'specHash']
      .every(key => typeof lease[key] === 'string' && lease[key] !== '')) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  }
  if (value.branchOwnerships !== undefined && !storeIsObject(value.branchOwnerships)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  if (value.ownershipRevision !== undefined && (!Number.isSafeInteger(value.ownershipRevision) || Number(value.ownershipRevision) < 0)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
}

/**
 * 递归排序对象键并保留数组顺序，生成不受对象字段插入顺序影响的摘要原文。
 *
 * @param value 需要生成稳定序列化表示的任意业务输入。
 */
function storeFormatCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(storeFormatCanonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => /* 将排序后的键与其规范化值拼成稳定的对象成员表示。 */
    `${JSON.stringify(key)}:${storeFormatCanonical(object[key])}`,
  ).join(',')}}`
}

/**
 * 对规范化输入计算 SHA-256，用于比较请求内容和执行配置是否相同。
 *
 * @param value 需要绑定到收据或配置比较的业务输入。
 */
export function storeCreateInputHash(value: unknown): string {
  return createHash('sha256').update(storeFormatCanonical(value)).digest('hex')
}
