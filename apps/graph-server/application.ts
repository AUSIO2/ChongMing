import type { Connection } from 'mongoose'
import type { QueueConfig } from '../../contracts/events'
import { persistenceCreateMongo } from '../../backend/adapters/storage/mongo/persistence'
import { outboxCreateService } from '../../backend/adapters/messaging/mongo-outbox'
import { applicationBuildService } from '../../backend/application/graph-application'
import { sourceReadUrl } from '../../backend/adapters/sources/http-source'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import { DEFAULT_RUN_CONFIGURATION } from '../config/default-prompts'

// 用途：创建服务，供后续流程使用。
export function applicationCreateService(connection: Connection, options: { leaseMs?: number; allowPrivateSources?: boolean; messaging?: QueueConfig; reporter?: DiagnosticReporter } = {}) {
  const database = persistenceCreateMongo(connection)
  return applicationBuildService(database, outboxCreateService(connection, database.graph(), options.messaging, options.reporter), {
    ...options, readUrl: sourceReadUrl, seedConfiguration: DEFAULT_RUN_CONFIGURATION,
  })
}
