// 092 先行 DSH 验收：执行真实业务工具插件，库材料作为明确只读上下文。
import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph-work'
import { promptReadWork, promptReadWorkPersona } from '../../../backend/execution/dsh/prompt-renderer'
import { LIBRARY_TEST_AGENT, LIBRARY_TEST_OUTPUT, libraryTestFrozenClaim } from '../fixtures/library-claims'

interface ToolExecution { agent: TestAgent; name: string; signal: AbortSignal; concludeTurn(): void }
interface BusinessTool { name: string; parameters: { properties: Record<string, unknown> }; execute(
  /* 模型提交的工具边界输入，运行时仍需工具schema和服务端校验。 */ args: unknown,
  /* 原始根Agent和取消信号，租约不从args读取。 */ execution: ToolExecution,
): Promise<unknown> }
interface TestAgent {
  id: string
  concludeTurn(): void
  ctx: { tools: { restrict(/* 插件授予当前阶段的能力集。 */ input: { allow: string[] }): void }
    systemPrompt: { variable: ReturnType<typeof vi.fn>; section: ReturnType<typeof vi.fn>; getSectionOrder(/* 系统提示词区域名。 */ name: string): number } }
}
enum LibraryToolTestMessage { PLUGIN_MISSING = 'Expected DSH library business plugin', TOOL_MISSING = 'Expected registered library tool',
  INVALID_SCHEMA = 'Expected object in library tool schema', SERVER_MISSING = 'Expected bounded library test HTTP server' }
const servers: Server[] = []

afterEach(async () => {
  // 释放本用例拥有的真实HTTP监听和环境设置，不保留后台请求。
  await Promise.all(servers.splice(0).map((/* 当前真实HTTP监听。 */ server) => new Promise<void>((/* 关闭完成入口。 */ resolve, /* 关闭失败入口。 */ reject) => {
    // 将原生关闭回调接入资源排空。
    server.close((/* 关闭时发生的原生错误。 */ error) => { /* 关闭失败由测试暴露。 */ error ? reject(error) : resolve() })
  })))
  vi.unstubAllEnvs()
})

function workView() {
  // 构造已获权 data_read，材料预先遵循其冻结定义投影；本用例不实现库数据库。
  const profile = structuredClone(LIBRARY_TEST_AGENT.profile)
  const grant: GraphWorkGrant = { workId: 'operation:assess:assess', mapId: 'map', runId: 'run', operationId: 'operation', stageId: 'assess', slotId: 'assess',
    specHash: 'frozen-spec', priority: 'medium', hostId: 'host', holderId: 'holder', fence: 7, expiresAt: '2099-01-01T00:00:00.000Z', leaseMs: 30000 }
  const material = libraryTestFrozenClaim()
  material.entry.claim.nodeSnapshot.payload = { content: '只读材料 {{claimContent}} 保持字面值。', context: { visible: { value: '模型可见依据', visibleToAI: true } } }
  const data: GraphDataRead = { mapId: grant.mapId, runId: grant.runId, operationId: grant.operationId, transitionRef: { id: 'fixture.library-assess', version: 1 },
    specHash: grant.specHash, inputs: {}, context: {}, priorStageResults: [], promptVariables: { claimContent: '目标陈述' },
    stage: { id: grant.stageId, slotId: grant.slotId, agent: { ref: LIBRARY_TEST_AGENT.ref, profile }, tools: [] },
    outputContract: { mode: 'outputs', ports: [{ port: 'opinion', type: LIBRARY_TEST_OUTPUT, count: { min: 1, max: 1 },
      schema: { type: 'object', properties: { score: { type: 'number' }, reason: { type: 'string' } }, required: ['score', 'reason'], additionalProperties: false },
      references: [], successorOf: [{ source: 'input', port: 'claim' }] }] }, proposalId: grant.workId,
    work: { id: grant.workId, stageId: grant.stageId, slotId: grant.slotId, specHash: grant.specHash, status: 'ready' }, libraryClaims: [material] }
  return { grant, data, material, profile }
}

function objectAt(
  /* SDK已生成但尚未逐字段读取的工具schema。 */ input: unknown,
  /* 当前断言要定位的对象路径。 */ path: string[],
): Record<string, unknown> {
  // 在真实JS/SDK边界校验对象路径，避免以any绕过工具合同检查。
  let current: unknown = input
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(LibraryToolTestMessage.INVALID_SCHEMA)
    current = Object.getOwnPropertyDescriptor(current, key)?.value
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(LibraryToolTestMessage.INVALID_SCHEMA)
  return current as Record<string, unknown>
}

async function toolFixture() {
  // 真实插件生成SDK工具，只有HTTP工作服务回复为受控已获权view。
  const { grant, data, material, profile } = workView()
  const calls: Array<{ url: string | undefined; body: unknown; holder: string | string[] | undefined }> = []
  const server = createServer(async (/* 实际工具HTTP请求。 */ request, /* 此次工作服务回复端。 */ response) => {
    // 记录真实工具序列化输入和原租约header，不自行代替Graph提案规则。
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ url: request.url, body, holder: request.headers['x-work-holder'] })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, data }))
  })
  servers.push(server)
  await new Promise<void>((/* 监听已建立的完成入口。 */ resolve) => { /* 仅监听本机临时端口。 */ server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(LibraryToolTestMessage.SERVER_MISSING)
  vi.stubEnv('CHONGMING_DATA_API', `http://127.0.0.1:${address.port}`)
  vi.stubEnv('CHONGMING_DATA_TOKEN', 'fixture-work-token')
  const tools = new Map<string, BusinessTool>()
  const listeners: Array<(/* 新创建的原始根Agent。 */ event: { agent: TestAgent }) => void> = []
  const concludeTurn = vi.fn()
  const agent: TestAgent = { id: 'root-session', concludeTurn, ctx: { tools: { restrict(/* 此次实际授予的能力集合。 */ _input) { /* 本用例只观察工具字段，不模拟模型能力执行。 */ } },
    systemPrompt: { variable: vi.fn(), section: vi.fn(), getSectionOrder(/* 根Agent系统提示词区域名。 */ _name) { /* 原SDK区域顺序不影响本合同。 */ return 0 } } } }
  const ctx = { tools: {
    register(/* SDK真实生成的工具。 */ tool: BusinessTool) { /* 注册原工具供真实execute调用。 */ tools.set(tool.name, tool) },
    get(/* 注册工具的公开名称。 */ name: string) { /* 插件只读取本阶段注册的业务工具。 */ return tools.get(name) },
    guard(/* 插件安装的执行能力检查。 */ _guard: (/* 原SDK执行身份。 */ exec: ToolExecution) => string | undefined) { /* 本用例execute仍经插件自身businessReadAgent检查。 */ },
  }, agents: { get(/* SDK根Agent身份。 */ id: string) { /* 只返回原始根Agent，复制对象不获权。 */ return id === agent.id ? agent : undefined } },
  on(/* SDK Agent 创建事件名称。 */ _event: string, /* 插件安装的根Agent创建回调。 */ listener: (/* 原SDK Agent创建记录。 */ event: { agent: TestAgent }) => void) {
    // 保留真实插件回调，稍后以原始根Agent触发配置。
    listeners.push(listener)
  } }
  const moduleUrl = new URL('../../../backend/execution/dsh/dsh-business-plugin.mjs', import.meta.url)
  const plugin: unknown = await import(moduleUrl.href)
  if (!plugin || typeof plugin !== 'object' || !('apply' in plugin) || typeof plugin.apply !== 'function') throw new Error(LibraryToolTestMessage.PLUGIN_MISSING)
  plugin.apply(ctx, { grant, rootSessionId: agent.id, proposalId: data.proposalId, specHash: data.specHash, stage: data.stage,
    outputContract: data.outputContract, persona: promptReadWorkPersona(profile, data), libraryClaimRefs: [material.ref] })
  for (const listener of listeners) listener({ agent })
  const tool = tools.get('data_propose')
  if (!tool) throw new Error(LibraryToolTestMessage.TOOL_MISSING)
  return { tool, agent, calls, grant, material, data, concludeTurn }
}

describe('092 DSH library context and tool contract', () => {
  // 保留原Work/lease边界，仅增加只读获权材料与可选输出引用元信息。
  it('appends explicitly readonly selected material without recursive template substitution or private payload', () => {
    // 库正文属于只读用户上下文，不能改变默认Agent模板或重新解释正文中的模板标记。
    const { data, profile, material } = workView()
    const prompt = promptReadWork(promptReadWorkPersona(profile, data), data.libraryClaims)
    expect(prompt).toContain('只读证据库材料')
    expect(prompt).toContain(material.ref.entryId)
    expect(prompt).toContain('只读材料 {{claimContent}} 保持字面值。')
    expect(prompt).not.toContain('不应提供给模型的字段')
    expect(prompt).not.toContain('隐藏的上下文依据')
    expect(promptReadWorkPersona(profile, data)).not.toContain(material.ref.entryId)
    expect(promptReadWorkPersona(profile, data)).not.toContain('只读材料 {{claimContent}} 保持字面值。')
    expect(profile.content).toBe(LIBRARY_TEST_AGENT.profile.content)
  })

  it('keeps empty material prompt shape compatible', () => {
    // 没有显式材料的旧Work不增加空标头或额外业务默认内容。
    const { data, profile } = workView()
    const plain = { ...data }
    delete plain.libraryClaims
    const persona = promptReadWorkPersona(profile, plain)
    expect(promptReadWork(persona, [])).toBe(promptReadWork(persona, plain.libraryClaims))
  })

  it('exposes optional library usage metadata outside the immutable output payload schema', async () => {
    // 新工具字段位于output元信息，现有payload合同保持score/reason不被偷偷改写。
    const f = await toolFixture()
    const schema = objectAt(f.tool.parameters, ['properties', 'proposal', 'properties', 'outputs', 'items', 'properties'])
    expect(schema).toHaveProperty('libraryClaimRefs')
    const reference = objectAt(schema.libraryClaimRefs, ['items', 'properties'])
    expect(objectAt(schema, ['libraryClaimRefs'])).toMatchObject({ type: 'array', description: expect.stringContaining('32') })
    expect(reference).toMatchObject({ entryId: { type: 'string' }, contentDigest: { type: 'string' }, reason: { type: 'string' } })
    const payload = objectAt(schema.payload, ['properties'])
    expect(payload).not.toHaveProperty('libraryClaimRefs')
    const invalidRefs = [
      { refs: Array.from({ length: 33 }, () => { /* 真实执行边界须先拒绝33项集合。 */ return { ...f.material.ref, reason: '明确使用理由' } }),
        message: 'Proposal does not match the frozen output contract' },
      { refs: [{ ...f.material.ref, reason: ' ' }], message: 'Proposal does not match the frozen output contract' },
      { refs: [{ ...f.material.ref, reason: '明确使用理由', privateAuthority: true }], message: 'is not a declared property' },
    ]
    for (const invalid of invalidRefs) {
      await expect(f.tool.execute({ proposal: { kind: 'outputs', reason: '不应接受无效引用', outputs: [{ key: 'opinion', port: 'opinion',
        typeRef: LIBRARY_TEST_OUTPUT, payload: { score: 0.5, reason: '正文schema保持原样' }, libraryClaimRefs: invalid.refs }] } },
      { agent: f.agent, name: 'data_propose', signal: new AbortController().signal, concludeTurn: f.concludeTurn }))
        .rejects.toThrow(invalid.message)
    }
    expect(f.calls).toHaveLength(0)
  })

  it('passes explicit selected usage metadata through the real tool while keeping original work/lease identity', async () => {
    // 模型库引用原样透传；正式身份、specHash和租约仍由插件可信配置补入。
    const f = await toolFixture()
    const reference = { ...f.material.ref, reason: '明确使用该条固定事实' }
    await f.tool.execute({ proposal: { kind: 'outputs', reason: '完成核查', outputs: [{ key: 'opinion', port: 'opinion', typeRef: LIBRARY_TEST_OUTPUT,
      payload: { score: 0.5, reason: '保留原意见分数' }, libraryClaimRefs: [reference] }] } },
    { agent: f.agent, name: 'data_propose', signal: new AbortController().signal, concludeTurn: f.concludeTurn })
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]).toMatchObject({ url: '/internal/v1/data/propose', holder: f.grant.holderId,
      body: { mapId: f.grant.mapId, operationId: f.grant.operationId, id: f.grant.workId, specHash: f.grant.specHash,
        outputs: [{ libraryClaimRefs: [reference], payload: { score: 0.5 } }] } })
    expect(f.concludeTurn).toHaveBeenCalledOnce()
  })
})
