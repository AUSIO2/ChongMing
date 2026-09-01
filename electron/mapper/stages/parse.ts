import { readFile } from 'node:fs/promises'
import { mapIdCreateNews, mapIdReadChain } from '../../shared/map-ids'
import { AppError, ErrorCode } from '../../shared/errors'
import { promptRender } from '../../shared/prompt-vars'
import { workspaceReadForMap } from '../../api/workspace-service'
import type { AgentEvent, AgentLoop, MapperDocument } from '../types'

export async function parseStep(
  document: MapperDocument,
  agentLoop: AgentLoop,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const run = document.run
  if (!run || run.stage !== 'parse') return

  if (run.step === 'load') {
    const source = document.sources.find(item => item.id === run.targetId)
    if (!source) {
      throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `Source not found: ${run.targetId}`)
    }
    run.step = 'route'
    return
  }

  if (run.step === 'route') {
    run.step = 'confirm-route'
    return
  }

  if (run.step === 'confirm-route') {
    run.step = 'workers'
    return
  }

  if (run.step === 'workers') {
    const source = document.sources.find(item => item.id === run.targetId)!
    if (source.kind !== 'file') {
      throw new AppError(ErrorCode.MAPPER_EXECUTION_FAILED, 'URL source not supported yet')
    }
    const workspace = await workspaceReadForMap(document.id)
    const agent = workspace.agents.find(item => item.promptPath === 'fact-parser/extract')
    if (!agent) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID_SUBAGENT,
        'Parse agent not found: fact-parser/extract',
      )
    }
    const rawContent = await readFile(source.uri, 'utf-8')
    const prompt = promptRender(
      agent.content,
      agent.promptVars,
      'parseExtract',
      { rawContent },
    )
    const result = await agentLoop.run({
      callId: `${run.runId}:parse`,
      prompt,
      agent: {
        name: agent.agentName ?? 'parse',
        model: agent.model,
        baseUrl: agent.baseUrl,
        tools: agent.tools ?? [],
      },
    }, { signal, onEvent })
    run.draft.calls = [{
      callId: `${run.runId}:parse`,
      agentName: agent.agentName ?? 'parse',
      text: result.text,
      sessionId: result.sessionId,
    }]
    run.draft.output = result.text.trim() || rawContent.trim()
    run.step = 'validate'
    return
  }

  if (run.step === 'validate') {
    run.step = 'save'
    return
  }

  if (run.step === 'save') {
    const chainId = mapIdReadChain(run.targetId)
    if (!chainId) {
      throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `Invalid source: ${run.targetId}`)
    }
    const newsId = mapIdCreateNews(chainId)
    const existing = document.news.find(news => news.id === newsId)
    if (existing) {
      existing.content = run.draft.output ?? ''
    } else {
      document.news.push({
        id: newsId,
        sourceId: run.targetId,
        content: run.draft.output ?? '',
        context: {},
      })
    }
    document.timeline.activeScope = newsId
    run.step = 'done'
  }
}
