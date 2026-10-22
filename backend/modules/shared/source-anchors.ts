// 校验 successor 来源锚点的形状、内容版本、JSON Pointer 和精确原文摘录。
import type { JsonValue } from '../../../contracts/data-definition'
import type { GraphEdge, GraphNode, GraphSourceAnchor } from '../../../contracts/graph'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { sourceTextReadQuote } from '../../../contracts/source-text'
import { GraphError } from './domain-error'
import { inputReadArray, inputReadObject, inputReadRevision, inputReadString } from './input-validation'

/** 解析来源定位元数据，拒绝未知字段、无效 JSON Pointer 和过多条目。 */
export function graphReadSourceAnchors(value: unknown, label = 'edge.sourceAnchors'): GraphSourceAnchor[] {
  const values = inputReadArray(value, label)
  if (values.length > 64) throw new GraphError(413, 'SOURCE_ANCHOR_LIMIT', messageFormat(RuntimeMessage.VALUE_HAS_TOO_MANY_ENTRIES, label))
  return values.map((value, index) => {
    const pathLabel = `${label}[${index}]`
    const item = inputReadObject(value, ['path', 'sourceRevision', 'startLine', 'endLine', 'quote'], pathLabel)
    const path = inputReadString(item.path, `${pathLabel}.path`)
    const sourceRevision = inputReadRevision(item.sourceRevision, `${pathLabel}.sourceRevision`)
    const startLine = inputReadRevision(item.startLine, `${pathLabel}.startLine`)
    const endLine = inputReadRevision(item.endLine, `${pathLabel}.endLine`)
    if (!/^\/(?:[^~]|~[01])*$/.test(path) || startLine < 1 || endLine < startLine || typeof item.quote !== 'string') {
      throw new GraphError(400, 'INVALID_SOURCE_ANCHOR', RuntimeMessage.SOURCE_ANCHOR_IS_INVALID)
    }
    return { path, sourceRevision, startLine, endLine, quote: item.quote }
  })
}

/** 读取确定的原文字段，支持数组下标并拒绝不存在的自有属性。 */
function graphReadSourceText(source: GraphNode, path: string): string | undefined {
  let value: JsonValue | undefined = source.payload
  for (const part of path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return undefined
    value = (value as Record<string, JsonValue>)[part]
  }
  return typeof value === 'string' ? value : undefined
}

/**
 * 新增/修改的脚注须对应当前正文；已经保存或导入的旧版本摘录保留为历史依据。
 *
 * @param edge 来源隐含在 from 的 successor 关系。
 * @param source 当前来源节点。
 * @param allowHistorical 完全保留的已有锚点集合；true 仅供便携包旧版本记录使用。
 */
export function graphValidateSourceAnchors(
  /* 已由 HTTP 或便携包入口解析锚点形状的关系。 */ edge: Pick<GraphEdge, 'kind' | 'sourceAnchors'>,
  /* 锚点必须引用的当前来源节点。 */ source: GraphNode,
  /* 已保存原样锚点；true 允许便携包携带历史版本。 */ allowHistorical: boolean | readonly GraphSourceAnchor[] = false,
): void {
  // 只核对关系种类、来源版本及原文摘录，锚点结构已由实际输入边界建立。
  if (edge.sourceAnchors === undefined) return
  if (edge.kind !== 'successor') throw new GraphError(422, 'INVALID_SOURCE_ANCHOR', RuntimeMessage.SOURCE_ANCHORS_REQUIRE_A_SUCCESSOR_RELATION)
  for (const anchor of edge.sourceAnchors) {
    if (anchor.sourceRevision !== source.revision) {
      const preservesAnchor = allowHistorical === true || Array.isArray(allowHistorical)
        && allowHistorical.some(previous => previous.path === anchor.path && previous.sourceRevision === anchor.sourceRevision
          && previous.startLine === anchor.startLine && previous.endLine === anchor.endLine && previous.quote === anchor.quote)
      if (preservesAnchor && anchor.sourceRevision < source.revision) continue
      throw new GraphError(409, 'SOURCE_VERSION_CONFLICT', RuntimeMessage.SOURCE_ANCHOR_VERSION_CHANGED)
    }
    const text = graphReadSourceText(source, anchor.path)
    if (text === undefined || sourceTextReadQuote(text, anchor.startLine, anchor.endLine) !== anchor.quote) {
      throw new GraphError(422, 'INVALID_SOURCE_ANCHOR', RuntimeMessage.SOURCE_ANCHOR_QUOTE_DOES_NOT_MATCH)
    }
  }
}
