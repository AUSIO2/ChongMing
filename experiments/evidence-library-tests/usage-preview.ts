// 为092浏览器验收建立跨Map核查引用、原消费者历史和当前人工引用，所有数据仅在临时Mongo内。
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { evidenceCreateUsageFixture, usageRef, usageResponseData } from './usage-fixture'

enum UsagePreviewMessage { CONSUMER_MISSING = 'Usage preview did not publish its consumer.', CLEANUP_FAILED = 'Usage preview cleanup failed.' }

async function start(): Promise<void> {
  // 使用真实公开/内部HTTP完成核查发布及消费者编辑，不用浏览器mock或修改用户数据库。
  const fixture = await evidenceCreateUsageFixture()
  let directory: string | undefined
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    // 所有退出路径共用一次清理，服务结束后删除临时认证文件。
    return closing ??= (async () => {
      // 保证服务清理异常也不会遗留预览凭据。
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      const errors: unknown[] = []
      try { await fixture.close() } catch (error) { errors.push(error) }
      if (directory !== undefined) {
        try { await rm(directory, { recursive: true, force: true }) } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, UsagePreviewMessage.CLEANUP_FAILED)
    })()
  }
  function stop(): void {
    // 信号等待本进程拥有的Mongo与HTTP关闭，再返回实际退出状态。
    void close().then(() => /* 自有资源关闭后正常退出。 */ process.exit(0), (/* 清理诊断。 */ error) => {
      // 只报告资源关闭失败，不打印认证文件内容。
      console.error(error)
      process.exit(1)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'chongming-usage-preview-'))
    const metadataPath = path.join(directory, 'connection.json')
    const scope = await fixture.createScope()
    const incorrect = await fixture.createLibraryEntry(scope, 0, '澄川公交试点在所有周末免费。')
    const correct = await fixture.createLibraryEntry(scope, 1, '澄川公交试点覆盖十二条线路。')
    const target = await fixture.createTarget(scope)
    const run = await fixture.startRun(scope, target, [usageRef(incorrect.entry)])
    usageResponseData(run.response)
    const grant = await fixture.claimWork(run)
    const proposal = await fixture.outputProposal(grant, scope, [usageRef(incorrect.entry, '核查周末免费陈述时引用固定反证。')])
    usageResponseData(await fixture.propose(grant, proposal))
    const produced = await fixture.client.read('map.get', { mapId: target.mapId })
    const consumer = produced.nodes.find((/* 实际已发布核查产物。 */ node) => /* 选取本测试的Opinion消费者。 */ node.typeId === scope.opinionType.id)
    if (!consumer) throw new Error(UsagePreviewMessage.CONSUMER_MISSING)
    usageResponseData(await fixture.editMetadata(target.mapId, target.nodes.map((/* 实际目标根。 */ node) => /* 取得真实编辑分支根。 */ node.id), [{
      id: consumer.id, typeId: consumer.typeId, typeVersion: consumer.typeVersion,
      payload: { ...consumer.payload, score: 1 },
      libraryClaimRefs: [usageRef(incorrect.entry, '人工复核保留该固定反证，更新本次使用说明。')],
    }]))
    await writeFile(metadataPath, JSON.stringify({ baseUrl: fixture.baseUrl, ownerToken: fixture.ownerToken,
      viewerToken: fixture.viewerToken, workspaceId: scope.workspaceId, entryId: incorrect.entry.id,
      secondEntryId: correct.entry.id, mapId: target.mapId, consumerNodeId: consumer.id }, null, 2), { mode: 0o600 })
    process.stdout.write(JSON.stringify({ baseUrl: fixture.baseUrl, metadataPath }) + '\n')
  } catch (error) {
    try { await close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], UsagePreviewMessage.CLEANUP_FAILED) }
    throw error
  }
}

void start().catch((/* 预览启动失败的实际诊断。 */ error) => {
  // 启动失败不留下测试服务，退出码明确表示本次预览未就绪。
  console.error(error)
  process.exitCode = 1
})
