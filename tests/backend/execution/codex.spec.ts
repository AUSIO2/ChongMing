// 105先行：真实fake子进程验证执行器协议，不把模拟输出冒充真实Codex推理验收。
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DshEvent } from '../../../contracts/dsh'
import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph-work'
import { codexRunWork, type CodexWorkInput } from '../../../backend/execution/codex/work-executor'
import { codexReadOutputGuide, codexReadPrompt } from '../../../backend/execution/codex/proposal'

const temporaryDirectories: string[] = []
afterEach(async () => {
  // 每个用例独占自己的文件和Fetch seam，失败也不污染原预览或后续测试。
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((/* 用例独占目录。 */ directory) => /* 只删除测试自有文件。 */ rm(directory, { recursive: true, force: true })))
})

async function fixture(
  /* 冻结阶段允许的提案类型。 */ mode: GraphDataRead['outputContract']['mode'] = 'outputs',
) {
  // 工作API使用受控Fetch，CLI为真实子进程；不读取认证文件或运行实际模型。
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'chongming-codex-test-')))
  temporaryDirectories.push(directory)
  const bin = path.join(directory, 'fake-codex')
  await copyFile(new URL('../fixtures/codex-cli.mjs', import.meta.url), bin); await chmod(bin, 0o755)
  const tracePath = path.join(directory, 'trace.json'), configPath = path.join(directory, 'fake-config.json')
  const grant: GraphWorkGrant = { mapId: 'map-id', runId: 'run-id', operationId: 'operation-id', workId: 'work-id',
    stageId: 'stage-id', slotId: 'slot-id', specHash: 'frozen-spec', hostId: 'host-id', holderId: 'holder-id', fence: 4,
    priority: 'medium', expiresAt: '2099-01-01T00:00:00.000Z', leaseMs: 30000 }
  const data: GraphDataRead = { mapId: grant.mapId, runId: grant.runId, operationId: grant.operationId, specHash: grant.specHash,
    transitionRef: { id: 'test.transition', version: 1 }, proposalId: 'fixed-proposal-id',
    inputs: { claim: [{ key: 'claim-key', node: { id: 'claim-id', revision: 2, typeId: 'test.claim', typeVersion: 1,
      payload: { content: 'Two plus two is four.' }, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' } }] },
    context: {}, priorStageResults: [], promptVariables: { claimContent: 'Two plus two is four.' },
    stage: { id: grant.stageId, slotId: grant.slotId, tools: [], agent: { ref: { id: 'test.agent', version: 0 }, profile: {
      id: 'test.agent', name: 'Frozen Codex Agent', description: 'Fixture', content: 'Check {{claimContent}}', promptVars: ['claimContent'],
      tools: [], provider: 'openai', model: 'frozen-test-model', baseUrl: 'https://api.openai.com/v1' } }, plan: { stageIds: ['assess'], maxSlots: 2, tools: [], agents: [] } },
    outputContract: { mode, ports: [{ port: 'opinion', type: { id: 'test.opinion', version: 1 }, count: { min: 1, max: 1 },
      schema: { type: 'object', additionalProperties: true }, references: [], successorOf: [] }] },
    work: { id: grant.workId, stageId: grant.stageId, slotId: grant.slotId, specHash: grant.specHash, status: 'ready' } }
  const proposals = { outputs: { kind: 'outputs', reason: 'Checked supplied material', outputs: [{ key: 'result', port: 'opinion',
    typeRef: { id: 'test.opinion', version: 1 }, payload: { score: 1, reason: 'Arithmetic', customNested: { preserved: true } } }] },
    selection: { kind: 'selection', reason: 'Select a saved candidate', selection: [{ workId: 'prior-work', key: 'prior-output' }] },
    plan: { kind: 'plan', reason: 'One clear angle', slots: [{ id: 'check-one', stageId: 'assess', agentRef: { id: 'test.agent', version: 0 },
      angle: 'Arithmetic', hint: 'Check the supplied number', priority: 'medium', tools: [] }] } }
  let proposal: unknown = proposals[mode], processMode = 'ok', accepted = false, acceptSubmission = true, loseSubmitReply = false
  let modelConnection: unknown = { provider: 'openai', model: 'frozen-test-model', baseUrl: 'https://api.openai.com/v1', apiKey: 'fake-scoped-codex-key-110' }
  const calls: Array<{ url: string; body: unknown; proof: string | null }> = []
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (/* 工作API发出的实际Request。 */ value, /* 常规Fetch可选参数。 */ init) => {
    // 记录普通JSON请求，只有propose能改变本测试服务的accepted事实。
    const request = value instanceof Request ? value : new Request(value, init)
    const body: unknown = await request.clone().json()
    calls.push({ url: request.url, body, proof: request.headers.get('x-work-id') })
    if (request.url.endsWith('/internal/v1/work')) return Response.json({ ok: true, data: { workId: grant.workId, status: accepted ? 'accepted' : 'ready' } })
    if (request.url.endsWith('/internal/v1/data/read')) return Response.json({ ok: true, data })
    if (request.url.endsWith('/internal/v1/model/read')) return Response.json({ ok: true, data: modelConnection })
    if (request.url.endsWith('/internal/v1/data/propose')) {
      if (acceptSubmission) accepted = true
      if (loseSubmitReply) throw new TypeError('Controlled response loss after acceptance')
      return Response.json({ ok: true, data: { accepted: acceptSubmission } })
    }
    throw new Error('Unexpected Codex work endpoint')
  })
  const input: CodexWorkInput = { grant, token: 'fixture-internal-token', dataApiUrl: 'http://work-api.test', codexBin: bin,
    workHome: path.join(directory, 'attempts'), env: { CODEX_FAKE_CONFIG: configPath, CHONGMING_DATA_TOKEN: 'fixture-internal-token', CHONGMING_AMQP_URL: 'fixture-broker-private' } }
  async function configure(): Promise<void> {
    // fake配置只影响测试子进程，模型从未被调用。
    await writeFile(configPath, JSON.stringify({ tracePath, mode: processMode, proposal }), { mode: 0o600 })
  }
  await configure()
  return { input, data, calls, fetcher, directory, tracePath, configure,
    setModelConnection(/* 本Work接口的受控模型配置，不读取真实密钥。 */ value: unknown): void { modelConnection = value },
    setProposal(/* 测试注入的未知模型结果。 */ value: unknown): void { /* 改下一次fake结果。 */ proposal = value },
    setMode(/* 测试子进程的失败或等待模式。 */ value: string): void { /* 不改变工作服务状态。 */ processMode = value },
    markAccepted(): void { /* 模拟旧请求已被后端接纳。 */ accepted = true },
    rejectSubmission(): void { /* HTTP成功本身不等于accepted工作事实。 */ acceptSubmission = false },
    dropSubmitReply(): void { /* 仅丢交付，仍由服务先实际接纳。 */ loseSubmitReply = true } }
}

describe('105 optional Codex exec work runner', () => {
  it('uses only the scoped Key and endpoint through an explicit provider without cached authentication', async () => {
    const f = await fixture()
    await codexRunWork({ ...f.input, env: { ...f.input.env, OPENAI_API_KEY: 'fake-server-key', CODEX_API_KEY: 'fake-codex-server-key',
      CODEX_HOME: '/private/old-auth-cache', OPENAI_BASE_URL: 'https://wrong-server.example' } })
    const trace = JSON.parse(await readFile(f.tracePath, 'utf8'))
    expect(trace.modelKeyDigest).toBe(createHash('sha256').update('fake-scoped-codex-key-110').digest('hex'))
    expect(trace.args).toEqual(expect.arrayContaining(['model_provider="chongming_work"',
      'model_providers.chongming_work.base_url="https://api.openai.com/v1"',
      'model_providers.chongming_work.env_key="CHONGMING_MODEL_API_KEY"',
      'model_providers.chongming_work.requires_openai_auth=false']))
    expect(trace.codexHome.startsWith(trace.cwd + path.sep)).toBe(true)
    expect(trace.envNames).not.toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY']))
    for (const content of [trace.input, JSON.stringify(trace.args)]) expect(content).not.toMatch(/fake-scoped-codex-key-110|fake-server-key|fake-codex-server-key/)
    expect(f.calls.find(call => call.url.endsWith('/model/read'))).toMatchObject({ proof: f.input.grant.workId })
  })

  it('refuses a missing scoped Key before spawning even when server credentials exist', async () => {
    const f = await fixture()
    f.setModelConnection({ provider: 'openai', model: 'frozen-test-model', baseUrl: 'https://api.openai.com/v1', apiKey: '' })
    await expect(codexRunWork({ ...f.input, env: { OPENAI_API_KEY: 'fake-server-key' } })).rejects.toBeInstanceOf(Error)
    await expect(readFile(f.tracePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['fake-scoped-codex-key-110', 'fake-"quoted"-key'])('rejects an output that echoes the scoped Key instead of sending it to graph storage (%s)', async apiKey => {
    const f = await fixture()
    f.setModelConnection({ provider: 'openai', model: 'frozen-test-model', baseUrl: 'https://api.openai.com/v1', apiKey })
    f.setProposal({ kind: 'outputs', reason: 'unexpected echo ' + apiKey, outputs: [] })
    await f.configure()
    await expect(codexRunWork(f.input)).rejects.toBeInstanceOf(Error)
    expect(f.calls.some(call => call.url.endsWith('/data/propose'))).toBe(false)
  })
  // Fake只证明进程和协议，真正推理与业务落库另走显式live验收。
  it('projects exact output source keys and candidate references after old persona instructions', async () => {
    // 105真实拒绝显示输入锚点和预留nodeId被误用，提示必须给可直接复制的端口元数据。
    const f = await fixture()
    f.data.stage.agent.profile.content = 'LEGACY_MERGE_TEMPLATE：提交merge及reportIds。'
    f.data.outputContract.ports = [
      { port: 'verification', type: { id: 'factcheck.verification', version: 1 }, count: { min: 1, max: 1 },
        schema: { type: 'object', properties: { score: { type: 'number', enum: [0, 0.5, 1] }, reason: { type: 'string' }, opinionIds: { type: 'array', items: { type: 'string' }, minItems: 1 } },
          required: ['score', 'reason', 'opinionIds'], additionalProperties: false },
        references: [{ path: '/opinionIds/*', target: { kind: 'node', types: [{ id: 'factcheck.opinion', version: 1 }] } }],
        successorOf: [{ source: 'output', port: 'opinions' }] },
      { ...f.data.outputContract.ports[0], port: 'opinion', successorOf: [{ source: 'input', port: 'claim' }] },
    ]
    f.data.priorStageResults = [{ mode: 'outputs', workId: 'accepted-assess-work', stageId: 'assess', slotId: 'logic',
      acceptedAt: '2026-10-21T00:00:00.000Z', reason: 'Accepted opinion', outputs: [{ key: 'saved-opinion', port: 'opinions',
        typeRef: { id: 'factcheck.opinion', version: 1 }, nodeId: 'reserved-opinion-node-id', payload: { score: 1, reason: 'Provided reference', evidenceClaimIds: [] } }] }]
    const prompt = codexReadPrompt(f.data)
    expect(prompt).toContain('"allowedSourceKeys"')
    const expected = [{ port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 }, allowedSourceKeys: ['accepted-assess-work:saved-opinion'],
      candidateReferences: [{ path: '/opinionIds/*', candidates: [{ candidate: { workId: 'accepted-assess-work', key: 'saved-opinion' } }] }] },
    { port: 'opinion', typeRef: { id: 'test.opinion', version: 1 }, allowedSourceKeys: ['claim-key'], candidateReferences: [] }]
    expect(codexReadOutputGuide(f.data)).toEqual(expected)
    const metadata = prompt.split('\n\n').find((/* 一段完整JSON资料。 */ section) => /* 不从persona中的相似字符串判断投影是否真实使用。 */ section.startsWith('{') && section.includes('"outputContract"'))
    if (!metadata) throw new Error('Expected actual frozen prompt metadata')
    expect(JSON.parse(metadata).outputGuidance).toEqual(expected)
    expect(JSON.stringify(codexReadOutputGuide(f.data))).not.toContain('reserved-opinion-node-id')
    expect(prompt).toContain('预留')
    expect(prompt).toContain('省略sourceKeys')
    expect(prompt.lastIndexOf('执行规范')).toBeGreaterThan(prompt.indexOf('LEGACY_MERGE_TEMPLATE'))
    expect(prompt.lastIndexOf('执行规范')).toBeGreaterThan(prompt.indexOf('"outputGuidance"'))
  })

  it.each(['outputs', 'selection', 'plan'] as const)('submits %s with fixed Host identity after an isolated CLI invocation', async (/* 当前冻结模式。 */ mode) => {
    // 模型只写业务提案，真实授权与proposalId由宿主注入，退出0后仍须accepted确认。
    const f = await fixture(mode), events: DshEvent[] = []
    const result = await codexRunWork({ ...f.input, onEvent: (/* 已脱离模型文本的活动事件。 */ event) => { /* 仅保留工作阶段摘要。 */ events.push(event) } })
    expect(result).toMatchObject({ workId: f.input.grant.workId, status: 'accepted', sessionId: 'fake-codex-session' })
    expect(events).toEqual(expect.arrayContaining([
      { method: 'codex.exec.started', params: { workId: f.input.grant.workId, model: 'frozen-test-model' } },
      { method: 'codex.exec.accepted', params: { workId: f.input.grant.workId, model: 'frozen-test-model', threadId: 'fake-codex-session',
        usage: { input_tokens: 1, output_tokens: 1 } } },
    ]))
    const trace = JSON.parse(await readFile(f.tracePath, 'utf8'))
    expect(trace.args).toEqual(expect.arrayContaining(['--no-daemon', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', 'read-only', '--json', '--output-schema', '-o', '-m', 'frozen-test-model', '-']))
    expect(trace.args).toContain('web_search="disabled"')
    expect(trace.args).toContain('model_reasoning_effort="low"')
    for (const feature of ['shell_tool', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use', 'image_generation']) expect(trace.args).toContain(feature)
    expect(trace.schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['proposalJson'], properties: { proposalJson: { type: 'string' } } })
    expect(trace.input).toContain('Two plus two is four.')
    expect(trace.input).toContain('outputContract')
    expect(JSON.stringify(trace)).not.toContain(f.input.token)
    expect(trace.envNames.filter((/* 子进程继承环境名。 */ name: string) => /* 只有本Work模型Key可以交给CLI，业务授权仍不交付。 */ name.startsWith('CHONGMING_'))).toEqual(['CHONGMING_MODEL_API_KEY'])
    const submission = f.calls.find((/* 一次真实HTTP seam调用。 */ call) => /* 宿主提交固定提案。 */ call.url.endsWith('/data/propose'))
    expect(submission).toMatchObject({ proof: f.input.grant.workId, body: { kind: mode, mapId: f.input.grant.mapId,
      operationId: f.input.grant.operationId, specHash: f.input.grant.specHash, id: f.data.proposalId } })
    expect(f.calls.at(-1)?.url).toContain('/internal/v1/work')
    expect(events.some((/* 公共执行摘要。 */ event) => /* 不依赖模型自然语言推断调用成功。 */ event.method === 'session.event')).toBe(true)
  })

  it('keeps only necessary CLI authentication environment and excludes foreign thread provider and Host markers', async () => {
    // 不复制密钥文件；仅允许官方认证缓存和必要进程环境，父会话及其它provider凭据不进入CLI。
    const f = await fixture()
    await codexRunWork({ ...f.input, env: { ...f.input.env, CODEX_THREAD_ID: 'different-thread',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'outer-app', DEEPSEEK_API_KEY: 'fixture-other-provider-secret',
      UNRELATED_SECRET: 'fixture-unrelated-secret', LC_ALL: 'C', OPENAI_API_KEY: 'fixture-codex-only-auth' } })
    const trace = JSON.parse(await readFile(f.tracePath, 'utf8'))
    expect(trace.envNames).toEqual(expect.arrayContaining(['HOME', 'PATH', 'LC_ALL', 'CHONGMING_MODEL_API_KEY']))
    for (const name of ['OPENAI_API_KEY', 'CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'DEEPSEEK_API_KEY', 'UNRELATED_SECRET', 'CHONGMING_DATA_TOKEN', 'CHONGMING_AMQP_URL', 'CODEX_FAKE_CONFIG']) expect(trace.envNames).not.toContain(name)
  })

  it('returns an existing accepted receipt without reading inputs or launching the CLI', async () => {
    // 已接纳重放不再次推理，也不需要依赖本地可执行文件存在。
    const f = await fixture(); f.markAccepted()
    const events: DshEvent[] = []
    expect(await codexRunWork({ ...f.input, codexBin: '/nonexistent/unused-codex', onEvent: (/* 宿主可读的白名单事件。 */ event) => { /* 不应记录一次不存在的新CLI调用。 */ events.push(event) } })).toMatchObject({ status: 'accepted', sessionId: null })
    expect(f.calls).toHaveLength(1)
    expect(events).toEqual([])
    await expect(readFile(f.tracePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['wrong-grant', 'provider', 'tools'] as const)('rejects %s before launching any inference', async (/* 启动前不满足的冻结工作条件。 */ problem) => {
    // 授权、模型来源或未桥接工具不满足时明确拒绝，不能静默换模型或忽略工具。
    const f = await fixture()
    if (problem === 'wrong-grant') f.data.specHash = 'different-spec'
    else if (problem === 'provider') f.data.stage.agent.profile.provider = 'deepseek-official'
    else { f.data.stage.tools = [{ name: 'web_search', description: 'Unavailable DSH tool' }]; f.data.stage.agent.profile.tools = ['web_search'] }
    await expect(codexRunWork(f.input)).rejects.toBeInstanceOf(Error)
    expect(f.calls.some((/* 工作API调用。 */ call) => /* 配置失败不提交假产物。 */ call.url.endsWith('/data/propose'))).toBe(false)
    await expect(readFile(f.tracePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['identity', 'nodeId', 'wrong-kind', 'invalid', 'exit'] as const)('rejects %s output instead of treating text or exit zero as success', async (/* 真实fake进程返回的无效输出。 */ problem) => {
    // 只做提案外壳与宿主身份边界，业务payload完整Schema由原服务验证。
    const f = await fixture()
    if (problem === 'identity') f.setProposal({ kind: 'outputs', reason: 'bad', outputs: [], operationId: 'forged-operation' })
    else if (problem === 'nodeId') f.setProposal({ kind: 'outputs', reason: 'bad', outputs: [{ key: 'one', port: 'opinion', typeRef: { id: 'test.opinion', version: 1 }, payload: {}, nodeId: 'chosen-node' }] })
    else if (problem === 'wrong-kind') f.setProposal({ kind: 'selection', reason: 'Wrong frozen mode', selection: [] })
    else f.setMode(problem)
    await f.configure()
    await expect(codexRunWork(f.input)).rejects.toBeInstanceOf(Error)
    expect(f.calls.some((/* 受控工作API调用。 */ call) => /* 无效结果不能进入提交。 */ call.url.endsWith('/data/propose'))).toBe(false)
  })

  it('confirms only the original Work after a submit reply is lost and never launches a second CLI', async () => {
    // 服务先accepted后丢回包，沿原Work状态核对，不重新推理另一提案。
    const f = await fixture(); f.dropSubmitReply()
    const events: DshEvent[] = []
    expect(await codexRunWork({ ...f.input, onEvent: (/* 可核对实际CLI调用的白名单事件。 */ event) => { /* 收据确认必须沿同一次调用。 */ events.push(event) } })).toMatchObject({ status: 'accepted' })
    expect(f.calls.filter((/* 一次API调用。 */ call) => /* 原提案只发送一次。 */ call.url.endsWith('/data/propose'))).toHaveLength(1)
    expect(f.calls.at(-1)?.url).toContain('/internal/v1/work')
    expect(events.filter((/* 每个白名单执行事件。 */ event) => /* 丢回包确认不应再启动进程。 */ event.method === 'codex.exec.started')).toHaveLength(1)
    expect(events.filter((/* 每个白名单执行事件。 */ event) => /* 只有原accepted确认后上报。 */ event.method === 'codex.exec.accepted')).toHaveLength(1)
  })

  it('rejects successful HTTP and CLI completion if the original Work was not accepted', async () => {
    // 状态查询是权威成功条件，不把通用成功信封当收据。
    const f = await fixture(); f.rejectSubmission()
    await expect(codexRunWork(f.input)).rejects.toBeInstanceOf(Error)
  })

  it('awaits its own CLI close before returning cancellation and submits no result', async () => {
    // fake收到SIGTERM后延迟写closed标记，证明关闭顺序由runner实际等待。
    const f = await fixture(); f.setMode('hang'); await f.configure()
    const controller = new AbortController(), reason = new Error('Controlled Host cancellation')
    const result = codexRunWork({ ...f.input, signal: controller.signal })
    const assertion = expect(result).rejects.toBe(reason)
    await vi.waitFor(async () => { /* 等待真实子进程已启动并收完stdin。 */ expect(JSON.parse(await readFile(f.tracePath, 'utf8')).args).toContain('exec') })
    controller.abort(reason)
    await assertion
    expect(await readFile(f.tracePath + '.closed', 'utf8')).toBe('closed')
    expect(f.calls.some((/* 受控工作API调用。 */ call) => /* 取消工作不写提案。 */ call.url.endsWith('/data/propose'))).toBe(false)
  })
})
