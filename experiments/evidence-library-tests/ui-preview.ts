// 启动自有 Mongo/HTTP，令牌只写临时文件，退出时清理全部资源。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { evidenceCreateUiFixture } from './ui-fixture'

enum PreviewMessage {
  CLEANUP_FAILED = 'Evidence UI preview cleanup failed.',
}

async function start(): Promise<void> {
  // 建立真实预览环境并完成样本准备，再保持进程供浏览器验收。
  const fixture = await evidenceCreateUiFixture()
  let directory: string | undefined
  let closing: Promise<void> | undefined

  function close(): Promise<void> {
    // 多种退出原因共享一个关闭 Promise，令牌文件与真实服务均由本进程清理。
    return closing ??= (async () => {
      // 清理每个自有资源后再报告全部失败，保留已执行关闭的事实。
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      const errors: unknown[] = []
      try { await fixture.close() } catch (error) { errors.push(error) }
      if (directory !== undefined) {
        try { await rm(directory, { recursive: true, force: true }) } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, PreviewMessage.CLEANUP_FAILED)
    })()
  }

  function stop(): void {
    // 收到进程退出信号后等待有界服务清理，再结束这个验收进程。
    void close().then(() => /* 清理完成后结束预览进程。 */ process.exit(0), (/* 资源清理错误。 */ error) => {
      // 只输出清理失败，不输出身份令牌或业务凭据。
      console.error(error)
      process.exit(1)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    directory = await mkdtemp(path.join(tmpdir(), 'chongming-evidence-preview-'))
    const metadataPath = path.join(directory, 'connection.json')
    // 展示正确、错误和长正文三类固定条目，再留一份未收录 Claim 验收表单。
    const samples = [
      { content: '澄川公交试点包含十二条线路。', confidence: 1 as const },
      { content: '澄川公交试点在所有周末免费。', confidence: 0 as const },
      { content: '地方档案记载 café Москва。\n这段内容用于核对证据单页的固定原文。\n收录之后，原文和确定判断保持不变。', confidence: 1 as const },
    ]
    for (const sample of samples) {
      const claim = await fixture.createClaim(sample.content)
      await fixture.gateway.dispatch(randomUUID(), 'evidence.collect', { workspaceId: fixture.workspaceId, claim,
        confidence: sample.confidence, applicability: { subject: '澄川公交', event: '试点', time: null, place: null, conditions: [] },
        reason: '按已核对的档案显式收录。', basisRefs: [{ kind: 'manual', text: '临时界面验收记录。' }] })
    }
    const uncollected = await fixture.createClaim('尚未收录的独立陈述，可从 Map 中显式收录。')
    await writeFile(metadataPath, JSON.stringify({ baseUrl: fixture.baseUrl, ownerToken: fixture.ownerToken,
      viewerToken: fixture.viewerToken, workspaceId: fixture.workspaceId, otherWorkspaceId: fixture.otherWorkspaceId,
      uncollected }, null, 2), { mode: 0o600 })
    process.stdout.write(JSON.stringify({ baseUrl: fixture.baseUrl, metadataPath }) + '\n')
  } catch (error) {
    try { await close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], PreviewMessage.CLEANUP_FAILED) }
    throw error
  }
}

void start().catch((/* 预览启动或样本准备失败。 */ error) => {
  // 启动失败只输出错误，令牌不进入标准输出。
  console.error(error)
  process.exitCode = 1
})
