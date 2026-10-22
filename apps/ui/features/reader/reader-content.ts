// 按节点的精确类型读取完整单页标题、字段和现有 Map 关系。
import type { DataSchema, DataTypeDefinition, DefinitionCatalog, JsonValue } from '../../../../contracts/data-definition'
import type { GraphNode } from '../../../../contracts/graph'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphRun } from '../../../../contracts/graph-run'
import type { NodeIdentity } from '../graph/node-identity'
import { payloadFindType, payloadReadPointer, payloadResolveSchema } from '../graph/data-payload'
import { payloadReadFieldLabel, payloadReadValueLabel } from '../graph/payload-labels'

export type ReaderValueKind = 'text' | 'json'

interface ReaderFieldContent {
  key: string
  path: string
  label: string
  displayText: string
}
export type ReaderField = ReaderFieldContent & (
  | { primary: true; kind: 'text'; value: string }
  | { primary: false; kind: ReaderValueKind; value: JsonValue }
)

export interface ReaderRelation {
  key: string
  edgeId: string
  direction: 'incoming' | 'outgoing'
  kind: 'successor' | 'reference'
  path: string | null
  label: string
  target: NodeIdentity
  title: string
  available: boolean
}

export type ReaderState =
  | { status: 'inactive' | 'unselected' | 'loading' | 'empty' | 'missing' | 'error' }
  | { status: 'ready'; identity: NodeIdentity; snapshot: GraphSnapshot; node: GraphNode }

export function readerReadState(
  /* 阅读区域是否属于当前可见页面。 */ active: boolean,
  /* 当前图首次读取是否尚未完成。 */ loading: boolean,
  /* 当前读取失败的界面提示，未失败时为空。 */ errorMessage: string | null,
  /* 用户希望阅读的完整节点身份，尚未选择时为空。 */ identity: NodeIdentity | null,
  /* 当前已接纳的图快照，可能仍属于切换前的图。 */ snapshot: GraphSnapshot | null,
): ReaderState {
  // 就绪结果持有同次匹配的图、身份和节点，消费者不再重复查找或拼接非空条件。
  if (!active) return { status: 'inactive' }
  if (loading && !snapshot) return { status: 'loading' }
  if (!identity) return { status: errorMessage ? 'error' : snapshot?.nodes.length === 0 ? 'empty' : 'unselected' }
  if (snapshot && (snapshot.workspaceId !== identity.workspaceId || snapshot.mapId !== identity.mapId)) return { status: 'loading' }
  if (!snapshot) return { status: errorMessage ? 'error' : 'loading' }
  const node = snapshot.nodes.find((/* 当前图中的实际节点。 */ item) => /* 只为请求的节点建立就绪关联。 */ item.id === identity.nodeId)
  if (!node) return { status: errorMessage ? 'error' : 'missing' }
  return { status: 'ready', identity, snapshot, node }
}

/**
 * 优先按当前已发布目录的精确 id/version 查找类型，再查看 Run 冻结定义。
 *
 * @param node 要阅读的数据节点，其 typeId/typeVersion 决定唯一可用 schema。
 * @param catalog 当前工作区已经发布的类型目录；缺失时不能猜测最新版本。
 * @param runs 当前 Map 已返回的历史/执行 Run，只用其精确冻结类型补齐旧定义。
 */
export function readerFindDefinition(
  /* 决定唯一精确类型版本的当前节点。 */ node: GraphNode,
  /* 工作区当前目录；没有该精确版本时才查找运行快照。 */ catalog: DefinitionCatalog | null,
  /* 已由服务端冻结的历史运行，不可变版本沿用其原定义。 */ runs: readonly GraphRun[],
): DataTypeDefinition | undefined {
  // 精确版本在发布边界已保证不可变，读取时直接定位，不重复比较完整定义正文。
  const current = payloadFindType(catalog, node)
  if (current) return current
  for (const run of runs) {
    const frozen = payloadFindType(run.definitions, node)
    if (frozen) return frozen
  }
  return undefined
}

/**
 * 读取适合作为页面标题的短声明；把整篇正文存入 titlePath 时退回类型标题。
 *
 * @param node 页面主节点；这里只读取原 payload，不写入展示截断。
 * @param definition 与节点精确 id/version 匹配的可选展示声明。
 */
export function readerReadHeading(node: GraphNode, definition?: DataTypeDefinition): string {
  const titlePath = definition?.presentation?.titlePath
  const value = titlePath ? payloadReadPointer(node.payload, titlePath) : undefined
  if (typeof value === 'string' && value.trim()) {
    const heading = value.trim()
    if (!heading.includes('\n') && Array.from(heading).length <= 80) return heading
  }
  return definition?.title || '数据节点'
}

/**
 * 按定义字段顺序展示实际 payload；缺少 schema 时保留完整的原始 JSON 视图。
 *
 * @param node 已取得的节点或候选正文；字段渲染不依赖正式节点身份。
 * @param definition 当前节点精确版本的定义；不存在时使用 payload 自有字段。
 */
export function readerReadFields(
  /* 已取得的节点或候选正文，不要求分配正式节点身份。 */ node: Pick<GraphNode, 'payload'>,
  /* 正文的精确类型定义，缺失时保留完整字段回退。 */ definition?: DataTypeDefinition,
): ReaderField[] {
  // 按原字段顺序和中文标签展示payload，候选与正式节点采用同一只读规则。
  const payload = node.payload as JsonValue
  if (Array.isArray(payload)) return [readerCreateField('', '内容', payload, false)]
  if (payload === null || typeof payload !== 'object') return [readerCreateField('', '内容', payload, true)]

  const fields: ReaderField[] = []
  const schema = definition?.schema
  const orderedPaths = schema?.type === 'object'
    ? readerResolveOrderedPaths(definition, payload)
    : []

  for (const path of orderedPaths) {
    const value = payloadReadPointer(payload, path)
    if (value === undefined) continue
    const field = readerCreateField(path, readerReadFieldLabel(path, definition), value, readerFieldIsText(path, definition?.schema))
    if (value === null || typeof value !== 'object') field.displayText = payloadReadValueLabel(path, value, definition?.presentation?.enumLabels)
    fields.push(field)
  }

  return fields.length ? fields : [readerCreateField('', definition?.title || '完整数据', payload, false)]
}

/** 沿实际字段路径读取 schema 标签，包含动态上下文字典与数组条目。 */
export function readerReadFieldLabel(
  /* 当前正文字段的完整JSON Pointer。 */ path: string,
  /* 精确类型版本的发布定义，缺少时仍保留字段名称。 */ definition?: DataTypeDefinition,
): string {
  // 沿自有字段声明或动态字典schema解释标签，不将继承成员当作已发布字段。
  const root = definition?.schema
  let field = root
  for (const segment of path ? path.slice(1).split('/') : []) {
    if (!field || !root) break
    const resolved = payloadResolveSchema(field, root)
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    const declared = resolved.properties && Object.prototype.hasOwnProperty.call(resolved.properties, key) ? resolved.properties[key] : undefined
    field = resolved.type === 'array' ? resolved.items
      : declared ?? (typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : undefined)
  }
  const schemaTitle = field && root ? payloadResolveSchema(field, root).title : undefined
  return payloadReadFieldLabel(path, definition?.presentation?.fieldLabels, schemaTitle)
}

/**
 * 列出选中节点一跳范围内已存在的入边、出边和服务端索引的 payload 引用。
 *
 * @param snapshot 当前 Map 的只读快照；Map 身份不匹配时返回空列表。
 * @param identity 单页对应的完整 Workspace/Map/Node 身份。
 * @param catalog 当前精确类型目录，用于为关系端点取得安全的展示标题。
 */
export function readerReadRelations(
  snapshot: GraphSnapshot,
  identity: NodeIdentity,
  catalog: DefinitionCatalog | null,
): ReaderRelation[] {
  if (snapshot.workspaceId !== identity.workspaceId || snapshot.mapId !== identity.mapId) return []
  const node = snapshot.nodes.find(item => item.id === identity.nodeId)
  if (!node) return []

  const nodes = new Map(snapshot.nodes.map(item => [item.id, item]))
  const relations: ReaderRelation[] = []
  for (const edge of snapshot.edges) {
    if (edge.from !== node.id && edge.to !== node.id) continue
    const direction = edge.from === node.id ? 'outgoing' : 'incoming'
    const targetId = direction === 'outgoing' ? edge.to : edge.from
    const target = nodes.get(targetId)
    relations.push({
      key: `${direction}:${edge.kind}:${edge.id}`,
      edgeId: edge.id,
      direction,
      kind: edge.kind,
      path: null,
      label: readerRelationLabel(direction, edge.kind),
      target: { workspaceId: identity.workspaceId, mapId: identity.mapId, nodeId: targetId },
      title: target ? readerReadNodeLabel(target, catalog, snapshot.runs) : targetId,
      available: !!target,
    })
  }

  for (const relation of node.payloadReferences ?? []) {
    const target = nodes.get(relation.targetId)
    relations.push({
      key: `payload:${node.id}:${relation.path}:${relation.targetId}`,
      edgeId: relation.targetId,
      direction: 'outgoing',
      kind: 'reference',
      path: relation.path,
      label: '字段引用',
      target: { workspaceId: identity.workspaceId, mapId: identity.mapId, nodeId: relation.targetId },
      title: target ? readerReadNodeLabel(target, catalog, snapshot.runs) : relation.targetId,
      available: !!target,
    })
  }

  return relations
}

/**
 * 将注册的 presentation.fieldOrder 与正文自有字段合并为去重的根路径顺序。
 *
 * @param definition 本节点精确类型定义，包含可选的展示字段顺序。
 * @param payload 当前完整 JSON payload，不会被此函数修改。
 */
function readerResolveOrderedPaths(
  /* 当前节点可用的精确展示定义；未加载时只展示实际字段。 */ definition: DataTypeDefinition | undefined,
  /* 调用方已经排除数组、null 和标量的 JSON 对象。 */ payload: Record<string, JsonValue>,
): string[] {
  // 只整理展示顺序；调用者读取字段时统一排除正文中不存在的声明路径。
  const ordered = (definition?.presentation?.fieldOrder ?? []).map((/* 声明的字段展示路径。 */ path) => {
    // 嵌套展示路径先归并到其实际根字段。
    const root = readerPointerRoot(path)
    return `/${readerEscapePointer(root)}`
  })
  const declared = Object.keys(payload).map((/* 实际对象的根字段名。 */ name) =>
    /* 把字段名编码为可读取的 JSON Pointer。 */ `/${readerEscapePointer(name)}`)
  return [...ordered, ...declared].filter((
    /* 已合并的一个候选根路径。 */ path,
    /* 该路径在合并顺序中的位置。 */ index,
    /* 用于保留首次出现顺序的全部路径。 */ all,
  ) => /* 保留每个根路径第一次出现的位置。 */
    all.indexOf(path) === index)
}

/**
 * 把 JSON Pointer 的根字段名称解码为 JSON object 的字段键。
 *
 * @param pointer 指向 payload 属性的绝对 JSON Pointer。
 */
function readerPointerRoot(pointer: string): string {
  // split 对任何字符串都至少返回一段，空路径自然得到空字段名。
  const [first] = pointer.slice(1).split('/')
  return first.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * 返回声明顺序路径末端属性，供嵌套 fieldLabel 缺省时显示。
 *
 * @param pointer 指向实际 payload 字段的 JSON Pointer。
 */
function readerPointerLastSegment(pointer: string): string {
  // 最后一个分隔符之后的子串始终存在，无须为字符串分段制造缺失状态。
  const last = pointer.slice(pointer.lastIndexOf('/') + 1)
  return last.replace(/~1/g, '/').replace(/~0/g, '~') || '内容'
}

/**
 * 将 JSON object 属性编码为 JSON Pointer path segment。
 *
 * @param key 实际 payload object 的原始字段名称。
 */
function readerEscapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

/**
 * 仅将长文本字段标为正文段落，短文本和机器元数据使用紧凑展示。
 *
 * @param path 当前字符串字段的 JSON Pointer。
 * @param schema 节点精确类型声明；可缺省于旧版冻结定义。
 */
function readerFieldIsText(path: string, schema?: DataSchema): boolean {
  const field = schema?.properties?.[readerPointerLastSegment(path)]
  return field?.type === 'string' && (field.maxLength === undefined || field.maxLength > 120)
}

/**
 * 使用只读字段投影建立单个渲染条目，按 JSON 类型选择文本或结构化值排版。
 *
 * @param path 完整字段 JSON Pointer；根 payload 用空字符串。
 * @param label 精确字段标签或语义化类型标题。
 * @param value 原始 JSON 值，不创建新的业务默认值。
 * @param primary 字符串是否采用书页正文排版。
 */
function readerCreateField(
  /* 完整字段路径，空路径表示根正文。 */ path: string,
  /* 展示定义解析后的字段标签。 */ label: string,
  /* 保留原始类型的字段正文。 */ value: JsonValue,
  /* 展示定义是否将此字段列为正文候选。 */ primary: boolean,
): ReaderField {
  // 只将真实字符串标记为主正文，使读取方可直接依赖primary的字符串契约。
  const content = {
    key: path || '$root',
    path,
    label,
    displayText: readerFormatValue(value),
  }
  return primary && typeof value === 'string'
    ? { ...content, value, kind: 'text', primary: true }
    : { ...content, value, kind: 'json', primary: false }
}

/**
 * 保留 false/0/null 与空文本的区别，并对复杂 JSON 用稳定缩进显示。
 *
 * @param value 类型化节点 payload 中的实际 JSON 值。
 */
function readerFormatValue(value: JsonValue): string {
  if (value === null) return '空值'
  if (typeof value === 'string') return value || '空字符串'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

/**
 * 把节点数据转为关系列表中的类型标题，未知版本只退回稳定 typeId。
 *
 * @param node 当前 Map 快照中已存在的引用端点。
 * @param catalog 当前已发布目录，可缺省于离线/旧图查看。
 * @param runs 当前快照中的冻结 Run 定义，用于读取历史节点的精确标签。
 */
function readerReadNodeLabel(node: GraphNode, catalog: DefinitionCatalog | null, runs: readonly GraphRun[]): string {
  const definition = readerFindDefinition(node, catalog, runs)
  return definition?.title ?? '数据节点'
}

/**
 * 只在相同方向与关系种类下描述真实入边/出边。
 *
 * @param direction 目标位于当前节点之前或之后的方向。
 * @param kind 后端提供的 successor 或 reference 关系种类。
 */
function readerRelationLabel(direction: ReaderRelation['direction'], kind: ReaderRelation['kind']): string {
  if (kind === 'reference') return direction === 'incoming' ? '被字段引用' : '字段引用'
  return direction === 'incoming' ? '结构前置' : '结构后继'
}
