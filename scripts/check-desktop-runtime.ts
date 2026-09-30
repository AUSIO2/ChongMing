// 验证随包 Node/SQLite/DSH 的完整运行、持久化重启及父进程断开后的清理。
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { clientCreateService } from '../apps/desktop/local-service-process'
import { clientCreateGateway } from '../client/graph-client'
import type { GraphDataRead } from '../contracts/graph'

async function desktopCheckRuntime() {
  // 使用模拟模型端点运行完整核验，再检查服务重启、日志脱敏与父进程失联退出。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-runtime-check-'))
  const runtimeDirectory = path.resolve(process.argv[2] ?? '.desktop-runtime')
  const calls: string[] = []
  const provider = createServer(async (request, response) => {
    // 模拟模型工具调用，根据上一条工具结果依次提交路由、报告和合并产物。
    try {
      assert.equal(request.url, '/chat/completions')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const last = [...body.messages].reverse().find((message: { role: string }) => /* 从倒序消息中寻找最近的工具执行结果。 */  message.role === 'tool')
      let name = 'data_read', args: unknown = {}
      if (last) {
        const data = JSON.parse(last.content) as GraphDataRead
        name = 'data_propose'
        calls.push(data.stage.id)
        if (data.stage.id === 'route') {
          const candidate = data.stage.plan?.agents[0], stageId = data.stage.plan?.stageIds[0]
          if (!candidate || !stageId) throw new Error('Packaged route has no frozen candidate Agent')
          args = { proposal: { kind: 'plan', reason: 'Packaged runtime route', slots: [{
            id: 'packaged-slot', stageId, agentRef: candidate.ref, angle: 'Packaged check', priority: 'medium', hint: '', tools: [],
          }] } }
        } else if (data.stage.id === 'assess') {
          const port = data.outputContract.ports[0]
          args = { proposal: { kind: 'outputs', reason: 'Packaged report', outputs: [{ key: 'packaged-opinion', port: port.port,
            typeRef: port.type, payload: { score: 1, reason: 'Packaged report', evidenceIds: [] } }] } }
        } else {
          const port = data.outputContract.ports[0]
          const opinionIds = data.priorStageResults.flatMap(result => result.mode === 'outputs'
            ? result.outputs.map(output => ({ candidate: { workId: result.workId, key: output.key } })) : [])
          args = { proposal: { kind: 'outputs', reason: 'Packaged result', outputs: [{ key: 'packaged-verification', port: port.port,
            typeRef: port.type, payload: { score: 1, reason: 'Packaged result', opinionIds } }] } }
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  await new Promise<void>(resolve => /* 等待模拟模型服务绑定本机随机端口。 */  provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('Provider did not bind')
  const priorUrl = process.env.DEEPSEEK_BASE_URL, priorKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:' + address.port
  process.env.DEEPSEEK_API_KEY = 'fixture-runtime-key'
  const service = clientCreateService({ runtimeDirectory, dataDirectory: path.join(directory, 'data'), configDirectory: path.join(directory, 'config') })
  const gateway = clientCreateGateway({ baseUrl: 'http://127.0.0.1' })
  try {
    const connection = await service.start()
    await gateway.connect({ ...connection, remember: false })
    const workspaceId = (await gateway.read('workspace.list', {})).items[0].id
    const workspace = await gateway.read('workspace.get', { workspaceId })
    const mapId = randomUUID(), claimId = randomUUID()
    await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: workspace.revision, id: mapId, name: 'Packaged runtime' })
    await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [claimId], expectedVersion: null }, changes: { nodes: { put: [{
      id: claimId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'Packaged runtime fact', category: null },
    }] } } })
    const branch = await gateway.read('branch.get', { mapId, rootIds: [claimId] })
    await gateway.dispatch(randomUUID(), 'run.start', { mapId, id: randomUUID(), branch: {
      rootIds: [...branch.scope.rootIds], expectedVersion: branch.version,
    }, scope: { nodeIds: [claimId] }, mode: 'auto', plan: { steps: [{
      id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [claimId] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } })
    const deadline = Date.now() + 30000
    let completed = false
    while (Date.now() < deadline) {
      const graph = await gateway.read('map.get', { mapId })
      const run = graph.runs[0]
      assert.notEqual(run?.status, 'failed', JSON.stringify(run?.error))
      if (run?.status === 'completed') {
        assert.equal(graph.nodes.filter(node => /* 只统计默认包核验结论，确认完整执行生成一个验证节点。 */  node.typeId === 'factcheck.verification').length, 1)
        completed = true; break
      }
      await delay(80)
    }
    assert(completed, 'Packaged DSH flow timed out')
    assert.deepEqual(calls, ['route', 'assess', 'merge'])
    await gateway.disconnect(); await service.close()
    const diagnostics = await readFile(path.join(directory, 'data', 'service-diagnostics.log'), 'utf8')
    assert.match(diagnostics, /"name":"shutdown\.started"/)
    assert.doesNotMatch(diagnostics, new RegExp(connection.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const restart = clientCreateService({ runtimeDirectory, dataDirectory: path.join(directory, 'data'), configDirectory: path.join(directory, 'config') })
    try {
      const next = await restart.start()
      assert.equal(next.token, connection.token)
      await gateway.connect({ ...next, remember: false })
      assert.equal((await gateway.read('map.get', { mapId })).runs[0]?.status, 'completed')
    } finally { await gateway.disconnect(); await restart.close() }
    // 不发送 stop 而直接断开父进程 IPC，验证服务仍会退出并释放 SQLite 目录锁。
    const child = spawn(path.join(runtimeDirectory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), [path.join(runtimeDirectory, 'service/main.mjs')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CHONGMING_DESKTOP_DATA_DIR: path.join(directory, 'data'), CHONGMING_CONFIG_DIR: path.join(directory, 'config') },
    })
    const exited = new Promise<number | null>(resolve => /* 等待独立服务进程退出并取得退出码。 */  child.once('exit', resolve))
    const timeout = setTimeout(() => /* 父进程断开测试超过上限时强制结束子进程，避免验证悬挂。 */  child.kill('SIGKILL'), 5000)
    try {
      await new Promise<void>((resolve, reject) => {
        // 在断开 IPC 前等待子进程就绪，提前退出或进程错误则拒绝等待。
         child.once('error', reject); child.once('exit', () => /* 子进程尚未就绪就退出时报告验证失败。 */  reject(new Error('Child exited before readiness'))); child.once('message', () => /* 收到子进程消息后完成就绪等待。 */  resolve()) })
      child.disconnect()
      assert.equal(await exited, 0)
    } finally { clearTimeout(timeout); child.kill('SIGKILL') }
    console.log('Packaged Node + SQLite + DSH, restart and parent disconnect: passed')
  } finally {
    await gateway.disconnect(); await service.close()
    if (priorUrl === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = priorUrl
    if (priorKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = priorKey
    provider.closeAllConnections(); await new Promise<void>(resolve => /* 等待模拟模型服务关闭后再移除测试目录。 */  provider.close(() => /* 模型服务关闭回调到达后完成清理等待。 */  resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}
desktopCheckRuntime().catch(error => {
  // 输出验证错误并设置失败退出码。
   console.error(error); process.exitCode = 1 })
