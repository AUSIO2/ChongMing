import { describe, expect, it } from 'vitest'
import type {
  AgentCall,
  AgentEvent,
  AgentLoop,
} from '../../electron/mapper/types'

const call: AgentCall = {
  callId: 'call-1',
  prompt: 'check this',
  agent: { name: 'test', tools: [] },
}

function createFakeAgentLoop(): AgentLoop {
  return {
    async run(_call, { signal, onEvent }) {
      signal.throwIfAborted()
      onEvent({ type: 'delta', channel: 'text', text: 'done' })
      onEvent({ type: 'tool-start', name: 'search', argsSummary: 'query' })
      onEvent({ type: 'tool-end', name: 'search' })
      return { text: 'done', sessionId: 'session-1' }
    },
    async close() {},
  }
}

describe('AgentLoop contract', () => {
  it('returns a result and emits normalized events', async () => {
    const events: AgentEvent[] = []
    const result = await createFakeAgentLoop().run(call, {
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    })

    expect(result).toEqual({ text: 'done', sessionId: 'session-1' })
    expect(events).toEqual([
      { type: 'delta', channel: 'text', text: 'done' },
      { type: 'tool-start', name: 'search', argsSummary: 'query' },
      { type: 'tool-end', name: 'search' },
    ])
  })

  it('honors an already-aborted signal', async () => {
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))

    await expect(createFakeAgentLoop().run(call, {
      signal: abort.signal,
      onEvent: () => {},
    })).rejects.toThrow('cancelled')
  })
})
