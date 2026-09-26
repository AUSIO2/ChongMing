import type { GraphActivity } from './activity'
import type { GraphSnapshot, GraphWorkGrant } from './graph'
import type { ClientErrorData } from './client'

export interface QueueConfig { url: string; namespace: string }
export interface QueueWork { version: 1; deploymentId: string; mapId: string; workId: string }
export interface QueueChange { version: 1; deploymentId: string; kind: 'graph' | 'workspace' | 'settings' | 'access' | 'activity'; activity?: GraphActivity; holderId?: string; mapId?: string; workspaceId?: string }
export type GraphClaimResult = { status: 'claimed'; grant: GraphWorkGrant } | { status: 'busy'; retryAfterMs: number } | { status: 'obsolete' }
export type GraphStreamEvent =
  | { type: 'snapshot'; snapshot: GraphSnapshot }
  | { type: 'activity'; items: GraphActivity[] }
  | { type: 'refresh'; scope: 'workspace' | 'settings' }
  | { type: 'error'; error: ClientErrorData }
