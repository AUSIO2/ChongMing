// 重启可靠性：只重开真实应用进程，保留同一存储、身份、资产、收据与 Web 地址。
import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { clientCreateGateway } from '../../client/graph-client'
import type { ClientGateway } from '../../contracts/client'
import type { GraphNode } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphBranchOwnership } from '../../contracts/graph-branch'
import { expect, workspaceLogin, workspaceOpenMap } from './workspace-fixture'
import { recoveryTest as test, type WorkspaceRecoveryEnvironment } from './workspace-recovery-fixture'

enum RecoveryCaseError {
  NODE_MISSING = 'M00 恢复检查未找到原节点。',
  OWNERSHIP_MISSING = 'M00 崩溃前没有观察到真实编辑占用。',
  SAVE_DIAGNOSTIC_UNAVAILABLE = 'M00 恢复保存失败，公开 DOM 诊断未能完成。',
  DIAGNOSTIC_TIMEOUT = 'M00 恢复保存失败时公开 DOM 诊断超过独立期限。',
  SAVE_INSPECTOR_MISSING = 'M00 恢复保存失败时数据详情面板已不存在。',
  SAVE_FIELD_MISSING = 'M00 恢复保存失败时正文控件已不存在，草稿状态未知。',
  SAVE_FIELD_NOT_EDITABLE = 'M00 恢复保存失败时正文已不可编辑。',
  SAVE_DRAFT_CHANGED = 'M00 恢复保存失败时正文草稿已改变。',
  SAVE_VERSION_CONFLICT = 'M00 恢复保存失败时出现了版本变化冲突提示。',
  SAVE_DISABLED = 'M00 恢复保存失败时保存按钮被禁用，未观察到版本冲突提示。',
  SAVE_OTHER_FAILURE = 'M00 恢复保存失败时公开编辑条件仍满足，需继续诊断原异常。',
}

interface RecoverySaveStage { mode: 'graceful' | 'crash'; round: 1 | 2 | 3; phase: 'before-restart' | 'after-restart' }
interface RecoverySaveObservation {
  inspectorPresent: boolean
  fieldPresent: boolean
  claimVisible: boolean
  fieldEditable: boolean
  // 仅 fieldPresent=true 时可用于判断正文；控件缺失不能推断草稿改变。
  draftMatches: boolean
  conflictVisible: boolean
  saveEnabled: boolean
  dirtyVisible: boolean
  releaseVisible: boolean
}

/** 独立公共读取必须取得已知身份，不能用第一个节点替代原始记录。 */
function recoveryReadNode(/* 同账号公共读取返回的真实快照。 */ snapshot: GraphSnapshot, /* 最初记录的节点身份。 */ nodeId: string): GraphNode {
  // 精确匹配最初保存的节点，身份丢失直接失败。
  const node = snapshot.nodes.find((/* 本次真实读取的节点。 */ item) => item.id === nodeId)
  if (!node) throw new Error(RecoveryCaseError.NODE_MISSING)
  return node
}

/** 从正常连接表单重新进入原图；不复用旧 context 的 renderer 内存。 */
async function recoveryOpenPage(
  /* 当前测试持有的真实浏览器。 */ browser: Browser,
  /* 父持存储、凭据与稳定 Web 地址。 */ recovery: WorkspaceRecoveryEnvironment,
  /* 最初创建的原图名称。 */ mapName: string,
): Promise<{ context: BrowserContext; page: Page }> {
  // 新建浏览器上下文，并通过公开表单重新进入原图。
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await workspaceLogin(page, recovery.webUrl, recovery.credential.token)
    await workspaceOpenMap(page, mapName)
    const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
    await scene.focus()
    await scene.press('Escape')
    await scene.press('ArrowRight')
    await expect(page.getByRole('region', { name: '数据详情', exact: true })).toBeVisible()
    return { context, page }
  } catch (cause) {
    try { await context.close() }
    catch (cleanup) { throw new AggregateError([cause, cleanup], 'Recovery page initialization and cleanup failed') }
    throw cause
  }
}

/** 保存操作完全经真实表单完成，独立 API 检查正文和精确版本递增。 */
async function recoverySavePage(
  /* 正常登录且已选中原节点的真实页面。 */ page: Page,
  /* 同账号用于独立事实核对的公共客户端。 */ gateway: ClientGateway,
  /* 当前图及最后确认的节点。 */ current: { mapId: string; node: GraphNode },
  /* 当前服务 bootstrap 公布的租约策略。 */ leasesRequired: boolean,
  /* 本轮保存后必须逐字保持的全文。 */ content: string,
  /* 只包含固定模式、轮次与重启前后的诊断阶段。 */ stage: RecoverySaveStage,
): Promise<GraphNode> {
  // 正常保存操作保持原样，仅在失败后收集有界公开 DOM 现场并保留原 cause。
  return test.step(`recovery-save:${stage.mode}:${stage.round}:${stage.phase}`, async () => {
    // 正常路径保留全部原操作和断言；诊断只在原路径已经失败以后执行。
    const inspector = page.getByRole('region', { name: '数据详情', exact: true })
    const field = inspector.getByRole('group', { name: '正文', exact: true }).getByRole('textbox')
    try {
      if (leasesRequired && !await inspector.getByRole('button', { name: '释放分支编辑权', exact: true }).isVisible()) {
        // 已自然到期的旧占用仍可能显示在上一次快照中，界面公开的尝试领取入口同样合法。
        await inspector.getByRole('button', { name: /^(?:尝试)?领取分支编辑权$/ }).click()
        await expect(inspector.getByRole('button', { name: '释放分支编辑权', exact: true })).toBeVisible()
      }
      await expect(field).toBeEditable()
      await field.fill(content)
      await expect(field).toHaveValue(content)
      await expect(inspector.getByText('未保存', { exact: true })).toBeVisible()
      await expect(inspector.getByRole('button', { name: '保存数据', exact: true })).toBeEnabled()
      await inspector.getByRole('button', { name: '保存数据', exact: true }).click()
      await expect(inspector.getByText('未保存', { exact: true })).toHaveCount(0)
      const saved = recoveryReadNode(await gateway.read('map.get', { mapId: current.mapId }), current.node.id)
      expect(saved.payload.content).toBe(content)
      expect(saved.revision).toBe(current.node.revision + 1)
      expect(saved.typeId).toBe(current.node.typeId)
      expect(saved.typeVersion).toBe(current.node.typeVersion)
      return saved
    } catch (cause) {
      let observation: RecoverySaveObservation
      let diagnosticTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const evaluation = page.evaluate((
          /* 仅在浏览器内比较全文，返回值中不包含原文或草稿。 */ expected: string,
        ): RecoverySaveObservation => {
          // 单次只读公共 document；即便原 locator 已丢失，也不会等待它重新出现。
          const inspector = document.querySelector('section[aria-label="数据详情"]')
          const legends = inspector ? Array.from(inspector.querySelectorAll('legend')).slice(0, 128) : []
          const contentLegend = legends.find((/* 当前面板有限候选中的真实字段名。 */ legend) => legend.textContent?.trim() === '正文')
          const candidate = contentLegend?.parentElement?.querySelector('textarea,input[type="text"],input:not([type])')
          const field = candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement ? candidate : null
          const buttons = inspector ? Array.from(inspector.querySelectorAll('button')).slice(0, 128) : []
          const save = buttons.find((/* 当前面板的真实按钮。 */ button) => button.textContent?.trim() === '保存数据')
          const release = buttons.find((/* 当前面板的真实按钮。 */ button) => button.textContent?.trim() === '释放分支编辑权')
          const claim = buttons.find((/* 正常领取和服务端旧占用下的尝试领取都属于公开入口。 */ button) => /^(?:尝试)?领取分支编辑权$/.test(button.textContent?.trim() ?? ''))
          const conflict = inspector?.querySelector('.conflict-notice strong'), dirty = inspector?.querySelector('.draft-tag')
          return { inspectorPresent: inspector !== null, fieldPresent: field !== null,
            claimVisible: claim instanceof HTMLButtonElement && claim.getClientRects().length > 0,
            fieldEditable: field !== null && !field.matches(':disabled') && !field.readOnly,
            draftMatches: field !== null && field.value === expected,
            conflictVisible: conflict?.textContent?.trim() === '服务器数据已变化，草稿已保留。' && conflict.getClientRects().length > 0,
            saveEnabled: save instanceof HTMLButtonElement && !save.matches(':disabled'),
            dirtyVisible: dirty?.textContent?.trim() === '未保存' && dirty.getClientRects().length > 0,
            releaseVisible: release instanceof HTMLButtonElement && release.getClientRects().length > 0 }
        }, content)
        observation = await Promise.race([evaluation, new Promise<never>((
          /* 超时不产生替代现场数据。 */ _resolve,
          /* 独立诊断期限到达时拒绝读取，原保存 cause 仍由外层聚合保留。 */ reject,
        ) => {
          // page.evaluate 不受 actionTimeout 保证；本失败路径独占五秒期限，context 最终关闭结束残留读取。
          diagnosticTimer = setTimeout(() => /* 到期只报告固定诊断失败，不填充真假不明的 DTO。 */ reject(new Error(RecoveryCaseError.DIAGNOSTIC_TIMEOUT)), 5_000)
        })])
        await test.info().attach('m00-recovery-save-observation', { contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ schemaVersion: 1, ...stage, ...observation })) })
      } catch (diagnostic) {
        throw new AggregateError([cause, diagnostic], RecoveryCaseError.SAVE_DIAGNOSTIC_UNAVAILABLE, { cause })
      } finally { clearTimeout(diagnosticTimer) }
      // 不重填、不额外等待或重新保存；每种现场观测使用独立静态位置并保留原失败。
      if (!observation.inspectorPresent) throw new Error(RecoveryCaseError.SAVE_INSPECTOR_MISSING, { cause })
      if (!observation.fieldPresent) throw new Error(RecoveryCaseError.SAVE_FIELD_MISSING, { cause })
      if (!observation.fieldEditable) throw new Error(RecoveryCaseError.SAVE_FIELD_NOT_EDITABLE, { cause })
      if (!observation.draftMatches) throw new Error(RecoveryCaseError.SAVE_DRAFT_CHANGED, { cause })
      if (observation.conflictVisible) throw new Error(RecoveryCaseError.SAVE_VERSION_CONFLICT, { cause })
      if (!observation.saveEnabled) throw new Error(RecoveryCaseError.SAVE_DISABLED, { cause })
      throw new Error(RecoveryCaseError.SAVE_OTHER_FAILURE, { cause })
    }
  })
}

/** 三轮均保留同一组业务身份；成功保存后重启，并在新 context 中继续真实编辑。 */
async function recoveryVerifyRounds(
  /* 当前测试独占的真实浏览器。 */ browser: Browser,
  /* 仅应用可重启、存储由父持有的隔离环境。 */ recovery: WorkspaceRecoveryEnvironment,
  /* 优雅退出或仅强杀应用服务的固定场景。 */ mode: 'graceful' | 'crash',
): Promise<void> {
  // 反复保存、重启同一个应用，再验证原材料可读且能继续写入。
  const gateway = clientCreateGateway({ baseUrl: recovery.baseUrl })
  let active: BrowserContext | undefined
  await gateway.connect({ baseUrl: recovery.baseUrl, token: recovery.credential.token, remember: false })
  try {
    const bootstrap = await gateway.read('app.bootstrap', {})
    const leasesRequired = bootstrap.metadata.clientLeases !== 'none'
    expect(bootstrap.identity.userId).toBe(recovery.credential.userId)
    expect((await gateway.read('workspace.list', {})).items).toHaveLength(0)
    const createRequestId = randomUUID()
    const workspaceParams = { id: randomUUID(), name: '原工作区恢复验收', description: '保留原数据，逐轮重开真实应用。', agentSource: 'library' as const }
    await gateway.dispatch(createRequestId, 'workspace.create', workspaceParams)
    const workspace = await gateway.read('workspace.get', { workspaceId: workspaceParams.id })
    const created = await gateway.dispatch(randomUUID(), 'map.create', {
      workspaceId: workspace.id, expectedRevision: workspace.revision, id: randomUUID(), name: '原图与原节点',
    })
    const map = created.data.snapshot
    const nodeId = randomUUID()
    const prepared = await gateway.dispatch(randomUUID(), 'graph.apply', {
      mapId: map.mapId, branch: { rootIds: [nodeId], expectedVersion: null },
      changes: { nodes: { put: [{ id: nodeId, typeId: 'factcheck.claim', typeVersion: 1,
        payload: { content: '原始全文，节点身份跨应用重启保持。', category: 'data' } }] } },
    })
    let confirmed = recoveryReadNode(prepared.data.snapshot, nodeId)
    const bytes = Buffer.from('服务恢复后仍须下载到完全相同的原资产字节。\nM00 recovery asset', 'utf8')
    const uploaded = await gateway.upload(randomUUID(), { workspaceId: workspace.id, filename: '原恢复材料.txt', mediaType: 'text/plain', bytes })
    let opened = await recoveryOpenPage(browser, recovery, map.name)
    active = opened.context
    for (let round = 0; round < 3; round++) {
      const content = `${mode} 第 ${round + 1} 轮保存。\n原节点与原图继续使用。\n完整末行：提交已确认。`
      const currentRound = (round + 1) as 1 | 2 | 3
      confirmed = await recoverySavePage(opened.page, gateway, { mapId: map.mapId, node: confirmed }, leasesRequired, content,
        { mode, round: currentRound, phase: 'before-restart' })
      let ownership: GraphBranchOwnership | undefined
      if (leasesRequired) {
        if (mode === 'graceful') {
          await opened.page.getByRole('button', { name: '释放分支编辑权', exact: true }).click()
          await expect(opened.page.getByRole('button', { name: '领取分支编辑权', exact: true })).toBeVisible()
        } else {
          const beforeCrash = await gateway.read('map.get', { mapId: map.mapId })
          ownership = beforeCrash.ownerships.find((/* 崩溃前实际后端的分支占用。 */ item) => item.kind === 'editor' && item.rootIds.includes(nodeId))
          if (!ownership) throw new Error(RecoveryCaseError.OWNERSHIP_MISSING)
          expect(ownership.ownerUserId).toBe(recovery.credential.userId)
        }
      }
      await active.close()
      active = undefined
      const beforeRestart = await gateway.read('map.get', { mapId: map.mapId })
      if (ownership) {
        // 最后一个 renderer 已关闭，此次读取包含关闭前合法在途续租的最终结果。
        ownership = beforeRestart.ownerships.find((/* 关闭 renderer 后仍存活的同一租约。 */ item) => item.leaseId === ownership?.leaseId)
        if (!ownership) throw new Error(RecoveryCaseError.OWNERSHIP_MISSING)
      }
      await recovery.restart(mode)
      const reopened = await gateway.read('map.get', { mapId: map.mapId })
      expect(reopened.mapId).toBe(map.mapId)
      expect(reopened.workspaceId).toBe(workspace.id)
      expect(recoveryReadNode(reopened, nodeId)).toEqual(confirmed)
      expect(reopened.nodes).toHaveLength(1)
      expect(reopened.edges).toHaveLength(0)
      expect(reopened.revision).toBe(beforeRestart.revision)
      if (ownership) {
        // 真实默认租期仍生效：重开不能删除旧占用，也不能提前授予新 holder。
        const retained = reopened.ownerships.find((/* 重开后同一服务端编辑占用。 */ item) => item.leaseId === ownership?.leaseId)
        expect(retained).toMatchObject({ leaseId: ownership.leaseId, holderId: ownership.holderId,
          fence: ownership.fence, ownerUserId: ownership.ownerUserId, scope: ownership.scope })
        expect(retained?.expiresAt !== null && retained?.expiresAt !== undefined).toBe(true)
        expect(Date.parse(retained?.expiresAt ?? '')).toBeGreaterThanOrEqual(Date.parse(ownership.expiresAt ?? ''))
        ownership = retained
        const contender = await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [nodeId], holderId: randomUUID() })
        expect(contender.data.status).toBe('busy')
      }
      const identity = await gateway.read('app.bootstrap', {})
      expect(identity.identity.userId).toBe(recovery.credential.userId)
      const replay = await gateway.dispatch(createRequestId, 'workspace.create', workspaceParams)
      expect(replay.replayed).toBe(true)
      expect(replay.data.id).toBe(workspace.id)
      expect((await gateway.read('workspace.list', {})).items.map((/* 原账号真实可见目录。 */ item) => item.id)).toEqual([workspace.id])
      const assets = await gateway.read('asset.list', { workspaceId: workspace.id, limit: 100 })
      expect(assets.items).toHaveLength(1)
      expect(assets.items[0]?.id).toBe(uploaded.data.id)
      expect(Buffer.from((await gateway.download({ kind: 'asset', id: uploaded.data.id })).bytes).equals(bytes)).toBe(true)
      opened = await recoveryOpenPage(browser, recovery, map.name)
      active = opened.context
      const inspector = opened.page.getByRole('region', { name: '数据详情', exact: true })
      const field = inspector.getByRole('group', { name: '正文', exact: true }).getByRole('textbox')
      await expect(field).toHaveValue(content)
      if (ownership) {
        const expiresAtMs = Date.parse(ownership.expiresAt ?? '')
        let firstAbsentAtMs: number | undefined
        expect(Number.isFinite(expiresAtMs)).toBe(true)
        await expect(field).toBeDisabled()
        // 无旧 renderer 续租；等待真实公共快照中的旧租约自然到期，不改时钟/存储或手动释放。
        await expect.poll(async () => {
          // 只读公共快照，服务端按真实到期规则投影有效占用。
          const snapshot = await gateway.read('map.get', { mapId: map.mapId })
          const isPresent = snapshot.ownerships.some((/* 当前仍有效的真实占用。 */ item) => item.leaseId === ownership?.leaseId)
          if (!isPresent && firstAbsentAtMs === undefined) firstAbsentAtMs = Date.now()
          return isPresent
        }, { timeout: 45_000, intervals: [250, 500, 1000] }).toBe(false)
        expect(firstAbsentAtMs).toBeGreaterThanOrEqual(expiresAtMs)
      }
      confirmed = await recoverySavePage(opened.page, gateway, { mapId: map.mapId, node: confirmed }, leasesRequired,
        `${content}\n恢复后继续编辑成功，原节点版本递增。`, { mode, round: currentRound, phase: 'after-restart' })
    }
  } finally {
    try { await active?.close() } finally { await gateway.disconnect() }
  }
}

test('M00-R04 优雅重启三轮后保留原身份全文资产和收据，并能继续编辑', async (
  /* 真实浏览器及仅父持存储的可重启环境。 */ { browser, recovery },
) => {
  // UI 成功收到保存结果后再正常关闭应用，不重建数据库或原身份。
  test.setTimeout(180_000)
  await recoveryVerifyRounds(browser, recovery, 'graceful')
})

test('M00-R05 强杀应用三轮后已确认提交不丢，旧租约自然到期后可继续编辑', async (
  /* 真实浏览器及不会被 child 强杀的父持存储。 */ { browser, recovery },
) => {
  // 只强杀应用；Mongo/SQLite 文件仍由父持有，崩溃不冒充数据库断电恢复。
  test.setTimeout(240_000)
  await recoveryVerifyRounds(browser, recovery, 'crash')
})
