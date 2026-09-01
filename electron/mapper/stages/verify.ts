import { agentReadMaxSubAgent } from '../../shared/agent-limits'
import { ctxFormat, ctxReadAiContext } from '../../shared/context'
import { AppError, ErrorCode } from '../../shared/errors'
import { mapIdUpdateInstance } from '../../shared/map-ids'
import { promptRender } from '../../shared/prompt-vars'
import { workspaceReadForMap } from '../../api/workspace-service'
import { readRouteOutput, readVerifyOutput } from '../output'
import type {
  AgentEvent,
  AgentLoop,
  MapperDocument,
  MapperDraftCall,
  OpinionRecord,
} from '../types'

export async function verifyStep(
  document: MapperDocument,
  agentLoop: AgentLoop,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const run = document.run
  if (!run || run.stage !== 'verify') return
  const claim = document.claims.find(item => item.id === run.targetId)
  if (!claim) {
    throw new AppError(ErrorCode.CLAIM_NOT_FOUND, `Claim not found: ${run.targetId}`)
  }
  const news = document.news.find(item => item.id === claim.newsId)
  const workspace = await workspaceReadForMap(document.id)
  const agents = workspace.agents.filter(
    agent => agent.agentType === 'verify' && agent.agentName,
  )

  if (run.step === 'load') {
    run.step = 'route'
    return
  }

  if (run.step === 'route') {
    const coordinator = workspace.agents.find(
      agent => agent.promptPath === 'fact-verifier/main-agent-route',
    )
    if (!coordinator) {
      throw new AppError(ErrorCode.CONFIG_INVALID_SUBAGENT, 'Verify route agent not found')
    }
    const prompt = promptRender(
      coordinator.content,
      coordinator.promptVars,
      'verifyRoute',
      {
        availableAgents: agents.map(agent => `- ${agent.agentName}`).join('\n'),
        claimContent: claim.content,
        originalContent: news?.content ?? '',
        context: ctxFormat(ctxReadAiContext(news?.context ?? {})),
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
      parentId: claim.id,
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
    const rows = await Promise.all(routes.map(async route => {
      const agent = agents.find(item => item.agentName === route.agentName)
      if (!agent) {
        throw new AppError(
          ErrorCode.CONFIG_INVALID_SUBAGENT,
          `Verify agent not found: ${route.agentName}`,
        )
      }
      const prompt = promptRender(
        agent.content,
        agent.promptVars,
        'verifySubAgent',
        {
          claimContent: claim.content,
          originalContent: news?.content ?? '',
          context: ctxFormat(ctxReadAiContext(news?.context ?? {})),
          hint: route.hint ?? '',
        },
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
      const parsed = readVerifyOutput(result.text)
      const opinion: OpinionRecord = {
        agentName: route.agentName,
        instanceId: route.instanceId,
        priority: route.priority,
        score: parsed.score,
        reason: parsed.reason,
      }
      const call = {
          callId: `${run.runId}:${route.instanceId}`,
          agentName: route.agentName,
          instanceId: route.instanceId,
          text: result.text,
          sessionId: result.sessionId,
        } satisfies MapperDraftCall
      return { call, opinion }
    }))
    run.draft.calls = rows.map(row => row.call)
    run.draft.opinions = rows.map(row => row.opinion)
    run.step = 'merge'
    return
  }

  if (run.step === 'merge') {
    const coordinator = workspace.agents.find(
      agent => agent.promptPath === 'fact-verifier/main-agent-merge',
    )
    if (!coordinator) {
      throw new AppError(ErrorCode.CONFIG_INVALID_SUBAGENT, 'Verify merge agent not found')
    }
    const opinions = run.draft.opinions ?? []
    const prompt = promptRender(
      coordinator.content,
      coordinator.promptVars,
      'verifyMerge',
      {
        claimContent: claim.content,
        originalContent: news?.content ?? '',
        opinions: opinions.map(opinion =>
          `【${opinion.agentName}】(priority: ${opinion.priority})\n`
          + `  score: ${opinion.score}\n  reason: ${opinion.reason}`,
        ).join('\n\n'),
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
    const merged = readVerifyOutput(result.text)
    run.draft.verify = { ...merged, opinions }
    run.draft.output = result.text
    run.step = 'validate'
    return
  }

  if (run.step === 'validate') {
    run.step = 'save'
    return
  }

  if (run.step === 'save') {
    claim.verify = run.draft.verify
    document.routes = [
      ...document.routes.filter(route => route.parentId !== claim.id),
      ...run.draft.routes,
    ]
    run.step = 'done'
  }
}
