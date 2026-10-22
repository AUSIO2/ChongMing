// 文件职责：封装 DSH SDK 的启动、会话执行、事件投影和幂等关闭。
import { RuntimeMessage } from '../../../contracts/messages'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { ModelConnectionMessage } from '../../../contracts/model-connection'
import { workCreateModelEnvironment } from '../work-api'
import type {
  DshEvent,
  DshRunInput,
  DshRunResult,
  DshRuntimeAPI,
  DshRuntimeConfig,
} from '../../../contracts/dsh'
/**
 * 把 SDK 通知复制为可序列化的公共运行事件。
 *
 * @param notification SDK 发出的原始通知，将复制为 JSON 可传输的公共事件。
 */
export function dshReadEvent(notification: HarnessNotification, apiKey?: string): DshEvent {
  // 提供方错误可能回显请求字段；在事件离开执行器前移除本次工作密钥。
  const redact = (value: DshEvent['params'][string]): DshEvent['params'][string] => {
    if (typeof value === 'string') return apiKey ? value.split(apiKey).join('[redacted]') : value
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [apiKey ? key.split(apiKey).join('[redacted]') : key, redact(item)]))
    return value
  }
  return {
    method: notification.method,
    params: redact(JSON.parse(JSON.stringify(notification.params))) as DshEvent['params'],
  }
}
function dshReadBinary(): string {
  // 从当前 SDK 依赖的安装清单解析 DSH 可执行文件路径。
  const sdk = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client')
  const manifest = createRequire(sdk).resolve('@deepseek-ai/dsh/package.json')
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(manifest)))
  if (typeof metadata.bin?.dsh !== 'string') throw new Error(RuntimeMessage.INSTALLED_DSH_HAS_NO_DECLARED_EXECUTABLE)
  return path.resolve(path.dirname(manifest), metadata.bin.dsh)
}
/**
 * 按部署配置创建 Harness，并移除不应传给模型进程的队列凭据环境变量。
 *
 * @param config 由部署及工作授权决定的运行时配置，含路径、模型和受控环境覆盖。
 */
export function dshCreateRuntime(config: DshRuntimeConfig): DshRuntimeAPI {
  const connection = config.modelConnection
  if (!connection || typeof connection.apiKey !== 'string' || !connection.apiKey.trim()
    || connection.provider !== config.provider || connection.model !== config.model || !connection.baseUrl) {
    throw new Error(ModelConnectionMessage.CONFIGURATION_MISSING)
  }
  const env = workCreateModelEnvironment({ ...process.env, ...config.env }, connection)
  delete env.CHONGMING_AMQP_URL
  delete env.CHONGMING_TEST_BROKER_FILE
  const harness = new DeepSeekHarness({
    dshBin: config.dshBin ?? dshReadBinary(),
    dshHome: config.dshHome,
    cwd: config.cwd,
    processCwd: config.processCwd,
    profile: config.profile ?? 'sdk',
    patches: config.patches,
    provider: config.provider,
    model: config.model,
    maxTokens: config.maxTokens,
    env,
  })
  let closePromise: Promise<void> | undefined

  return {
    start() {
      // 在运行时尚未关闭时启动 Harness 子进程。
      if (closePromise) return Promise.reject(new Error(RuntimeMessage.DSH_RUNTIME_IS_CLOSED))
      return harness.start()
    },
    /**
     * 执行非空提示词，收集并转发事件，返回会话身份和最终响应。
     *
     * @param input 本轮提示词及可选会话身份；提示词去除首尾空白后不得为空。
     * @param onEvent 可选同步事件观察者，接收经过 JSON 复制的 DSH 通知。
     */
    async run(input: DshRunInput, onEvent): Promise<DshRunResult> {
      if (closePromise) throw new Error(RuntimeMessage.DSH_RUNTIME_IS_CLOSED)
      const prompt = input.prompt.trim()
      if (!prompt) throw new Error(RuntimeMessage.DSH_PROMPT_MUST_NOT_BE_EMPTY)

      const events: DshEvent[] = []
      const result = await harness.run(prompt, {
        sessionId: input.sessionId,
        /**
         * 将通知投影为公共事件，同时加入结果记录并通知调用者。
         *
         * @param notification Harness 本轮推送的原始通知，需要复制后才暴露给调用者。
         */
        onNotification(notification) {
          const event = dshReadEvent(notification, connection.apiKey)
          events.push(event)
          onEvent?.(event)
        },
      })
      return {
        sessionId: result.sessionId,
        finalResponse: result.finalResponse.split(connection.apiKey).join('[redacted]'),
        events,
      }
    },
    close(): Promise<void> {
      // 合并关闭请求，返回同一个 Harness 资源释放 Promise。
      return closePromise ??= harness.close()
    },
  }
}
