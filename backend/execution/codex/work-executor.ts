// 可选Codex exec执行器：一份Work启动一个独立CLI，业务成功仍以原服务accepted收据为准。
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { DshEvent } from '../../../contracts/dsh'
import type { ModelWorkConfiguration } from '../../../contracts/model-connection'
import { WorkAccessError, workCreateModelEnvironment, workReadData, workReadModel, workReadProfile, workReadReply, workReadStatus, type WorkApiInput, type WorkRunResult } from '../work-api'
import { CODEX_OUTPUT_SCHEMA, codexReadPrompt, codexReadProposal } from './proposal'

export interface CodexWorkInput extends WorkApiInput {
  codexBin?: string
  workHome?: string
  processCwd?: string
  env?: Record<string, string | undefined>
  onEvent?: (event: DshEvent) => void
}
enum CodexWorkMessage {
  OPENAI_REQUIRED = 'Codex执行器要求冻结provider为openai，并明确指定模型。',
  TOOLS_UNSUPPORTED = '当前Codex执行器只支持没有外部工具的工作，未映射DSH工具。',
  CLI_FAILED = 'Codex执行进程未成功完成。',
  OUTPUT_INVALID = 'Codex最终结构化输出不存在、过大或无法读取。',
  NOT_ACCEPTED = 'Codex执行已结束，但原Work尚未被后端接纳。',
}
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DISABLED_FEATURES = ['shell_tool', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use', 'image_generation']
const CLI_ENV_NAMES = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TERM', 'SHELL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'USERPROFILE'])

export async function codexRunWork(
  /* Host已领取并负责续租的固定授权与本地CLI配置。 */ options: CodexWorkInput,
): Promise<WorkRunResult> {
  // 已接纳工作不重复推理；新的CLI结果只由宿主持原proof提交，不把模型退出0视为成功。
  const input = { ...options, grant: { ...options.grant } }, grant = input.grant
  const resultBase = { workId: grant.workId, mapId: grant.mapId, runId: grant.runId, operationId: grant.operationId, status: 'accepted' as const }
  input.signal?.throwIfAborted()
  if (await workReadStatus(input) === 'accepted') return { ...resultBase, sessionId: null, finalResponse: '' }
  const data = await workReadData(input), profile = workReadProfile(data)
  if (profile.provider !== 'openai' || !profile.model.trim()) throw new Error(CodexWorkMessage.OPENAI_REQUIRED)
  if (data.stage.tools.length) throw new Error(CodexWorkMessage.TOOLS_UNSUPPORTED)
  const modelConnection = await workReadModel(input, data)
  const prompt = codexReadPrompt(data)
  const root = path.resolve(input.workHome ?? input.processCwd ?? tmpdir())
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, 'chongming-codex-'))
  try {
    const execution = await runCli(input, modelConnection, prompt, directory)
    // 提供方或CLI异常回显密钥时拒绝整份产物，不能把它写入图或返回工作结果。
    if (execution.output.includes(modelConnection.apiKey)) throw new Error(CodexWorkMessage.OUTPUT_INVALID)
    const proposal = codexReadProposal(execution.output, data.outputContract.mode)
    if (containsKey(proposal, modelConnection.apiKey)) throw new Error(CodexWorkMessage.OUTPUT_INVALID)
    input.signal?.throwIfAborted()
    const headers = { 'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence) }
    let submitFailure: WorkAccessError | undefined
    try {
      await workReadReply<unknown>(input, '/internal/v1/data/propose', { ...proposal, mapId: grant.mapId,
        operationId: grant.operationId, id: data.proposalId, specHash: grant.specHash }, headers)
    } catch (cause) {
      // 仅访问/交付不明时查询同一Work；不重新启动CLI或生成另一提案。
      if (!(cause instanceof WorkAccessError)) throw cause
      submitFailure = cause
    }
    if (await workReadStatus(input) !== 'accepted') throw submitFailure ?? new Error(CodexWorkMessage.NOT_ACCEPTED)
    input.onEvent?.({ method: 'codex.exec.accepted', params: { workId: grant.workId, model: profile.model,
      threadId: execution.sessionId, ...(execution.usage ? { usage: execution.usage } : {}) } })
    return { ...resultBase, sessionId: execution.sessionId, finalResponse: execution.output }
  } finally {
    // runCli必须先结束自有进程，随后才删除这次尝试目录并交还Host。
    await rm(directory, { recursive: true, force: true })
  }
}

function containsKey(
  /* 仅检查即将提交的已解析业务值，不记录或转换它。 */ value: unknown,
  /* 本Work实际持有的模型密钥。 */ apiKey: string,
): boolean {
  // JSON可能转义密钥字符，必须在解码后递归检查，不能只搜索文件原始字节。
  if (typeof value === 'string') return value.includes(apiKey)
  if (Array.isArray(value)) return value.some(item => containsKey(item, apiKey))
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => key.includes(apiKey) || containsKey(item, apiKey))
}

async function runCli(
  /* 本工作独占的取消信号和本地可执行配置。 */ input: CodexWorkInput,
  /* 本工作私有端点交付的模型和API Key。 */ connection: ModelWorkConfiguration,
  /* 已按冻结变量展开的工作资料，只通过stdin交付。 */ prompt: string,
  /* 仅本次工作拥有的空执行目录。 */ directory: string,
): Promise<{ output: string; sessionId: string | null; usage: Record<string, number> | null }> {
  // 使用无shell独立进程；忽略用户配置并禁非必要能力，不修改全局配置或复制认证文件。
  const schemaPath = path.join(directory, 'result-schema.json'), outputPath = path.join(directory, 'result.json')
  await writeFile(schemaPath, JSON.stringify(CODEX_OUTPUT_SCHEMA), { mode: 0o600 })
  const codexHome = path.join(directory, 'codex-home')
  await mkdir(codexHome, { mode: 0o700 })
  input.signal?.throwIfAborted()
  const args = ['--no-daemon', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--json',
    '--output-schema', schemaPath, '-o', outputPath, '-m', connection.model, '-c', 'model_provider="chongming_work"',
    '-c', 'model_providers.chongming_work.name="Workspace model"',
    '-c', `model_providers.chongming_work.base_url=${JSON.stringify(connection.baseUrl)}`,
    '-c', 'model_providers.chongming_work.env_key="CHONGMING_MODEL_API_KEY"',
    '-c', 'model_providers.chongming_work.wire_api="responses"',
    '-c', 'model_providers.chongming_work.requires_openai_auth=false',
    '-c', 'model_providers.chongming_work.supports_websockets=false',
    '-c', 'model_reasoning_effort="low"', '-c', 'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap((/* 本版不需要的内置能力。 */ feature) => /* 使用官方本机probe已接受的显式关闭参数。 */ ['--disable', feature]), '-']
  const sourceEnv = workCreateModelEnvironment({ ...process.env, ...input.env }, connection)
  const env = { ...Object.fromEntries(Object.entries(sourceEnv).filter((/* 父进程的一项环境变量。 */ [name]) =>
    /* 不接纳旧CLI认证或缓存入口，只保留必要进程与传输环境。 */ CLI_ENV_NAMES.has(name.toUpperCase()) || name.startsWith('LC_'))),
    CHONGMING_MODEL_API_KEY: connection.apiKey, CODEX_HOME: codexHome }
  const child = spawn(input.codexBin ?? 'codex', args, { cwd: directory, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
  let failure: unknown, sessionId: string | null = null, pending = '', usage: Record<string, number> | null = null
  let forceClose: ReturnType<typeof setTimeout> | undefined
  const terminate = (): void => {
    // 只终止本次CLI；无daemon模式保证close可等待，超时才强制收尾同一进程。
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    forceClose ??= setTimeout(() => { /* 子进程不响应取消时只强制终止自有PID。 */ child.kill('SIGKILL') }, 2000)
    forceClose.unref()
  }
  const onAbort = (): void => { /* 原Host取消后先停进程，再由close结束本次执行。 */ terminate() }
  const readLine = (/* CLI标准JSONL的一行事件。 */ line: string): void => {
    // 只提取会话身份和固定活动阶段，不把模型正文/工具参数发到活动接口或日志。
    let event: unknown
    try { event = JSON.parse(line) } catch { return }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return
    if ('type' in event && event.type === 'thread.started' && 'thread_id' in event && typeof event.thread_id === 'string') {
      if (event.thread_id.includes(connection.apiKey)) throw new Error(CodexWorkMessage.OUTPUT_INVALID)
      sessionId = event.thread_id
    }
    if ('type' in event && event.type === 'turn.started') input.onEvent?.({ method: 'session.event', params: { event: { type: 'step/start' } } })
    if ('type' in event && event.type === 'turn.completed' && 'usage' in event && event.usage !== null && typeof event.usage === 'object' && !Array.isArray(event.usage)) {
      const counts = Object.fromEntries(Object.entries(event.usage).filter((/* 一项原始CLI用量字段。 */ [key, value]) =>
        /* 只保留公开token计数，不转发CLI原始对象或其它身份。 */ ['input_tokens', 'cached_input_tokens', 'output_tokens'].includes(key)
          && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
      const safeCounts: Record<string, number> = {}
      for (const [key, value] of Object.entries(counts)) if (typeof value === 'number') safeCounts[key] = value
      if (Object.keys(safeCounts).length) usage = safeCounts
    }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (/* 流已经设置UTF-8编码后的片段。 */ chunk: string) => {
    // 持续排空JSONL，限制单行缓冲，不依赖stdout中的助手文本当最终业务结果。
    pending += chunk
    if (pending.length > MAX_OUTPUT_BYTES) { failure = new Error(CodexWorkMessage.OUTPUT_INVALID); terminate(); return }
    const lines = pending.split('\n'); pending = lines.pop() ?? ''
    try { for (const line of lines) if (line.trim()) readLine(line) }
    catch (cause) { failure = cause; terminate() }
  })
  child.stderr.resume()
  child.stdin.on('error', () => { /* 进程提前拒绝stdin时不泄漏资料，也不遗留未处理EPIPE。 */ failure ??= new Error(CodexWorkMessage.CLI_FAILED); terminate() })
  input.signal?.addEventListener('abort', onAbort, { once: true })
  if (input.signal?.aborted) terminate()
  try {
    const code = await new Promise<number | null>((/* close后才允许宿主结束或释放。 */ resolve) => {
      // 启动错误也等待close；不在error事件时提前返回留下子进程或管道。
      child.once('error', () => { /* 配置/启动失败保持固定文案，不输出环境或原始stderr。 */ failure = new Error(CodexWorkMessage.CLI_FAILED) })
      child.once('spawn', () => {
        // 只有操作系统确认独立进程已启动后记录实际调用，accepted早退不会产生本事件。
        try { input.onEvent?.({ method: 'codex.exec.started', params: { workId: input.grant.workId, model: connection.model } }) }
        catch (cause) { failure = cause; terminate() }
      })
      child.once('close', (/* 本次CLI退出码。 */ exitCode) => { /* 所有自有管道已结束后交还执行控制。 */ resolve(exitCode) })
      child.stdin.end(prompt)
    })
    input.signal?.throwIfAborted()
    if (failure) throw failure
    if (code !== 0) throw new Error(CodexWorkMessage.CLI_FAILED)
    let output: string
    try {
      if ((await stat(outputPath)).size > MAX_OUTPUT_BYTES) throw new Error(CodexWorkMessage.OUTPUT_INVALID)
      output = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(outputPath))
    } catch { throw new Error(CodexWorkMessage.OUTPUT_INVALID) }
    return { output, sessionId, usage }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    clearTimeout(forceClose)
  }
}
