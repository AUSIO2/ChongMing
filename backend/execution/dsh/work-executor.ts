// 文件职责：为单份已领取工作建立隔离 DSH 进程，并核对服务端提交结果。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DshEvent, DshRuntimeAPI } from '../../../contracts/dsh'
import { dshCreateRuntime } from './runtime'
import { promptReadWork, promptReadWorkPersona } from './prompt-renderer'
import { workReadData, workReadModel, workReadProfile, workReadStatus, type WorkApiInput, type WorkRunResult } from '../work-api'

const businessPatch = fileURLToPath(new URL('./dsh-business.patch.yml', import.meta.url))

export interface DshWorkInput extends WorkApiInput {
  // Host已校验部署配置和领取授权，负责续租与释放；本执行器只运行授权内的根会话。
  dshHome: string
  dshBin?: string
  cwd?: string
  processCwd?: string
  /** Trusted deployment patches may register custom tools and model providers. */
  patches?: string[]
  env?: Record<string, string | undefined>
  maxTokens?: number
  /** Bounded follow-up turns if the Agent stops before submitting this work's result. */
  maxRounds?: number
  // 同步接收经过 JSON 复制的本次执行事件。
  onEvent?: (event: DshEvent) => void
}

/** One accepted work grant owns one DSH process. The caller owns claim, renew and release. */
/**
 * 为未完成工作启动独立 DSH 会话与可写目录，有限追问直到收据确认，最终关闭进程并清理本次尝试。
 *
 * @param options Host已校验的单工作配置和授权；执行器复制 grant，管理临时补丁和 DSH 进程。
 */
export async function dshRunWork(options: DshWorkInput): Promise<WorkRunResult> {
  const input = { ...options, grant: structuredClone(options.grant) }
  const grant = input.grant
  input.signal?.throwIfAborted()
  const maxRounds = input.maxRounds ?? 3
  const resultBase = { workId: grant.workId, mapId: grant.mapId, runId: grant.runId, operationId: grant.operationId, status: 'accepted' as const }
  if (await workReadStatus(input) === 'accepted') return { ...resultBase, sessionId: null, finalResponse: '' }
  const data = await workReadData(input)
  const profile = workReadProfile(data)
  const modelConnection = await workReadModel(input, data)
  const persona = promptReadWorkPersona(profile, data)
  const prompt = promptReadWork(persona, data.libraryClaims)
  const rootSessionId = randomUUID()
  const dshHome = path.resolve(input.dshHome)
  await mkdir(dshHome, { recursive: true })
  const attemptHome = await mkdtemp(path.join(dshHome, 'attempt-'))
  let attemptProcessDirectory = path.join(attemptHome, 'process')
  let runtime: DshRuntimeAPI | undefined
  let closePromise: Promise<void> | undefined
  function dshCloseWork(): Promise<void> {
    // 幂等关闭已创建的工作运行时，尚未创建时立即完成。
    if (!runtime) return Promise.resolve()
    return closePromise ??= runtime.close()
  }
  const abort = () => {
    // 工作取消时立即触发运行时关闭，不阻塞取消事件处理。
     void dshCloseWork().catch(() => {
    // 取消回调不传播关闭异常；主流程 finally 仍会等待同一关闭 Promise。
  }) }
  try {
    input.signal?.throwIfAborted()
    if (input.processCwd) {
      const processRoot = path.resolve(input.processCwd)
      await mkdir(processRoot, { recursive: true })
      attemptProcessDirectory = await mkdtemp(path.join(processRoot, '.chongming-attempt-'))
    } else await mkdir(attemptProcessDirectory, { recursive: true })
    const patchPath = path.join(attemptHome, 'work.patch.yml')
    // The token remains in the environment; the immutable grant never enters model arguments.
    await writeFile(patchPath, JSON.stringify([
      { id: 'chongming-data-tools', config: { grant, rootSessionId,
        proposalId: data.proposalId, specHash: data.specHash, stage: data.stage,
        outputContract: data.outputContract, persona,
        ...(data.libraryClaims?.length ? { libraryClaimRefs: data.libraryClaims.map(
          (/* 当前Work实际获权的只读固定材料。 */ material) => /* 补丁只绑定精确身份，材料正文留在用户上下文。 */ ({ ...material.ref }),
        ) } : {}) } },
      { id: 'sdk-jsonrpc-server', config: { maxTokensAsSuccess: false } },
      ...(profile.provider === 'deepseek-official' ? [{ id: 'llm-deepseek', config: {
        apiKeyEnv: 'CHONGMING_MODEL_API_KEY', baseURL: modelConnection.baseUrl,
      } }] : []),
      ...(profile.provider === 'openai' ? [{ id: 'llm-pi-ai', config: { providers: { openai: {
        apiKeyEnv: 'CHONGMING_MODEL_API_KEY', baseURL: modelConnection.baseUrl,
        api: 'openai-completions', models: [{ id: modelConnection.model }],
      } } } }] : []),
    ], null, 2), { mode: 0o600 })
    input.signal?.throwIfAborted()
    runtime = dshCreateRuntime({
      dshBin: input.dshBin,
      dshHome: attemptHome,
      cwd: path.resolve(input.cwd ?? process.cwd()),
      processCwd: attemptProcessDirectory,
      profile: 'sdk',
      patches: [businessPatch, ...(input.patches ?? []), patchPath],
      provider: profile.provider, model: profile.model, modelConnection, maxTokens: input.maxTokens,
      env: { ...input.env, CHONGMING_DATA_API: input.dataApiUrl, CHONGMING_DATA_TOKEN: input.token },
    })
    input.signal?.addEventListener('abort', abort, { once: true })
    input.signal?.throwIfAborted()
    await runtime.start()
    for (let round = 0; round < maxRounds; round++) {
      input.signal?.throwIfAborted()
      const result = await runtime.run({ sessionId: rootSessionId, prompt }, input.onEvent)
      if (await workReadStatus(input) === 'accepted') return { ...resultBase, sessionId: result.sessionId, finalResponse: result.finalResponse }
    }
    throw new Error(messageFormat(RuntimeMessage.DSH_STOPPED_WITHOUT_SUBMITTING_THIS_WORK_AFTER_VALUE_TURNS, maxRounds))
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error
    throw error
  } finally {
    input.signal?.removeEventListener('abort', abort)
    try { await dshCloseWork() } finally {
      // 仅在 DSH 子进程确认关闭后删除本次尝试的 Home 与进程目录，绝不触碰其他并行尝试。
      const directories = attemptProcessDirectory.startsWith(attemptHome + path.sep)
        ? [attemptHome] : [attemptHome, attemptProcessDirectory]
      // 递归删除本次尝试目录；不存在时视为已完成清理。
      await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
    }
  }
}
