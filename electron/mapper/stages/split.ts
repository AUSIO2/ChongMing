import { agentReadMaxSubAgent } from '../../shared/agent-limits'
import { ctxFormat, ctxReadAiContext } from '../../shared/context'
import { AppError, ErrorCode } from '../../shared/errors'
import { mapIdCreateClaim, mapIdUpdateInstance } from '../../shared/map-ids'
import { promptReadOutputParams, promptRender } from '../../shared/prompt-vars'
import { workspaceReadForMap } from '../../api/workspace-service'
import {
  readClaimsOutput,
  readMergeFlags,
  readRouteOutput,
} from '../output'
import type {
  AgentEvent,
  AgentLoop,
  ClaimRecord,
  MapperDocument,
  MapperDraftCall,
} from '../types'

export async function splitStep(
  document: MapperDocument,
  agentLoop: AgentLoop,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const run = document.run
  if (!run || run.stage !== 'split') return
  const news = document.news.find(item => item.id === run.targetId)
  if (!news) {
    throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `News not found: ${run.targetId}`)
  }
  const workspace = await workspaceReadForMap(document.id)
  const agents = workspace.agents.filter(
    agent => agent.agentType === 'split' && agent.agentName,
  )

  if (run.step === 'load') {
    run.step = 'route'
    return
  }

  if (run.step === 'route') {
    const coordinator = workspace.agents.find(
      agent => agent.promptPath === 'fact-extractor/main-agent-route',
    )
    if (!coordinator) {
      throw new AppError(ErrorCode.CONFIG_INVALID_SUBAGENT, 'Split route agent not found')
    }
    const prompt = promptRender(
      coordinator.content,
      coordinator.promptVars,
      'splitRoute',
      {
        availableAgents: agents.map(agent => `- ${agent.agentName}`).join('\n'),
        context: ctxFormat(ctxReadAiContext(news.context)),
        content: news.content,
      },
    )
    const result = await agentLoop.run({
      callId: `${run.runId}:route`,
      prompt,
      agent: {
        name: 'route',
        model: coordinator.model,
        baseUrl: coordinator.baseUrl,
        tools: coordinator.tools ?? [],
      },
    }, { signal, onEvent })
    let routes = readRouteOutput(
      result.text,
      new Set(agents.map(agent => agent.agentName!)),
    )
    if (routes.length === 0) {
      routes = agents.map((agent, index) => ({
        agentName: agent.agentName!,
        priority: (['high', 'medium', 'low'] as const)[Math.min(index, 2)],
      }))
    }
    run.draft.routes = mapIdUpdateInstance(routes).map(route => ({
      ...route,
      parentId: news.id,
    }))
    run.step = 'confirm-route'
    return
  }

  if (run.step === 'confirm-route') {
    run.step = 'workers'
    return
  }

  if (run.step === 'workers') {
    const order = { high: 0, medium: 1, low: 2 } as const
    const routes = run.draft.routes
      .slice()
      .sort((a, b) => order[a.priority] - order[b.priority])
      .slice(0, agentReadMaxSubAgent())
    const calls = await Promise.all(routes.map(async route => {
      const agent = agents.find(item => item.agentName === route.agentName)
      if (!agent) {
        throw new AppError(
          ErrorCode.CONFIG_INVALID_SUBAGENT,
          `Split agent not found: ${route.agentName}`,
        )
      }
      const prompt = promptRender(
        agent.content,
        agent.promptVars,
        'splitSubAgent',
        {
          content: news.content,
          context: ctxFormat(ctxReadAiContext(news.context)),
          hint: route.hint ?? '',
        },
        promptReadOutputParams(agent, 'splitSubAgent'),
      )
      const result = await agentLoop.run({
        callId: `${run.runId}:${route.instanceId}`,
        prompt,
        agent: {
          name: route.agentName,
          model: agent.model,
          baseUrl: agent.baseUrl,
          tools: agent.tools ?? [],
        },
      }, { signal, onEvent })
      return {
        callId: `${run.runId}:${route.instanceId}`,
        agentName: route.agentName,
        instanceId: route.instanceId,
        text: result.text,
        sessionId: result.sessionId,
      } satisfies MapperDraftCall
    }))
    run.draft.calls = calls
    run.step = 'merge'
    return
  }

  if (run.step === 'merge') {
    const drafts: ClaimRecord[] = []
    for (const call of run.draft.calls) {
      for (const claim of readClaimsOutput(call.text)) {
        drafts.push({
          id: '',
          newsId: news.id,
          content: claim.content,
          category: claim.category,
          sourceAgent: call.agentName,
          sourceInstanceId: call.instanceId,
        })
      }
    }
    const coordinator = workspace.agents.find(
      agent => agent.promptPath === 'fact-extractor/main-agent-merge',
    )
    if (!coordinator) {
      throw new AppError(ErrorCode.CONFIG_INVALID_SUBAGENT, 'Split merge agent not found')
    }
    const prompt = promptRender(
      coordinator.content,
      coordinator.promptVars,
      'splitMerge',
      {
        content: news.content,
        subResults: drafts
          .map((claim, index) => `[${index}] (${claim.sourceAgent ?? '?'}) ${claim.content}`)
          .join('\n'),
      },
    )
    const result = await agentLoop.run({
      callId: `${run.runId}:merge`,
      prompt,
      agent: {
        name: 'merge',
        model: coordinator.model,
        baseUrl: coordinator.baseUrl,
        tools: coordinator.tools ?? [],
      },
    }, { signal, onEvent })
    const flags = readMergeFlags(result.text)
    run.draft.claims = drafts
      .filter((_claim, index) => flags.get(index) !== false)
      .map((claim, index) => ({
        ...claim,
        id: mapIdCreateClaim(index, news.id),
      }))
    run.draft.output = result.text
    run.step = 'validate'
    return
  }

  if (run.step === 'validate') {
    run.step = 'save'
    return
  }

  if (run.step === 'save') {
    document.claims = [
      ...document.claims.filter(claim => claim.newsId !== news.id),
      ...(run.draft.claims ?? []),
    ]
    document.routes = [
      ...document.routes.filter(route => route.parentId !== news.id),
      ...run.draft.routes,
    ]
    run.step = 'done'
  }
}
