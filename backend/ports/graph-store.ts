import type { GraphMapSummary, GraphWork, GraphWorkGrant, GraphWorkProof } from '../../contracts/graph'
import type { GraphDocument, GraphReceipt } from '../modules/graph/graph-record'

export interface GraphStore {
  initialize(): Promise<void>
  create(document: GraphDocument): Promise<boolean>
  read(mapId: string): Promise<GraphDocument | null>
  discover(): AsyncGenerator<GraphDocument>
  readLeaseDelay(mapId: string, workId: string): Promise<number>
  readDispatch(): AsyncGenerator<GraphDocument & { dispatchVersion: number }>
  clearDispatch(mapId: string, version: number): Promise<boolean>
  claim(document: GraphDocument, work: GraphWork, hostId: string, holderId: string, leaseMs: number): Promise<GraphWorkGrant | null>
  readLease(mapId: string, proof: GraphWorkProof): Promise<GraphDocument | null>
  renew(mapId: string, proof: GraphWorkProof): Promise<GraphWorkGrant | null>
  release(mapId: string, proof: GraphWorkProof): Promise<boolean>
  list(workspaceId: string): Promise<GraphMapSummary[]>
  commit(document: GraphDocument, expectedRevision: number, receipt: GraphReceipt, grant?: GraphWorkGrant): Promise<boolean>
}
