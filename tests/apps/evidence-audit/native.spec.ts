// 以真实仓颉二进制验证结构审计、业务边界和中文报告，不以模拟算法代替仓颉实现。
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface AuditNode {
  id: string
  revision: number
  typeId: string
  typeVersion: number
  payload: Record<string, unknown>
  payloadReferences?: Array<{ path: string; targetId: string }>
  libraryClaimRefs?: Array<{ entryId: string; reason: string }>
}
interface AuditGraph {
  mapId: string
  workspaceId: string
  name: string
  revision: number
  nodes: AuditNode[]
  edges: Array<{ id: string; kind: string; from: string; to: string }>
}
interface AuditResult {
  protocolVersion: number
  status: string
  summary?: { errorCount: number; warningCount: number; pendingClaimCount: number; nodeCount: number }
  findings?: Array<{ code: string; severity: string; nodeId?: string; edgeId?: string }>
  markdown?: string
  error?: { code: string; message: string }
}

let directory: string
let serial = 0
const binary = path.resolve(process.env.CHONGMING_CANGJIE_AUDIT_BIN ?? 'apps/evidence-audit-cj/bin/evidence-audit')

beforeAll(async () => {
  // 为真实仓颉运行建立独立输入目录，避免修改示例或工作区数据。
  directory = await mkdtemp(path.join(tmpdir(), 'cangjie-audit-native-'))
})
afterAll(async () => {
  // 清理本套测试生成的输入，保留仓颉构建产物供用户运行。
  await rm(directory, { recursive: true, force: true })
})

async function sample(): Promise<AuditGraph> {
  // 每次从固定公开演示文件取得独立对象，测试修改不会污染后续用例。
  return JSON.parse(await readFile('apps/evidence-audit-cj/examples/completed.json', 'utf8'))
}

async function audit(/* 本次要交给真实仓颉程序的图输入，字符串用于畸形JSON用例。 */ input: AuditGraph | string) {
  // 编码输入、启动真实二进制并核对源文件未被修改，返回退出码与已解析结果。
  const file = path.join(directory, `input-${serial++}.json`)
  const text = typeof input === 'string' ? input : JSON.stringify(input)
  await writeFile(file, text, { mode: 0o600 })
  const result = spawnSync(binary, ['--input', file], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  expect(result.signal).toBeNull()
  expect(await readFile(file, 'utf8')).toBe(text)
  expect(result.stderr).toBe('')
  const body: AuditResult = JSON.parse(result.stdout)
  expect(body.protocolVersion).toBe(1)
  return { code: result.status, body, text: result.stdout }
}

function codes(/* 一次已完成审计返回的发现项。 */ body: AuditResult): string[] {
  // 提取稳定诊断代码，以业务含义断言而不依赖错误文案。
  return (body.findings ?? []).map(/* 当前发现项的结构化信息。 */ finding => /* 只读取稳定代码。 */ finding.code)
}

describe('真实仓颉证据图检查', () => {
  // 从正常结构、损坏结构与未覆盖范围验证退出语义及报告，不调用外部模型。
  it('完成中文演示图并以确定顺序导出相同报告', async () => {
    // 两次运行相同输入应逐字节一致，报告包含真实内容且明确结构检查范围。
    const graph = await sample()
    const first = await audit(graph)
    const second = await audit(graph)
    expect(first.code).toBe(0)
    expect(first.body.status).toBe('pass')
    expect(first.body.summary).toMatchObject({ errorCount: 0, warningCount: 0, pendingClaimCount: 0, nodeCount: 4 })
    expect(first.body.markdown).toContain('2 + 2 = 4')
    expect(first.body.markdown).toContain('结构')
    expect(first.body.markdown).toContain('opinion')
    expect(first.text).toBe(second.text)
  })

  it('空图合法，尚无结论的事实只产生警告', async () => {
    // 空图与未完成核查都是可导出状态，不当作结构损坏。
    const graph = await sample()
    graph.nodes = []
    graph.edges = []
    const empty = await audit(graph)
    expect(empty.code).toBe(0)
    expect(empty.body.summary?.errorCount).toBe(0)
    graph.nodes = [{ id: 'pending', revision: 0, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '待核查陈述', category: null } }]
    const pending = await audit(graph)
    expect(pending.code).toBe(0)
    expect(pending.body.status).toBe('warning')
    expect(pending.body.summary?.pendingClaimCount).toBe(1)
    expect(codes(pending.body)).toContain('PENDING_CLAIM')
  })

  it('准确发现重复节点、重复边和悬空边', async () => {
    // 分别破坏身份唯一性与端点存在性，要求结构错误以exit1和稳定代码返回。
    const graph = await sample()
    graph.nodes.push(structuredClone(graph.nodes[0]))
    graph.edges.push(structuredClone(graph.edges[0]))
    graph.edges.push({ id: 'broken', kind: 'reference', from: 'news', to: 'missing' })
    const result = await audit(graph)
    expect(result.code).toBe(1)
    expect(result.body.status).toBe('fail')
    expect(codes(result.body)).toEqual(expect.arrayContaining(['DUPLICATE_NODE_ID', 'DUPLICATE_EDGE_ID', 'MISSING_EDGE_NODE']))
  })

  it('核查意见引用不存在或错误类型的目标会失败', async () => {
    // 引用合法性由ID与节点类型判断，不通过reason文本猜测。
    const graph = await sample()
    graph.nodes[2].payload.evidenceClaimIds = ['absent', 'news']
    const result = await audit(graph)
    expect(result.code).toBe(1)
    expect(codes(result.body)).toEqual(expect.arrayContaining(['MISSING_REFERENCE_TARGET', 'REFERENCE_TYPE_MISMATCH']))
  })

  it('显式payload引用独立检查，缺省引用索引与人工节点合法', async () => {
    // 不要求producer或派生引用索引，但已有索引中的悬空目标必须报告。
    const graph = await sample()
    delete graph.nodes[3].payloadReferences
    expect((await audit(graph)).code).toBe(0)
    graph.nodes[0].payloadReferences = [{ path: '/custom', targetId: 'absent' }]
    const result = await audit(graph)
    expect(result.code).toBe(1)
    expect(codes(result.body)).toContain('MISSING_REFERENCE_TARGET')
  })

  it('外部库引用不作为本图节点处理，未知类型不伪装为已覆盖', async () => {
    // entryId允许不在本图，未知类型即使payload为空也只检查通用结构并说明范围。
    const graph = await sample()
    graph.nodes[2].libraryClaimRefs = [{ entryId: 'external-library-entry', reason: '外部证据引用' }]
    graph.nodes.push({ id: 'custom', revision: 0, typeId: 'custom.document', typeVersion: 1, payload: {} })
    const result = await audit(graph)
    expect(result.code).toBe(0)
    expect(result.body.status).toBe('warning')
    expect(codes(result.body)).toEqual(expect.arrayContaining(['EXTERNAL_LIBRARY_UNCHECKED', 'UNSUPPORTED_NODE_TYPE']))
    expect(codes(result.body)).not.toContain('MISSING_REFERENCE_TARGET')
  })

  it('未来节点版本保留为未覆盖，不按第一版payload误判', async () => {
    // 仓颉模块无法验证未来业务语义时必须显示警告，仍保留通用结构检查。
    const graph = await sample()
    graph.nodes[2].typeVersion = 2
    graph.nodes[2].payload = {}
    const result = await audit(graph)
    expect(result.code).toBe(0)
    expect(result.body.status).toBe('warning')
    expect(codes(result.body)).toContain('UNSUPPORTED_NODE_VERSION')
    expect(codes(result.body)).toContain('UNSUPPORTED_REFERENCE_VERSION')
  })

  it('reference成环合法且不能为待完成事实提供结论', async () => {
    // 只有successor形成核查流程，reference环不参与完成状态推导。
    const graph = await sample()
    graph.edges = graph.edges.map(/* 当前流程边。 */ edge => /* 将演示边改为普通引用。 */ ({ ...edge, kind: 'reference' }))
    graph.edges.push({ id: 'back', kind: 'reference', from: 'verification', to: 'news' })
    const result = await audit(graph)
    expect(result.code).toBe(0)
    expect(result.body.summary?.pendingClaimCount).toBe(1)
  })

  it('坏JSON、缺失图字段与输入包不能伪装为空图通过', async () => {
    // 结构不可解析时只返回invalid，不能出具成功报告。
    for (const source of ['{', '{}', '{"ok":false,"error":{"code":"NO_ACCESS"}}', '{"formatVersion":4,"maps":[]}']) {
      const result = await audit(source)
      expect(result.code).toBe(2)
      expect(result.body.status).toBe('invalid')
      expect(result.body.error?.code).toBeTypeOf('string')
    }
  })

  it('第一版非法分数与空结论引用会报错', async () => {
    // 无效业务字段属于可定位的图问题，而不是正常无结果。
    const graph = await sample()
    graph.nodes[2].payload.score = 0.7
    graph.nodes[3].payload.opinionIds = []
    const result = await audit(graph)
    expect(result.code).toBe(1)
    expect(codes(result.body)).toContain('INVALID_PAYLOAD')
  })

  it('原始正文不能注入报告标题或HTML', async () => {
    // 特殊字符保持为资料文本，不改变报告结构或生成可执行标记。
    const graph = await sample()
    graph.nodes[1].payload.content = '# injected\n<script>alert(1)</script>\n[链接](javascript:alert(1)) | `code`'
    const result = await audit(graph)
    expect(result.code).toBe(0)
    expect(result.body.markdown).not.toContain('<script>')
    expect(result.body.markdown).not.toContain('\n# injected')
    expect(result.body.markdown).not.toContain('[链接](javascript:alert(1))')
  })

  it('successor结构环失败，节点和边标识使用独立命名空间', async () => {
    // 图结构必须无环；节点名与边名相同本身并不构成重复标识。
    const graph = await sample()
    graph.edges[0].id = graph.nodes[0].id
    expect((await audit(graph)).code).toBe(0)
    graph.edges.push({ id: 'cycle', kind: 'successor', from: 'verification', to: 'claim' })
    const result = await audit(graph)
    expect(result.code).toBe(1)
    expect(codes(result.body)).toContain('SUCCESSOR_CYCLE')
  })

  it('真实Node入口调用仓颉并将正常与断链报告写入新文件', async () => {
    // 验证实际跨语言路径，不能由模拟子进程或Node重复算法代替仓颉结果。
    const graph = await sample()
    const input = path.join(directory, 'node-live-input.json')
    const output = path.join(directory, 'node-live-report.md')
    await writeFile(input, JSON.stringify({ ok: true, data: graph }))
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/evidence-audit/main.ts', '--input', input,
      '--format', 'markdown', '--output', output], { encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, CHONGMING_CANGJIE_AUDIT_BIN: binary } })
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(output, 'utf8')).toContain('2 + 2 = 4')
    graph.edges[0].to = 'missing'
    await writeFile(input, JSON.stringify(graph))
    const broken = spawnSync(process.execPath, ['--import', 'tsx', 'apps/evidence-audit/main.ts', '--input', input],
      { encoding: 'utf8', timeout: 15_000, env: { ...process.env, CHONGMING_CANGJIE_AUDIT_BIN: binary } })
    expect(broken.status, broken.stderr).toBe(1)
    expect(JSON.parse(broken.stdout).status).toBe('fail')
    expect(JSON.parse(broken.stdout).findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MISSING_EDGE_NODE' })]))
  })

  it('复制发行目录后可在不含SDK变量的环境独立运行', async () => {
    // 相对rpath与随包动态库必须足以执行，不能依赖开发者全局SDK配置。
    const relocated = path.join(directory, 'relocated-bin')
    await cp(path.dirname(binary), relocated, { recursive: true })
    const result = spawnSync(path.join(relocated, 'evidence-audit'), ['--input', path.resolve('apps/evidence-audit-cj/examples/completed.json')],
      { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).status).toBe('pass')
  })


  it('仓颉原生入口拒绝非标准JSON数字且保留字符串中的类似文字', async () => {
    // stdx默认允许进制扩展，公开JSON接口必须与Node的标准JSON边界保持一致。
    const graph = await sample()
    const valid = JSON.stringify(graph)
    for (const number of ['0x1', '0b1', '0o1', '01', '+1', '1.', 'NaN', 'Infinity']) {
      const result = await audit(valid.replace('"revision":1', '"revision":' + number))
      expect(result.code, number).toBe(2)
      expect(result.body.status, number).toBe('invalid')
    }
    graph.nodes[0].payload.content = '字面文本0x1、+1、01不应被当作JSON数字。'
    expect((await audit(graph)).code).toBe(0)
  })


  it('整数版本支持合法小数与指数表示，拒绝小数值和不安全整数', async () => {
    // JSON数值语义不由文本写法决定，同时限制跨Node与仓颉转换的精度边界。
    const graph = await sample()
    const valid = JSON.stringify(graph)
    for (const number of ['1.0', '1e0']) {
      expect((await audit(valid.replace('"revision":1', '"revision":' + number))).code, number).toBe(0)
    }
    for (const number of ['1.5', '9007199254740992']) {
      expect((await audit(valid.replace('"revision":1', '"revision":' + number))).code, number).toBe(2)
    }
  })

})
