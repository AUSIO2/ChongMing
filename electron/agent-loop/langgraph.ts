import { llmCreateChatModel } from '../shared/llm-model'
import { llmRunInvoke } from '../shared/llm-utils'
import { toolRead } from '../tools'
import type { AgentLoop } from '../mapper/types'

export const langGraphAgentLoop: AgentLoop = {
  async run(call, { signal, onEvent }) {
    signal.throwIfAborted()
    const text = await llmRunInvoke(
      llmCreateChatModel({
        model: call.agent.model,
        baseUrl: call.agent.baseUrl,
      }),
      toolRead(call.agent.tools) ?? [],
      call.prompt,
      {
        signal,
        onDeltaActivity: event => onEvent({ type: 'delta', ...event }),
        onSkillActivity: event => onEvent(
          event.phase === 'start'
            ? {
                type: 'tool-start',
                name: event.toolName,
                argsSummary: event.argsSummary,
              }
            : { type: 'tool-end', name: event.toolName },
        ),
      },
    )
    signal.throwIfAborted()
    return { text }
  },

  async close() {},
}
