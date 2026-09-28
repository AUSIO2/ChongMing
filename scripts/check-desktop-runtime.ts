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

async function desktopCheckRuntime() {
  // 使用模拟模型端点运行完整核验，再检查服务重启、日志脱敏与父进程失联退出。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-runtime-check-'))
  const runtimeDirectory = path.resolve(process.argv[2] ?? '.desktop-runtime')
  const calls: string[] = []
  const provider = createServer(async (/* 随包 DSH 发给测试模型端点的 HTTP 请求，断言路径后解析对话。 */ request, /* 测试模型端点拥有的 HTTP 响应，用来发送模拟工具调用事件流。 */ response) => {
    // 模拟模型工具调用，根据上一条工具结果依次提交路由、报告和合并产物。
    try {
      assert.equal(request.url, '/chat/completions')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const last = [...body.messages].reverse().find((/* 倒序对话中的候选消息，只选最近的工具结果。 */ message: { role: string }) => /* 从倒序消息中寻找最近的工具执行结果。 */  message.role === 'tool')
      let name = 'data_read', args: unknown = {}
      if (last) {
        const data = JSON.parse(last.content)
        name = 'data_propose'
        calls.push(data.work.actor.role)
        if (data.work.actor.role === 'router') args = { proposal: { kind: 'route', reason: 'Packaged runtime route', slots: [{
          id: 'packaged-slot', agentId: data.configuration.agents[0].id, angle: 'Packaged check', priority: 'medium', hint: '', tools: [],
        }] } }
        else if (data.work.actor.role === 'worker') args = { proposal: { kind: 'report', score: 1, reason: 'Packaged report' } }
        else args = { proposal: { kind: 'merge', reportIds: data.reports.map((/* 业务数据中的已接受报告，取其编号形成模拟合并引用。 */ report: { id: string }) => /* 提取全部报告编号供模拟合并提案引用。 */  report.id), score: 1, reason: 'Packaged result' } }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  await new Promise<void>(/* 模拟模型服务监听随机端口后的完成回调。 */ resolve => /* 等待模拟模型服务绑定本机随机端口。 */  provider.listen(0, '127.0.0.1', resolve))
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
    let result = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: workspace.revision, id: mapId, name: 'Packaged runtime' })
    result = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, expectedRevision: result.data.snapshot.revision, changes: { nodes: { put: [{
      id: claimId, data: { kind: 'claim', content: 'Packaged runtime fact', category: null },
    }] } } })
    await gateway.dispatch(randomUUID(), 'run.start', { mapId, expectedRevision: result.data.snapshot.revision, id: randomUUID(), scope: { nodeIds: [claimId] }, until: 'verified', mode: 'auto' })
    const deadline = Date.now() + 30000
    let completed = false
    while (Date.now() < deadline) {
      const graph = await gateway.read('map.get', { mapId })
      assert.notEqual(graph.run?.status, 'failed', JSON.stringify(graph.run?.error))
      if (graph.run?.status === 'completed') {
        assert.equal(graph.nodes.filter(/* 运行完成快照中的业务节点，用于统计核验产物。 */ node => /* 只统计核验产物，确认完整执行生成一个验证节点。 */  node.data.kind === 'verification').length, 1)
        completed = true; break
      }
      await delay(80)
    }
    assert(completed, 'Packaged DSH flow timed out')
    assert.deepEqual(calls, ['router', 'worker', 'merge'])
    await gateway.disconnect(); await service.close()
    const diagnostics = await readFile(path.join(directory, 'data', 'service-diagnostics.log'), 'utf8')
    assert.match(diagnostics, /"name":"shutdown\.started"/)
    assert.doesNotMatch(diagnostics, new RegExp(connection.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const restart = clientCreateService({ runtimeDirectory, dataDirectory: path.join(directory, 'data'), configDirectory: path.join(directory, 'config') })
    try {
      const next = await restart.start()
      assert.equal(next.token, connection.token)
      await gateway.connect({ ...next, remember: false })
      assert.equal((await gateway.read('map.get', { mapId })).run?.status, 'completed')
    } finally { await gateway.disconnect(); await restart.close() }
    // 不发送 stop 而直接断开父进程 IPC，验证服务仍会退出并释放 SQLite 目录锁。
    const child = spawn(path.join(runtimeDirectory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), [path.join(runtimeDirectory, 'service/main.mjs')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CHONGMING_DESKTOP_DATA_DIR: path.join(directory, 'data'), CHONGMING_CONFIG_DIR: path.join(directory, 'config') },
    })
    const exited = new Promise<number | null>(/* 独立服务退出时接收退出码的 Promise 完成函数。 */ resolve => /* 等待独立服务进程退出并取得退出码。 */  child.once('exit', resolve))
    const timeout = setTimeout(() => /* 父进程断开测试超过上限时强制结束子进程，避免验证悬挂。 */  child.kill('SIGKILL'), 5000)
    try {
      await new Promise<void>((/* 收到子进程就绪消息后完成等待的函数。 */ resolve, /* 子进程创建失败或未就绪即退出时拒绝等待的函数。 */ reject) => {
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
    provider.closeAllConnections(); await new Promise<void>(/* 模拟模型端点完全关闭后完成清理等待的函数。 */ resolve => /* 等待模拟模型服务关闭后再移除测试目录。 */  provider.close(() => /* 模型服务关闭回调到达后完成清理等待。 */  resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}
desktopCheckRuntime().catch(/* 随包运行验证的失败原因，输出后设置非零退出码。 */ error => {
  // 输出验证错误并设置失败退出码。
   console.error(error); process.exitCode = 1 })
