import type {
  MapperClaimNode,
  MapperDataPhase,
  MapperNewsNode,
  MapperNode,
  MapperOpinionNode,
  MapperParseAgentNode,
  MapperSnapshot,
  MapperSourceNode,
  MapperSubAgentNode,
  MapperToolKind,
} from '../../electron/mapper/types'
import type {
  CatalogSubAgent,
} from '../../electron/api/types'
import type {
  Confidence,
  ExecutionMode,
  MapSubAgentParams,
  Priority,
} from '../../electron/shared/types'

export type {
  CatalogSubAgent,
  Confidence,
  ExecutionMode,
  MapSubAgentParams,
  Priority,
}

export type MapNode = MapperNode
export type MapSourceNode = MapperSourceNode
export type MapParseAgentNode = MapperParseAgentNode
export type MapNewsNode = MapperNewsNode
export type MapSubAgentNode = MapperSubAgentNode
export type MapClaimNode = MapperClaimNode
export type MapOpinionNode = MapperOpinionNode
export type MapSnapshot = MapperSnapshot
export type MapNodeKind = MapperNode['kind']
export type MapToolKind = MapperToolKind
export type MapDataPhase = MapperDataPhase
export type MapRunPhase = MapperSnapshot['runPhase']

export type MapSourceParams = MapperSourceNode['params']
export type MapParseAgentParams = MapperParseAgentNode['params']
export type MapNewsParams = MapperNewsNode['params']
export type MapClaimParams = MapperClaimNode['params']
export type MapOpinionParams = MapperOpinionNode['params']

export interface MapEdge {
  id: string
  from: string
  to: string
}

export interface MapAgentStream {
  node: 'route' | 'merge'
  thinking: string
  text: string
}
