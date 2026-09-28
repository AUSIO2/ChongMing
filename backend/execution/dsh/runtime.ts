// 文件职责：封装 DSH SDK 的启动、会话执行、事件投影和幂等关闭。
import { RuntimeMessage } from '../../../contracts/messages'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type {
  DshEvent,
  DshRunInput,
  DshRunResult,
  DshRuntimeAPI,
  DshRuntimeConfig,
} from '../../../contracts/dsh'
export function dshReadEvent(/* SDK 发出的原始通知，将复制为 JSON 可传输的公共事件。 */ notification: HarnessNotification): DshEvent {
  // 把 SDK 通知复制为可序列化的公共运行事件。
  return {
    method: notification.method,
    params: JSON.parse(JSON.stringify(notification.params)),
  }
}
function dshReadBinary(): string {
  // 从当前 SDK 依赖的安装清单解析 DSH 可执行文件路径。
  const sdk = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client')
  const manifest = createRequire(sdk).resolve('@deepseek-ai/dsh/package.json')
  const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof metadata.bin?.dsh !== 'string') throw new Error(RuntimeMessage.INSTALLED_DSH_HAS_NO_DECLARED_EXECUTABLE)
  return path.resolve(path.dirname(manifest), metadata.bin.dsh)
}
export function dshCreateRuntime(/* 由部署及工作授权决定的运行时配置，含路径、模型和受控环境覆盖。 */ config: DshRuntimeConfig): DshRuntimeAPI {
  // 按部署配置创建 Harness，并移除不应传给模型进程的队列凭据环境变量。
  const env = { ...process.env, ...config.env }
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
    async run(/* 本轮提示词及可选会话身份；提示词去除首尾空白后不得为空。 */ input: DshRunInput, /* 可选同步事件观察者，接收经过 JSON 复制的 DSH 通知。 */ onEvent): Promise<DshRunResult> {
      // 执行非空提示词，收集并转发事件，返回会话身份和最终响应。
      if (closePromise) throw new Error(RuntimeMessage.DSH_RUNTIME_IS_CLOSED)
      const prompt = input.prompt.trim()
      if (!prompt) throw new Error(RuntimeMessage.DSH_PROMPT_MUST_NOT_BE_EMPTY)

      const events: DshEvent[] = []
      const result = await harness.run(prompt, {
        sessionId: input.sessionId,
        onNotification(/* Harness 本轮推送的原始通知，需要复制后才暴露给调用者。 */ notification) {
          // 将通知投影为公共事件，同时加入结果记录并通知调用者。
          const event = dshReadEvent(notification)
          events.push(event)
          onEvent?.(event)
        },
      })
      return {
        sessionId: result.sessionId,
        finalResponse: result.finalResponse,
        events,
      }
    },
    close(): Promise<void> {
      // 合并关闭请求，返回同一个 Harness 资源释放 Promise。
      return closePromise ??= harness.close()
    },
  }
}
