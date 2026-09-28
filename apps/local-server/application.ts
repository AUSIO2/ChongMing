// 使用进程内消息与持久化事件装配独立本地图服务。
import type { Persistence, PersistenceEvents } from '../../backend/ports/persistence'
import { localCreateMessaging } from '../../backend/adapters/messaging/in-process'
import { applicationBuildService } from '../../backend/application/graph-application'
import { sourceReadUrl } from '../../backend/adapters/sources/http-source'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import { DEFAULT_RUN_CONFIGURATION } from '../config/default-prompts'

export function applicationCreateLocalService(/* 同时提供事务存储与本地提交事件的持久化实例，由运行时负责关闭。 */ database: Persistence & PersistenceEvents, /* 可选租期、私有来源读取策略及诊断器；租期单位为毫秒，省略项沿用模块默认值。 */ options: { leaseMs?: number; allowPrivateSources?: boolean; reporter?: DiagnosticReporter } = {}) {
  // 装配共享应用能力和进程内消息服务，并暴露供本地 Host 使用的队列。
  const messaging = localCreateMessaging(database, options.reporter)
  return { ...applicationBuildService(database, messaging, { ...options, readUrl: sourceReadUrl,
    seedConfiguration: DEFAULT_RUN_CONFIGURATION }), localQueue: messaging.queue }
}
