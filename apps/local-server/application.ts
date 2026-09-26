import type { Persistence, PersistenceEvents } from '../../backend/ports/persistence'
import { localCreateMessaging } from '../../backend/adapters/messaging/in-process'
import { applicationBuildService } from '../../backend/application/graph-application'
import { sourceReadUrl } from '../../backend/adapters/sources/http-source'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import { DEFAULT_RUN_CONFIGURATION } from '../config/default-prompts'

// 用途：创建本机服务服务，供后续流程使用。
export function applicationCreateLocalService(database: Persistence & PersistenceEvents, options: { leaseMs?: number; allowPrivateSources?: boolean; reporter?: DiagnosticReporter } = {}) {
  const messaging = localCreateMessaging(database, options.reporter)
  return { ...applicationBuildService(database, messaging, { ...options, readUrl: sourceReadUrl,
    seedConfiguration: DEFAULT_RUN_CONFIGURATION }), localQueue: messaging.queue }
}
