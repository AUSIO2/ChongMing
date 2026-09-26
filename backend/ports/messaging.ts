import type { GraphActivity } from '../../contracts/activity'
import type { QueueWork, QueueChange } from '../../contracts/events'

export interface WorkChannel {
  readonly signal: AbortSignal
  readonly closed: Promise<void>
  consumeWork(handler: (message: QueueWork, signal: AbortSignal) => Promise<'ack' | 'retry'>, stop?: AbortSignal): Promise<void>
  close(): Promise<void>
}
export interface WorkTransport { namespace: string; open(namespace: string): Promise<WorkChannel> }
export interface QueueLink extends WorkChannel {
  publishWork(message: QueueWork): Promise<void>
  publishChange(message: QueueChange): Promise<void>
  subscribeChanges(handler: (message: QueueChange) => void, stop?: AbortSignal): Promise<() => Promise<void>>
}
export interface MessagingService {
  initialize(): Promise<void>
  messaging(): { version: 1; deploymentId: string; namespace: string; enabled: boolean }
  startMessaging(): Promise<void>
  finished(): Promise<unknown | undefined>
  closeMessaging(): Promise<void>
  watchChanges(listener: (change: QueueChange | null) => void): () => void
  readActivities(mapId: string): QueueChange[]
  publishActivity(activity: GraphActivity, holderId: string): Promise<void>
}
