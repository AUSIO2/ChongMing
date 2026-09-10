import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type {
  DshEvent,
  DshJson,
  DshRunInput,
  DshRunResult,
  DshRuntimeAPI,
  DshRuntimeConfig,
} from '../contracts/dsh'

function dshReadJson(value: unknown): DshJson {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    return value as null | boolean | number | string
  }
  if (Array.isArray(value)) return value.map(dshReadJson)
  if (typeof value !== 'object') return String(value)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, dshReadJson(item)]),
  )
}

export function dshReadEvent(notification: HarnessNotification): DshEvent {
  return {
    method: notification.method,
    params: dshReadJson(notification.params) as Record<string, DshJson>,
  }
}

export function dshCreateRuntime(config: DshRuntimeConfig): DshRuntimeAPI {
  const harness = new DeepSeekHarness({
    dshBin: config.dshBin,
    dshHome: config.dshHome,
    cwd: config.cwd,
    processCwd: config.processCwd,
    profile: config.profile ?? 'sdk',
    provider: config.provider,
    model: config.model,
    maxTokens: config.maxTokens,
  })
  let closed = false

  return {
    start: () => harness.start(),

    async run(input: DshRunInput, onEvent): Promise<DshRunResult> {
      if (closed) throw new Error('DSH runtime is closed')
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

    async close(): Promise<void> {
      if (closed) return
      closed = true
      await harness.close()
    },
  }
}
