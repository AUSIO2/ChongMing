// 文件职责：用多个真实 Host 与 DSH 进程验证并行核查、人工审核及崩溃接管。
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'
import { createGraphApi, expectRejected, type TestGraphApi } from '../fixtures/graph-api'
import { verificationConfiguration } from '../fixtures/verification'

interface WireCall { id: string; function: { name: string; arguments: string } }
interface WireMessage { role: string; content?: string; tool_call_id?: string; tool_calls?: WireCall[] }
interface ProviderRequest { messages: WireMessage[]; tools?: Array<{ function: { name: string } }> }
interface Trace { role?: string; sessionId?: string; tools?: string[]; prompt?: string; error?: string; last?: unknown }

function toolResults(/* DSH 发给模型供应商的完整消息历史，含工具调用与原生工具结果。 */ messages: WireMessage[]) {
  // 将原生工具结果与调用身份关联，解析出脚本模型所需的业务返回值。
  const calls = new Map(messages.flatMap(/* 消息历史中的一项，读取其可能包含的工具调用数组。 */ message => /* 收集消息序列中的全部工具调用声明。 */  message.tool_calls ?? []).map(/* 历史中的单次工具调用，按调用 ID 建立结果关联。 */ call => /* 以调用身份建立工具名查找索引。 */  [call.id, call]))
  return messages.flatMap(/* 消息历史中的一项，只有 tool 角色才解析为业务工具返回值。 */ message => {
    // 只解析工具结果消息，并拒绝无法匹配原调用的响应。
    if (message.role !== 'tool') return []
    const call = calls.get(message.tool_call_id ?? '')
    if (!call) throw new Error('Native tool result has no call')
    return [{ name: call.function.name, data: JSON.parse(message.content ?? '') as Record<string, any> }]
  })
}

function stream(/* 本地模型夹具的 HTTP 响应流，写入模拟 SSE 工具调用并结束。 */ response: ServerResponse, /* 本轮要求 DSH 调用的工具名称，由测试流程决定。 */ name: string, /* 脚本模型选择的工具参数，将序列化到原生调用载荷中。 */ args: unknown) {
  // 模拟模型 SSE 响应，要求 DSH 执行指定工具及参数。
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
    id: `tool-${Date.now()}-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

async function listen(/* 用例创建的本地模型 HTTP 服务器，函数只负责启动监听。 */ server: Server) {
  // 启动本地模型服务并返回实际监听地址。
  await new Promise<void>(/* 模型服务器监听完成后解除启动等待的回调。 */ resolve => /* 等待模型 HTTP 服务绑定临时端口。 */  server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Provider did not bind')
  return `http://127.0.0.1:${address.port}`
}

interface HostProcess {
  child: ChildProcess
  ready: Promise<void>
  exited: Promise<{ code: number | null; signal: string | null }>
  // 返回当前已收集的 stdout 和 stderr，供退出断言与失败诊断使用。
  output(): string
  crashed?: boolean
}

function startHost(/* 本次真实 Host 子进程的唯一业务身份，亦用于区分工作目录和日志。 */ hostId: string, /* 已经启动的 API 夹具，提供地址、内部令牌和真实队列配置。 */ api: TestGraphApi, /* 本用例独占临时目录，容纳各 Host 的 DSH 数据与工具日志。 */ directory: string, /* 将模型请求定向到本地供应商的可信测试补丁路径。 */ patchPath: string, /* 证据工具模拟执行延迟，单位毫秒，默认 150；崩溃场景可延长。 */ toolDelayMs = 150): HostProcess {
  // 启动真实 Host 子进程，收集日志并暴露就绪、退出和输出状态。
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('apps/execution-host/main.ts'),
    '--data-api', api.url, '--host-id', hostId,
    '--dsh-home', path.join(directory, hostId), '--request-timeout-ms', '3000',
    '--patch', patchPath, '--cwd', directory, '--process-cwd', directory, '--max-tokens', '2000', '--max-rounds', '3',
  ], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, CHONGMING_DATA_TOKEN: api.token, DEEPSEEK_API_KEY: 'local-fixture-key',
    CHONGMING_AMQP_URL: api.queue.url, CHONGMING_QUEUE_NAMESPACE: api.queue.namespace,
    DSH_TELEMETRY_DISABLED: '1', CHONGMING_E2E_TOOL_LOG: path.join(directory, 'tool-calls.jsonl'),
    CHONGMING_E2E_RUNTIME_LOG: path.join(directory, 'runtime-processes.jsonl'), CHONGMING_E2E_OVERLAP: '1',
    CHONGMING_E2E_TOOL_DELAY_MS: String(toolDelayMs),
    CHONGMING_CONFIG_DIR: path.join(directory, 'local-config'),
  } })
  let stdout = '', stderr = '', readyResolved = false
  let readyResolve!: () => void, readyReject!: (/* Host 就绪前失败的具体异常，传给启动等待的拒绝函数。 */ error: Error) => void
  const ready = new Promise<void>((/* 观察到 Host 启动事件后兑现 ready Promise 的回调。 */ resolve, /* Host 启动失败或提前退出时拒绝 ready Promise 的回调。 */ reject) => {
    // 保存 Host 就绪通知及启动失败回调。
     readyResolve = resolve; readyReject = reject })
  child.stdout!.on('data', /* Host stdout 新收到的字节块，累积后检测结构化启动日志。 */ chunk => {
    // 收集 stdout，并在观察到结构化启动事件时通知就绪。
    stdout += chunk.toString()
    if (!readyResolved && stdout.includes('"host.started"')) { readyResolved = true; readyResolve() }
  })
  child.stderr!.on('data', /* Host stderr 新收到的字节块，保存用于失败诊断。 */ chunk => {
    // 收集 Host stderr，以便失败时附带运行诊断。
     stderr += chunk.toString() })
  child.once('error', readyReject)
  const exited = new Promise<{ code: number | null; signal: string | null }>(/* 子进程退出后兑现退出码及终止信号的回调。 */ resolve => /* 把子进程退出事件转为包含退出码和信号的 Promise。 */  child.once('exit', (/* Host 正常退出时的进程码，因信号终止时为 null。 */ code, /* 导致 Host 终止的信号名，正常退出时为 null。 */ signal) => {
    // 启动前退出时拒绝就绪等待，并记录最终退出状态。
    if (!readyResolved) readyReject(new Error(`Host failed before ready: ${stderr}`))
    resolve({ code, signal })
  }))
  return { child, ready, exited, output: () => /* 合并 Host 的标准输出与错误日志供断言和诊断。 */  stdout + stderr }
}

async function stopHost(/* 本测试启动并持有的 Host 进程句柄，含日志及退出等待。 */ host: HostProcess) {
  // 先请求 Host 正常终止并等待排空，超时才强杀且报告失败。
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGTERM')
  const result = await Promise.race([host.exited, delay(5000, undefined, { ref: false }).then(() => /* 将关闭期限到达转换为空结果，以区分正常退出。 */  null)])
  if (!result) { host.child.kill('SIGKILL'); await host.exited; throw new Error(`Host did not drain: ${host.output()}`) }
  expect(result).toEqual({ code: 0, signal: null })
  expect(host.output()).toContain('"host.stopped"')
}

async function stopOwnedRuntime(/* 由本测试真实工具日志取得的 DSH 进程号，不允许传入测试运行器自身。 */ pid: number) {
  // 只停止本测试记录的 DSH 进程，先温和终止再有界升级强杀。
  if (pid === process.pid) throw new Error('Refusing to treat the test runner as an owned DSH process')
  const alive = () => {
    // 探测指定 PID 是否仍存在，忽略已退出进程。
    try { process.kill(pid, 0); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  }
  if (!alive()) return
  try { process.kill(pid, 'SIGTERM') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
  for (let attempt = 0; attempt < 100 && alive(); attempt++) await delay(20)
  if (!alive()) return
  try { process.kill(pid, 'SIGKILL') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
  for (let attempt = 0; attempt < 100 && alive(); attempt++) await delay(20)
  expect(alive(), `Owned DSH PID ${pid} did not exit`).toBe(false)
}

describe('Multiple real Host processes and official DSH', () => {
  // 覆盖多进程核查在自动、人工审核和 Host 崩溃三种场景下的协作。
  it.each([
    { mode: 'auto' as const, crash: false },
    { mode: 'human-in-loop' as const, crash: false },
    { mode: 'auto' as const, crash: true },
  ])('automatically executes shared slots ($mode, crash=$crash)', async (/* 参数化场景的审核模式与崩溃开关，决定是否暂停审核或强杀 Host。 */ { mode, crash }) => {
    // 运行真实 Host、DSH、工具和 Mongo，仅脚本化模型响应，验证并行结果与接管授权。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-multi-host-'))
    const trace: Trace[] = []
    const hosts: HostProcess[] = []
    const orphanPids = new Set<number>()
    let crashedGrant: GraphWorkGrant | undefined, crashedHostId: string | undefined, crashAt: number | undefined
    let api: TestGraphApi | undefined, provider: Server | undefined
    let slots: import('../../../contracts/graph').GraphPlanSlot[] = []
    try {
      // Only model responses are scripted. Production Host loops, DSH processes, tools and Mongo are real.
      provider = createServer(async (/* 真实 DSH 发给本地模型的请求，需验证路由、凭据和私有内容未泄漏。 */ request, /* 本地模型返回流，依据当前角色写入下一次工具调用。 */ response) => {
        // 按冻结角色驱动读取、路由、证据调用和汇总，同时拒绝私有上下文泄漏。
        try {
          if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer local-fixture-key') throw new Error('Unexpected external/provider request')
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest
          const persona = body.messages.filter(/* 模型消息历史条目，只选择 system 和 user 形成角色提示词。 */ message => /* 筛选形成角色提示词的 system 与 user 消息。 */  message.role === 'system' || message.role === 'user').map(/* 选中的提示词消息，提取正文以识别冻结角色标记。 */ message => /* 收集提示词正文以识别本次模型请求对应的角色。 */  message.content).join('\n')
          const role = persona.match(/E2E_ROLE=(router|worker|merge)/)?.[1]
          if (!role) throw new Error('Frozen role persona was not installed')
          if (JSON.stringify(body).includes('PRIVATE_CONTEXT_NEVER_TO_MODEL')) throw new Error('A private context field reached the model')
          const results = toolResults(body.messages)
          const last = results[results.length - 1]
          const readResult = results.find(result => result.name === 'data_read')?.data as unknown as GraphDataRead | undefined
          trace.push({ role, sessionId: String(request.headers['x-deepseek-harness-session-id']),
            tools: body.tools?.map(/* 模型请求暴露的工具 schema，记录 function.name 检查能力集合。 */ tool => /* 记录模型可见工具名，用于验证角色能力隔离。 */  tool.function.name),
            prompt: body.messages.find(/* 模型消息条目，定位 user 消息以检查变量顺序。 */ message => /* 取得用户提示词供变量顺序和授权上下文断言。 */  message.role === 'user')?.content, last })
          if (!last) return stream(response, 'data_read', {})
          if (last.name === 'archive_lookup') return stream(response, 'data_propose', { proposal: {
            kind: 'outputs', reason: `${last.data.marker}: ${last.data.source}`, outputs: [{
              key: `opinion-${readResult!.stage.slotId}`, port: 'opinions', typeRef: { id: 'factcheck.opinion', version: 1 },
              payload: { score: last.data.score, reason: `${last.data.marker}: ${last.data.source}`, evidenceIds: [] },
            }],
          } })
          if (last.name !== 'data_read') throw new Error('Accepted work should conclude its native turn')
          const data = last.data as unknown as GraphDataRead
          if (role === 'router') return stream(response, 'data_propose', { proposal: {
            kind: 'plan', reason: 'Three evidence angles selected by the router', slots,
          } })
          if (role === 'worker') {
            if (data.stage.id !== 'assess') throw new Error('Worker lacks its DB-derived stage identity')
            return stream(response, 'archive_lookup', { query: slots.find(slot => slot.id === data.stage.slotId)!.angle })
          }
          const opinionIds = data.priorStageResults.flatMap(result => result.mode === 'outputs'
            ? result.outputs.map(output => ({ candidate: { workId: result.workId, key: output.key } })) : [])
          return stream(response, 'data_propose', { proposal: { kind: 'outputs', reason: 'Merged three independent Host reports.', outputs: [{
            key: 'verification', port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 },
            payload: { score: 0.5, reason: 'Merged three independent Host reports.', opinionIds },
          }] } })
        } catch (error) {
          trace.push({ error: String(error) })
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: String(error) } }))
        }
      })
      const providerUrl = await listen(provider)
      const patchPath = path.join(directory, 'fixture.patch.yml')
      await writeFile(patchPath, ['- id: llm-deepseek', '  config:', '    apiKeyEnv: DEEPSEEK_API_KEY',
        `    baseURL: ${providerUrl}/v1`, '    thinking: disabled', '    streamIdleTimeoutMs: 10000',
        '- insert:', '    - id: verification-evidence-fixture',
        `      name: ${JSON.stringify(path.resolve('tests/backend/fixtures/evidence-tool.mjs'))}`, '',
      ].join('\n'))
      const configuration = verificationConfiguration(5)
      configuration.tools = [{ name: 'archive_lookup', description: 'Read local fixture evidence' }]
      configuration.router.content = 'E2E_ROLE=router\nClaim={{claimContent}}'
      configuration.router.promptVars = ['context', 'claimContent', 'availableAgents']
      configuration.merger.content = 'E2E_ROLE=merge\nClaim={{claimContent}}'
      configuration.merger.promptVars = ['opinions', 'claimContent', 'originalContent']
      for (const profile of [configuration.router, configuration.merger, ...configuration.agents]) {
        profile.provider = 'deepseek-official'; profile.model = 'deepseek-v4-flash'
      }
      for (const profile of configuration.agents) {
        profile.content = 'E2E_ROLE=worker\nClaim={{claimContent}}'; profile.tools = ['archive_lookup']
        profile.promptVars = ['hint', 'claimContent', 'context', 'originalContent']; profile.defaultPriority = 'high'
      }
      api = await createGraphApi(crash ? 2500 : 15000, configuration)
      const context = await api.createRun(mode, configuration, { content: 'Fixture original source', context: {
        public: { value: 'PUBLIC_CONTEXT_TO_MODEL', visibleToAI: true },
        private: { value: 'PRIVATE_CONTEXT_NEVER_TO_MODEL', visibleToAI: false },
      } })
      const operation = (await api.store.read(context.mapId))!.runs[0].operations[0]
      const planner = operation.executionSpec.stages.find(stage => stage.id === 'route')!
      slots = planner.plan!.agents.slice(0, 3).map((agent, index) => ({ id: `angle-${index + 1}`, stageId: 'assess', agentRef: agent.ref,
        angle: `independent-angle-${index + 1}`, hint: `Follow evidence chain ${index + 1}`, priority: 'high', tools: ['archive_lookup'] }))
      hosts.push(startHost('host-a', api, directory, patchPath, crash ? 2200 : 150),
        startHost('host-b', api, directory, patchPath, crash ? 2200 : 150))
      await Promise.all(hosts.map(/* 已启动的 Host 进程句柄，读取 ready 等待启动完成。 */ host => /* 等待每个真实 Host 的启动日志确认。 */  host.ready))
      expect(hosts[0].child.pid).not.toBe(hosts[1].child.pid)
      async function waitFor(/* 判定图是否达到当前审核或完成边界的纯条件函数。 */ predicate: (/* 刚从图 API 读取的最新测试快照，供条件判断而非直接修改。 */ snapshot: Record<string, any>) => boolean) {
        // 轮询图直到指定业务边界，Run 失败或超时立即报告。
        const deadline = Date.now() + 45000
        while (Date.now() < deadline) {
          const current = await api!.snapshot(context.mapId)
          if (current.runs[0].status === 'failed') throw new Error(`Host failed: ${JSON.stringify(current.runs[0].error)}`)
          if (predicate(current)) return current
          await delay(40)
        }
        throw new Error('Hosts did not reach the expected business boundary')
      }
      if (crash) {
        const deadline = Date.now() + 25000
        let starts: Array<{ hostId: string; pid: number }> = []
        while (Date.now() < deadline) {
          const text = await readFile(path.join(directory, 'tool-calls.jsonl'), 'utf8').catch(/* 读取工具日志失败的文件系统异常，仅 ENOENT 表示尚待创建。 */ error => {
            // 工具日志尚未创建时继续等待，其余文件读取错误不隐藏。
            if (error.code === 'ENOENT') return ''
            throw error
          })
          starts = text.trim().split('\n').filter(Boolean).map(/* 工具日志中的一行 JSON 文本，解码为调用事件。 */ line => /* 解析每条工具 JSONL 记录。 */  JSON.parse(line)).filter(/* 已经解码的工具事件，按 event=start 筛选运行中的工作。 */ record => /* 仅保留工具启动记录以定位执行中的进程。 */  record.event === 'start')
          if (new Set(starts.map(/* 工具启动事件，提取 hostId 统计参与执行的 Host。 */ record => /* 提取已启动工具的 Host 身份，等待两个 Host 同时参与。 */  record.hostId)).size === 2) break
          await delay(20)
        }
        expect(new Set(starts.map(/* 工具启动事件，提取 hostId 验证两个 Host 均已运行。 */ record => /* 提取 Host 身份，断言两台 Host 都已开始证据执行。 */  record.hostId)).size).toBe(2)
        crashedHostId = starts[0].hostId
        const document = (await api.store.read(context.mapId))!
        crashedGrant = Object.values(document.leases).find(grant => grant.hostId === crashedHostId && grant.stageId === 'assess')!
        expect(crashedGrant).toBeDefined()
        expect(document.runs[0].operations[0].stages.find(stage => stage.stageId === 'assess')!.results).toHaveLength(0)
        const victim = hosts.find(/* 测试启动的 Host 进程，按其结构化日志确认应强杀的目标。 */ host => /* 按结构化 Host 身份日志找到要强杀的子进程。 */  host.output().includes(`"hostId":"${crashedHostId}"`))!
        victim.crashed = true
        crashAt = Date.now()
        expect(victim.child.kill('SIGKILL')).toBe(true)
        expect(await victim.exited).toEqual({ code: null, signal: 'SIGKILL' })
        // These PIDs came only from this test's real SDK tool log, never from a system process search.
        for (const record of starts.filter(/* 工具启动记录，只处理所属 Host 与强杀目标一致的进程。 */ record => /* 只清理被强杀 Host 产生且由测试日志记录的 DSH 进程。 */  record.hostId === crashedHostId)) {
          orphanPids.add(record.pid)
          await stopOwnedRuntime(record.pid)
          orphanPids.delete(record.pid)
        }
      }
      if (mode === 'human-in-loop') {
        const routed = await waitFor(snapshot => snapshot.runs[0].status === 'waiting' && snapshot.runs[0].operations[0].review.kind === 'plan')
        expect(routed.runs[0].operations[0].stages.find((stage: { stageId: string }) => stage.stageId === 'assess').results).toEqual([])
        await delay(200)
        await expect(readFile(path.join(directory, 'tool-calls.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await api.answer(context.mapId)
        const merged = await waitFor(/* 最新图快照，用于等待人工模式的结果审核状态。 */ snapshot => /* 等待人工模式的结果审核边界。 */  snapshot.runs[0].status === 'waiting' && snapshot.runs[0].operations[0].review.kind === 'result')
        expect(merged.nodes).toHaveLength(2)
        expect(merged.runs[0].operations[0].stages.find((stage: { stageId: string }) => stage.stageId === 'assess').results).toHaveLength(3)
        await api.answer(context.mapId)
      }
      const completed = await waitFor(/* 最新图快照，用于等待 Run 到达 completed。 */ snapshot => /* 等待本次 Run 完成全部报告与汇总。 */  snapshot.runs[0].status === 'completed')
      expect(completed.runs[0].operations[0].stages.find((stage: { stageId: string }) => stage.stageId === 'assess').planSlots).toHaveLength(3)
      const opinions = completed.nodes.filter((node: { typeId: string }) => node.typeId === 'factcheck.opinion')
      const verification = completed.nodes.find((node: { typeId: string }) => node.typeId === 'factcheck.verification')
      expect(verification.payload).toMatchObject({ score: 0.5, reason: 'Merged three independent Host reports.',
        opinionIds: opinions.map((node: { id: string }) => node.id) })
      for (const slot of slots) expect(opinions).toContainEqual(expect.objectContaining({ producer: expect.objectContaining({ agentRef: slot.agentRef }),
        payload: expect.objectContaining({ reason: `custom-tool-executed: archive:${slot.angle}` }) }))
      await Promise.all(hosts.filter(/* 本测试 Host 句柄，crashed 标记决定是否仍需正常关闭。 */ host => /* 只对仍存活、未被强杀的 Host 执行正常关闭断言。 */  !host.crashed).map(stopHost))
      const toolCalls = (await readFile(path.join(directory, 'tool-calls.jsonl'), 'utf8')).trim().split('\n').map(/* 完整证据工具日志的一行 JSON 文本。 */ line => /* 解析完整工具调用日志，验证执行数量与重叠时间。 */  JSON.parse(line))
      const starts = toolCalls.filter(/* 工具调用事件，挑选开始记录以检查数量与时间范围。 */ call => /* 收集工具开始事件。 */  call.event === 'start')
      const ends = toolCalls.filter(/* 工具调用事件，挑选结束记录以匹配实际执行时段。 */ call => /* 收集工具结束事件。 */  call.event === 'end')
      if (crash) {
        expect(starts.length).toBeGreaterThanOrEqual(4)
        expect(ends.length).toBeGreaterThanOrEqual(3)
      } else {
        expect(starts).toHaveLength(3)
        expect(ends).toHaveLength(3)
      }
      expect(new Set(starts.map(/* 工具开始事件，提取 Host 身份检查多机分工。 */ call => /* 提取工具执行的 Host 身份，确认工作由多个 Host 分担。 */  call.hostId))).toEqual(new Set(['host-a', 'host-b']))
      expect(new Set(starts.map(/* 工具开始事件，提取 DSH 会话身份检查每份工作独立执行。 */ call => /* 提取工具会话身份，确认每份工作拥有独立 DSH 根会话。 */  call.sessionId)).size).toBe(starts.length)
      const endedAt = (/* 某次工具开始记录，按会话查结束时间，崩溃时回退到 Host 被强杀时间。 */ start: typeof starts[number]) => /* 查找工具结束时间，崩溃执行以 Host 被终止的时间作为上界。 */  ends.find(/* 候选工具结束记录，使用 sessionId 与本次开始记录对应。 */ end => /* 用会话身份匹配对应的工具结束记录。 */  end.sessionId === start.sessionId)?.at
        ?? (start.hostId === crashedHostId ? crashAt : undefined)
      expect(starts.some(/* 作为重叠检查基准的一次工具开始记录。 */ a => /* 寻找至少一对来自不同 Host 的重叠执行。 */  starts.some(/* 另一工具开始记录，须属于不同 Host 且执行时间区间重叠。 */ b => /* 比较两个 Host 工具的实际执行时间区间是否相交。 */  a.hostId !== b.hostId
        && Math.max(a.at, b.at) < Math.min(endedAt(a), endedAt(b))))).toBe(true)
      const runtimes = (await readFile(path.join(directory, 'runtime-processes.jsonl'), 'utf8')).trim().split('\n')
        .map(/* 运行时生命周期日志的一行 JSON 文本。 */ line => /* 解析 DSH 进程生命周期的 JSONL 记录。 */  JSON.parse(line)).filter(/* 解码后的运行时事件，只选择 runtime-start。 */ record => /* 只保留 DSH 进程启动记录。 */  record.event === 'runtime-start')
      if (crash) expect(new Set(runtimes.map(/* 崩溃场景的运行时启动记录，提取 PID 统计实际创建进程数。 */ runtime => /* 统计崩溃重跑场景创建的独立 DSH 进程。 */  runtime.pid)).size).toBeGreaterThanOrEqual(6)
      else expect(new Set(runtimes.map(/* 正常场景的运行时启动记录，提取 PID 检查一工作一进程。 */ runtime => /* 统计正常场景每份工作使用的独立 DSH 进程。 */  runtime.pid)).size).toBe(5)
      expect(new Set(runtimes.map(/* 运行时启动记录，提取 Host 身份确认两台 Host 均执行过工作。 */ runtime => /* 提取运行时所属 Host，验证两个 Host 都承担执行。 */  runtime.hostId))).toEqual(new Set(['host-a', 'host-b']))
      for (const entry of trace) expect([...(entry.tools ?? [])].sort()).toEqual(entry.role === 'worker'
        ? ['archive_lookup', 'data_propose', 'data_read'] : ['data_propose', 'data_read'])
      for (const entry of trace) {
        const prompt = entry.prompt ?? ''
        expect(prompt).toContain('Claim=Fixture claim')
        const names = entry.role === 'router' ? configuration.router.promptVars!
          : entry.role === 'worker' ? configuration.agents[0].promptVars! : configuration.merger.promptVars!
        let previous = -1
        for (const name of names) {
          const position = prompt.indexOf(`\n\n${name}:\n`)
          expect(position).toBeGreaterThan(previous)
          previous = position
        }
        if (entry.role === 'router' || entry.role === 'worker') expect(prompt).toContain('PUBLIC_CONTEXT_TO_MODEL')
        if (entry.role !== 'router') expect(prompt).toContain('Fixture original source')
      }
      expect(new Set(trace.map(/* 模型调用轨迹条目，提取已验证角色检查三个阶段齐全。 */ entry => /* 提取模型轨迹角色，确认路由、worker 和汇总都已完成。 */  entry.role))).toEqual(new Set(['router', 'worker', 'merge']))
      if (crashedGrant) {
        const replacement = (await api.store.read(context.mapId))!.leases[crashedGrant.workId]
        expect(replacement.fence).toBeGreaterThan(crashedGrant.fence)
        expect(replacement.hostId).not.toBe(crashedGrant.hostId)
        expectRejected(await api.propose(crashedGrant, { mapId: context.mapId, operationId: context.operationId,
          id: crashedGrant.workId, specHash: crashedGrant.specHash, kind: 'outputs', reason: 'Late orphan proposal', outputs: [{
            key: 'late', port: 'opinions', typeRef: { id: 'factcheck.opinion', version: 1 },
            payload: { score: 0, reason: 'Late orphan proposal', evidenceIds: [] },
          }],
        }))
        expect(await api.snapshot(context.mapId)).toEqual(completed)
      }
    } catch (error) {
      const runtimeErrors = await readFile(path.join(directory, 'runtime-processes.jsonl'), 'utf8').catch(() => /* 诊断日志不可读时返回空文本，避免覆盖原始业务失败。 */  '')
      throw new Error(`${error instanceof Error ? error.stack : String(error)}\nHosts:\n${hosts.map(/* 测试持有的 Host 句柄，读取已收集输出附加到错误诊断。 */ host => /* 收集每个 Host 的日志，附加到失败诊断中。 */  host.output()).join('\n')}\nProvider trace:\n${JSON.stringify(trace, null, 2)}\nRuntime events:\n${runtimeErrors}`)
    } finally {
      await Promise.all(hosts.map(async /* 待清理的 Host 句柄，仍未退出时才请求正常终止。 */ host => {
        // 清理仍在运行的 Host，不重复终止已经退出的子进程。
        if (host.child.exitCode === null && host.child.signalCode === null) await stopHost(host)
      }))
      for (const pid of orphanPids) {
        await stopOwnedRuntime(pid)
      }
      if (provider) { provider.closeAllConnections(); await new Promise<void>(/* 本地模型服务器关闭后兑现清理完成的回调。 */ resolve => /* 等待模型夹具服务器完成关闭。 */  provider!.close(() => /* 模型 HTTP 监听结束后解除清理等待。 */  resolve())) }
      await api?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 90_000)
})
