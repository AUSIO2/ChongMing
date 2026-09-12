import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type {
  DshEvent,
  DshRunInput,
  DshRunResult,
  DshRuntimeAPI,
  DshRuntimeConfig,
} from '../contracts/dsh'

export function dshReadEvent(notification: HarnessNotification): DshEvent {
  return {
    method: notification.method,
    params: JSON.parse(JSON.stringify(notification.params)),
  }
}

export function dshCreateRuntime(config: DshRuntimeConfig): DshRuntimeAPI {
  const harness = new DeepSeekHarness({
    dshBin: config.dshBin,
    dshHome: config.dshHome,
    cwd: config.cwd,
    processCwd: config.processCwd,
    profile: config.profile ?? 'sdk',
    patches: config.patches,
    provider: config.provider,
    model: config.model,
    maxTokens: config.maxTokens,
    env: { ...process.env, ...config.env },
  })
  let closePromise: Promise<void> | undefined

  return {
    start() {
      if (closePromise) return Promise.reject(new Error('DSH runtime is closed'))
      return harness.start()
    },

    async run(input: DshRunInput, onEvent): Promise<DshRunResult> {
      if (closePromise) throw new Error('DSH runtime is closed')
      const prompt = input.prompt.trim()
      if (!prompt) throw new Error('DSH prompt must not be empty')

      const events: DshEvent[] = []
      const result = await harness.run(prompt, {
        sessionId: input.sessionId,
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

    close(): Promise<void> {
      return closePromise ??= harness.close()
    },
  }
}
