// 通过真实 SQLite 所有者及已有初始化/关闭 seam 验证双失败保留和完整清理。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

import * as applications from '../../../apps/local-server/application'
import { localCreateRuntime } from '../../../apps/local-server/runtime'
import * as storage from '../../../backend/adapters/storage/sqlite/persistence'
import { diagnosticReadLine } from '../../../platform/node/diagnostics'

it.each([false, true])('retains startup and cleanup failures with reporter=%s', async (
  /* 是否装配真实诊断序列化；不得改变运行时拒绝类型。 */ withReporter,
) => {
  // 初始化错误不能被真实数据库释放后报告的次生错误取代。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-runtime-errors-'))
  const primary = Object.assign(new Error('controlled initialization failure'), { code: 'CONTROLLED_START_FAILED' })
  const secondary = Object.assign(new Error('controlled database close failure'), { code: 'CONTROLLED_CLOSE_FAILED' })
  const lines: Array<{ name: string; failure?: { code?: string } }> = []
  const reporter: DiagnosticReporter = { report: (/* 运行时上报的实际主错或清理错误。 */ event) => {
    // 使用生产诊断序列化确认原生错误身份没有被聚合栈替代。
    const output = diagnosticReadLine('runtime-test', 'test', event)
    lines.push(JSON.parse(output.line))
    return output.errorId
  }, close: async () => { /* 内存诊断没有外部资源。 */ } }
  const createDatabase = storage.sqliteCreatePersistence
  const createApplication = applications.applicationCreateLocalService
  const messagingClosed = vi.fn()
  vi.spyOn(storage, 'sqliteCreatePersistence').mockImplementation((/* 本例独占 SQLite 目录。 */ location) => {
    // 先保存并执行实际关闭，故障不会遗留真实数据库资源。
    const database = createDatabase(location)
    const close = database.close.bind(database)
    vi.spyOn(database, 'close').mockImplementation(async () => {
      // 完成真实释放后模拟关闭诊断失败。
      await close()
      throw secondary
    })
    return database
  })
  vi.spyOn(applications, 'applicationCreateLocalService').mockImplementation((/* 原持久化所有者。 */ database, /* 原应用选项。 */ options) => {
    // 只控制初始化故障，其他装配与清理继续走真实实现。
    const application = createApplication(database, options)
    vi.spyOn(application, 'initialize').mockRejectedValue(primary)
    const close = application.closeMessaging.bind(application)
    vi.spyOn(application, 'closeMessaging').mockImplementation(async () => {
      // 标记消息清理已尝试，随后完成真实释放。
      messagingClosed()
      await close()
    })
    return application
  })
  try {
    const problem = await localCreateRuntime({ directory, reporter: withReporter ? reporter : undefined }).then(
      () => { /* 这份受控初始化必须拒绝，不能返回运行时。 */ throw new Error('Expected startup rejection') },
      (/* 实际启动拒绝值。 */ error: unknown) => /* 保留原对象供后续身份断言。 */ error,
    )
    expect(problem).toBeInstanceOf(AggregateError)
    if (!(problem instanceof AggregateError)) throw new Error('Expected aggregated startup failure')
    expect(problem.errors[0]).toBe(primary)
    expect(problem.errors[1]).toBeInstanceOf(AggregateError)
    expect(problem.errors[1].errors).toEqual([secondary])
    expect(messagingClosed).toHaveBeenCalledOnce()
    if (withReporter) {
      expect(lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'runtime.start.failed', failure: expect.objectContaining({ code: primary.code }) }),
        expect.objectContaining({ name: 'runtime.resource.close.failed', failure: expect.objectContaining({ code: secondary.code }) }),
      ]))
    }
  } finally {
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})
