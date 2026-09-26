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

// 用途：处理桌面端相关工作，并把结果交给调用方。
async function desktopCheckRuntime() {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-runtime-check-'))
  const runtimeDirectory = path.resolve(process.argv[2] ?? '.desktop-runtime')
  const calls: string[] = []
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/chat/completions')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const last = [...body.messages].reverse().find((message: { role: string }) => message.role === 'tool')
      let name = 'data_read', args: unknown = {}
      if (last) {
        const data = JSON.parse(last.content)
        name = 'data_propose'
        calls.push(data.work.actor.role)
        if (data.work.actor.role === 'router') args = { proposal: { kind: 'route', reason: 'Packaged runtime route', slots: [{
          id: 'packaged-slot', agentId: data.configuration.agents[0].id, angle: 'Packaged check', priority: 'medium', hint: '', tools: [],
        }] } }
        else if (data.work.actor.role === 'worker') args = { proposal: { kind: 'report', score: 1, reason: 'Packaged report' } }
        else args = { proposal: { kind: 'merge', reportIds: data.reports.map((report: { id: string }) => report.id), score: 1, reason: 'Packaged result' } }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
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
        assert.equal(graph.nodes.filter(node => node.data.kind === 'verification').length, 1)
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
    // Drop the IPC parent channel without sending stop; the service must release its SQLite lock.
    const child = spawn(path.join(runtimeDirectory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), [path.join(runtimeDirectory, 'service/main.mjs')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CHONGMING_DESKTOP_DATA_DIR: path.join(directory, 'data'), CHONGMING_CONFIG_DIR: path.join(directory, 'config') },
    })
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => reject(new Error('Child exited before readiness'))); child.once('message', () => resolve()) })
      child.disconnect()
      assert.equal(await exited, 0)
    } finally { clearTimeout(timeout); child.kill('SIGKILL') }
    console.log('Packaged Node + SQLite + DSH, restart and parent disconnect: passed')
  } finally {
    await gateway.disconnect(); await service.close()
    if (priorUrl === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = priorUrl
    if (priorKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = priorKey
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}
desktopCheckRuntime().catch(error => { console.error(error); process.exitCode = 1 })
