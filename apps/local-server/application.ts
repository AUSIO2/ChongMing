// 使用进程内消息与持久化事件装配独立本地图服务。
import type { Persistence, PersistenceEvents } from '../../backend/ports/persistence'
import { localCreateMessaging } from '../../backend/adapters/messaging/in-process'
import { applicationBuildService } from '../../backend/application/graph-application'
import { sourceReadUrl } from '../../backend/adapters/sources/http-source'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import { DEFAULT_WORKSPACE_SEED } from '../config/default-prompts'
import type { AccountMailer } from '../../backend/ports/account-mailer'
import type { ModelSecretCodec } from '../../backend/ports/model-secrets'
import { accountCreatePasswords } from '../../backend/adapters/identity/argon2-passwords'

/**
 * 装配共享应用能力和进程内消息服务，并暴露供本地 Host 使用的队列。
 *
 * @param database 同时提供事务存储与本地提交事件的持久化实例，由运行时负责关闭。
 * @param options 可选租期、私有来源读取策略及诊断器；租期单位为毫秒，省略项沿用模块默认值。
 */
export function applicationCreateLocalService(database: Persistence & PersistenceEvents, options: { leaseMs?: number; allowPrivateSources?: boolean; reporter?: DiagnosticReporter; accountMailer?: AccountMailer; authChallengeSecret?: string; modelSecrets?: ModelSecretCodec } = {}) {
  const messaging = localCreateMessaging(database, options.reporter)
  return { ...applicationBuildService(database, messaging, { ...options, clientLeases: 'none', readUrl: sourceReadUrl,
    seedConfiguration: DEFAULT_WORKSPACE_SEED, accountPasswords: accountCreatePasswords() }), localQueue: messaging.queue }
}
