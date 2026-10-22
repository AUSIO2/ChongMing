// 110 模型连接：真实配置HTTP与DSH，凭据只用独立环境的假Key，不写入报告。
import { randomUUID } from 'node:crypto'
import type { ClientGateway } from '../../contracts/client'
import type { GraphRunPlan } from '../../contracts/graph-run'
import { expect, test, workspaceCreateActor, workspaceLogin, workspaceOpenMap } from './workspace-fixture'

const workspaceKey = 'ui-workspace-model-key', agentKey = 'ui-agent-model-key'

async function openWorkspaceModels(
  /* 当前环境的正常浏览器页面。 */ page: Parameters<typeof workspaceLogin>[0],
) {
  // 模型连接属于当前工作区管理，不经全局设置或页面内状态注入。
  await page.getByRole('button', { name: '管理工作台', exact: true }).click()
  return page.getByRole('region', { name: '工作区模型调用', exact: true })
}

async function startClaim(
  /* 真实公共网关，准备输入并启动已发布的核查转换。 */ gateway: ClientGateway,
  /* 当前用例自己的工作区。 */ workspaceId: string,
) {
  // 不以数据库字段或模型模拟器创建产物；只有输入由正式命令预置。
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const mapId = randomUUID(), nodeId = randomUUID()
  await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: workspace.revision, id: mapId, name: '110 模型连接验收' })
  await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [nodeId], expectedVersion: null },
    changes: { nodes: { put: [{ id: nodeId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '110 独立模型配置仍产生正式核查结果。', category: 'data' } }] } } })
  const branch = await gateway.read('branch.get', { mapId, rootIds: [nodeId] })
  const bootstrap = await gateway.read('app.bootstrap', {})
  const claim = bootstrap.metadata.clientLeases === 'none' ? null : await gateway.dispatch(randomUUID(), 'branch.claim', { mapId, rootIds: [nodeId], holderId: randomUUID() })
  if (claim && claim.data.status !== 'claimed') throw new Error('模型验收没有取得输入分支')
  const plan: GraphRunPlan = { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 },
    dependsOn: [], input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [nodeId] } }],
    context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] }
  const runId = randomUUID()
  await gateway.dispatch(randomUUID(), 'run.start', { mapId, id: runId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    ...(claim?.data.status === 'claimed' ? { lease: { leaseId: claim.data.grant.leaseId, holderId: claim.data.grant.holderId, fence: claim.data.grant.fence } } : {}),
    scope: { nodeIds: [nodeId] }, plan, mode: 'auto' })
  return { mapId, runId }
}

test('110 工作区保存模型连接后不回显Key，重新读取保留配置状态', async ({ page, webUrl, environment, gateway }) => {
  // 保存和读回走真实HTTP；密码控件随后必须清空，而非回填掩码或明文。
  await workspaceLogin(page, webUrl, environment.token)
  let editor = await openWorkspaceModels(page)
  await expect(editor).toBeVisible()
  await editor.getByLabel('模型名称', { exact: true }).fill('deepseek-flash')
  await editor.getByLabel('API Key', { exact: true }).fill(workspaceKey)
  await editor.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(editor.getByRole('status')).toContainText('模型调用配置已保存')
  await expect(editor.getByLabel('API Key', { exact: true })).toHaveValue('')
  await expect(editor).toContainText('已配置')
  const saved = await gateway.read('model.get', { scope: { kind: 'workspace', workspaceId: environment.workspaceId } })
  expect(JSON.stringify(saved).includes(workspaceKey)).toBe(false)
  expect(saved.apiKeyConfigured).toBe(true)
  await page.getByRole('button', { name: '关闭管理面板', exact: true }).click()
  editor = await openWorkspaceModels(page)
  await expect(editor.getByLabel('模型名称', { exact: true })).toHaveValue('deepseek-flash')
  await expect(editor).toContainText('已配置')
  await expect(editor.getByLabel('API Key', { exact: true })).toHaveValue('')
})

test('110 Agent独立模型与Key覆盖工作区，正式运行使用两层对应凭据', async ({ page, webUrl, environment, gateway }) => {
  // 即便转换精确版本未重发，新的调用策略也应在新Run冻结，并由实际模型HTTP接收。
  const workspace = await gateway.read('workspace.get', { workspaceId: environment.workspaceId })
  const router = workspace.agents.find(agent => agent.kind === 'verifyRoute')
  if (!router) throw new Error('模型验收没有核查路由配置')
  await workspaceLogin(page, webUrl, environment.token)
  await openWorkspaceModels(page)
  await page.getByRole('dialog', { name: '工作台管理', exact: true }).getByRole('button', { name: '智能体配置', exact: true }).click()
  const agents = page.getByRole('region', { name: '智能体管理', exact: true })
  await agents.getByRole('button', { name: new RegExp(`^${router.name} `) }).click()
  const editor = page.getByRole('region', { name: '智能体模型调用', exact: true })
  await expect(editor).toContainText('工作区')
  await editor.getByLabel('模型名称', { exact: true }).fill('fixture-agent-model')
  await editor.getByLabel('API Key', { exact: true }).fill(agentKey)
  await editor.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(editor.getByRole('status')).toContainText('模型调用配置已保存')
  await expect(editor.getByLabel('API Key', { exact: true })).toHaveValue('')
  const { mapId, runId } = await startClaim(gateway, environment.workspaceId)
  await expect.poll(async () => (await gateway.read('map.get', { mapId })).runs.find(run => run.id === runId)?.status, { timeout: 45_000 }).toBe('completed')
  expect(environment.modelConnections.some(item => item.role === 'router' && item.credential === 'agent' && item.model === 'fixture-agent-model')).toBe(true)
  expect(environment.modelConnections.some(item => item.role === 'worker' && item.credential === 'workspace')).toBe(true)
  expect(environment.modelConnections.some(item => item.credential === 'other')).toBe(false)
  await editor.getByRole('button', { name: '继承工作区 Key', exact: true }).click()
  await expect(editor.getByRole('status')).toContainText('模型调用配置已保存')
  await expect.poll(async () => (await gateway.read('model.get', { scope: { kind: 'agent', workspaceId: environment.workspaceId, agentId: router.id } })).apiKeyConfigured).toBe(false)
  const inherited = await gateway.read('model.get', { scope: { kind: 'agent', workspaceId: environment.workspaceId, agentId: router.id } })
  expect(inherited.apiKeyConfigured).toBe(false)
  expect(inherited.effective.apiKeySource).toBe('workspace')
})

test('110 编辑者与只读成员只能查看脱敏模型状态', async ({ browser, webUrl, environment }) => {
  // 各成员使用自己令牌，不能借Owner身份隐藏绕过配置编辑权限。
  for (const role of ['editor', 'viewer'] as const) {
    const actor = await workspaceCreateActor(environment, role, environment.workspaceId)
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await workspaceLogin(page, webUrl, actor.token)
      const editor = await openWorkspaceModels(page)
      await expect(editor).toBeVisible()
      await expect(editor.getByLabel('API Key', { exact: true })).not.toBeVisible()
      await expect(editor.getByRole('button', { name: '保存模型配置', exact: true })).not.toBeVisible()
      await expect(editor).toContainText('所有者')
    } finally { await context.close() }
  }
})

test('110 未配置Key的工作区在开始运行前明确提示，不创建失败任务', async ({ page, webUrl, environment, gateway }) => {
  // 新工作区没有从共享库或服务器复制凭据，缺配置应留在启动表单纠正。
  const workspaceId = randomUUID(), mapId = randomUUID(), nodeId = randomUUID()
  const created = await gateway.dispatch(randomUUID(), 'workspace.create', { id: workspaceId, name: '110 尚未配置模型', description: '', agentSource: 'library' })
  await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: created.data.revision, id: mapId, name: '110 缺少模型Key' })
  await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [nodeId], expectedVersion: null },
    changes: { nodes: { put: [{ id: nodeId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '110 缺配置时不得启动模型。', category: null } }] } } })
  await workspaceLogin(page, webUrl, environment.token)
  await page.getByLabel('当前工作区', { exact: true }).selectOption(workspaceId)
  await workspaceOpenMap(page, '110 缺少模型Key')
  await page.getByRole('button', { name: '运行转换', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '运行数据转换', exact: true })
  await dialog.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.verify-claim@1')
  await dialog.getByRole('button', { name: '全选符合条件的节点', exact: true }).click()
  await dialog.getByRole('button', { name: '开始处理', exact: true }).click()
  await expect(dialog.getByRole('alert').filter({ hasText: 'API Key' })).toBeVisible()
  expect((await gateway.read('map.get', { mapId })).runs).toHaveLength(0)
  expect(environment.modelConnections).toHaveLength(0)
})
