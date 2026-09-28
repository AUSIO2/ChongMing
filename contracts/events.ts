// 定义队列工作提示、变更提示、领取结果和客户端实时事件。
import type { GraphActivity } from './activity'
import type { GraphSnapshot, GraphWorkGrant } from './graph'
import type { ClientErrorData } from './client'

// 消息传输连接地址与基础命名空间。
export interface QueueConfig { url: string; namespace: string }
// 指向具体部署及工作编号的投递提示，实际可执行性仍由 claim 决定。
export interface QueueWork { version: 1; deploymentId: string; mapId: string; workId: string }
// 部署内的图、权限、设置或活动变更提示，消费者据此刷新对应数据。
export interface QueueChange { version: 1; deploymentId: string; kind: 'graph' | 'workspace' | 'settings' | 'access' | 'activity'; activity?: GraphActivity; holderId?: string; mapId?: string; workspaceId?: string }
// 领取结果区分已授权、暂时占用及已失效工作，busy 给出重试等待毫秒数。
export type GraphClaimResult = { status: 'claimed'; grant: GraphWorkGrant } | { status: 'busy'; retryAfterMs: number } | { status: 'obsolete' }
// 客户端实时流的完整快照、活动摘要、刷新提示或结构化错误。
export type GraphStreamEvent =
  | { type: 'snapshot'; snapshot: GraphSnapshot }
  | { type: 'activity'; items: GraphActivity[] }
  | { type: 'refresh'; scope: 'workspace' | 'settings' }
  | { type: 'error'; error: ClientErrorData }
