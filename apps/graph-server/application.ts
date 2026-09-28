// 将 Mongo 持久化、事务消息发件箱与默认配置装配为部署式图服务。
import type { Connection } from 'mongoose'
import type { QueueConfig } from '../../contracts/events'
import { persistenceCreateMongo } from '../../backend/adapters/storage/mongo/persistence'
import { outboxCreateService } from '../../backend/adapters/messaging/mongo-outbox'
import { applicationBuildService } from '../../backend/application/graph-application'
import { sourceReadUrl } from '../../backend/adapters/sources/http-source'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import { DEFAULT_RUN_CONFIGURATION } from '../config/default-prompts'

export function applicationCreateService(/* 调用方已打开的 Mongo 连接，装配持久化与发件箱共用它，关闭仍由入口负责。 */ connection: Connection, /* 可选装配策略；租期以毫秒计，来源权限、消息配置和诊断器交给对应模块，省略时沿用其默认值。 */ options: { leaseMs?: number; allowPrivateSources?: boolean; messaging?: QueueConfig; reporter?: DiagnosticReporter } = {}) {
  // 在给定 Mongo 连接上装配持久化与发件箱，向应用层注入来源读取及默认 Agent 配置。
  const database = persistenceCreateMongo(connection)
  return applicationBuildService(database, outboxCreateService(connection, database.graph(), options.messaging, options.reporter), {
    ...options, readUrl: sourceReadUrl, seedConfiguration: DEFAULT_RUN_CONFIGURATION,
  })
}
