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

// 用途：读取事件，并把结构化结果交给调用方。
export function dshReadEvent(notification: HarnessNotification): DshEvent {
  return {
    method: notification.method,
    params: JSON.parse(JSON.stringify(notification.params)),
  }
}

// 用途：读取DSH 运行时，并把结构化结果交给调用方。
function dshReadBinary(): string {
  const sdk = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client')
  const manifest = createRequire(sdk).resolve('@deepseek-ai/dsh/package.json')
  const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof metadata.bin?.dsh !== 'string') throw new Error(RuntimeMessage.INSTALLED_DSH_HAS_NO_DECLARED_EXECUTABLE)
  return path.resolve(path.dirname(manifest), metadata.bin.dsh)
}

// 用途：创建运行时，供后续流程使用。
export function dshCreateRuntime(config: DshRuntimeConfig): DshRuntimeAPI {
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
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    start() {
      if (closePromise) return Promise.reject(new Error(RuntimeMessage.DSH_RUNTIME_IS_CLOSED))
      return harness.start()
    },

    // 用途：执行当前异步操作。
    async run(input: DshRunInput, onEvent): Promise<DshRunResult> {
      if (closePromise) throw new Error(RuntimeMessage.DSH_RUNTIME_IS_CLOSED)
      const prompt = input.prompt.trim()
      if (!prompt) throw new Error(RuntimeMessage.DSH_PROMPT_MUST_NOT_BE_EMPTY)

      const events: DshEvent[] = []
      const result = await harness.run(prompt, {
        sessionId: input.sessionId,
        // 用途：处理当前模块相关工作，并把结果交给调用方。
        onNotification(notification) {
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

    // 用途：关闭当前模块并释放占用的资源。
    close(): Promise<void> {
      return closePromise ??= harness.close()
    },
  }
}
