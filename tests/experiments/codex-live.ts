// 显式真实模型演示；不属于默认测试矩阵，不复用模拟模型，也不连接用户的 5173 预览。
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import { chromium, expect, type Browser, type Locator, type Page, type Request } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

import type { DiagnosticEvent, DiagnosticReporter } from '../../contracts/diagnostics'
import type { GraphNode } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphAgentProfile } from '../../contracts/graph-agent'
import type { GraphOperation, GraphRun } from '../../contracts/graph-run'
import { clientCreateGateway, ClientError } from '../../client/graph-client'
import { DEFAULT_WORKSPACE_SEED } from '../../apps/config/default-prompts'
import { localCreateRuntime } from '../../apps/local-server/runtime'
import type { HostExecutionEvent } from '../../backend/execution/host-worker'
import type { WorkspaceSeedInput } from '../../backend/modules/workspace/seed-configuration'
import { diagnosticReadLine } from '../../platform/node/diagnostics'
import { workspaceCreateStaticDocumentPlugin } from '../browser/workspace-vite'
import { codexLiveAssertBranching, CodexLiveBranchingError } from './codex-live-branching'

type LivePhase = 'claim' | 'news'
interface LiveOptions {
  phase: LivePhase
  codexBin: string
  webPort: number
  timeoutMs: number
  headed: boolean
  keepOpen: boolean
}
interface LiveDiagnostic {
  at: string
  name: string
  severity: DiagnosticEvent['severity']
  context: Partial<Record<'mapId' | 'runId' | 'operationId' | 'workId' | 'phase' | 'model', string | number | boolean>> & { threadId?: string | null }
  failure?: { type?: string; code?: string; stack?: string[] }
}
interface LiveArtifacts {
  directory: string
  diagnostics: LiveDiagnostic[]
  summary: Record<string, unknown>
}

enum LiveMessage {
  ARGUMENT_INVALID = '演示参数无效；须明确指定 phase 和 codex-bin，且预览端口不能是 5173。',
  DEFAULT_PROFILE_MISSING = '正式提示词中缺少演示需要的无工具 Agent。',
  VITE_NOT_LISTENING = '隔离演示页面未取得独立监听端口。',
  MAP_MISSING = '页面没有创建唯一的演示数据图。',
  NODE_MISSING = '页面没有保存指定正文和精确类型的数据节点。',
  START_NOT_CONFIRMED = '页面确认前出现运行，或确认后没有唯一的运行。',
  RUN_FAILED = '真实运行失败；安全摘要保留其错误码和工作身份。',
  RUN_NOT_COMPLETED = '真实运行尚未在演示期限内完成。',
  SPEC_MISMATCH = '保存的执行规格、模型或工具边界不符合本次演示配置。',
  OUTPUT_MISMATCH = '正式输出、创建来源或结构关系不符合实际运行记录。',
  PIPELINE_MISMATCH = '后步没有按声明端口消费前步正式事实。',
  CLI_EVIDENCE_MISSING = '保存结果缺少对应真实 Codex 工作接受诊断。',
  INTERRUPTED = '本次隔离演示已停止。',
  UNEXPECTED_FAILURE = '演示未通过；未输出任意异常内容或模型进程原始输出。',
  CLEANUP_FAILED = '部分自有演示资源没有正常关闭。',
}

class LiveCheckError extends Error {
  constructor(
    /* 稳定的本地核对失败类别，不接受任意模型错误文本。 */ readonly check: LiveMessage,
    /* 仅含本脚本选择的身份、计数或状态，不含令牌和进程输出。 */ readonly details: Record<string, unknown> = {},
  ) {
    super(check)
    this.name = 'LiveCheckError'
  }
}

const MODEL = 'gpt-6-astra'
const REFERENCE_URL = 'https://science.nasa.gov/mission/webb/launch/'
const CLAIM_CONTENT = '詹姆斯·韦布空间望远镜于2021年12月25日发射。'
const NEWS_CONTENT = `${CLAIM_CONTENT}\n此次发射使用阿丽亚娜5号火箭。`
const REFERENCE_CONTENT = 'NASA 的韦布任务发射资料记载：发射日期为2021年12月25日，运载火箭为阿丽亚娜5号，发射地点为法属圭亚那库鲁。'
const REFERENCE_BOUNDARY = '基于提供材料核查、未在线取证。参考资料由演示宿主事先提供，本次执行没有 web_search 或 web_fetch；不得声称独立访问过该网页。'
const USAGE = 'node --import tsx tests/experiments/codex-live.ts --phase claim|news --codex-bin <CLI路径> [--keep-open] [--headed] [--web-port 5187] [--timeout-ms 1800000]'

function liveRequire(
  /* 当前业务边界是否成立。 */ condition: unknown,
  /* 不成立时保存的稳定类别。 */ check: LiveMessage,
  /* 经本脚本选择的有限诊断信息。 */ details: Record<string, unknown> = {},
): asserts condition {
  // 将断言失败收敛到安全摘要，避免测试框架把完整令牌或模型载荷打印出来。
  if (!condition) throw new LiveCheckError(check, details)
}

function liveReadOptions(
  /* 仅来自命令行的显式演示参数；不读取用户配置或密钥文件。 */ args: string[],
): LiveOptions | null {
  // 缺省只展示用法；必须显式选择阶段才会建立真实执行器。
  if (!args.length || args.includes('--help')) return null
  const values = new Map<string, string>()
  let headed = false
  let keepOpen = false
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === '--headed') { headed = true; continue }
    if (key === '--keep-open') { keepOpen = true; continue }
    liveRequire(['--phase', '--codex-bin', '--web-port', '--timeout-ms'].includes(key), LiveMessage.ARGUMENT_INVALID)
    const value = args[index + 1]
    liveRequire(value && !value.startsWith('--') && !values.has(key), LiveMessage.ARGUMENT_INVALID)
    values.set(key, value)
    index += 1
  }
  const phase = values.get('--phase')
  const codexBin = values.get('--codex-bin')
  const webPort = Number(values.get('--web-port') ?? '5187')
  const timeoutMs = Number(values.get('--timeout-ms') ?? '1800000')
  liveRequire(phase === 'claim' || phase === 'news', LiveMessage.ARGUMENT_INVALID)
  liveRequire(typeof codexBin === 'string' && codexBin.trim(), LiveMessage.ARGUMENT_INVALID)
  liveRequire(Number.isInteger(webPort) && webPort > 1023 && webPort <= 65535 && webPort !== 5173, LiveMessage.ARGUMENT_INVALID)
  liveRequire(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, LiveMessage.ARGUMENT_INVALID)
  return { phase, codexBin, webPort, timeoutMs, headed, keepOpen }
}

function liveCreateSeed(): WorkspaceSeedInput {
  // 复用正式定义的播种机制和随仓库提示词；本次所有模型标签与工具边界显式冻结。
  function configure(
    /* 正式发布资源中的一份提示词配置。 */ profile: GraphAgentProfile,
  ): GraphAgentProfile {
    // 修改本次隔离初始化副本，保留正式资源对象。
    return { ...profile, tools: [], provider: 'openai', model: MODEL }
  }
  const splitter = DEFAULT_WORKSPACE_SEED.split.agents.find(
    /* 正式拆分候选，不使用新的模型模拟角色。 */ agent => /* 只保留适合两句新闻的一个有限候选。 */ agent.id === 'split-data',
  )
  const logic = DEFAULT_WORKSPACE_SEED.agents.find(
    /* 正式核查候选。 */ agent => /* 此候选原本不声明外部检索工具。 */ agent.id === 'logic' && agent.tools.length === 0,
  )
  liveRequire(splitter && logic, LiveMessage.DEFAULT_PROFILE_MISSING)
  const generalSplitter: GraphAgentProfile = { ...configure(splitter), id: 'original-news-facts', name: '原文事实拆分',
    description: '逐条提取新闻原文的独立陈述，覆盖日期、型号等事实，不从参考材料新增陈述。',
    content: '读取本次data_read提供的News、可见上下文及拆分hint。逐句覆盖新闻正文中的所有可独立核查陈述，包括日期、型号和地点等不同内容，不限于数值事实；彼此独立的陈述分别输出，不能只选择其中一句，也不把两句合并为一条。可按原文消解“此次”等指代，保留完整主体和语义；不从context新增原文没有的事实，不验证真伪。提交kind为outputs的阶段提案并说明reason，outputs每项包含独立key、port=claims、outputContract中的精确typeRef，以及含content和category的payload；category按正式合同取data或null。sourceKeys省略时沿用本次新闻来源，不编造正式节点ID。' }
  const materials: GraphAgentProfile = { ...configure(logic), id: 'provided-materials', name: '提供材料一致性',
    description: '独立逐项核对陈述与提供材料的一致性，明确没有在线取证。',
    content: `${logic.content}\n本次职责是将陈述逐项与 context 中“参考资料”核对。${REFERENCE_BOUNDARY} 理由须区分资料支持、资料不覆盖和逻辑矛盾；仅凭资料没有出现某事不能断言其为假。` }
  const limitations: GraphAgentProfile = { ...configure(logic), id: 'context-limits', name: '逻辑与语境限定审查',
    description: '独立审查主体、时间、措辞限定和证据范围，区分资料支持与外部独立证实。',
    content: `${logic.content}\n本次职责是独立审查Claim的主体、时间和措辞限定是否与原新闻语境一致，是否存在推理跳跃、扩大陈述或把材料支持当作独立证实。不要复写另一角度的材料逐项对照；说明本角度发现的依据与限制，按正式意见合同独立给出score和reason。${REFERENCE_BOUNDARY}` }
  const router = configure(DEFAULT_WORKSPACE_SEED.router)
  router.content = `${router.content.replace('不要固定选择两个或全部Agent。', '')}\n本次示例任务要求每条Claim分别安排“提供材料一致性”和“逻辑与语境限定审查”两种独立职责。为这两种职责各选择一个匹配的可用Agent，生成两个不同angle及具体hint；槽位身份、措辞和理由由你决定，不能省略任一职责。不要在路由阶段代写意见或结论，tools保持为空。`
  const merger = configure(DEFAULT_WORKSPACE_SEED.merger)
  merger.content = `${merger.content}\n本次示例任务要求综合“提供材料一致性”和“逻辑与语境限定审查”两类已接纳意见的实际理由。结论应明确记录两类意见各自的作用，并通过正式候选引用实际使用两类意见，不能只取一条高分意见而省略限定审查；仍不得按意见数量投票，不得伪造、改写或修补无效意见。`
  return { parse: configure(DEFAULT_WORKSPACE_SEED.parse),
    split: { router: configure(DEFAULT_WORKSPACE_SEED.split.router), merger: configure(DEFAULT_WORKSPACE_SEED.split.merger), agents: [generalSplitter] },
    router, merger, agents: [materials, limitations], tools: [], maxSlots: 2 }
}

async function liveWriteJson(
  /* 本次私有产物的绝对文件路径。 */ filename: string,
  /* 已明确投影为安全字段的摘要。 */ value: unknown,
): Promise<void> {
  // 强制权限覆盖已有文件，避免依赖调用者的 umask。
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(filename, 0o600)
}

async function liveReadLimitedJson(
  /* 原请求或响应的克隆流；不读取 headers，也不消费交还业务调用者的原流。 */ body: ReadableStream<Uint8Array> | null,
): Promise<unknown> {
  // 观察最多读取 64 KiB；超限或非 JSON 只放弃这份观察，不改变真实请求结果。
  if (!body) return undefined
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 64 * 1024) return undefined
      parts.push(part.value)
    }
    const bytes = Buffer.concat(parts)
    try { return JSON.parse(bytes.toString('utf8')) }
    catch { return undefined }
  } finally {
    // 观察在原响应交还后并行执行，取消克隆不会阻塞原业务读取。
    await reader.cancel().catch(() => { /* 保留真实调用结果，次要观察流取消失败不外抛。 */ })
    reader.releaseLock()
  }
}

function liveObserveRejectedProposals(
  /* 仅写入本轮 0700 目录内的 0600 私有文件，不复写以前失败记录。 */ artifacts: LiveArtifacts,
): () => Promise<void> {
  // 临时装饰当前进程的 fetch；原参数、原响应与异常均原样转发，finally 恢复。
  const originalFetch = globalThis.fetch
  const pending = new Set<Promise<void>>()
  const rejected: Array<Record<string, unknown>> = []
  let observedCount = 0
  const observedFetch: typeof globalThis.fetch = async (
    /* 原样交给原 fetch 的请求，不读取认证头。 */ input,
    /* 原样交给原 fetch 的覆盖选项。 */ init,
  ): Promise<Response> => {
    let matches = false
    let requestClone: globalThis.Request | undefined
    let bodyText: string | undefined
    try {
      const url = new URL(input instanceof globalThis.Request ? input.url : String(input))
      matches = url.pathname === '/internal/v1/data/propose' && observedCount < 5
      if (matches) {
        // Request 必须在转发前克隆；字符串 body 只保留已有副本，绝不重建带认证头的 Request。
        if (typeof init?.body === 'string' && Buffer.byteLength(init.body) <= 64 * 1024) bodyText = init.body
        else if (input instanceof globalThis.Request && init?.body === undefined) requestClone = input.clone()
      }
    } catch {
      // 不可观察的输入仍交给原 fetch 决定其业务结果，不能由观察器改写异常。
    }
    const response = await originalFetch(input, init)
    if (!matches || response.ok || observedCount >= 5) {
      if (requestClone?.body) {
        // 成功请求不留下观察副本；取消克隆的排空由本次 finally 等待。
        const cleanup = requestClone.body.cancel().catch(() => { /* 克隆取消失败不改变原响应。 */ })
        pending.add(cleanup)
        void cleanup.finally(() => { /* 结束的克隆不再占用排空集合。 */ pending.delete(cleanup) })
      }
      return response
    }
    observedCount += 1
    let responseClone: Response
    try { responseClone = response.clone() }
    catch {
      // 连克隆都不可取得时仍原样交还响应，不能让观察器改变真实失败。
      artifacts.summary.rejectedProposalObservationFailed = true
      return response
    }
    const observation = (async (): Promise<void> => {
      // 只观察失败响应；并行读取克隆让原调用者立即继续使用原响应。
      let proposal: unknown
      if (bodyText === undefined) proposal = await liveReadLimitedJson(requestClone?.body ?? null)
      else {
        try { proposal = JSON.parse(bodyText) }
        catch { /* 不合法请求正文也保留后端真实错误，不尝试修正或重发。 */ }
      }
      const reply: unknown = await liveReadLimitedJson(responseClone.body)
      const captured: Record<string, unknown> = { at: new Date().toISOString(), status: response.status }
      if (proposal && typeof proposal === 'object') {
        for (const key of ['kind', 'reason', 'outputs', 'selection', 'slots', 'id', 'mapId', 'runId', 'operationId', 'workId', 'specHash']) {
          // 仅保留本次提案业务字段；不保存请求对象、headers、授权 proof 或任意附加字段。
          if (Object.prototype.hasOwnProperty.call(proposal, key)) captured[key] = Reflect.get(proposal, key)
        }
      }
      if (reply && typeof reply === 'object' && 'error' in reply && reply.error && typeof reply.error === 'object') {
        const error: { code?: string; message?: string } = {}
        if ('code' in reply.error && typeof reply.error.code === 'string') error.code = reply.error.code.slice(0, 80)
        if ('message' in reply.error && typeof reply.error.message === 'string') error.message = reply.error.message.slice(0, 4096)
        captured.error = error
      }
      rejected.push(captured)
      artifacts.summary.rejectedProposalCount = rejected.length
      await liveWriteJson(path.join(artifacts.directory, 'rejected-proposals.json'), rejected)
    })().catch(() => {
      // 观察或私有文件写入失败只留标记；禁止覆盖原 fetch 的响应或产生额外模型调用。
      artifacts.summary.rejectedProposalObservationFailed = true
    })
    pending.add(observation)
    void observation.finally(() => { /* 当前观察结束后从本轮排空集合移除。 */ pending.delete(observation) })
    return response
  }
  globalThis.fetch = observedFetch
  return async (): Promise<void> => {
    // Host 完成关闭后恢复原 fetch，再等待已开始的有限私有观察落盘。
    globalThis.fetch = originalFetch
    await Promise.all(pending)
  }
}

function liveCreateReporter(
  /* 本次演示独占的有界诊断数组。 */ artifacts: LiveArtifacts,
): DiagnosticReporter {
  // 复用正式脱敏器保存错误类型和去首行调用栈；禁止保存 message、reason 或原始 CLI 内容。
  const instanceId = randomUUID()
  const workFailures: Array<{ name: string; context: LiveDiagnostic['context']; failure: NonNullable<LiveDiagnostic['failure']> }> = []
  artifacts.summary.workFailures = workFailures
  return {
    report(/* 正式运行时发出的诊断，原始错误只交既有脱敏器。 */ event): string {
      const encoded = diagnosticReadLine('codex-live', instanceId, event)
      const decoded: unknown = JSON.parse(encoded.line)
      let failure: LiveDiagnostic['failure']
      if (decoded && typeof decoded === 'object' && 'failure' in decoded
        && decoded.failure && typeof decoded.failure === 'object') {
        const value = decoded.failure
        failure = {}
        if ('type' in value && typeof value.type === 'string') failure.type = value.type
        if ('code' in value && typeof value.code === 'string') failure.code = value.code
        if ('stack' in value && Array.isArray(value.stack) && value.stack.every(
          /* 正式脱敏器生成的栈帧。 */ frame => /* 只保留字符串帧，不接收任意对象。 */ typeof frame === 'string',
        )) failure.stack = value.stack
        const message: unknown = event.error instanceof Error ? Reflect.getOwnPropertyDescriptor(event.error, 'message')?.value : undefined
        const prefix = typeof message === 'string' ? /^([A-Z][A-Z0-9_]{1,79}):/.exec(message) : null
        if (prefix) failure.code = prefix[1]
      }
      const context: LiveDiagnostic['context'] = {}
      for (const key of ['mapId', 'runId', 'operationId', 'workId', 'phase'] as const) {
        const value = event.context?.[key]
        if (value !== undefined) context[key] = value
      }
      if (artifacts.diagnostics.length < 2000) artifacts.diagnostics.push({ at: new Date().toISOString(), name: event.name, severity: event.severity, context, failure })
      if (failure && workFailures.length < 100) workFailures.push({ name: event.name, context, failure })
      return encoded.errorId
    },
    async close(): Promise<void> {
      // 只由主流程在 Host 结束后保存本数组；这里没有需要排空的异步输出。
    },
  }
}

function liveRecordExecution(
  /* 本次演示私有的有界摘要数组。 */ artifacts: LiveArtifacts,
  /* Host 已关联工作身份的真实执行事件，不保存 holder 或 fence。 */ event: HostExecutionEvent,
): void {
  // 只接受 Codex 两种固定证据；其余模型事件、正文和参数完全不持久化。
  if (!['codex.exec.started', 'codex.exec.accepted'].includes(event.event.method)) return
  const params = event.event.params
  if (params.workId !== event.workId || params.model !== MODEL) return
  const context: LiveDiagnostic['context'] = { workId: event.workId, model: MODEL }
  if (params.threadId === null || typeof params.threadId === 'string' && params.threadId.length <= 160) context.threadId = params.threadId
  if (artifacts.diagnostics.length < 2000) artifacts.diagnostics.push({ at: new Date().toISOString(), name: event.event.method, severity: 'info', context })
}

async function liveCreateWeb(
  /* 本次 SQLite API 的固定回环地址。 */ apiUrl: string,
  /* 隔离目录和显式新端口，永不使用 5173。 */ input: { directory: string; port: number },
): Promise<ViteDevServer> {
  // Vite 读取仓库配置时临时选择 Web 装配；配置完成后恢复此进程环境。
  const oldWeb = process.env.CHONGMING_WEB
  const oldApi = process.env.CHONGMING_GRAPH_API
  process.env.CHONGMING_WEB = '1'
  process.env.CHONGMING_GRAPH_API = apiUrl
  try {
    return await createServer({ configFile: path.resolve('vite.config.ts'), cacheDir: path.join(input.directory, 'vite-cache'),
      logLevel: 'silent', clearScreen: false, plugins: [workspaceCreateStaticDocumentPlugin()],
      server: { host: '127.0.0.1', port: input.port, strictPort: false,
        proxy: { '/api/v1': { target: apiUrl, changeOrigin: true, followRedirects: false } } } })
  } finally {
    if (oldWeb === undefined) delete process.env.CHONGMING_WEB
    else process.env.CHONGMING_WEB = oldWeb
    if (oldApi === undefined) delete process.env.CHONGMING_GRAPH_API
    else process.env.CHONGMING_GRAPH_API = oldApi
  }
}

async function liveLogin(
  /* 本次隔离浏览器的普通页面。 */ page: Page,
  /* 本次 Vite 回环地址。 */ webUrl: string,
  /* 仅填入页面内存的本次用户令牌，不进入日志或截图。 */ token: string,
): Promise<void> {
  // 页面与独立 API 客户端分别认证；不读取或注入 Vue 状态。
  await page.goto(webUrl)
  await page.getByText('使用访问令牌', { exact: true }).click()
  await page.getByLabel('服务地址', { exact: true }).fill(webUrl)
  await page.getByLabel('用户访问令牌', { exact: true }).fill(token)
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
}

async function liveCreateNode(
  /* 用户实际操作的页面。 */ page: Page,
  /* 仅用于独立读取结果的公共 API 客户端。 */ gateway: ReturnType<typeof clientCreateGateway>,
  /* 当前页面刚创建的数据图身份。 */ mapId: string,
  /* 正式默认包中两种输入类型之一。 */ type: 'news' | 'claim',
  /* 本次明确提供的短新闻或单事实正文。 */ content: string,
): Promise<GraphNode> {
  // 创建动作全部通过可见表单；独立查询只核对最终保存身份与正文。
  await page.getByRole('button', { name: '＋ 数据', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加数据', exact: true })
  await dialog.getByRole('combobox', { name: /^数据类型/ }).selectOption(`factcheck.${type}@1`)
  await dialog.getByRole('group', { name: '正文', exact: true }).getByRole('textbox').fill(content)
  if (type === 'news') {
    const context = dialog.getByRole('group', { name: '上下文', exact: true })
    await context.getByRole('button', { name: '＋ 添加字段', exact: true }).click()
    await context.getByRole('textbox', { name: '字段名称', exact: true }).fill('参考资料')
    await context.getByRole('textbox', { name: '字段名称', exact: true }).press('Tab')
    await context.getByRole('group', { name: '内容', exact: true }).getByRole('textbox')
      .fill(`${REFERENCE_CONTENT}\n来源：${REFERENCE_URL}\n${REFERENCE_BOUNDARY}`)
    await context.getByRole('checkbox', { name: '允许 AI 使用', exact: true }).check()
  }
  await dialog.getByRole('button', { name: '添加数据', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const snapshot = await gateway.read('map.get', { mapId })
  const nodes = snapshot.nodes.filter(
    /* API 返回的正式数据节点。 */ node => /* 匹配实际类型和完整输入正文，不按数组顺序猜测。 */ node.typeId === `factcheck.${type}` && node.payload.content === content,
  )
  const node = nodes[0]
  liveRequire(nodes.length === 1 && node, LiveMessage.NODE_MISSING)
  liveRequire(node.revision === 0 && !node.producer && node.manualOrigin, LiveMessage.NODE_MISSING)
  if (type === 'news') {
    const context = node.payload.context
    liveRequire(context && typeof context === 'object' && !Array.isArray(context), LiveMessage.NODE_MISSING)
    const reference = context.参考资料
    liveRequire(reference && typeof reference === 'object' && !Array.isArray(reference)
      && reference.visibleToAI === true && typeof reference.value === 'string'
      && reference.value.includes(REFERENCE_CONTENT) && reference.value.includes(REFERENCE_BOUNDARY), LiveMessage.NODE_MISSING)
  }
  return node
}

async function liveSetScopeNode(
  /* 当前可见步骤的具体输入或上下文端口。 */ port: Locator,
  /* 本次应当进入端口的唯一正式节点。 */ nodeId: string,
): Promise<void> {
  // 先清空该端口默认勾选，再明确选中唯一节点，不借用内部表单数据。
  const checkboxes = port.getByRole('checkbox')
  for (let index = 0; index < await checkboxes.count(); index += 1) await checkboxes.nth(index).uncheck()
  await port.getByRole('checkbox', { name: new RegExp(nodeId) }).check()
}

async function liveConfigureRun(
  /* 正常页面；只有最终确认按钮会启动模型工作。 */ page: Page,
  /* 单事实或两步新闻演示。 */ phase: LivePhase,
  /* 已保存的原新闻。 */ news: GraphNode,
  /* 单事实阶段的输入；新闻链由前步正式输出产生事实。 */ claim: GraphNode | null,
): Promise<Locator> {
  // 两阶段共用正式统一表单；后步通过公开选项值绑定前步 claims 端口。
  await page.getByRole('button', { name: '运行转换', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '运行数据转换', exact: true })
  const first = dialog.getByRole('region', { name: '步骤 1', exact: true })
  await first.getByRole('combobox', { name: '转换', exact: true })
    .selectOption(phase === 'claim' ? 'factcheck.verify-claim@1' : 'factcheck.split-news@1')
  if (phase === 'claim') {
    liveRequire(claim, LiveMessage.NODE_MISSING)
    await liveSetScopeNode(first.getByRole('group', { name: '输入端口 claim', exact: true }), claim.id)
    await liveSetScopeNode(first.getByRole('group', { name: '上下文端口 news', exact: true }), news.id)
  } else {
    await liveSetScopeNode(first.getByRole('group', { name: '输入端口 news', exact: true }), news.id)
    await dialog.getByRole('button', { name: '添加步骤', exact: true }).click()
    const second = dialog.getByRole('region', { name: '步骤 2', exact: true })
    await second.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.verify-claim@1')
    const source = second.getByRole('combobox', { name: '来源 claim', exact: true })
    const priorOutput = source.locator('option').filter({ hasText: /^步骤 1 .*claims$/ })
    await expect(priorOutput).toHaveCount(1)
    const value = await priorOutput.getAttribute('value')
    liveRequire(value, LiveMessage.PIPELINE_MISMATCH)
    await source.selectOption(value)
    await second.getByRole('combobox', { name: '分组方式', exact: true }).selectOption({ label: '逐个' })
    await liveSetScopeNode(second.getByRole('group', { name: '上下文端口 news', exact: true }), news.id)
  }
  await dialog.getByRole('combobox', { name: '处理方式', exact: true }).selectOption('auto')
  await dialog.getByRole('checkbox', { name: '重新生成已有结果', exact: true }).uncheck()
  await expect(dialog.getByRole('button', { name: '开始处理', exact: true })).toBeEnabled()
  return dialog
}

async function liveWaitForRun(
  /* 独立公共 API 客户端，不读取页面计算出的运行状态。 */ gateway: ReturnType<typeof clientCreateGateway>,
  /* 已由页面实际创建的运行身份。 */ input: { mapId: string; runId: string; timeoutMs: number },
  /* 根进程拥有的停止信号，finally 会关闭 Host 并等待子进程结束。 */ signal: AbortSignal,
  /* 只记录有限状态和最后读取，不保存任意进程信息。 */ artifacts: LiveArtifacts,
): Promise<GraphRun> {
  // 轮询只读事实状态；不重发启动命令，也不重试失败的真实模型工作。
  const deadline = Date.now() + input.timeoutMs
  let previous = ''
  let completedAt: number | null = null
  while (Date.now() < deadline) {
    if (signal.aborted) throw new LiveCheckError(LiveMessage.INTERRUPTED)
    const run = await gateway.read('run.get', { mapId: input.mapId, runId: input.runId }, signal)
    const progress = { status: run.status, operations: run.operations.length,
      acceptedWorkCount: run.operations.flatMap(
        /* 保存的运行处理项。 */ operation => /* accepted result 是后端事实，不是 CLI 退出码。 */ operation.stages.flatMap(
          /* 保存的阶段。 */ stage => /* 每项结果对应一份已接受提案。 */ stage.results,
        ),
      ).length }
    artifacts.summary.progress = progress
    const current = JSON.stringify(progress)
    if (current !== previous) { process.stdout.write(`${current}\n`); previous = current }
    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new LiveCheckError(LiveMessage.RUN_FAILED, { runId: run.id, status: run.status, code: run.error?.code, workId: run.error?.workId })
    }
    if (run.status === 'completed') {
      // 数据库完成与 Host 的接受回调是相邻异步观察；只等原工作的诊断到达，不重跑业务。
      completedAt ??= Date.now()
      const workIds = run.operations.flatMap(
        /* 已完成的实际处理项。 */ operation => /* 每份正式 accepted result 都需要同工作 CLI 证据。 */ operation.stages.flatMap(
          /* 已完成阶段。 */ stage => /* 保留实际结果对应工作。 */ stage.results.map(
            /* 已接纳结果。 */ result => /* 不把候选数量当工作数。 */ result.workId,
          ),
        ),
      )
      const hasEvidence = workIds.every(
        /* 原工作身份。 */ workId => /* 等待真实执行器已确认后端接纳的回调。 */ artifacts.diagnostics.some(
          /* 只保存固定字段的真实执行事件。 */ event => /* 工作身份必须相同。 */ event.name === 'codex.exec.accepted' && event.context.workId === workId,
        ),
      )
      if (hasEvidence) return run
      liveRequire(Date.now() - completedAt < 10_000, LiveMessage.CLI_EVIDENCE_MISSING, { runId: run.id })
    }
    await delay(1000, undefined, { signal })
  }
  throw new LiveCheckError(LiveMessage.RUN_NOT_COMPLETED, { runId: input.runId, timeoutMs: input.timeoutMs })
}

function liveVerifyOperation(
  /* 单份实际完成的 Operation。 */ operation: GraphOperation,
  /* 对应的完整冻结 Run。 */ run: GraphRun,
  /* 独立查询的正式图节点和边。 */ snapshot: GraphSnapshot,
): void {
  // 冻结规格、实际接受的工作与正式产物必须能逐项关联。
  liveRequire(operation.status === 'completed' && operation.specHash === operation.executionSpec.specHash, LiveMessage.SPEC_MISMATCH)
  for (const stage of operation.executionSpec.stages) {
    liveRequire(stage.agent.profile.provider === 'openai' && stage.agent.profile.model === MODEL
      && stage.agent.profile.tools.length === 0 && stage.tools.length === 0, LiveMessage.SPEC_MISMATCH)
    for (const candidate of stage.plan?.agents ?? []) {
      liveRequire(candidate.profile.provider === 'openai' && candidate.profile.model === MODEL
        && candidate.profile.tools.length === 0, LiveMessage.SPEC_MISMATCH)
    }
  }
  for (const stage of operation.stages) {
    liveRequire(stage.closed && stage.results.length === stage.expectedWorkIds.length, LiveMessage.OUTPUT_MISMATCH)
    for (const result of stage.results) {
      liveRequire(stage.expectedWorkIds.includes(result.workId) && result.acceptedAt && result.stageId === stage.stageId,
        LiveMessage.OUTPUT_MISMATCH)
    }
  }
  for (const ref of operation.outputRefs) {
    const node = snapshot.nodes.find(
      /* 当前图的正式节点。 */ item => /* 只按服务端分配的实际输出身份关联。 */ item.id === ref.id,
    )
    liveRequire(node && node.revision === ref.revision && node.producer?.operationId === operation.id
      && node.producer.workId === ref.workId, LiveMessage.OUTPUT_MISMATCH)
    const producer = node.producer
    const agent = run.agents.find(
      /* 本轮冻结的精确 Agent 配置。 */ item => /* 不能拿当前目录名称替代当时执行者。 */ item.ref.id === producer.agentRef.id && item.ref.version === producer.agentRef.version,
    )
    liveRequire(agent?.profile.provider === 'openai' && agent.profile.model === MODEL && agent.profile.tools.length === 0,
      LiveMessage.SPEC_MISMATCH)
    liveRequire(operation.stages.some(
      /* 正式产物来源所属的已接受阶段。 */ stage => /* selection 产物仍应指向实际生成候选的工作。 */ stage.stageId === producer.stageId && stage.results.some(
        /* 后端保存的一份提案结果。 */ result => /* 与正式 producer.workId 严格相等。 */ result.workId === producer.workId,
      ),
    ), LiveMessage.OUTPUT_MISMATCH)
  }
}

function liveVerifyResults(
  /* 本次显式选择的演示阶段。 */ phase: LivePhase,
  /* 保存的完整运行。 */ run: GraphRun,
  /* 独立 API 读取的最终图。 */ snapshot: GraphSnapshot,
  /* 用户通过页面创建的原新闻。 */ news: GraphNode,
  /* 单事实阶段由页面创建的原 Claim。 */ claim: GraphNode | null,
  /* 真实执行器的安全诊断摘要。 */ diagnostics: LiveDiagnostic[],
): Record<string, unknown> {
  // 不固定真实拆分数量、评分或理由；只要求所有实际正式 Claim 形成可追溯闭环。
  liveRequire(run.mode === 'auto' && !run.regenerate && run.tools.length === 0 && !run.paused, LiveMessage.SPEC_MISMATCH)
  for (const input of [news, ...(claim ? [claim] : [])]) {
    // 运行只能增加正式产物，不能改写用户通过页面保存的原新闻和单事实。
    const saved = snapshot.nodes.find((/* 最终图中的正式节点。 */ node) => /* 以原输入的稳定身份查找。 */ node.id === input.id)
    liveRequire(isDeepStrictEqual(saved, input), LiveMessage.OUTPUT_MISMATCH)
  }
  liveRequire(run.plan.steps.length === (phase === 'claim' ? 1 : 2), LiveMessage.PIPELINE_MISMATCH)
  const verifyStep = run.plan.steps.find(
    /* 页面保存的有限步骤。 */ step => /* 精确默认转换身份，不按标题猜测。 */ step.transitionRef.id === 'factcheck.verify-claim' && step.transitionRef.version === 1,
  )
  liveRequire(verifyStep, LiveMessage.PIPELINE_MISMATCH)
  const verifyOperations = run.operations.filter(
    /* 本次实际处理项。 */ operation => /* 只收集核查步骤的正式处理。 */ operation.stepId === verifyStep.id,
  )
  let claims: GraphNode[]
  if (phase === 'news') {
    const splitStep = run.plan.steps[0]
    liveRequire(splitStep && splitStep.transitionRef.id === 'factcheck.split-news', LiveMessage.PIPELINE_MISMATCH)
    liveRequire(verifyStep.dependsOn.length === 1 && verifyStep.dependsOn[0] === splitStep.id
      && verifyStep.input.length === 1 && verifyStep.input[0]?.source.kind === 'step'
      && verifyStep.input[0].source.stepId === splitStep.id && verifyStep.input[0].source.port === 'claims', LiveMessage.PIPELINE_MISMATCH)
    const splitOperations = run.operations.filter(
      /* 实际保存的拆分处理。 */ operation => /* 原新闻单输入只应有一个处理项。 */ operation.stepId === splitStep.id,
    )
    liveRequire(splitOperations.length === 1, LiveMessage.PIPELINE_MISMATCH)
    const outputIds = splitOperations.flatMap(
      /* 第一步完成并发布的处理。 */ operation => /* 后步只能消费 claims 端口正式身份。 */ operation.outputRefs.filter(
        /* 一个正式产物引用。 */ ref => /* 不把其它端口或候选键混入。 */ ref.port === 'claims',
      ).map((/* 已发布引用。 */ ref) => /* 保留正式节点 ID。 */ ref.id),
    ).sort()
    const consumedIds = verifyOperations.flatMap(
      /* 按各事实独立核查的处理。 */ operation => /* 直接核对保存 inputRefs，不以正文相似代替。 */ operation.group.inputRefs.map(
        /* 实际冻结输入引用。 */ ref => /* 取得正式节点身份。 */ ref.id,
      ),
    ).sort()
    liveRequire(outputIds.length > 0 && JSON.stringify(outputIds) === JSON.stringify(consumedIds), LiveMessage.PIPELINE_MISMATCH)
    claims = outputIds.map(
      /* 拆分正式输出身份。 */ id => {
        // 未发布或错类型不能当作下一步的事实。
        const node = snapshot.nodes.find((/* 图中正式节点。 */ item) => /* 与输出身份一致。 */ item.id === id)
        liveRequire(node?.typeId === 'factcheck.claim' && node.typeVersion === 1, LiveMessage.OUTPUT_MISMATCH)
        liveRequire(snapshot.edges.some((/* 保存的结构或引用边。 */ edge) => /* 原新闻与实际事实的结构来源。 */ edge.kind === 'successor' && edge.from === news.id && edge.to === id), LiveMessage.OUTPUT_MISMATCH)
        return node
      },
    )
  } else {
    liveRequire(claim, LiveMessage.NODE_MISSING)
    claims = [claim]
  }
  liveRequire(verifyOperations.length === claims.length, LiveMessage.PIPELINE_MISMATCH)
  if (phase === 'news') codexLiveAssertBranching(run, snapshot, news.id)
  for (const operation of run.operations) liveVerifyOperation(operation, run, snapshot)
  const acceptedWorkIds = run.operations.flatMap(
    /* 运行中实际执行的处理项。 */ operation => /* 汇总后端已接纳工作。 */ operation.stages.flatMap(
      /* 真实阶段结果。 */ stage => /* 每个结果保留同一工作身份。 */ stage.results.map(
        /* 已接纳的提案结果。 */ result => /* 不读取 CLI 原始内容。 */ result.workId,
      ),
    ),
  )
  for (const workId of acceptedWorkIds) {
    const starts = diagnostics.filter(
      /* 真实执行器发出的白名单摘要。 */ event => /* 每份新工作只实际启动一轮 CLI。 */ event.name === 'codex.exec.started' && event.context.workId === workId,
    )
    const accepted = diagnostics.filter(
      /* 真实执行器发出的白名单摘要。 */ event => /* 接纳证据必须对应同一份正式工作。 */ event.name === 'codex.exec.accepted' && event.context.workId === workId,
    )
    liveRequire(starts.length === 1 && accepted.length === 1,
      LiveMessage.CLI_EVIDENCE_MISSING, { workId, startedCount: starts.length, acceptedCount: accepted.length })
  }
  for (const input of claims) {
    const operation = verifyOperations.find(
      /* 一项实际核查处理。 */ item => /* 每个 Claim 恰为本处理的唯一结构输入。 */ item.group.inputRefs.length === 1 && item.group.inputRefs[0]?.id === input.id,
    )
    liveRequire(operation && operation.group.contextRefs.some(
      /* 冻结的只读背景引用。 */ ref => /* 参考材料来自页面保存的原 News。 */ ref.port === 'news' && ref.id === news.id && ref.revision === news.revision,
    ), LiveMessage.PIPELINE_MISMATCH)
    const outputs = snapshot.nodes.filter(
      /* 独立读取的正式节点。 */ node => /* 仅属于这一核查处理，不拿其它 Claim 的结论凑数。 */ node.producer?.operationId === operation.id,
    )
    const opinions = outputs.filter((/* 本处理的正式产物。 */ node) => /* 实际意见数量由本次路由决定。 */ node.typeId === 'factcheck.opinion')
    const verifications = outputs.filter((/* 本处理的正式产物。 */ node) => /* 每个默认核查处理只发布一个结论。 */ node.typeId === 'factcheck.verification')
    const verification = verifications[0]
    liveRequire(opinions.length > 0 && verifications.length === 1 && verification, LiveMessage.OUTPUT_MISMATCH)
    const opinionIds = opinions.map((/* 已保存的意见节点。 */ node) => /* 结论只能引用当前处理真正发布的意见。 */ node.id).sort()
    liveRequire(Array.isArray(verification.payload.opinionIds)
      && JSON.stringify([...verification.payload.opinionIds].sort()) === JSON.stringify(opinionIds), LiveMessage.OUTPUT_MISMATCH)
    for (const opinion of opinions) {
      liveRequire(snapshot.edges.some((/* 保存的真实关系。 */ edge) => /* Claim 到核查意见。 */ edge.kind === 'successor' && edge.from === input.id && edge.to === opinion.id), LiveMessage.OUTPUT_MISMATCH)
      liveRequire(snapshot.edges.some((/* 保存的真实关系。 */ edge) => /* 意见到引用它的核查结论。 */ edge.kind === 'successor' && edge.from === opinion.id && edge.to === verification.id), LiveMessage.OUTPUT_MISMATCH)
    }
  }
  return { runId: run.id, mode: run.mode, plan: run.plan, acceptedWorkIds,
    operationCount: run.operations.length, claimCount: claims.length,
    operations: run.operations.map((/* 保存的正式处理。 */ operation) => /* 摘要仅保留身份和冻结关系。 */ ({ id: operation.id, stepId: operation.stepId,
      transitionRef: operation.transitionRef, specHash: operation.specHash, inputRefs: operation.group.inputRefs,
      contextRefs: operation.group.contextRefs, outputRefs: operation.outputRefs,
      stages: operation.stages.map((/* 已接纳阶段。 */ stage) => /* 不复制完整候选或提示词。 */ ({ stageId: stage.stageId,
        angles: stage.planSlots.map((/* 本阶段实际批准的槽位。 */ slot) => /* 保留有限角度便于核对两个职责，省略完整hint。 */ ({ slotId: slot.id, agentRef: slot.agentRef, angle: slot.angle.slice(0, 240) })),
        results: stage.results.map((/* 已接受工作。 */ result) => /* 已保存时间可与真实执行诊断关联。 */ ({ workId: result.workId, mode: result.mode, acceptedAt: result.acceptedAt })) })) })),
    nodes: snapshot.nodes.map((/* 用户输入或正式模型产物。 */ node) => /* 短预览便于审查，完整正文保留在私有 SQLite 与正常页面。 */ ({ id: node.id, typeId: node.typeId,
      revision: node.revision, producer: node.producer, contentPreview: typeof node.payload.content === 'string' ? node.payload.content.slice(0, 400) : undefined,
      score: node.payload.score, reasonPreview: typeof node.payload.reason === 'string' ? node.payload.reason.slice(0, 700) : undefined,
      opinionIds: node.payload.opinionIds })),
    edges: snapshot.edges.map((/* 保存的结构或引用关系。 */ edge) => /* 只记录必要身份，不输出任意附加正文。 */ ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to })) }
}

async function liveRun(
  /* 已验证的显式执行选项。 */ options: LiveOptions,
): Promise<void> {
  // 本函数独占运行时、页面和信号；退出时等待真实 Host 子进程结束，数据目录保留供复核。
  await mkdir(path.resolve('test-results'), { recursive: true })
  const directory = await mkdtemp(path.resolve('test-results', `105-codex-live-${options.phase}-`))
  await chmod(directory, 0o700)
  const artifacts: LiveArtifacts = { directory, diagnostics: [], summary: { phase: options.phase, model: MODEL, provider: 'openai',
    referenceUrl: REFERENCE_URL, referenceBoundary: REFERENCE_BOUNDARY, startedAt: new Date().toISOString(), status: 'running' } }
  const reporter = liveCreateReporter(artifacts)
  const closeObservation = liveObserveRejectedProposals(artifacts)
  const controller = new AbortController()
  let runtime: Awaited<ReturnType<typeof localCreateRuntime>> | undefined
  let web: ViteDevServer | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let loggedIn = false
  let gateway: ReturnType<typeof clientCreateGateway> | undefined
  function stop(): void {
    // 首次停止信号只取消本次演示，实际资源仍由 finally 排空。
    controller.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    artifacts.summary.action = 'initialize-isolated-runtime'
    runtime = await localCreateRuntime({ directory: path.join(directory, 'runtime'), port: 0, executor: 'codex',
      codexBin: options.codexBin, concurrency: 1, seedConfiguration: liveCreateSeed(), reporter,
      onEvent: (/* 已由同一 Host 关联实际工作身份的事件。 */ event: HostExecutionEvent): void => {
        // 仅保存固定的启动与接纳关联证据，不保存事件的任意 payload。
        liveRecordExecution(artifacts, event)
      } })
    web = await liveCreateWeb(runtime.baseUrl, { directory, port: options.webPort })
    await web.listen()
    const address = web.httpServer?.address()
    liveRequire(address && typeof address !== 'string' && address.port !== 5173, LiveMessage.VITE_NOT_LISTENING)
    const webUrl = `http://127.0.0.1:${address.port}`
    Object.assign(artifacts.summary, { webUrl, apiUrl: runtime.baseUrl, workspaceId: runtime.workspaceId, tokenFile: runtime.tokenPath })
    await liveWriteJson(path.join(directory, 'summary.json'), artifacts.summary)
    process.stdout.write(`${JSON.stringify({ phase: options.phase, artifacts: directory, webUrl, model: MODEL })}\n`)
    gateway = clientCreateGateway({ baseUrl: runtime.baseUrl, timeoutMs: 15_000 })
    await gateway.connect({ baseUrl: runtime.baseUrl, token: runtime.userToken, remember: false })
    browser = await chromium.launch({ headless: !options.headed })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    page.setDefaultTimeout(15_000)
    artifacts.summary.action = 'page-login'
    await liveLogin(page, webUrl, runtime.userToken)
    loggedIn = true
    artifacts.summary.action = 'page-create-map'
    await page.getByRole('button', { name: '创建第一张数据图', exact: true }).click()
    const mapDialog = page.getByRole('dialog', { name: '创建数据图', exact: true })
    const mapName = options.phase === 'claim' ? '真实 Codex · 单事实资料核查' : '真实 Codex · 新闻拆分与逐条核查'
    await mapDialog.getByLabel('数据图名称', { exact: true }).fill(mapName)
    await mapDialog.getByRole('button', { name: '创建数据图', exact: true }).click()
    await expect(mapDialog).not.toBeVisible()
    const maps = await gateway.read('map.list', { workspaceId: runtime.workspaceId })
    const map = maps[0]
    liveRequire(maps.length === 1 && map?.name === mapName, LiveMessage.MAP_MISSING)
    artifacts.summary.mapId = map.id
    artifacts.summary.action = 'page-create-news-and-reference-materials'
    const news = await liveCreateNode(page, gateway, map.id, 'news', NEWS_CONTENT)
    artifacts.summary.action = 'page-create-single-claim'
    const claim = options.phase === 'claim' ? await liveCreateNode(page, gateway, map.id, 'claim', CLAIM_CONTENT) : null
    const starts: string[] = []
    page.on('request', (/* 正常页面发出的公共 API 请求，仅记录方法名。 */ request: Request): void => {
      // 不读取 Authorization 或完整请求体；确保只有明确确认才启动工作。
      if (!request.url().endsWith('/api/v1/command') || request.method() !== 'POST') return
      const value: unknown = request.postDataJSON()
      if (value && typeof value === 'object' && 'method' in value && value.method === 'run.start') starts.push('run.start')
    })
    artifacts.summary.action = 'page-configure-run'
    const dialog = await liveConfigureRun(page, options.phase, news, claim)
    const startsBeforeConfirm = starts.length
    liveRequire(startsBeforeConfirm === 0 && (await gateway.read('map.get', { mapId: map.id })).runs.length === 0, LiveMessage.START_NOT_CONFIRMED)
    const planScreenshot = path.join(directory, 'configured-plan.png')
    await page.screenshot({ path: planScreenshot, fullPage: true })
    await chmod(planScreenshot, 0o600)
    artifacts.summary.action = 'page-confirm-run'
    await dialog.getByRole('button', { name: '开始处理', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    const started = await gateway.read('map.get', { mapId: map.id })
    const initialRun = started.runs[0]
    liveRequire(starts.length === 1 && started.runs.length === 1 && initialRun, LiveMessage.START_NOT_CONFIRMED)
    artifacts.summary.runId = initialRun.id
    artifacts.summary.plan = initialRun.plan
    artifacts.summary.action = 'wait-real-host-and-codex'
    const run = await liveWaitForRun(gateway, { mapId: map.id, runId: initialRun.id, timeoutMs: options.timeoutMs }, controller.signal, artifacts)
    const snapshot = await gateway.read('map.get', { mapId: map.id })
    artifacts.summary.action = 'independent-api-verification'
    const verified = liveVerifyResults(options.phase, run, snapshot, news, claim, artifacts.diagnostics)
    artifacts.summary.action = 'page-show-all-saved-nodes'
    const labels = page.locator('.scene-label')
    await expect(labels).toHaveCount(snapshot.nodes.length)
    for (let index = 0; index < snapshot.nodes.length; index += 1) {
      // 等待真实页面自动取景，不能点击“适应”或借用内部相机状态掩盖初次展示问题。
      await expect(labels.nth(index)).toBeInViewport({ ratio: 1 })
    }
    const finalScreenshot = path.join(directory, 'saved-results.png')
    await page.screenshot({ path: finalScreenshot, fullPage: true })
    await chmod(finalScreenshot, 0o600)
    Object.assign(artifacts.summary, { status: 'passed', completedAt: new Date().toISOString(), verified })
    await liveWriteJson(path.join(directory, 'summary.json'), artifacts.summary)
    await liveWriteJson(path.join(directory, 'diagnostics.json'), artifacts.diagnostics)
    process.stdout.write(`${JSON.stringify({ status: 'passed', phase: options.phase, runId: run.id, artifacts: directory, webUrl })}\n`)
    if (options.keepOpen && !controller.signal.aborted) {
      process.stdout.write('本次隔离预览保持运行；发送 SIGINT 或 SIGTERM 后关闭自有进程，保存数据保留。\n')
      await new Promise<void>((/* 停止信号到来后允许主流程释放资源。 */ resolve) => {
        // 注册前后检查一次信号，避免检查与订阅之间丢失停止事件。
        controller.signal.addEventListener('abort', () => /* 不延迟正常关闭。 */ resolve(), { once: true })
        if (controller.signal.aborted) resolve()
      })
    }
  } catch (error) {
    const frame = error instanceof Error ? error.stack?.split('\n').slice(1).find(
      /* 去除首行后的有限调用帧。 */ line => /* 记录实际断言调用点，不只记录共用 liveRequire 的构造位置。 */ line.includes('codex-live.ts:') && !/\bat liveRequire\b/.test(line),
    ) : undefined
    const location = /codex-live\.ts:(\d+):(\d+)/.exec(frame ?? '')
    const scriptLocation = location ? { line: Number(location[1]), column: Number(location[2]) } : undefined
    const failure = error instanceof LiveCheckError ? { check: error.check, details: error.details, scriptLocation }
      : error instanceof CodexLiveBranchingError ? { check: error.check, scriptLocation }
      : { check: LiveMessage.UNEXPECTED_FAILURE, errorName: error instanceof Error ? error.name : 'Unknown',
        clientCode: error instanceof ClientError ? error.code : undefined,
        scriptLocation }
    Object.assign(artifacts.summary, { status: 'failed', stoppedAt: new Date().toISOString(), failure })
    if (loggedIn && page && !page.isClosed()) {
      // 不截登录表单；失败截图仅包含已登录的本次公开页面。
      try {
        if (await page.getByRole('button', { name: '退出登录', exact: true }).isVisible()) {
          const screenshot = path.join(directory, 'failure.png')
          await page.screenshot({ path: screenshot, fullPage: true })
          await chmod(screenshot, 0o600)
        }
      } catch {
        // 浏览器本身已结束时保留主失败，不能让次要截图错误覆盖它。
      }
    }
    process.stdout.write(`${JSON.stringify({ status: 'failed', phase: options.phase, artifacts: directory, failure })}\n`)
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    gateway?.close()
    const cleanupFailures: string[] = []
    for (const [name, close] of [
      ['browser', () => /* 关闭本次页面及其浏览器。 */ browser?.close()],
      ['web', () => /* 关闭本次 Vite，保留用户自己的服务。 */ web?.close()],
      ['runtime', () => /* Host 停止并排空子进程后才关闭 API 与 SQLite。 */ runtime?.close()],
      ['proposal-observation', () => /* 恢复原 fetch，并排空已经开始的拒绝提案观察。 */ closeObservation()],
    ] as const) {
      try { await close() }
      catch { cleanupFailures.push(name) }
    }
    if (cleanupFailures.length) {
      artifacts.summary.cleanup = { check: LiveMessage.CLEANUP_FAILED, resources: cleanupFailures }
      process.exitCode = 1
    }
    artifacts.summary.closedAt = new Date().toISOString()
    await reporter.close()
    await liveWriteJson(path.join(directory, 'summary.json'), artifacts.summary)
    await liveWriteJson(path.join(directory, 'diagnostics.json'), artifacts.diagnostics)
  }
}

async function liveMain(): Promise<void> {
  // 参数解析和执行失败都只输出受控字段，禁止默认打印任意错误堆栈。
  try {
    const options = liveReadOptions(process.argv.slice(2))
    if (!options) { process.stdout.write(`${USAGE}\n`); return }
    await liveRun(options)
  } catch (error) {
    const check = error instanceof LiveCheckError ? error.check : LiveMessage.UNEXPECTED_FAILURE
    process.stdout.write(`${JSON.stringify({ status: 'failed', check })}\n`)
    process.exitCode = 1
  }
}

void liveMain()
