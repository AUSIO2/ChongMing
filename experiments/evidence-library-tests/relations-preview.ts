// 为091浏览器验收建立真实固定来源链，服务和令牌只在临时环境中存活。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { evidenceCreateRelationFixture, relationClaimRef, relationCollectParams } from './relations-fixture'

enum RelationPreviewMessage { CLEANUP_FAILED = 'Relation preview cleanup failed.' }

async function start(): Promise<void> {
  // 建立真实五节点链与显式 node 依据，供图连线和固定邻域阅读验收。
  const fixture = await evidenceCreateRelationFixture()
  let directory: string | undefined
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    // 重复退出信号共用一次关闭，始终移除临时令牌目录。
    return closing ??= (async () => {
      // 先停HTTP/数据库，再删本进程的认证文件。
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      const errors: unknown[] = []
      try { await fixture.close() } catch (error) { errors.push(error) }
      if (directory !== undefined) {
        try { await rm(directory, { recursive: true, force: true }) } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, RelationPreviewMessage.CLEANUP_FAILED)
    })()
  }
  function stop(): void {
    // 等待实际资源清理后结束预览，不输出身份令牌。
    void close().then(() => /* 自有资源全部关闭后正常退出。 */ process.exit(0), (/* 清理失败。 */ error) => {
      // 只输出关闭诊断，不输出认证或原始数据库内容。
      console.error(error)
      process.exit(1)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'chongming-relation-preview-'))
    const metadataPath = path.join(directory, 'connection.json')
    const workspaceId = await fixture.createWorkspace()
    const source = await fixture.nodeInput(workspaceId, 'factcheck.source', {
      locator: { kind: 'url', url: 'https://example.test/bus-archive' }, label: '澄川公交试点档案',
    })
    const news = await fixture.nodeInput(workspaceId, 'factcheck.news', {
      content: '试点公告规定正常票价。\n周末没有免费安排。\n范围为澄川公交十二条线路。', context: {},
    })
    const claim = await fixture.nodeInput(workspaceId, 'factcheck.claim', { content: '澄川公交试点在所有周末免费。', category: null })
    const opinion = await fixture.opinionInput(workspaceId, 0.5)
    const verification = await fixture.nodeInput(workspaceId, 'factcheck.verification', {
      score: 0.5, reason: '保留收录时已存在的核查结果及原始分数。', opinionIds: [opinion.id],
    })
    const graph = await fixture.createGraph(workspaceId, [source, news, claim, opinion, verification], [
      { id: randomUUID(), kind: 'successor', from: source.id, to: news.id },
      { id: randomUUID(), kind: 'successor', from: news.id, to: claim.id, label: '原文出处',
        sourceAnchors: [{ path: '/content', sourceRevision: 0, startLine: 1, endLine: 2, quote: '试点公告规定正常票价。\n周末没有免费安排。' }] },
      { id: randomUUID(), kind: 'successor', from: claim.id, to: opinion.id },
      { id: randomUUID(), kind: 'successor', from: opinion.id, to: verification.id },
    ])
    const params = relationCollectParams(workspaceId, relationClaimRef(graph, claim.id), 0)
    params.reason = '按档案保留原陈述，固定判断为完全错误；原核查意见分数照原值保存。'
    params.basisRefs = [{ kind: 'manual', text: '原文出处与核查下游均为收录时保存的版本。' },
      { kind: 'node', ref: relationClaimRef(graph, opinion.id) }]
    const entry = (await fixture.client.dispatch(randomUUID(), 'evidence.collect', params)).data.entry
    await writeFile(metadataPath, JSON.stringify({ baseUrl: fixture.baseUrl, ownerToken: fixture.ownerToken,
      viewerToken: fixture.viewerToken, workspaceId, entryId: entry.id, mapId: graph.mapId,
      mapRevision: graph.revision }, null, 2), { mode: 0o600 })
    process.stdout.write(JSON.stringify({ baseUrl: fixture.baseUrl, metadataPath }) + '\n')
  } catch (error) {
    try { await close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], RelationPreviewMessage.CLEANUP_FAILED) }
    throw error
  }
}

void start().catch((/* 预览启动失败的原始诊断。 */ error) => {
  // 启动异常向调用者报告，不留下测试资源或令牌。
  console.error(error)
  process.exitCode = 1
})
