// 性能用例数据前提：按已注册精确定义，经真实公共 API 创建固定种子和真实关系的图。
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ClientGateway } from '../../contracts/client'
import type { GraphChanges, GraphNodeInput } from '../../contracts/graph'
import type { WorkspaceLoadProfile } from './workspace-load.config'

export interface WorkspaceDataset {
  readonly mapId: string
  readonly mapName: string
  readonly nodeIds: readonly string[]
  readonly rootIds: readonly string[]
  readonly expectedNodes: number
  readonly expectedEdges: number
  readonly seed: number
  readonly payloadBytes: number
  readonly jsonBytes: number
  readonly derivedReferenceCount: number
  readonly probeNodeId: string
  readonly probeContent: string
}

enum WorkspaceDatasetError {
  INVALID_PROFILE = 'M00 规模输入必须包含合法节点/关系数和固定种子。',
  DEFINITION_MISSING = 'M00 规模图所需精确定义未注册，不生成替代 schema。',
  SIZE_MISMATCH = 'M00 规模图的实际节点或边数量不符合输入。',
  CONTENT_MISMATCH = 'M00 规模图的实际正文、精确类型或边端点不符合固定输入。',
  PROBE_MISSING = 'M00 规模图缺少预定的独立正文节点。',
}

/** 从固定种子生成合法 UUID；同一图内稳定，跨测试通过独立 Map 区分业务身份。 */
function datasetId(
  /* 当前数据规模的固定种子。 */ seed: number,
  /* 节点或边的确定性命名空间。 */ kind: string,
  /* 当前命名空间内的序号。 */ index: number,
): string {
  // 从种子、类型和序号生成稳定身份，并保留独立探针的排序空间。
  const bytes = createHash('sha256').update(`${seed}:${kind}:${index}`).digest().subarray(0, 16)
  bytes[0] |= 0x80
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 按 UTF-8 实际字节建立非空正文，避免用字符长度冒充传输体积。 */
function datasetText(
  /* 唯一正文前缀，公开页面可据此定位已存材料。 */ prefix: string,
  /* 当前类型计划的 UTF-8 正文字节数。 */ sizeBytes: number,
): string {
  // 用 ASCII 填充补足 UTF-8 字节数，保留可定位的中文前缀。
  return prefix + 'x'.repeat(Math.max(0, sizeBytes - Buffer.byteLength(prefix, 'utf8')))
}

export async function workspacePrepareDataset(
  /* 当前工作区具备真实写权限的独立公共客户端。 */ gateway: ClientGateway,
  /* 只在此测试拥有的工作区中创建数据。 */ workspaceId: string,
  /* 已冻结的节点/存储边规模及固定种子。 */ profile: WorkspaceLoadProfile,
): Promise<WorkspaceDataset> {
  // 预置仅供读取/性能场景；A01 的关键 UI 创建操作不调用这个函数。
  if (!Number.isSafeInteger(profile.nodeCount) || profile.nodeCount < 40
    || !Number.isSafeInteger(profile.edgeCount) || profile.edgeCount < profile.nodeCount
    || !Number.isSafeInteger(profile.seed)) throw new Error(WorkspaceDatasetError.INVALID_PROFILE)
  const catalog = (await gateway.read('definition.get', { workspaceId })).catalog
  const typeIds = ['factcheck.news', 'factcheck.claim', 'factcheck.opinion', 'factcheck.verification']
  for (const id of typeIds) {
    if (!catalog.dataTypes.some((/* 真实发布目录中的精确定义。 */ item) => {
      // 使用现有 v1 合同，不在测试里注册简化类型。
      return item.id === id && item.version === 1
    })) throw new Error(WorkspaceDatasetError.DEFINITION_MISSING)
  }
  const newsCount = Math.floor(profile.nodeCount * 0.05)
  const claimCount = Math.floor(profile.nodeCount * 0.65)
  const opinionCount = Math.floor(profile.nodeCount * 0.20)
  const verificationCount = profile.nodeCount - newsCount - claimCount - opinionCount
  const independentCount = Math.min(8, claimCount - 1)
  const newsIds = Array.from({ length: newsCount }, (/* 未使用的数组项。 */ _value, /* 新闻序号。 */ index) => datasetId(profile.seed, 'news', index))
  const claimIds = Array.from({ length: claimCount }, (/* 未使用的数组项。 */ _value, /* 事实序号。 */ index) => {
    // 无后继、无入边的低字典序事实作为独立写根和公开键盘选择探针。
    return index < independentCount ? `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` : datasetId(profile.seed, 'claim', index)
  })
  const opinionIds = Array.from({ length: opinionCount }, (/* 未使用的数组项。 */ _value, /* 意见序号。 */ index) => datasetId(profile.seed, 'opinion', index))
  const verificationIds = Array.from({ length: verificationCount }, (/* 未使用的数组项。 */ _value, /* 结论序号。 */ index) => datasetId(profile.seed, 'verification', index))
  const relatedClaims = claimIds.slice(independentCount)
  const nodes: GraphNodeInput[] = []
  for (let index = 0; index < newsCount; index++) {
    nodes.push({ id: newsIds[index], typeId: 'factcheck.news', typeVersion: 1, payload: {
      content: datasetText(`M00 新闻 ${profile.seed}/${index}。`, index === 0 ? 64 * 1024 : 8 * 1024),
      context: { 来源说明: { value: '固定种子性能材料，不连接外部来源。', visibleToAI: true } },
    } })
  }
  for (let index = 0; index < claimCount; index++) {
    nodes.push({ id: claimIds[index], typeId: 'factcheck.claim', typeVersion: 1,
      payload: { content: datasetText(`M00 事实 ${profile.seed}/${index}。`, 512), category: 'data' } })
  }
  for (let index = 0; index < opinionCount; index++) {
    nodes.push({ id: opinionIds[index], typeId: 'factcheck.opinion', typeVersion: 1, payload: {
      score: index % 2 ? 0 : 1, reason: datasetText(`M00 意见 ${profile.seed}/${index}。`, 1024),
      evidenceClaimIds: [relatedClaims[index % relatedClaims.length], relatedClaims[(index + 1) % relatedClaims.length]],
    } })
  }
  for (let index = 0; index < verificationCount; index++) {
    nodes.push({ id: verificationIds[index], typeId: 'factcheck.verification', typeVersion: 1, payload: {
      score: 0.5, reason: datasetText(`M00 结论 ${profile.seed}/${index}。`, 1024),
      opinionIds: [opinionIds[index % opinionIds.length]],
    } })
  }

  const edges: NonNullable<NonNullable<GraphChanges['edges']>['put']> = []
  const pairs = new Set<string>()
  const addEdge = (
    /* 后继保持合法类型与无环；补充引用允许跨层/成环。 */ kind: 'successor' | 'reference',
    /* 当前图中已定义的来源节点。 */ from: string,
    /* 当前图中不同于来源的目标节点。 */ to: string,
  ): void => {
    // 同一关系种类/端点只放一条边，实际边数不能靠重复连线充数。
    const key = `${kind}:${from}:${to}`
    if (from === to || pairs.has(key)) return
    pairs.add(key)
    edges.push({ id: datasetId(profile.seed, 'edge', edges.length), kind, from, to, label: `M00 ${kind}` })
  }
  for (let index = 0; index < relatedClaims.length; index++) addEdge('successor', newsIds[index % newsIds.length], relatedClaims[index])
  for (let index = 0; index < opinionIds.length; index++) addEdge('successor', relatedClaims[index % relatedClaims.length], opinionIds[index])
  for (let index = 0; index < verificationIds.length; index++) addEdge('successor', opinionIds[index % opinionIds.length], verificationIds[index])
  const referenceIds = [...newsIds, ...relatedClaims, ...opinionIds, ...verificationIds]
  // 确定性跨度和高连接枢纽形成真实引用密度，不触及独立写根。
  for (let distance = 1; edges.length < profile.edgeCount && distance < referenceIds.length; distance++) {
    for (let index = 0; index < referenceIds.length && edges.length < profile.edgeCount; index++) {
      addEdge('reference', referenceIds[index], referenceIds[(index + distance) % referenceIds.length])
      if (edges.length < profile.edgeCount) addEdge('reference', referenceIds[0], referenceIds[(index + distance) % referenceIds.length])
    }
  }
  if (edges.length !== profile.edgeCount) throw new Error(WorkspaceDatasetError.SIZE_MISMATCH)
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const mapId = randomUUID()
  const mapName = `M00 ${profile.name} ${profile.seed}`
  await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: workspace.revision, id: mapId, name: mapName })
  await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId, branch: { rootIds: [...newsIds, ...claimIds.slice(0, independentCount)], expectedVersion: null },
    changes: { nodes: { put: nodes }, edges: { put: edges } },
  })
  const saved = await gateway.read('map.get', { mapId })
  if (saved.nodes.length !== profile.nodeCount || saved.edges.length !== profile.edgeCount) throw new Error(WorkspaceDatasetError.SIZE_MISMATCH)
  const savedNodes = new Map(saved.nodes.map((/* 已持久化的真实节点。 */ node) => [node.id, node]))
  const savedEdges = new Map(saved.edges.map((/* 已持久化的真实边。 */ edge) => [edge.id, edge]))
  for (const expected of nodes) {
    const actual = savedNodes.get(expected.id)
    if (!actual || actual.typeId !== expected.typeId || actual.typeVersion !== expected.typeVersion
      || !isDeepStrictEqual(actual.payload, expected.payload)) throw new Error(WorkspaceDatasetError.CONTENT_MISMATCH)
  }
  for (const expected of edges) {
    const actual = savedEdges.get(expected.id)
    if (!actual || actual.kind !== expected.kind || actual.from !== expected.from || actual.to !== expected.to
      || actual.label !== expected.label) throw new Error(WorkspaceDatasetError.CONTENT_MISMATCH)
  }
  const probe = saved.nodes.find((/* 已存的独立事实节点。 */ node) => node.id === claimIds[0])
  if (!probe || typeof probe.payload.content !== 'string') throw new Error(WorkspaceDatasetError.PROBE_MISSING)
  return {
    mapId, mapName, nodeIds: saved.nodes.map((/* 公共快照实际返回的节点。 */ node) => node.id),
    rootIds: claimIds.slice(0, independentCount), expectedNodes: saved.nodes.length, expectedEdges: saved.edges.length,
    seed: profile.seed, probeNodeId: probe.id, probeContent: probe.payload.content,
    payloadBytes: saved.nodes.reduce((/* 已累积的 payload 字节。 */ count, /* 当前真实节点。 */ node) => count + Buffer.byteLength(JSON.stringify(node.payload)), 0),
    jsonBytes: Buffer.byteLength(JSON.stringify(saved)),
    derivedReferenceCount: saved.nodes.reduce((/* 已累积的派生引用。 */ count, /* 当前真实节点。 */ node) => count + (node.payloadReferences?.length ?? 0), 0),
  }
}
