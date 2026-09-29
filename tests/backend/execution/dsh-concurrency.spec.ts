// 文件职责：验证并发 DSH 工作各自拥有独立 Home、进程目录、补丁、会话与事件生命周期。
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DshRuntimeAPI, DshRuntimeConfig } from '../../../contracts/dsh'
import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'
import * as dshRuntime from '../../../backend/execution/dsh/runtime'
import { dshRunWork, type DshWorkInput } from '../../../backend/execution/dsh/work-executor'

vi.mock('@deepseek-ai/dsh-sdk-client', { spy: true })

const temporaryDirectories: string[] = []

afterEach(async () => {
  // 恢复运行时与网络替身，并移除用例创建的父目录。
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(/* 当前用例登记的临时父目录。 */ directory =>
    /* 删除测试父目录及任何失败路径残留。 */ rm(directory, { recursive: true, force: true })))
})

function dshGrant(/* 当前并发工作的稳定编号。 */ workId: string): GraphWorkGrant {
  // 构造绑定同一 Operation、不同槽位和 Work 的通用阶段授权。
  return {
    workId, mapId: 'map', runId: 'run', operationId: 'operation', stageId: 'workers', slotId: workId,
    specHash: 'frozen-spec', hostId: 'host', holderId: 'holder-' + workId, fence: 1,
    expiresAt: '2099-01-01T00:00:00.000Z', leaseMs: 30_000,
  }
}

function dshData(/* 当前工作授权，数据视图必须逐项绑定其阶段和槽位。 */ grant: GraphWorkGrant): GraphDataRead {
  // 构造只含声明式提示变量和冻结 Agent 的通用工作数据视图。
  return {
    mapId: grant.mapId, runId: grant.runId, operationId: grant.operationId,
    transitionRef: { id: 'fixture.transition', version: 1 }, specHash: grant.specHash,
    inputs: {}, context: {}, priorStageResults: [], promptVariables: { content: 'Concurrent ' + grant.workId },
    stage: {
      id: grant.stageId, slotId: grant.slotId,
      agent: { ref: { id: 'fixture.agent', version: 1 }, profile: {
        id: 'fixture-agent', name: 'Fixture', description: 'Concurrent fixture', content: 'Check {{content}}',
        tools: [], provider: 'fixture-provider', model: 'fixture-model', promptVars: ['content'],
      } },
      tools: [],
    },
    outputContract: { mode: 'outputs', ports: [] }, proposalId: 'proposal-' + grant.workId,
    work: { id: grant.workId, stageId: grant.stageId, slotId: grant.slotId, specHash: grant.specHash, status: 'ready' },
  }
}

describe('concurrent DSH work attempts', () => {
  // 覆盖一个 Host 内多个真实工作尝试的可写目录与事件隔离。
  it('keeps attempt homes, process directories, patches and sessions separate until every runtime closes', async () => {
    // 同时运行两份工作，在两者都进入 run 后放行，并检查关闭顺序及清理边界。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-dsh-concurrency-'))
    temporaryDirectories.push(directory)
    const grants = [dshGrant('work-a'), dshGrant('work-b')]
    const statuses = new Map<string, number>()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (/* 执行器发起的工作状态或数据读取请求。 */ request) => {
      // 按可信请求头或证明中的 workId 返回各自数据，并在运行后一律报告 accepted。
      const current = request as Request
      const body = await current.clone().json() as { method?: string; params?: { workId?: string } }
      if (current.url.endsWith('/internal/v1/work')) {
        const workId = body.params?.workId ?? ''
        const count = (statuses.get(workId) ?? 0) + 1
        statuses.set(workId, count)
        return Response.json({ ok: true, data: { workId, status: count === 1 ? 'ready' : 'accepted' } })
      }
      const workId = current.headers.get('x-work-id') ?? ''
      const grant = grants.find(/* 两份并发授权候选，按请求头中的工作编号匹配。 */ item => /* 找到数据读取所属授权。 */ item.workId === workId)!
      return Response.json({ ok: true, data: dshData(grant) })
    })
    const configs: DshRuntimeConfig[] = [], patches = new Map<string, Record<string, any>>()
    const events = new Map<string, unknown[]>(), closes: string[] = []
    let running = 0, releaseBoth!: () => void
    const bothRunning = new Promise<void>(/* 两个运行时都进入 run 后的放行函数。 */ resolve => {
      // 保存并发屏障的释放函数。
      releaseBoth = resolve
    })
    vi.spyOn(dshRuntime, 'dshCreateRuntime').mockImplementation((/* 一份并发尝试的独立运行时配置。 */ config): DshRuntimeAPI => {
      // 保存路径并提供受屏障控制的运行时，close 时确认目录尚未被提前删除。
      configs.push(config)
      let workId = ''
      return {
        async start() {
          // 读取本尝试专属补丁，取得其工作身份并确认两个可写目录存在。
          await access(config.dshHome); await access(config.processCwd)
          const patch = JSON.parse(await readFile(config.patches!.at(-1)!, 'utf8'))
          workId = patch[0].config.grant.workId
          patches.set(workId, patch[0].config)
        },
        async run(/* 执行器提供的独立根会话身份。 */ input, /* 当前工作的裸 DSH 事件接收器。 */ onEvent) {
          // 发出当前工作事件并等待另一个运行时也进入执行。
          onEvent?.({ method: 'session.status', params: { workId } })
          if (++running === 2) releaseBoth()
          await bothRunning
          return { sessionId: input.sessionId!, finalResponse: workId, events: [] }
        },
        async close() {
          // 关闭时目录必须仍存在，清理由执行器在此 Promise 完成后执行。
          await access(config.dshHome); await access(config.processCwd)
          closes.push(workId)
        },
      }
    })
    const inputs = grants.map((/* 当前并发授权，转换成完整执行输入。 */ grant): DshWorkInput => /* 为每份授权共用父目录但保留独立事件集合。 */ ({
      grant, dataApiUrl: 'http://127.0.0.1:12345', token: 'fixture-token', dshHome: path.join(directory, 'home'),
      cwd: directory, processCwd: path.join(directory, 'process'),
      onEvent: /* 本工作收到的 DSH 事件，按 workId 保存以检查不会串线。 */ event => {
        // 将事件追加到所属工作集合。
        const list = events.get(grant.workId) ?? []; list.push(event); events.set(grant.workId, list)
      },
    }))
    const results = await Promise.all(inputs.map(/* 两份工作输入，并行交给执行器。 */ input => /* 启动一份独立 DSH 工作尝试。 */ dshRunWork(input)))
    expect(new Set(configs.map(/* 每个运行时配置，提取独立 DSH Home。 */ config => /* 返回 DSH Home 路径。 */ config.dshHome)).size).toBe(2)
    expect(new Set(configs.map(/* 每个运行时配置，提取独立进程目录。 */ config => /* 返回进程 cwd。 */ config.processCwd)).size).toBe(2)
    expect(new Set(results.map(/* 已完成工作结果，提取根会话身份。 */ result => /* 返回 DSH 会话编号。 */ result.sessionId)).size).toBe(2)
    expect(new Set(closes)).toEqual(new Set(['work-a', 'work-b']))
    for (const grant of grants) {
      expect(patches.get(grant.workId)).toMatchObject({ grant, specHash: grant.specHash,
        stage: { id: grant.stageId, slotId: grant.slotId }, outputContract: { mode: 'outputs' } })
      expect(events.get(grant.workId)).toEqual([{ method: 'session.status', params: { workId: grant.workId } }])
    }
    for (const config of configs) {
      await expect(access(config.dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(config.processCwd)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
