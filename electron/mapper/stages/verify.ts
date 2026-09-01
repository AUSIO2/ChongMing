import { agentReadMaxSubAgent } from '../../shared/agent-limits'
import { ctxFormat, ctxReadAiContext } from '../../shared/context'
import { AppError, ErrorCode } from '../../shared/errors'
import { mapIdUpdateInstance } from '../../shared/map-ids'
import { promptRender } from '../../shared/prompt-vars'
import { workspaceReadForMap } from '../../api/workspace-service'
import { readRouteOutput, readVerifyOutput } from '../output'
import type {
  MapperCallPlan,
  MapperStageContext,
  OpinionRecord,
} from '../types'

export async function verifyStep(
  context: MapperStageContext,
): Promise<void> {
  const { document } = context
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
    const [record] = await context.executeCalls([{
      call: {
        callId: `${run.runId}:route`, prompt,
        agent: {
          name: 'route', model: coordinator.model,
          baseUrl: coordinator.baseUrl, tools: coordinator.tools ?? [],
        },
      },
      role: 'route', agentName: 'route',
    }])
    const resumedRun = context.document.run!
    let routes = readRouteOutput(
      record.result!.text,
      new Set(agents.map(agent => agent.agentName!)),
    )
    if (routes.length === 0) {
      routes = agents.map((agent, index) => ({
        agentName: agent.agentName!,
        priority: (['high', 'medium', 'low'] as const)[Math.min(index, 2)],
      }))
    }
    resumedRun.draft.routes = mapIdUpdateInstance(routes).map(route => ({
      ...route,
      parentId: claim.id,
    }))
    resumedRun.step = 'confirm-route'
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
    const plans = routes.map(route => {
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
      return {
        call: {
          callId: `${run.runId}:${route.instanceId}`, prompt,
          agent: {
            name: route.agentName, model: agent.model,
            baseUrl: agent.baseUrl, tools: agent.tools ?? [],
          },
        },
        role: 'worker' as const,
        agentName: route.agentName,
        instanceId: route.instanceId,
      } satisfies MapperCallPlan
    })
    const records = await context.executeCalls(plans)
    const resumedRun = context.document.run!
    resumedRun.draft.opinions = records.map((record, index) => {
      const parsed = readVerifyOutput(record.result!.text)
      return {
        agentName: record.agentName,
        instanceId: record.instanceId!,
        priority: routes[index].priority,
        score: parsed.score,
        reason: parsed.reason,
      } satisfies OpinionRecord
    })
    resumedRun.step = 'merge'
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
    const [record] = await context.executeCalls([{
      call: {
        callId: `${run.runId}:merge`, prompt,
        agent: {
          name: 'merge', model: coordinator.model,
          baseUrl: coordinator.baseUrl, tools: coordinator.tools ?? [],
        },
      },
      role: 'merge', agentName: 'merge',
    }])
    const resumedRun = context.document.run!
    const merged = readVerifyOutput(record.result!.text)
    resumedRun.draft.verify = { ...merged, opinions }
    resumedRun.draft.output = record.result!.text
    resumedRun.step = 'validate'
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
