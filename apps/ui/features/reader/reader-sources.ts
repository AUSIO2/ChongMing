// 来源脚注只解释真实 successor 上的定位；原文版本变化时保留摘录而不高亮新版。
import type { DefinitionCatalog, DataTypeDefinition } from '../../../../contracts/data-definition'
import type { GraphEdge, GraphNode, GraphSourceAnchor } from '../../../../contracts/graph'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import { sourceTextReadLines, sourceTextReadQuote } from '../../../../contracts/source-text'
import { RuntimeMessage, messageFormat } from '../../../../contracts/messages'
import { graphReadNodeText } from '../graph/graph-layout'
import { payloadReadPointer } from '../graph/data-payload'
import type { NodeIdentity } from '../graph/node-identity'
import { readerFindDefinition, readerReadHeading } from './reader-content'

export { sourceTextReadLines as readerReadSourceLines }

export interface ReaderSourceFocus { target: NodeIdentity; anchor: GraphSourceAnchor }
export interface ReaderSourceSave {
  mapId: string
  edgeId: string
  expectedEdgeRevision: number
  sourceAnchors: GraphSourceAnchor[]
}
export interface ReaderSourceRange {
  anchor: GraphSourceAnchor
  status: 'current' | 'stale' | 'invalid' | 'missing'
  label: string
}
export interface ReaderSourceNote {
  number: number
  edgeId: string
  edgeRevision: number
  source: NodeIdentity
  sourceNode: GraphNode | null
  sourceTitle: string
  sourceDefinition?: DataTypeDefinition
  child: NodeIdentity
  childTitle: string
  childSummary: string
  ranges: ReaderSourceRange[]
}
export interface ReaderLineMarker {
  key: string
  number: number
  path: string
  line: number
  target: NodeIdentity
  title: string
}

/** 空输入清除定位；1,3 表示两个离散行，5-7 表示一个连续区间。 */
export function readerCreateSourceAnchors(source: GraphNode, path: string, input: string): GraphSourceAnchor[] {
  const text = payloadReadPointer(source.payload, path)
  if (typeof text !== 'string') throw new Error(RuntimeMessage.READER_SOURCE_FIELD_NOT_TEXT)
  const parts = input.trim().split(/[,，、;；\s]+/).filter(Boolean)
  if (parts.length > 64) throw new Error(RuntimeMessage.READER_SOURCE_TOO_MANY_RANGES)
  const occupied = new Set<number>()
  return parts.map(part => {
    const matched = /^(\d+)(?:[-–—~～](\d+))?$/.exec(part)
    if (!matched) throw new Error(RuntimeMessage.READER_SOURCE_RANGE_FORMAT)
    const startLine = Number(matched[1]), endLine = Number(matched[2] ?? matched[1])
    const quote = sourceTextReadQuote(text, startLine, endLine)
    if (quote === undefined) throw new Error(messageFormat(RuntimeMessage.READER_SOURCE_RANGE_OUT_OF_BOUNDS, part))
    for (let line = startLine; line <= endLine; line++) {
      if (occupied.has(line)) throw new Error(messageFormat(RuntimeMessage.READER_SOURCE_RANGE_DUPLICATE, line))
      occupied.add(line)
    }
    return { path, sourceRevision: source.revision, startLine, endLine, quote }
  })
}

export function readerSourceRangeStatus(source: GraphNode | null, anchor: GraphSourceAnchor): ReaderSourceRange['status'] {
  if (!source) return 'missing'
  if (source.revision !== anchor.sourceRevision) return source.revision > anchor.sourceRevision ? 'stale' : 'invalid'
  const text = payloadReadPointer(source.payload, anchor.path)
  return typeof text === 'string' && sourceTextReadQuote(text, anchor.startLine, anchor.endLine) === anchor.quote ? 'current' : 'invalid'
}

/** 在子页读 incoming 来源，在原文页读 outgoing 衍生节点；均按边身份编号。 */
export function readerReadSourceNotes(snapshot: GraphSnapshot, identity: NodeIdentity, catalog: DefinitionCatalog | null,
  direction: 'incoming' | 'outgoing' = 'incoming'): ReaderSourceNote[] {
  if (snapshot.workspaceId !== identity.workspaceId || snapshot.mapId !== identity.mapId) return []
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
  return snapshot.edges.filter(edge => edge.kind === 'successor' && (direction === 'incoming' ? edge.to : edge.from) === identity.nodeId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((edge, index) => readerCreateSourceNote(snapshot, edge, index + 1, nodes, catalog))
}

function readerCreateSourceNote(snapshot: GraphSnapshot, edge: GraphEdge, number: number,
  nodes: Map<string, GraphNode>, catalog: DefinitionCatalog | null): ReaderSourceNote {
  const source = nodes.get(edge.from) ?? null, child = nodes.get(edge.to)
  const definition = source ? readerFindDefinition(source, catalog, snapshot.runs) : undefined
  const childDefinition = child ? readerFindDefinition(child, catalog, snapshot.runs) : undefined
  return {
    number, edgeId: edge.id, edgeRevision: edge.revision,
    source: { workspaceId: snapshot.workspaceId, mapId: snapshot.mapId, nodeId: edge.from },
    sourceNode: source, sourceDefinition: definition,
    sourceTitle: source ? readerReadHeading(source, definition) : edge.from,
    child: { workspaceId: snapshot.workspaceId, mapId: snapshot.mapId, nodeId: edge.to },
    childTitle: child ? readerReadHeading(child, childDefinition) : edge.to,
    childSummary: child ? graphReadNodeText(child, catalog) : '',
    ranges: (edge.sourceAnchors ?? []).map(anchor => ({ anchor, status: readerSourceRangeStatus(source, anchor),
      label: anchor.startLine === anchor.endLine ? `第 ${anchor.startLine} 行` : `第 ${anchor.startLine}–${anchor.endLine} 行` })),
  }
}

/** 同一衍生节点在同一行只显示一个脚注号；历史版本不投影到当前正文。 */
export function readerReadLineMarkers(notes: readonly ReaderSourceNote[]): ReaderLineMarker[] {
  const markers = new Map<string, ReaderLineMarker>()
  for (const note of notes) for (const range of note.ranges) {
    if (range.status !== 'current') continue
    for (let line = range.anchor.startLine; line <= range.anchor.endLine; line++) {
      const key = JSON.stringify([note.edgeId, range.anchor.path, line])
      markers.set(key, { key, number: note.number, path: range.anchor.path, line, target: note.child, title: note.childTitle })
    }
  }
  return [...markers.values()]
}

export function readerReadFocusStatus(snapshot: GraphSnapshot | null, focus: ReaderSourceFocus | null): ReaderSourceRange['status'] | null {
  if (!snapshot || !focus || snapshot.workspaceId !== focus.target.workspaceId || snapshot.mapId !== focus.target.mapId) return null
  return readerSourceRangeStatus(snapshot.nodes.find(node => node.id === focus.target.nodeId) ?? null, focus.anchor)
}
