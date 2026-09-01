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
  ClaimRecord,
  MapperCallPlan,
  MapperStageContext,
} from '../types'

export async function splitStep(
  context: MapperStageContext,
): Promise<void> {
  const { document } = context
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
      parentId: news.id,
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
    await context.executeCalls(plans)
    context.document.run!.step = 'merge'
    return
  }

  if (run.step === 'merge') {
    const drafts: ClaimRecord[] = []
    for (const call of run.draft.calls.filter(call => call.role === 'worker')) {
      for (const claim of readClaimsOutput(call.result!.text)) {
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
    const flags = readMergeFlags(record.result!.text)
    resumedRun.draft.claims = drafts
      .filter((_claim, index) => flags.get(index) !== false)
      .map((claim, index) => ({
        ...claim,
        id: mapIdCreateClaim(index, news.id),
      }))
    resumedRun.draft.output = record.result!.text
    resumedRun.step = 'validate'
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
