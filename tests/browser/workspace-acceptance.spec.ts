// 工作区产品验收：真实页面写入、独立授权核对，以及同一数据的跨会话重新进入。
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Locator, Page, Request, Route } from '@playwright/test'
import { clientCreateGateway } from '../../client/graph-client'
import type { ClientGateway } from '../../contracts/client'
import type { DefinitionPackage } from '../../contracts/data-definition'
import type { EvidenceLibraryEntry } from '../../contracts/evidence-library'
import type { GraphNode, GraphNodeInput } from '../../contracts/graph'
import type { GraphSnapshot, GraphSuccess, GraphWriteResult } from '../../contracts/graph-api'
import type { GraphBranchLeaseProof } from '../../contracts/graph-branch'
import type { GraphRunPlan } from '../../contracts/graph-run'
import {
  expect,
  test,
  workspaceCreateActor,
  workspaceConnectPage,
  workspaceLogin,
  workspaceOpenMap,
} from './workspace-fixture'

interface GraphLabelPosition {
  title: string
  left: number
  top: number
}

enum WorkspaceAcceptanceMessage {
  SAVED_NODE_MISSING = '工作区验收未找到已保存节点。',
  CREATED_WORKSPACE_MISSING = '界面创建的工作区没有出现在公共目录。',
  CREATED_MAP_MISSING = '界面创建的数据图没有出现在公共目录。',
  CREATED_NODE_MISSING = '界面创建的数据没有出现在真实后端。',
  READING_IDENTITIES_MISSING = '验收节点身份生成失败。',
  PERMISSION_CLAIM_MISSING = '权限验收的事实节点准备失败。',
  BOOTSTRAP_METADATA_MISSING = '服务能力验收未取得真实启动元数据。',
  MANAGEMENT_CLAIM_BUSY = '数据图管理验收未能取得真实分支占用。',
  CREATED_RELATION_MISSING = '关系编辑验收未找到界面保存的关系。',
  COLLECTED_ENTRY_MISSING = '收录依据验收未找到界面保存的条目。',
  BASIS_DOWNLOAD_MISSING = '收录依据验收没有取得真实文件下载。',
  REVIEW_BRANCH_BUSY = '审核验收未能取得独占运行分支。',
  RESULT_REVIEW_MISSING = '审核验收未取得本次结果审核身份。',
  HISTORY_BRANCH_BUSY = '运行历史验收未能取得启动分支。',
  HISTORY_CONTROL_MISSING = '运行历史验收未能核对当前运行控制证明。',
  PROVENANCE_OPERATION_MISSING = '来源验收未找到真实生成或复用处理项。',
  PROVENANCE_OUTPUT_MISSING = '来源验收未找到真实生成的核查结论。',
  DEFINITION_PACKAGE_MISSING = '定义中心验收未找到现有精确包。',
  BINDING_TRANSITION_MISSING = '智能体绑定验收未找到原核查转换。',
  BINDING_AGENT_MISSING = '智能体绑定验收未找到原配置或保存的新配置。',
  COMPOSER_RUN_MISSING = '统一运行草稿验收未找到界面实际创建的运行。',
  COMPOSER_SOURCE_MISSING = '多步骤运行验收未找到真实来源端口或处理项。',
}

function workspaceReadRequestMethod(
  /* 浏览器实际发出的公共查询或命令，不读取认证头和私有请求参数。 */ request: Request,
): string {
  // 仅投影方法名称，以验证禁用能力时不会发出对应业务请求。
  if (request.method() !== 'POST' || !/\/api\/v1\/(query|command)$/.test(request.url())) return ''
  const body: unknown = request.postDataJSON()
  return body !== null && typeof body === 'object' && 'method' in body && typeof body.method === 'string' ? body.method : ''
}

/**
 * 取得公开表单的正文控件，不读取 Vue 状态，也不以字号或字段顺序寻找正文。
 *
 * @param container 添加数据对话框或节点详情等有界表单区域。
 */
function workspaceContentInput(
  /* 添加数据或节点详情中已经限定范围的真实表单区域。 */ container: Locator,
): Locator {
  // 以字段组的公开中文语义取得正文输入框。
  return container.getByRole('group', { name: '正文', exact: true }).getByRole('textbox')
}

/**
 * 仅为阅读、权限旅程准备空图；创建旅程 A01 不调用此助手。
 *
 * @param gateway 拥有目标工作区编辑权限的真实公共客户端。
 * @param workspaceId 已由测试准备的真实工作区身份。
 * @param name 页面需要打开的数据图名称。
 */
async function workspacePrepareMap(
  /* 已认证且有目标工作区编辑权限的独立公共客户端。 */ gateway: ClientGateway,
  /* 阅读旅程预置空图所归属的真实工作区身份。 */ workspaceId: string,
  /* 用户随后通过侧栏寻找的数据图展示名称。 */ name: string,
): Promise<GraphSnapshot> {
  // 使用当前工作区版本，通过真实公共命令建立阅读测试需要的空图。
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const created = await gateway.dispatch(randomUUID(), 'map.create', {
    workspaceId, expectedRevision: workspace.revision, id: randomUUID(), name,
  })
  return created.data.snapshot
}

/**
 * 在真实后端准备单节点阅读材料；被测的保存操作仍全部通过页面完成。
 *
 * @param gateway 拥有目标工作区编辑权限的真实公共客户端。
 * @param workspaceId 已存在且当前调用者可写的工作区身份。
 * @param name 页面用来识别目标图的展示名称。
 * @param content 供身份隔离和全文核对使用的独特事实正文。
 */
async function workspacePrepareClaim(
  /* 用公共命令准备阅读材料且拥有编辑权限的真实客户端。 */ gateway: ClientGateway,
  /* 已存在的目标工作区身份，不替创建旅程建立工作区。 */ workspaceId: string,
  /* 页面导航用来识别预置图的展示名称。 */ name: string,
  /* 用于独立核对和隔离检查的完整事实正文。 */ content: string,
): Promise<GraphSnapshot> {
  // 预置一个采用生产精确类型的事实，保留后续界面保存作为被测动作。
  const snapshot = await workspacePrepareMap(gateway, workspaceId, name)
  const node: GraphNodeInput = {
    id: randomUUID(), typeId: 'factcheck.claim', typeVersion: 1,
    payload: { content, category: 'data' },
  }
  return (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: snapshot.mapId, branch: { rootIds: [node.id], expectedVersion: null },
    changes: { nodes: { put: [node] } },
  })).data.snapshot
}

async function workspacePrepareNews(
  /* 已认证的真实公共客户端，只用于准备本例新闻材料。 */ gateway: ClientGateway,
  /* 当前测试独占的真实工作区。 */ workspaceId: string,
  /* 供正常依据选择器选择的跨Map展示名称。 */ name: string,
  /* 随后核对固定版本的原始新闻全文。 */ content: string,
): Promise<GraphSnapshot> {
  // 建立无任何连线的真实新闻，证明节点依据不限于Claim类型。
  const map = await workspacePrepareMap(gateway, workspaceId, name)
  const id = randomUUID()
  return (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: map.mapId, branch: { rootIds: [id], expectedVersion: null },
    changes: { nodes: { put: [{ id, typeId: 'factcheck.news', typeVersion: 1, payload: { content, context: {} } }] } },
  })).data.snapshot
}

async function workspaceSelectLibraryEntry(
  /* 已打开证据库数据图模式的正常页面。 */ page: Page,
  /* 当前工作区中唯一匹配目标条目的原陈述。 */ content: string,
): Promise<void> {
  // 正常清除旧邻域选择、检索唯一条目，再用场景键盘选择库根。
  const library = page.getByRole('region', { name: '工作区证据库', exact: true })
  const scene = library.getByRole('group', { name: '证据库数据图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await scene.focus()
  await scene.press('Escape')
  const filters = library.getByRole('form', { name: '证据库筛选', exact: true })
  await filters.getByRole('searchbox', { name: '关键词', exact: true }).fill(content)
  await filters.getByRole('button', { name: '检索', exact: true }).click()
  await expect(filters.getByRole('button', { name: '检索', exact: true })).toBeEnabled()
  await expect(library).toContainText('已加载 1 条')
  await scene.focus()
  await scene.press('ArrowRight')
}

async function workspaceSubmitCollection(
  /* 已选中当前事实的正常关系图页面。 */ page: Page,
  /* 用户明确选择的二值判断，表单会转换为协议数字。 */ confidence: '0' | '1',
  /* 本次收录理由；其他范围和依据保留表单的空值默认。 */ reason: string,
): Promise<void> {
  // 从公开表单提交当前版本的收录意图，成功或恢复的等待由具体旅程核对。
  await page.getByRole('button', { name: '收录到证据库', exact: true }).click()
  const collection = page.getByRole('dialog', { name: '收录到证据库', exact: true })
  await collection.getByRole('radio', { name: new RegExp(confidence === '0' ? '0 · 确定错误' : '1 · 确定正确') }).check()
  await collection.getByLabel('收录理由', { exact: true }).fill(reason)
  await collection.getByRole('button', { name: '确认收录', exact: true }).click()
}

/**
 * 在公开三维画布中用键盘选中首个节点，确保没有以私有选择状态代替用户操作。
 *
 * @param page 当前已打开目标数据图的真实浏览器页面。
 */
async function workspaceSelectFirstNode(
  /* 当前已经通过真实侧栏打开目标图的浏览器页面。 */ page: Page,
): Promise<void> {
  // 清空既有选择，再以真实键盘事件选择场景中的首个节点。
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await expect(scene).toBeVisible()
  await scene.focus()
  await scene.press('Escape')
  await scene.press('ArrowRight')
}

/**
 * 等待已注册类型和分支证明出现，协作模式通过真实按钮领取编辑权。
 *
 * @param page 当前选中待编辑节点的页面。
 * @param leasesRequired 服务端 bootstrap 给出的真实客户端租约策略。
 */
async function workspaceAcquireEditor(
  /* 已选中待编辑节点且由测试用户正常登录的页面。 */ page: Page,
  /* 服务端明确要求客户端租约时为真，本机无租约策略时为假。 */ leasesRequired: boolean,
): Promise<void> {
  // 依服务端策略取得真实编辑权，并等待正文控件进入可编辑状态。
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  if (leasesRequired) {
    const claim = inspector.getByRole('button', { name: '领取分支编辑权', exact: true })
    await expect(claim).toBeEnabled()
    await claim.click()
    await expect(inspector.getByRole('button', { name: '释放分支编辑权', exact: true })).toBeVisible()
  }
  await expect(workspaceContentInput(inspector)).toBeEditable()
}

/**
 * 从独立公共读取中取得已知节点；身份不存在时明确失败，避免误用第一个节点。
 *
 * @param snapshot 独立授权客户端取得的真实图快照。
 * @param nodeId 本旅程已经记录的稳定节点身份。
 */
function workspaceReadNode(
  /* 独立授权公共查询返回的真实图快照。 */ snapshot: GraphSnapshot,
  /* 本旅程先前记录、必须继续存在的图内稳定节点身份。 */ nodeId: string,
): GraphNode {
  // 核对已保存节点的稳定身份，缺失时报告具体的验收边界。
  const node = snapshot.nodes.find((/* 当前快照中的真实节点。 */ item) => /* 按完整图内身份匹配。 */ item.id === nodeId)
  if (!node) throw new Error(WorkspaceAcceptanceMessage.SAVED_NODE_MISSING)
  return node
}

async function workspaceRenameCurrentMap(
  /* 已正常登录并打开目标图的真实页面。 */ page: Page,
  /* 用户明确提交的新名称，不变更图或节点身份。 */ name: string,
): Promise<void> {
  // 通过当前图工具栏改名，并确认工具栏、侧栏和已打开标签都接纳新名称。
  await page.getByRole('button', { name: '改名', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '修改数据图名称', exact: true })
  await dialog.getByLabel('数据图名称', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.view-label strong')).toHaveText(name)
  await expect(page.getByRole('navigation', { name: '当前工作区的数据图', exact: true })
    .getByText(name, { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '打开的数据图', exact: true })
    .getByRole('button', { name, exact: true })).toBeVisible()
}

/**
 * 只观测公开 DOM 标签的投影位置，作为返回后相机行为的黑盒证据。
 *
 * @param page 当前展示真实三维关系图的页面。
 */
async function workspaceReadGraphLabels(
  /* 当前可见三维关系图所在的真实页面，只观测其公开 DOM。 */ page: Page,
): Promise<GraphLabelPosition[]> {
  // 将公开标签位置投影成稳定黑盒观察值，供往返前后比较。
  return page.locator('.graph-3d .scene-label').evaluateAll((/* 真实画布已经绘制的可见标签元素。 */ elements) => {
    // 使用 DOM 内联位置，不访问 Three 场景、相机对象或组件实例。
    return elements.map((/* 单个公开标签。 */ element) => {
      // 读取单个标签的公开文字和像素位置，并消除亚像素抖动。
      const style = (element as HTMLElement).style
      return {
        title: element.textContent ?? '',
        left: Math.round(Number.parseFloat(style.left)),
        top: Math.round(Number.parseFloat(style.top)),
      }
    }).sort((/* 左侧标签位置。 */ left, /* 右侧标签位置。 */ right) => /* 同类型标签按投影位置稳定排序。 */
      left.title.localeCompare(right.title) || left.left - right.left || left.top - right.top)
  })
}

/**
 * 从空普通账号开始创建、修改并重新进入同一份已保存数据。
 */
test('M00-A01 空账号通过界面创建并保存，关闭旧会话后保留原身份和全文', async (
  /* 当前用例独占的真实页面、浏览器和后端环境，不注入业务状态。 */ { page, browser, environment, webUrl },
) => {
  // 从普通空账号完成界面创建、修改、退出，并在新 context 核对原始数据。
  const actor = await workspaceCreateActor(environment)
  const verification = clientCreateGateway({ baseUrl: environment.baseUrl })
  await verification.connect({ baseUrl: environment.baseUrl, token: actor.token, remember: false })
  try {
    const bootstrap = await verification.read('app.bootstrap', {})
    expect(bootstrap.identity.userId).toBe(actor.userId)
    expect(bootstrap.identity.hostAdmin).toBe(false)
    expect((await verification.read('workspace.list', {})).items).toHaveLength(0)

    await workspaceLogin(page, webUrl, actor.token)
    await expect(page.getByText('还没有工作区。', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '创建工作区', exact: true }).first().click()
    const workspaceDialog = page.getByRole('dialog', { name: '创建工作区', exact: true })
    await workspaceDialog.getByLabel('工作区名称', { exact: true }).fill('A01 纸面核查工作区')
    await workspaceDialog.getByLabel('工作区说明', { exact: true }).fill('从普通空账号通过界面建立，重新连接后继续阅读。')
    await workspaceDialog.getByRole('button', { name: '创建工作区', exact: true }).click()
    await expect(workspaceDialog).not.toBeVisible()

    const directory = await verification.read('workspace.list', {})
    expect(directory.items).toHaveLength(1)
    const workspace = directory.items[0]
    if (!workspace) throw new Error(WorkspaceAcceptanceMessage.CREATED_WORKSPACE_MISSING)
    expect(workspace).toMatchObject({ name: 'A01 纸面核查工作区', role: 'owner' })
    await expect(page.getByRole('combobox', { name: '当前工作区', exact: true })).toHaveValue(workspace.id)

    await page.getByRole('button', { name: '创建第一张数据图', exact: true }).click()
    const mapDialog = page.getByRole('dialog', { name: '创建数据图', exact: true })
    await mapDialog.getByLabel('数据图名称', { exact: true }).fill('A01 原始事实')
    await mapDialog.getByRole('button', { name: '创建数据图', exact: true }).click()
    await expect(mapDialog).not.toBeVisible()

    const maps = await verification.read('map.list', { workspaceId: workspace.id })
    expect(maps).toHaveLength(1)
    const map = maps[0]
    if (!map) throw new Error(WorkspaceAcceptanceMessage.CREATED_MAP_MISSING)
    const initialContent = 'A01 事实正文第一行。\n这是一段必须完整保存的原始材料。\n末行标记：原始正文结束。'
    await page.getByRole('button', { name: '＋ 数据', exact: true }).click()
    const nodeDialog = page.getByRole('dialog', { name: '添加数据', exact: true })
    await nodeDialog.getByRole('combobox', { name: /^数据类型/ }).selectOption('factcheck.claim@1')
    await workspaceContentInput(nodeDialog).fill(initialContent)
    await nodeDialog.getByRole('button', { name: '添加数据', exact: true }).click()
    await expect(nodeDialog).not.toBeVisible()

    const created = await verification.read('map.get', { mapId: map.id })
    expect(created.nodes).toHaveLength(1)
    const originalNode = created.nodes[0]
    if (!originalNode) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
    expect(originalNode).toMatchObject({ typeId: 'factcheck.claim', typeVersion: 1, revision: 0, payload: { content: initialContent } })

    await workspaceAcquireEditor(page, bootstrap.metadata.clientLeases !== 'none')
    const inspector = page.getByRole('region', { name: '数据详情', exact: true })
    const savedContent = `${initialContent}\n补充保存行：该内容来自真实页面修改，结束标记 A01。`
    await workspaceContentInput(inspector).fill(savedContent)
    await inspector.getByRole('button', { name: '保存数据', exact: true }).click()
    await expect(inspector.getByText('未保存', { exact: true })).toHaveCount(0)
    const confirmed = await verification.read('map.get', { mapId: map.id })
    const savedNode = workspaceReadNode(confirmed, originalNode.id)
    expect(savedNode).toMatchObject({ typeId: originalNode.typeId, typeVersion: originalNode.typeVersion, revision: originalNode.revision + 1 })
    expect(savedNode.payload.content).toBe(savedContent)
    expect(confirmed.workspaceId).toBe(workspace.id)
    expect(confirmed.mapId).toBe(map.id)

    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '登录账户', exact: true })).toBeVisible()
    await page.context().close()
    const renewedContext = await browser.newContext()
    try {
      const renewedPage = await renewedContext.newPage()
      await workspaceLogin(renewedPage, webUrl, actor.token)
      await renewedPage.getByRole('combobox', { name: '当前工作区', exact: true }).selectOption(workspace.id)
      await workspaceOpenMap(renewedPage, map.name)
      await workspaceSelectFirstNode(renewedPage)
      await expect(workspaceContentInput(renewedPage.getByRole('region', { name: '数据详情', exact: true }))).toHaveValue(savedContent)
      await renewedPage.getByRole('button', { name: '单页', exact: true }).click()
      const article = renewedPage.getByRole('region', { name: '节点完整内容', exact: true })
      await expect(article.getByText(savedContent, { exact: true })).toBeVisible()
      const reopened = await verification.read('map.get', { mapId: map.id })
      expect(workspaceReadNode(reopened, originalNode.id)).toEqual(savedNode)
      expect(reopened.mapId).toBe(confirmed.mapId)
      expect(reopened.workspaceId).toBe(confirmed.workspaceId)
    } finally {
      await renewedContext.close()
    }
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    await verification.disconnect()
  }
})

/**
 * 在真实关系图中阅读新闻及事实，再沿既有关系往返并检查全文与视角。
 */
test('M00-A02 关系图与单页沿真实关系往返，保留全文、选中节点和视角', async (
  /* 当前用例的真实页面、独立准备客户端及隔离后端。 */ { page, gateway, environment, webUrl },
) => {
  // 沿真实新闻到事实的结构关系阅读，再核对选择、全文和图内投影均正确恢复。
  const map = await workspacePrepareMap(gateway, environment.workspaceId, 'A02 来源与事实')
  const [newsId, claimId] = [randomUUID(), randomUUID()].sort()
  if (!newsId || !claimId) throw new Error(WorkspaceAcceptanceMessage.READING_IDENTITIES_MISSING)
  const newsContent = 'A02 新闻：河流监测报告。\n第一行材料记录监测站名称。\n第三行材料记录取样日期。\n新闻全文结束标记：没有省略后半部分。'
  const claimContent = 'A02 事实：报告记录了具体监测站和取样日期。\n事实独立正文结束。'
  const prepared = (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: map.mapId, branch: { rootIds: [newsId], expectedVersion: null },
    changes: {
      nodes: { put: [
        { id: newsId, typeId: 'factcheck.news', typeVersion: 1, payload: {
          content: newsContent, context: { 采集说明: { value: 'A02 只用于阅读的上下文材料。', visibleToAI: true } },
        } },
        { id: claimId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: claimContent, category: 'data' } },
      ] },
      edges: { put: [{ id: randomUUID(), kind: 'successor', from: newsId, to: claimId, label: 'A02 新闻提取事实' }] },
    },
  })).data.snapshot
  expect(prepared.edges).toHaveLength(1)
  expect(prepared.edges[0]).toMatchObject({ from: newsId, to: claimId, kind: 'successor' })

  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  await expect(workspaceContentInput(inspector)).toHaveValue(newsContent)
  await expect(page.locator('.graph-3d .scene-label')).toHaveCount(2)
  const originalProjection = await workspaceReadGraphLabels(page)
  await page.getByRole('button', { name: '放大三维关系图', exact: true }).click()
  await expect.poll(async () => /* 等待公开标签投影响应真实缩放。 */ workspaceReadGraphLabels(page)).not.toEqual(originalProjection)
  await expect(page.locator('.graph-3d .scene-label')).toHaveCount(2)
  const zoomedProjection = await workspaceReadGraphLabels(page)
  expect(zoomedProjection).toHaveLength(2)
  for (const position of zoomedProjection) {
    expect(Number.isFinite(position.left) && Number.isFinite(position.top)).toBe(true)
  }

  await page.getByRole('button', { name: '单页', exact: true }).click()
  const reader = page.getByRole('region', { name: '单页阅读', exact: true })
  const article = reader.getByRole('region', { name: '节点完整内容', exact: true })
  await expect(article.getByText(newsContent, { exact: true })).toBeVisible()
  await expect(article).toContainText('A02 只用于阅读的上下文材料。')
  const related = reader.getByRole('complementary', { name: '关联材料', exact: true })
  await expect(related).toContainText('结构关系')
  await expect(related).toContainText('结构后继')
  await related.getByRole('button', { name: '事实', exact: true }).click()
  await expect(article.getByText(claimContent, { exact: true })).toBeVisible()
  await expect(article.getByText(newsContent, { exact: true })).toHaveCount(0)
  await expect(related).toContainText('结构前置')
  await expect(related.getByRole('button', { name: '新闻', exact: true })).toBeVisible()
  await reader.getByRole('button', { name: '返回关系图', exact: true }).click()
  await expect(workspaceContentInput(inspector)).toHaveValue(claimContent)
  await expect(page.locator('.graph-3d .scene-label')).toHaveCount(2)
  await expect.poll(async () => /* 返回后同尺寸标签应恢复到离开前的真实投影位置。 */ workspaceReadGraphLabels(page)).toEqual(zoomedProjection)
  await expect(page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })).toBeFocused()

  const confirmed = await gateway.read('map.get', { mapId: map.mapId })
  expect(confirmed.nodes).toEqual(prepared.nodes)
  expect(confirmed.edges).toEqual(prepared.edges)
  expect(workspaceReadNode(confirmed, newsId).payload.content).toBe(newsContent)
  expect(workspaceReadNode(confirmed, claimId).payload.content).toBe(claimContent)
  expect(environment.modelCalls).toHaveLength(0)
})

/**
 * 错误凭据后恢复连接，并在同一浏览器 context 换账号验证内容与草稿隔离。
 */
test('M00-A03 错误令牌可恢复，同一浏览器换账号后清除旧材料、选择和草稿', async (
  /* 同一浏览器 context 的页面及当前用例独占的真实身份服务。 */ { page, gateway, environment, webUrl },
) => {
  // 在同一 context 恢复错误登录并更换身份，检查权限和未保存资料的隔离。
  const oldContent = 'A03 账号甲专属事实正文，账号乙没有查看权限。'
  const oldDraft = 'A03 未保存草稿哨兵，切换账号后不得残留。'
  const firstMap = await workspacePrepareClaim(gateway, environment.workspaceId, 'A03 账号甲资料图', oldContent)
  const secondActor = await workspaceCreateActor(environment)
  const secondGateway = clientCreateGateway({ baseUrl: environment.baseUrl })
  await secondGateway.connect({ baseUrl: environment.baseUrl, token: secondActor.token, remember: false })
  try {
    const secondWorkspaceId = randomUUID()
    await secondGateway.dispatch(randomUUID(), 'workspace.create', {
      id: secondWorkspaceId, name: 'A03 账号乙独立工作区', description: '验证同一浏览器更换身份后的权限隔离。', agentSource: 'library',
    })
    const secondContent = 'A03 账号乙自己的事实正文。'
    const secondMap = await workspacePrepareClaim(secondGateway, secondWorkspaceId, 'A03 账号乙资料图', secondContent)

    await page.goto(webUrl)
    // 公开时间原点只在 Document 重建时变化；正常 hash 路由变化不算页面重载。
    const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin)
    await page.getByText('使用访问令牌', { exact: true }).click()
    await page.getByLabel('服务地址', { exact: true }).fill(webUrl)
    await page.getByLabel('用户访问令牌', { exact: true }).fill('m00-invalid-credential')
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0)
    await workspaceConnectPage(page, webUrl, environment.token)
    await workspaceOpenMap(page, firstMap.name)
    await workspaceSelectFirstNode(page)
    const firstBootstrap = await gateway.read('app.bootstrap', {})
    await workspaceAcquireEditor(page, firstBootstrap.metadata.clientLeases !== 'none')
    await workspaceContentInput(page.getByRole('region', { name: '数据详情', exact: true })).fill(oldDraft)
    await expect(page.getByText('未保存', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '登录账户', exact: true })).toBeVisible()

    await workspaceConnectPage(page, webUrl, secondActor.token)
    await expect(page.getByRole('combobox', { name: '当前工作区', exact: true })).toHaveValue(secondWorkspaceId)
    await expect(page.getByRole('combobox', { name: '当前工作区', exact: true }).getByRole('option', { name: '重明 · 核查验收', exact: true })).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: '打开的数据图', exact: true }).getByRole('button', { name: firstMap.name, exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '单页', exact: true })).toBeDisabled()
    await expect(page.getByText('未保存', { exact: true })).toHaveCount(0)
    await workspaceOpenMap(page, secondMap.name)
    await workspaceSelectFirstNode(page)
    await expect(workspaceContentInput(page.getByRole('region', { name: '数据详情', exact: true }))).toHaveValue(secondContent)
    await page.getByRole('button', { name: '单页', exact: true }).click()
    const article = page.getByRole('region', { name: '节点完整内容', exact: true })
    await expect(article.getByText(secondContent, { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText(oldContent)
    await expect(page.locator('body')).not.toContainText(oldDraft)
    // 同时检查隐藏表单的公开控件值，防止草稿只是在视觉上被藏起。
    const remainingDrafts: string[] = []
    for (const field of await page.locator('textarea').all()) remainingDrafts.push(await field.inputValue())
    expect(remainingDrafts).not.toContain(oldDraft)
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentTimeOrigin)
    expect((await secondGateway.read('workspace.list', {})).items.map((/* 乙有权访问的工作区概况。 */ item) => /* 比较公开目录身份。 */ item.id)).toEqual([secondWorkspaceId])
    // 非成员按真实授权合同隐藏工作区存在性；只读成员越权写入才是 403。
    await expect(secondGateway.read('map.get', { mapId: firstMap.mapId })).rejects.toMatchObject({ status: 404, code: 'WORKSPACE_NOT_FOUND' })
    const firstConfirmed = await gateway.read('map.get', { mapId: firstMap.mapId })
    expect(firstConfirmed.nodes).toEqual(firstMap.nodes)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    await secondGateway.disconnect()
  }
})

/**
 * 编辑者在 UI 提交后，独立只读 context 和独立公共 API 均遵守同一权限规则。
 */
test('M00-A04 编辑者界面保存后只读成员看见同一版本，界面与公共接口均拒绝写入', async (
  /* 当前用例提供的两个浏览器角色环境及独立授权核对客户端。 */ { page, browser, gateway, environment, webUrl, storage },
) => {
  // 让编辑者通过页面提交，再从只读角色的页面与公共 API 交叉核对权限。
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'A04 共享核查图', 'A04 编辑前的事实。')
  const originalNode = map.nodes[0]
  if (!originalNode) throw new Error(WorkspaceAcceptanceMessage.PERMISSION_CLAIM_MISSING)
  const editor = await workspaceCreateActor(environment, 'editor', environment.workspaceId)
  const viewer = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
  const viewerGateway = clientCreateGateway({ baseUrl: environment.baseUrl })
  await viewerGateway.connect({ baseUrl: environment.baseUrl, token: viewer.token, remember: false })
  try {
    await workspaceLogin(page, webUrl, editor.token)
    await workspaceOpenMap(page, map.name)
    await workspaceSelectFirstNode(page)
    const bootstrap = await gateway.read('app.bootstrap', {})
    await workspaceAcquireEditor(page, bootstrap.metadata.clientLeases !== 'none')
    const savedContent = 'A04 编辑者通过真实界面保存的全文。\n只读成员必须读到同一版本和结束标记。'
    const editorInspector = page.getByRole('region', { name: '数据详情', exact: true })
    await workspaceContentInput(editorInspector).fill(savedContent)
    await editorInspector.getByRole('button', { name: '保存数据', exact: true }).click()
    await expect(editorInspector.getByText('未保存', { exact: true })).toHaveCount(0)
    const confirmed = await viewerGateway.read('map.get', { mapId: map.mapId })
    const confirmedNode = workspaceReadNode(confirmed, originalNode.id)
    expect(confirmedNode.revision).toBe(originalNode.revision + 1)
    expect(confirmedNode.payload.content).toBe(savedContent)

    const viewerContext = await browser.newContext()
    try {
      const viewerPage = await viewerContext.newPage()
      await workspaceLogin(viewerPage, webUrl, viewer.token)
      await workspaceOpenMap(viewerPage, map.name)
      await workspaceSelectFirstNode(viewerPage)
      const inspector = viewerPage.getByRole('region', { name: '数据详情', exact: true })
      await expect(inspector.getByText('当前为只读权限。', { exact: true })).toBeVisible()
      await expect(workspaceContentInput(inspector)).toHaveValue(savedContent)
      await expect(workspaceContentInput(inspector)).toBeDisabled()
      await expect(inspector).toContainText(`内容版本 ${confirmedNode.revision}`)
      await expect(inspector.getByRole('button', { name: '保存数据', exact: true })).toHaveCount(0)
      await expect(inspector.getByRole('button', { name: '删除节点', exact: true })).toHaveCount(0)
      await expect(viewerPage.getByRole('button', { name: '＋ 数据', exact: true })).toBeDisabled()
      await expect(viewerPage.getByRole('button', { name: '运行转换', exact: true })).toBeDisabled()
      await expect(viewerPage.getByRole('button', { name: '创建数据图', exact: true })).toBeDisabled()
      await expect(viewerPage.getByRole('button', { name: '收录到证据库', exact: true })).toBeDisabled()
      const libraryEntry = viewerPage.locator('.workspace-sidebar').getByRole('button', { name: /^证据库/ })
      if (storage === 'mongo') {
        await expect(libraryEntry).toBeEnabled()
        await libraryEntry.click()
        await expect(viewerPage.getByRole('region', { name: '工作区证据库', exact: true })).toBeVisible()
        await expect(viewerPage.getByRole('button', { name: '撤回条目', exact: true })).toHaveCount(0)
        await workspaceOpenMap(viewerPage, map.name)
        await workspaceSelectFirstNode(viewerPage)
      } else await expect(libraryEntry).toBeDisabled()
      await viewerPage.getByRole('button', { name: '单页', exact: true }).click()
      const article = viewerPage.getByRole('region', { name: '节点完整内容', exact: true })
      await expect(article.getByText(savedContent, { exact: true })).toBeVisible()
      await expect(viewerPage.getByRole('button', { name: '在关系图中编辑', exact: true })).toBeDisabled()
      await viewerPage.getByRole('button', { name: '返回关系图', exact: true }).click()
      await expect(workspaceContentInput(inspector)).toHaveValue(savedContent)

      const branch = await viewerGateway.read('branch.get', { mapId: map.mapId, rootIds: [originalNode.id] })
      await expect(viewerGateway.dispatch(randomUUID(), 'graph.apply', {
        mapId: map.mapId, branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
        changes: { nodes: { put: [{
          id: confirmedNode.id, typeId: confirmedNode.typeId, typeVersion: confirmedNode.typeVersion,
          payload: { ...confirmedNode.payload, content: 'A04 只读成员不得写入的内容。' },
        }] } },
      })).rejects.toMatchObject({ status: 403 })
      const afterRejectedWrite = await gateway.read('map.get', { mapId: map.mapId })
      expect(afterRejectedWrite.nodes).toEqual(confirmed.nodes)
      expect(afterRejectedWrite.edges).toEqual(confirmed.edges)
      expect(afterRejectedWrite.revision).toBe(confirmed.revision)
    } finally {
      await viewerContext.close()
    }
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    await viewerGateway.disconnect()
  }
})

test('M01-C02 按真实服务能力开放证据库，旧服务重连后禁用选材且图仍可保存', async (
  /* 沿用两个项目的真实服务、正常页面及公共核对客户端。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 在真实能力与旧服务缺字段两种入口中检查请求边界，同时保持基础图读写可用。
  const content = 'C02 服务能力验收的原始事实。'
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C02 服务能力图', content)
  const originalNode = map.nodes[0]
  if (!originalNode) throw new Error(WorkspaceAcceptanceMessage.PERMISSION_CLAIM_MISSING)
  const bootstrap = await gateway.read('app.bootstrap', {})
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  const libraryEntry = page.locator('.workspace-sidebar').getByRole('button', { name: /^证据库/ })
  const runDialog = page.getByRole('dialog', { name: '运行数据转换', exact: true })
  if (storage === 'mongo') {
    await expect(libraryEntry).toBeEnabled()
    await expect(page.getByRole('button', { name: '收录到证据库', exact: true })).toBeEnabled()
    await gateway.dispatch(randomUUID(), 'evidence.collect', {
      workspaceId: environment.workspaceId,
      claim: { mapId: map.mapId, nodeId: originalNode.id, revision: originalNode.revision },
      confidence: 1,
      applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
      reason: 'C02 明确选择的服务切换验收材料。', basisRefs: [],
    })
    await libraryEntry.click()
    await expect(page.getByRole('region', { name: '工作区证据库', exact: true })).toContainText('已加载 1 条')
    await workspaceOpenMap(page, map.name)
    await workspaceSelectFirstNode(page)
    await page.getByRole('button', { name: '运行转换', exact: true }).click()
    const material = runDialog.getByRole('group', { name: '证据库材料 · 可选', exact: true })
    await expect(material.getByRole('searchbox', { name: '关键词', exact: true })).toBeEnabled()
    await expect(material.getByRole('button', { name: '检索材料', exact: true })).toBeEnabled()
    await material.getByRole('checkbox', { name: new RegExp(content) }).check()
    await expect(material).toContainText('已选 1/32 条')
    await runDialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
  }

  // 仅删除真实启动响应中的可选声明来模拟旧服务，不伪造查询或命令成功。
  await page.route('**/api/v1/query', async (/* 当前浏览器发出的真实公共查询。 */ route) => {
    // 其他查询直通真实后端，旧服务模拟只作用于启动元数据。
    if (workspaceReadRequestMethod(route.request()) !== 'app.bootstrap') return route.continue()
    // 测试读取直达同一真实后端，避免 APIRequestContext 再经 Vite 代理；浏览器请求仍同源。
    const response = await route.fetch({ url: new URL('/api/v1/query', environment.baseUrl).href })
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object' || !('data' in body) || body.data === null
      || typeof body.data !== 'object' || !('metadata' in body.data) || body.data.metadata === null
      || typeof body.data.metadata !== 'object') throw new Error(WorkspaceAcceptanceMessage.BOOTSTRAP_METADATA_MISSING)
    if ('capabilities' in body.data.metadata) delete body.data.metadata.capabilities
    await route.fulfill({ response, json: body })
  })
  const evidenceRequests: string[] = []
  page.on('request', (/* 只观察公开业务方法，不复制令牌或正文。 */ request) => {
    // 关闭能力后任何证据库请求都属于页面越过入口边界。
    const method = workspaceReadRequestMethod(request)
    if (method.startsWith('evidence.')) evidenceRequests.push(method)
  })
  if (storage === 'mongo') {
    // 同页重连到不声明能力的旧服务响应，继续复用正常的同源 API 代理。
    await workspaceConnectPage(page, webUrl, environment.token)
    await workspaceOpenMap(page, map.name)
    await workspaceSelectFirstNode(page)
  }
  await expect(libraryEntry).toBeDisabled()
  await expect(libraryEntry).toContainText('当前服务未提供证据库')
  await expect(page.getByRole('button', { name: '收录到证据库', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '运行转换', exact: true }).click()
  const unavailableMaterial = runDialog.getByRole('group', { name: '证据库材料 · 可选', exact: true })
  await expect(unavailableMaterial.getByRole('searchbox', { name: '关键词', exact: true })).toBeDisabled()
  await expect(unavailableMaterial.getByRole('button', { name: '检索材料', exact: true })).toBeDisabled()
  await expect(unavailableMaterial).toContainText('已选 0/32 条')
  await expect(runDialog.getByText('当前服务未提供证据库', { exact: true })).toBeVisible()
  await runDialog.getByRole('button', { name: '取消', exact: true }).click()
  await workspaceAcquireEditor(page, bootstrap.metadata.clientLeases !== 'none')
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  const savedContent = `${content}\nC02 能力关闭仍可保存图。`
  await workspaceContentInput(inspector).fill(savedContent)
  await inspector.getByRole('button', { name: '保存数据', exact: true }).click()
  await expect(inspector.getByText('未保存', { exact: true })).toHaveCount(0)
  const saved = await gateway.read('map.get', { mapId: map.mapId })
  expect(workspaceReadNode(saved, originalNode.id).payload.content).toBe(savedContent)
  expect(evidenceRequests).toEqual([])
  expect(environment.modelCalls).toHaveLength(0)
})

test('M02-C04 当前图从空图到非空图改名，取消后确认删除且保留其他图与固定证据', async (
  /* 两种真实服务、正常工作台页面及独立授权核对客户端。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 从工具栏完成两次改名和明确删除，独立核对图身份、原节点及已收录固定内容。
  const map = await workspacePrepareMap(gateway, environment.workspaceId, 'C04 待改名的空图')
  const other = await workspacePrepareMap(gateway, environment.workspaceId, 'C04 保留的另一图')
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, other.name)
  await workspaceOpenMap(page, map.name)

  const emptyName = 'C04 已改名的空图'
  await workspaceRenameCurrentMap(page, emptyName)
  const emptyRenamed = await gateway.read('map.get', { mapId: map.mapId })
  expect(emptyRenamed).toMatchObject({ mapId: map.mapId, name: emptyName, nodes: [], edges: [], revision: map.revision + 1 })
  const content = 'C04 删除来源图后仍保留收录时的事实全文。'
  await page.getByRole('button', { name: '＋ 数据', exact: true }).click()
  const nodeDialog = page.getByRole('dialog', { name: '添加数据', exact: true })
  await nodeDialog.getByRole('combobox', { name: /^数据类型/ }).selectOption('factcheck.claim@1')
  await workspaceContentInput(nodeDialog).fill(content)
  await nodeDialog.getByRole('button', { name: '添加数据', exact: true }).click()
  await expect(nodeDialog).not.toBeVisible()
  const populated = await gateway.read('map.get', { mapId: map.mapId })
  expect(populated.nodes).toHaveLength(1)
  const node = populated.nodes[0]
  if (!node) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)

  const finalName = 'C04 已改名的事实图'
  await workspaceRenameCurrentMap(page, finalName)
  const renamed = await gateway.read('map.get', { mapId: map.mapId })
  expect(renamed).toMatchObject({ mapId: map.mapId, name: finalName, revision: populated.revision + 1 })
  expect(renamed.nodes).toEqual(populated.nodes)
  expect(renamed.edges).toEqual(populated.edges)
  let entry: EvidenceLibraryEntry | null = null
  if (storage === 'mongo') {
    entry = (await gateway.dispatch(randomUUID(), 'evidence.collect', {
      workspaceId: environment.workspaceId, claim: { mapId: map.mapId, nodeId: node.id, revision: node.revision },
      confidence: 1, applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
      reason: 'C04 删除来源图前明确收录，验证固定证据独立保留。', basisRefs: [],
    })).data.entry
  }

  await page.getByRole('button', { name: '删除数据图', exact: true }).click()
  const deletion = page.getByRole('dialog', { name: '删除数据图', exact: true })
  await deletion.getByRole('button', { name: '取消', exact: true }).click()
  await expect(deletion).not.toBeVisible()
  expect((await gateway.read('map.get', { mapId: map.mapId })).name).toBe(finalName)
  await page.getByRole('button', { name: '删除数据图', exact: true }).click()
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(deletion).not.toBeVisible()
  await expect(page.getByRole('navigation', { name: '当前工作区的数据图', exact: true })
    .getByText(finalName, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '打开的数据图', exact: true })
    .getByRole('button', { name: finalName, exact: true })).toHaveCount(0)
  await expect(gateway.read('map.get', { mapId: map.mapId })).rejects.toMatchObject({ status: 404 })
  expect(await gateway.read('map.get', { mapId: other.mapId })).toEqual(other)
  expect((await gateway.read('map.list', { workspaceId: environment.workspaceId })).map(
    /* 独立公共目录中的实际图摘要。 */ item => /* 只核对图身份，避免依赖列表顺序。 */ item.id,
  )).toEqual([other.mapId])
  await workspaceOpenMap(page, other.name)

  if (entry) {
    expect(await gateway.read('evidence.get', { workspaceId: environment.workspaceId, entryId: entry.id })).toEqual(entry)
    await page.locator('.workspace-sidebar').getByRole('button', { name: /^证据库/ }).click()
    const library = page.getByRole('region', { name: '工作区证据库', exact: true })
    await expect(library).toContainText('已加载 1 条')
    const scene = library.getByRole('group', { name: '证据库数据图，拖拽旋转、右键平移、滚轮缩放', exact: true })
    await scene.focus()
    await scene.press('ArrowRight')
    const details = page.getByRole('complementary', { name: '证据条目详情', exact: true })
    await details.getByRole('button', { name: '打开固定单页 ↗', exact: true }).click()
    await expect(page.getByLabel('收录时固定的节点全文', { exact: true })).toContainText(content)
    await details.getByRole('button', { name: /^定位来源（原版本/ }).click()
    await expect(page.getByRole('status').filter({ hasText: '当前来源已不可用，证据库仍保留收录时的内容。' })).toBeVisible()
    await expect(page.getByLabel('收录时固定的节点全文', { exact: true })).toContainText(content)
  }
  expect(environment.modelCalls).toHaveLength(0)
})

test('M02-C04 占用阻止当前图改名删除，明确释放后成功且只读成员没有写入口', async (
  /* 同一真实服务中的占用持有人、工作台页面及独立只读浏览器 context。 */
  { page, browser, gateway, environment, webUrl, storage },
) => {
  // 协作服务真实占用后由持有人明确释放；两种服务均核对 Viewer 的页面和公共命令权限。
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C04 占用与只读权限图', 'C04 不得因改名或删除自动释放的事实。')
  const node = map.nodes[0]
  if (!node) throw new Error(WorkspaceAcceptanceMessage.PERMISSION_CLAIM_MISSING)
  let lease: GraphBranchLeaseProof | null = null
  if (storage === 'mongo') {
    const claimed = await gateway.dispatch(randomUUID(), 'branch.claim', {
      mapId: map.mapId, rootIds: [node.id], holderId: randomUUID(),
    })
    if (claimed.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.MANAGEMENT_CLAIM_BUSY)
    const grant = claimed.data.grant
    lease = { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
  }
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  if (lease) {
    await page.getByRole('button', { name: '改名', exact: true }).click()
    const rename = page.getByRole('dialog', { name: '修改数据图名称', exact: true })
    await rename.getByLabel('数据图名称', { exact: true }).fill('C04 占用期间不得保存的名字')
    await rename.getByRole('button', { name: '保存名称', exact: true }).click()
    await expect(rename.getByRole('alert')).toContainText('数据图正被占用，请先释放编辑权后重试。')
    expect((await gateway.read('map.get', { mapId: map.mapId })).name).toBe(map.name)
    await rename.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '删除数据图', exact: true }).click()
    const deletion = page.getByRole('dialog', { name: '删除数据图', exact: true })
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(deletion.getByRole('alert')).toContainText('数据图正被占用，请先释放编辑权后重试。')
    await deletion.getByRole('button', { name: '取消', exact: true }).click()
    const occupied = await gateway.read('map.get', { mapId: map.mapId })
    expect(occupied.ownerships).toContainEqual(expect.objectContaining({ leaseId: lease.leaseId }))
    expect((await gateway.dispatch(randomUUID(), 'branch.release', { mapId: map.mapId, lease })).data.released).toBe(true)
  }
  const renamedName = 'C04 明确释放后改名成功'
  await workspaceRenameCurrentMap(page, renamedName)
  const renamed = await gateway.read('map.get', { mapId: map.mapId })
  expect(renamed.name).toBe(renamedName)
  expect(renamed.nodes).toEqual(map.nodes)

  const viewer = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
  const viewerGateway = clientCreateGateway({ baseUrl: environment.baseUrl })
  await viewerGateway.connect({ baseUrl: environment.baseUrl, token: viewer.token, remember: false })
  try {
    const viewerContext = await browser.newContext()
    try {
      const viewerPage = await viewerContext.newPage()
      await workspaceLogin(viewerPage, webUrl, viewer.token)
      await workspaceOpenMap(viewerPage, renamedName)
      await expect(viewerPage.getByRole('button', { name: '改名', exact: true })).toBeDisabled()
      await expect(viewerPage.getByRole('button', { name: '删除数据图', exact: true })).toBeDisabled()
      await expect(viewerGateway.dispatch(randomUUID(), 'map.rename', {
        mapId: map.mapId, expectedRevision: renamed.revision, name: 'C04 只读成员不得改名',
      })).rejects.toMatchObject({ status: 403 })
      await expect(viewerGateway.dispatch(randomUUID(), 'map.delete', {
        mapId: map.mapId, expectedRevision: renamed.revision,
      })).rejects.toMatchObject({ status: 403 })
      expect(await gateway.read('map.get', { mapId: map.mapId })).toEqual(renamed)
    } finally {
      await viewerContext.close()
    }
  } finally {
    await viewerGateway.disconnect()
  }
  await page.getByRole('button', { name: '删除数据图', exact: true }).click()
  const deletion = page.getByRole('dialog', { name: '删除数据图', exact: true })
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(deletion).not.toBeVisible()
  await expect(gateway.read('map.get', { mapId: map.mapId })).rejects.toMatchObject({ status: 404 })
  expect(environment.modelCalls).toHaveLength(0)
})

test('M02-C05 新闻新增事实时自动建立后继与原文定位，重读仍显示人工创建', async (
  /* 两种真实服务、独立核对客户端和通过正常表单登录的工作台页面。 */ { page, gateway, environment, webUrl },
) => {
  // 只创建一个合法事实子节点，节点、后继与脚注必须在同一次提交中落地。
  const map = await workspacePrepareMap(gateway, environment.workspaceId, 'C05 新闻新增事实')
  const newsId = randomUUID()
  const newsContent = 'C05 第一行新闻事实。\nC05 第二行补充背景。\nC05 第三行新闻事实。'
  const prepared = (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: map.mapId, branch: { rootIds: [newsId], expectedVersion: null },
    changes: { nodes: { put: [
      { id: newsId, typeId: 'factcheck.news', typeVersion: 1, payload: { content: newsContent, context: {} } },
    ] } },
  })).data.snapshot
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  await expect(workspaceContentInput(inspector)).toHaveValue(newsContent)
  await inspector.getByRole('button', { name: '新增事实', exact: true }).click()
  const adding = page.getByRole('dialog', { name: '新增事实', exact: true })
  const content = 'C05 从新闻第一行和第三行人工提取的事实。'
  await workspaceContentInput(adding).fill(content)
  await adding.getByLabel('来源行号', { exact: true }).fill('1,3')
  await expect(page.getByRole('button', { name: '添加关系', exact: true })).toHaveCount(0)
  await expect(adding.getByLabel('起点节点', { exact: true })).toHaveCount(0)
  await expect(adding.getByLabel('终点节点', { exact: true })).toHaveCount(0)
  await expect(adding.getByLabel('关系类型', { exact: true })).toHaveCount(0)
  await adding.getByRole('button', { name: '保存事实', exact: true }).click()
  await expect(adding).not.toBeVisible()

  const saved = await gateway.read('map.get', { mapId: map.mapId })
  expect(saved.revision).toBe(prepared.revision + 1)
  expect(saved.nodes).toHaveLength(2)
  expect(saved.edges).toHaveLength(1)
  const claim = saved.nodes.find(
    /* 保存后唯一真实事实子节点。 */ node => /* 按精确类型核对新产物，不猜测客户端生成的身份。 */ node.typeId === 'factcheck.claim',
  )
  if (!claim) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  expect(claim).toMatchObject({ typeVersion: 1, revision: 0, payload: { content } })
  expect(claim.producer).toBeUndefined()
  expect(workspaceReadNode(saved, newsId)).toEqual(prepared.nodes[0])
  expect(saved.edges[0]).toMatchObject({ kind: 'successor', from: newsId, to: claim.id,
    sourceAnchors: [
      { path: '/content', sourceRevision: 0, startLine: 1, endLine: 1, quote: 'C05 第一行新闻事实。' },
      { path: '/content', sourceRevision: 0, startLine: 3, endLine: 3, quote: 'C05 第三行新闻事实。' },
    ] })
  await expect(inspector.getByRole('heading', { level: 2 })).toHaveText('事实')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(inspector).toContainText('人工创建')
  await expect(workspaceContentInput(inspector)).toHaveValue(content)
  await page.getByRole('button', { name: '单页', exact: true }).click()
  const footnotes = page.getByRole('region', { name: '来源脚注', exact: true })
  await expect(footnotes.getByText('C05 第一行新闻事实。', { exact: true })).toBeVisible()
  await expect(footnotes.getByText('C05 第三行新闻事实。', { exact: true })).toBeVisible()
  expect(environment.modelCalls).toHaveLength(0)
})

test('M02-C05 事实逐级新增人工核查意见与结论，占用和只读权限阻止创建', async (
  /* 独立真实后端、授权占用持有人以及正常页面和只读浏览器 context。 */
  { page, browser, gateway, environment, webUrl, storage },
) => {
  // 从合法父节点逐级创建固定类型，意见与结论明确保留人工来源，不开放自由牵线。
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C05 人工核查流程', 'C05 待人工核查的事实。')
  const parent = map.nodes[0]
  if (!parent) throw new Error(WorkspaceAcceptanceMessage.PERMISSION_CLAIM_MISSING)
  let lease: GraphBranchLeaseProof | null = null
  if (storage === 'mongo') {
    const claimed = await gateway.dispatch(randomUUID(), 'branch.claim', {
      mapId: map.mapId, rootIds: [parent.id], holderId: randomUUID(),
    })
    if (claimed.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.MANAGEMENT_CLAIM_BUSY)
    const grant = claimed.data.grant
    lease = { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
  }
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  await inspector.getByRole('button', { name: '新增核查意见', exact: true }).click()
  const opinionDialog = page.getByRole('dialog', { name: '新增核查意见', exact: true })
  const opinionReason = 'C05 人工核查意见：已核对原始记录。'
  await opinionDialog.getByRole('group', { name: '评分', exact: true }).getByRole('combobox').selectOption({ label: '1' })
  await opinionDialog.getByRole('group', { name: '核查理由', exact: true }).getByRole('textbox').fill(opinionReason)
  if (lease) {
    await opinionDialog.getByRole('button', { name: '保存核查意见', exact: true }).click()
    await expect(opinionDialog.getByRole('alert')).toContainText('另一客户端或运行任务正在使用此分支。')
    const rejected = await gateway.read('map.get', { mapId: map.mapId })
    expect(rejected.nodes).toEqual(map.nodes)
    expect(rejected.edges).toEqual([])
    expect((await gateway.dispatch(randomUUID(), 'branch.release', { mapId: map.mapId, lease })).data.released).toBe(true)
  }
  await opinionDialog.getByRole('button', { name: '保存核查意见', exact: true }).click()
  await expect(opinionDialog).not.toBeVisible()
  const withOpinion = await gateway.read('map.get', { mapId: map.mapId })
  const opinion = withOpinion.nodes.find(
    /* 本次父事实下新增的真实意见节点。 */ node => /* 使用精确类型识别人工产物。 */ node.typeId === 'factcheck.opinion',
  )
  if (!opinion) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  expect(opinion).toMatchObject({ payload: { score: 1, reason: opinionReason, evidenceClaimIds: [] } })
  expect(opinion.producer).toBeUndefined()
  expect(withOpinion.edges).toContainEqual(expect.objectContaining({ kind: 'successor', from: parent.id, to: opinion.id }))
  await expect(inspector.getByRole('heading', { level: 2 })).toHaveText('核查意见')
  await expect(inspector).toContainText('人工创建')

  if (storage === 'mongo') {
    await inspector.getByRole('button', { name: '领取分支编辑权', exact: true }).click()
    await expect(inspector.getByRole('button', { name: '释放分支编辑权', exact: true })).toBeVisible()
  }
  const evidenceFact = inspector.getByRole('group', { name: '作为证据引用的事实', exact: true })
    .getByRole('checkbox', { name: /C05 待人工核查的事实。/ })
  await evidenceFact.check()
  if (storage === 'mongo') {
    await inspector.getByRole('button', { name: '保存数据', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '当前编辑权未覆盖本次操作的全部节点，请先释放分支编辑权。' })).toBeVisible()
    expect(workspaceReadNode(await gateway.read('map.get', { mapId: map.mapId }), opinion.id).payload.evidenceClaimIds).toEqual([])
    await inspector.getByRole('button', { name: '释放分支编辑权', exact: true }).click()
    await expect(inspector.getByText('未保存', { exact: true })).toBeVisible()
    await expect(evidenceFact).toBeChecked()
  }
  await inspector.getByRole('button', { name: '保存数据', exact: true }).click()
  await expect(inspector.getByText('未保存', { exact: true })).toHaveCount(0)
  const referenced = await gateway.read('map.get', { mapId: map.mapId })
  const editedOpinion = workspaceReadNode(referenced, opinion.id)
  expect(editedOpinion.payload.evidenceClaimIds).toEqual([parent.id])
  expect(editedOpinion.payloadReferences).toEqual([{ path: '/evidenceClaimIds/*', targetId: parent.id }])
  expect(referenced.edges).toEqual(withOpinion.edges)

  await inspector.getByRole('button', { name: '新增核查结论', exact: true }).click()
  const verificationDialog = page.getByRole('dialog', { name: '新增核查结论', exact: true })
  const verificationReason = 'C05 人工核查结论：依据该人工意见确定。'
  await verificationDialog.getByRole('group', { name: '评分', exact: true }).getByRole('combobox').selectOption({ label: '1' })
  await verificationDialog.getByRole('group', { name: '核查理由', exact: true }).getByRole('textbox').fill(verificationReason)
  await verificationDialog.getByRole('group', { name: '核查意见节点', exact: true })
    .getByRole('checkbox', { name: new RegExp(opinionReason) }).check()
  await verificationDialog.getByRole('button', { name: '保存核查结论', exact: true }).click()
  await expect(verificationDialog).not.toBeVisible()
  const saved = await gateway.read('map.get', { mapId: map.mapId })
  const verification = saved.nodes.find(
    /* 新建人工结论的真实节点。 */ node => /* 结论只能来自预期固定类型。 */ node.typeId === 'factcheck.verification',
  )
  if (!verification) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  expect(saved.nodes).toHaveLength(3)
  expect(saved.edges).toHaveLength(2)
  expect(verification).toMatchObject({ payload: { score: 1, reason: verificationReason, opinionIds: [opinion.id] } })
  expect(verification.producer).toBeUndefined()
  expect(saved.edges).toContainEqual(expect.objectContaining({ kind: 'successor', from: opinion.id, to: verification.id }))
  await expect(inspector.getByRole('heading', { level: 2 })).toHaveText('核查结论')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(inspector).toContainText('人工创建')
  await expect(inspector.getByRole('button', { name: /^新增/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '添加关系', exact: true })).toHaveCount(0)

  const viewer = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
  const viewerContext = await browser.newContext()
  try {
    const viewerPage = await viewerContext.newPage()
    await workspaceLogin(viewerPage, webUrl, viewer.token)
    await workspaceOpenMap(viewerPage, map.name)
    await workspaceSelectFirstNode(viewerPage)
    const readOnly = viewerPage.getByRole('region', { name: '数据详情', exact: true })
    await expect(readOnly.getByRole('button', { name: '新增核查意见', exact: true })).toBeDisabled()
    await expect(viewerPage.getByRole('button', { name: '添加关系', exact: true })).toHaveCount(0)
  } finally {
    await viewerContext.close()
  }
  expect(environment.modelCalls).toHaveLength(0)
})

test('M03-C06 协作节点管理跨图固定证据理由，正文编辑与使用历史保持独立', async (
  /* 真实协作服务、正常浏览器、独立授权客户端及只读成员 context。 */
  { page, browser, gateway, environment, webUrl, storage },
) => {
  // 从真实另一图材料完成引用生命周期，当前节点、固定证据和历史消费者分别经公开API核对。
  test.skip(storage !== 'mongo', '跨图固定证据依赖当前协作服务能力。')
  const sourceContent = 'C06 固定材料全文：独立来源图记录了原始监测数据。'
  const source = await workspacePrepareClaim(gateway, environment.workspaceId, 'C06 固定材料来源图', sourceContent)
  const sourceNode = source.nodes[0]
  if (!sourceNode) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const consumerContent = 'C06 消费者原始正文，与本次使用理由分开保存。'
  const consumerMap = await workspacePrepareClaim(gateway, environment.workspaceId, 'C06 使用固定证据的图', consumerContent)
  const consumer = consumerMap.nodes[0]
  if (!consumer) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const entry = (await gateway.dispatch(randomUUID(), 'evidence.collect', {
    workspaceId: environment.workspaceId,
    claim: { mapId: source.mapId, nodeId: sourceNode.id, revision: sourceNode.revision },
    confidence: 0, applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
    reason: 'C06 明确收录另一图的固定材料，理由由消费者另填。', basisRefs: [],
  })).data.entry
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, consumerMap.name)
  await workspaceSelectFirstNode(page)
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  await expect(workspaceContentInput(inspector)).toHaveValue(consumerContent)
  await inspector.getByRole('button', { name: '编辑所用证据', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑所用证据', exact: true })
  await editor.getByRole('checkbox', { name: new RegExp(sourceContent) }).check()
  await editor.getByRole('button', { name: '加入所选证据', exact: true }).click()
  const drafts = editor.getByRole('region', { name: '所用固定证据', exact: true })
  await expect(drafts).toContainText(sourceContent)
  await expect(editor.getByRole('button', { name: '保存引用', exact: true })).toBeDisabled()
  const firstReason = 'C06 初次使用：该固定记录反驳本节点的说法。'
  await editor.getByLabel('使用理由 1', { exact: true }).fill(firstReason)
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  await expect(editor).not.toBeVisible()
  expect(workspaceReadNode(await gateway.read('map.get', { mapId: consumerMap.mapId }), consumer.id)).toEqual(consumer)

  await inspector.getByRole('button', { name: '编辑所用证据', exact: true }).click()
  await editor.getByRole('checkbox', { name: new RegExp(sourceContent) }).check()
  await editor.getByRole('button', { name: '加入所选证据', exact: true }).click()
  await editor.getByLabel('使用理由 1', { exact: true }).fill(firstReason)
  await editor.getByRole('button', { name: '保存引用', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const firstSaved = workspaceReadNode(await gateway.read('map.get', { mapId: consumerMap.mapId }), consumer.id)
  expect(firstSaved.payload).toEqual(consumer.payload)
  expect(firstSaved.libraryClaimRefs).toEqual([{ entryId: entry.id, contentDigest: entry.contentDigest, reason: firstReason }])
  const firstUses = await gateway.read('evidence.uses', { workspaceId: environment.workspaceId, entryId: entry.id })
  expect(firstUses.items).toHaveLength(1)
  const firstUse = firstUses.items[0]
  if (!firstUse) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  expect(firstUse).toMatchObject({ kind: 'manual', consumer: { mapId: consumerMap.mapId, nodeId: consumer.id, revision: firstSaved.revision },
    reason: firstReason, endedAt: null })

  const secondReason = 'C06 修订使用理由：记录中的原始数值与当前说法相反。'
  await inspector.getByRole('button', { name: '编辑所用证据', exact: true }).click()
  await editor.getByRole('button', { name: '核对固定证据 1', exact: true }).click()
  await expect(drafts).toContainText(sourceContent)
  await expect(drafts).toContainText('0 · 确定错误')
  await editor.getByLabel('使用理由 1', { exact: true }).fill(secondReason)
  await editor.getByRole('button', { name: '保存引用', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const reasonEdited = workspaceReadNode(await gateway.read('map.get', { mapId: consumerMap.mapId }), consumer.id)
  expect(reasonEdited.libraryClaimRefs).toEqual([{ entryId: entry.id, contentDigest: entry.contentDigest, reason: secondReason }])
  expect(reasonEdited.payload).toEqual(consumer.payload)

  await workspaceAcquireEditor(page, true)
  const editedContent = 'C06 只修改消费者正文，继续保留同一固定证据和理由。'
  await workspaceContentInput(inspector).fill(editedContent)
  await inspector.getByRole('button', { name: '保存数据', exact: true }).click()
  await expect(inspector.getByText('未保存', { exact: true })).toHaveCount(0)
  const contentEdited = workspaceReadNode(await gateway.read('map.get', { mapId: consumerMap.mapId }), consumer.id)
  expect(contentEdited.payload.content).toBe(editedContent)
  expect(contentEdited.libraryClaimRefs).toEqual(reasonEdited.libraryClaimRefs)
  await page.getByRole('button', { name: '单页', exact: true }).click()
  const reader = page.getByRole('region', { name: '单页阅读', exact: true })
  const references = reader.getByRole('region', { name: '所用固定证据', exact: true })
  await expect(references).toContainText(secondReason)
  await references.getByRole('button', { name: '查看固定证据 1', exact: true }).click()
  await expect(page.getByRole('region', { name: '证据固定单页', exact: true })).toBeVisible()
  await expect(page.getByLabel('收录时固定的节点全文', { exact: true })).toContainText(sourceContent)

  await workspaceOpenMap(page, consumerMap.name)
  await reader.getByRole('button', { name: '返回关系图', exact: true }).click()
  await workspaceSelectFirstNode(page)
  await gateway.dispatch(randomUUID(), 'evidence.withdraw', { workspaceId: environment.workspaceId,
    entryId: entry.id, expectedRevision: entry.revision, reason: 'C06 条目撤回后原消费者仍可保留原固定身份。' })
  const finalReason = 'C06 已撤回材料仍保留原始版本，本节点补充记录使用限制。'
  await inspector.getByRole('button', { name: '编辑所用证据', exact: true }).click()
  await expect(editor.getByLabel('使用理由 1', { exact: true })).toHaveValue(secondReason)
  await editor.getByLabel('使用理由 1', { exact: true }).fill(finalReason)
  await editor.getByRole('button', { name: '保存引用', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const withdrawnKept = workspaceReadNode(await gateway.read('map.get', { mapId: consumerMap.mapId }), consumer.id)
  expect(withdrawnKept.libraryClaimRefs).toEqual([{ entryId: entry.id, contentDigest: entry.contentDigest, reason: finalReason }])
  expect(withdrawnKept.payload.content).toBe(editedContent)

  const viewer = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
  const viewerContext = await browser.newContext()
  try {
    const viewerPage = await viewerContext.newPage()
    await workspaceLogin(viewerPage, webUrl, viewer.token)
    await workspaceOpenMap(viewerPage, consumerMap.name)
    await workspaceSelectFirstNode(viewerPage)
    const readOnly = viewerPage.getByRole('region', { name: '数据详情', exact: true })
    await expect(readOnly.getByRole('region', { name: '所用固定证据', exact: true })).toContainText(finalReason)
    await expect(readOnly.getByRole('button', { name: '编辑所用证据', exact: true })).toBeDisabled()
  } finally {
    await viewerContext.close()
  }

  await inspector.getByRole('button', { name: '编辑所用证据', exact: true }).click()
  await editor.getByRole('button', { name: '清空引用', exact: true }).click()
  await editor.getByRole('button', { name: '保存引用', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const cleared = workspaceReadNode(await gateway.read('map.get', { mapId: consumerMap.mapId }), consumer.id)
  expect(cleared.libraryClaimRefs).toEqual([])
  expect(cleared.payload.content).toBe(editedContent)
  expect((await gateway.read('evidence.uses', { workspaceId: environment.workspaceId, entryId: entry.id })).items).toEqual([])
  const history = await gateway.read('evidence.uses', { workspaceId: environment.workspaceId, entryId: entry.id, includeHistory: true })
  expect(history.items).toHaveLength(4)
  expect(history.items.every(
    /* 此消费者四个正式使用版本。 */ item => /* 清空引用结束每个旧版本，但不删除历史。 */ item.endedAt !== null,
  )).toBe(true)
  const originalUse = await gateway.read('evidence.use.get', { workspaceId: environment.workspaceId, entryId: entry.id, usageId: firstUse.id })
  expect(originalUse.consumerSnapshot.payload.content).toBe(consumerContent)
  expect(originalUse.reason).toBe(firstReason)
  const fixed = await gateway.read('evidence.get', { workspaceId: environment.workspaceId, entryId: entry.id })
  expect(fixed).toMatchObject({ status: 'withdrawn', confidence: 0, contentDigest: entry.contentDigest })
  expect(fixed.claim.nodeSnapshot.payload.content).toBe(sourceContent)
  expect(environment.modelCalls).toHaveLength(0)
})

test('M03-C06 本机服务未提供证据库时禁用节点引用编辑', async (
  /* 明确不装配证据库的真实SQLite服务与正常工作台页面。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 本机只验证真实能力边界，不伪造服务不接受的非空引用或新增库接口。
  test.skip(storage !== 'sqlite', '本例只验证本机未提供证据库的能力声明。')
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C06 本机能力图', 'C06 本机数据仍可正常阅读。')
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  await expect(workspaceContentInput(inspector)).toHaveValue('C06 本机数据仍可正常阅读。')
  await expect(inspector.getByRole('button', { name: '编辑所用证据', exact: true })).toBeDisabled()
  await expect(page.getByRole('dialog', { name: '编辑所用证据', exact: true })).toHaveCount(0)
  expect((await gateway.read('map.get', { mapId: map.mapId })).nodes).toEqual(map.nodes)
  expect(environment.modelCalls).toHaveLength(0)
})

test('M03-C07 混合四类有序收录依据，固定节点文件与库原文均可阅读', async (
  /* 正常协作服务、独立授权核对客户端及可下载文件的真实页面。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 所有候选来自真实公开API，收录时一次保存有序身份，阅读不替换材料版本。
  test.skip(storage !== 'mongo', '结构化收录依据使用当前协作证据库。')
  const newsContent = 'C07 跨图新闻原文：原始采样报告记录了具体日期。'
  const newsMap = await workspacePrepareNews(gateway, environment.workspaceId, 'C07 跨图新闻材料', newsContent)
  const news = newsMap.nodes[0]
  if (!news) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const libraryContent = 'C07 另一个库条目的固定全文，作为独立收录依据。'
  const libraryMap = await workspacePrepareClaim(gateway, environment.workspaceId, 'C07 库材料来源', libraryContent)
  const libraryClaim = libraryMap.nodes[0]
  if (!libraryClaim) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const libraryBasis = (await gateway.dispatch(randomUUID(), 'evidence.collect', {
    workspaceId: environment.workspaceId, claim: { mapId: libraryMap.mapId, nodeId: libraryClaim.id, revision: libraryClaim.revision },
    confidence: 0, applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
    reason: 'C07 准备真实活动库材料。', basisRefs: [],
  })).data.entry
  const bytes = Buffer.from('C07 依据文件的原始字节，必须完整一致。', 'utf8')
  const asset = (await gateway.upload(randomUUID(), { workspaceId: environment.workspaceId,
    filename: 'C07-依据文件.txt', mediaType: 'text/plain', bytes })).data
  const rootContent = 'C07 使用四类有序材料作出收录决定的原陈述。'
  const rootMap = await workspacePrepareClaim(gateway, environment.workspaceId, 'C07 待收录事实', rootContent)
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, rootMap.name)
  await workspaceSelectFirstNode(page)
  await page.getByRole('button', { name: '收录到证据库', exact: true }).click()
  const collection = page.getByRole('dialog', { name: '收录到证据库', exact: true })
  await collection.getByRole('radio', { name: /1 · 确定正确/ }).check()
  await collection.getByLabel('收录理由', { exact: true }).fill('C07 对照人工说明、新闻、文件和库材料后确认。')
  const basis = collection.getByRole('region', { name: '收录依据', exact: true })
  const manualText = 'C07 第一项人工依据，保持原始说明顺序。'
  await basis.getByLabel('依据类型', { exact: true }).selectOption('manual')
  await collection.getByLabel('人工依据 · 可选', { exact: true }).fill(manualText)
  await basis.getByRole('button', { name: '加入依据', exact: true }).click()
  await basis.getByLabel('依据类型', { exact: true }).selectOption('node')
  await basis.getByLabel('依据数据图', { exact: true }).selectOption(newsMap.mapId)
  await basis.getByLabel('依据节点', { exact: true }).selectOption(news.id)
  await basis.getByRole('button', { name: '加入依据', exact: true }).click()
  await basis.getByLabel('依据类型', { exact: true }).selectOption('asset')
  await basis.getByLabel('依据文件', { exact: true }).selectOption(asset.id)
  await basis.getByRole('button', { name: '加入依据', exact: true }).click()
  await basis.getByLabel('依据类型', { exact: true }).selectOption('library')
  await basis.getByLabel('依据库检索', { exact: true }).fill(libraryContent)
  await basis.getByRole('button', { name: '检索依据库', exact: true }).click()
  await basis.getByLabel('依据库条目', { exact: true }).selectOption(libraryBasis.id)
  await basis.getByRole('button', { name: '加入依据', exact: true }).click()
  const selected = collection.getByRole('region', { name: '已选收录依据', exact: true })
  await expect(selected).toContainText(manualText)
  await expect(selected).toContainText(newsContent)
  await expect(selected).toContainText(asset.filename)
  await expect(selected).toContainText(libraryContent)
  await collection.getByRole('button', { name: '确认收录', exact: true }).click()
  await expect(collection).not.toBeVisible()

  const found = (await gateway.read('evidence.search', { workspaceId: environment.workspaceId, query: rootContent, limit: 100 })).items.find(
    /* 独立API实际发布的库摘要。 */ item => /* 只匹配本次界面收录的完整陈述。 */ item.content === rootContent,
  )
  if (!found) throw new Error(WorkspaceAcceptanceMessage.COLLECTED_ENTRY_MISSING)
  const saved = await gateway.read('evidence.get', { workspaceId: environment.workspaceId, entryId: found.id })
  expect(saved.decision.basisRefs).toEqual([
    { kind: 'manual', text: manualText },
    { kind: 'node', ref: { mapId: newsMap.mapId, nodeId: news.id, revision: news.revision } },
    { kind: 'asset', assetId: asset.id, sha256: asset.sha256 },
    { kind: 'library', ref: { entryId: libraryBasis.id, contentDigest: libraryBasis.contentDigest } },
  ])
  const relations = await gateway.read('evidence.relations', { workspaceId: environment.workspaceId, entryId: saved.id })
  const fixedNews = relations.snapshot?.nodes.find(
    /* 收录时保存的真实关系节点。 */ node => /* 用完整跨Map身份找回非Claim新闻。 */
      node.ref.mapId === newsMap.mapId && node.ref.nodeId === news.id && node.ref.revision === news.revision,
  )
  expect(fixedNews?.nodeSnapshot).toEqual(news)
  expect(relations.snapshot?.edges).toContainEqual(expect.objectContaining({ kind: 'basis', basisIndex: 1, from: fixedNews?.key }))

  const details = page.getByRole('complementary', { name: '证据条目详情', exact: true })
  // C18固定关系保留原依据序号，不把它简化成普通引用线。
  const relationNotes = details.getByRole('region', { name: '固定关系说明', exact: true })
  const basisRelation = relationNotes.locator('details').filter({ hasText: '原收录依据第 2 项' }).first()
  await basisRelation.locator(':scope > summary').click()
  await expect(basisRelation.getByText('原收录依据第 2 项', { exact: true })).toBeVisible()
  const downloading = page.waitForEvent('download')
  await details.getByRole('button', { name: '下载依据文件 3', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe(asset.filename)
  const downloadedPath = await download.path()
  if (!downloadedPath) throw new Error(WorkspaceAcceptanceMessage.BASIS_DOWNLOAD_MISSING)
  expect(await readFile(downloadedPath)).toEqual(bytes)
  await details.getByRole('button', { name: '阅读固定节点依据 2', exact: true }).click()
  await expect(page.getByLabel('收录时固定的节点全文', { exact: true })).toContainText(newsContent)
  const fixedRelation = page.getByRole('region', { name: '证据固定单页', exact: true }).getByRole('region', { name: '固定关系说明', exact: true }).locator('details').filter({ hasText: '原收录依据第 2 项' }).first()
  await fixedRelation.locator(':scope > summary').click()
  await expect(fixedRelation.getByText('原收录依据第 2 项', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回证据库数据图', exact: true }).click()
  await workspaceSelectLibraryEntry(page, rootContent)
  await details.getByRole('button', { name: '查看固定库依据 4', exact: true }).click()
  await expect(page.getByLabel('收录时固定的节点全文', { exact: true })).toContainText(libraryContent)
  await expect(page.getByRole('region', { name: '证据固定单页', exact: true })).toContainText('0 · 确定错误')
  expect(environment.modelCalls).toHaveLength(0)
})

test('M03-C07 来源更新删除与库依据撤回后，Viewer仍阅读收录时的固定正文', async (
  /* 真实协作服务、授权变更客户端及只读成员的正常浏览器页面。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 来源变更由真实命令完成，Viewer阅读只依赖已保存的节点及库固定身份。
  test.skip(storage !== 'mongo', '固定依据与撤回状态使用协作证据库。')
  const originalNews = 'C07 历史新闻依据：这是收录时保存的全文。'
  const newsMap = await workspacePrepareNews(gateway, environment.workspaceId, 'C07 后续会删除的新闻', originalNews)
  const news = newsMap.nodes[0]
  if (!news) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const libraryContent = 'C07 之后撤回的库依据，固定陈述继续保留。'
  const libraryMap = await workspacePrepareClaim(gateway, environment.workspaceId, 'C07 撤回库依据来源', libraryContent)
  const libraryClaim = libraryMap.nodes[0]
  if (!libraryClaim) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const libraryBasis = (await gateway.dispatch(randomUUID(), 'evidence.collect', {
    workspaceId: environment.workspaceId, claim: { mapId: libraryMap.mapId, nodeId: libraryClaim.id, revision: libraryClaim.revision },
    confidence: 0, applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
    reason: 'C07 先真实收录再明确撤回。', basisRefs: [],
  })).data.entry
  const rootContent = 'C07 固定依据阅读的根陈述。'
  const rootMap = await workspacePrepareClaim(gateway, environment.workspaceId, 'C07 历史依据根图', rootContent)
  const root = rootMap.nodes[0]
  if (!root) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const saved = (await gateway.dispatch(randomUUID(), 'evidence.collect', {
    workspaceId: environment.workspaceId, claim: { mapId: rootMap.mapId, nodeId: root.id, revision: root.revision },
    confidence: 1, applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
    reason: 'C07 当前节点删除不应替换历史依据。', basisRefs: [
      { kind: 'node', ref: { mapId: newsMap.mapId, nodeId: news.id, revision: news.revision } },
      { kind: 'library', ref: { entryId: libraryBasis.id, contentDigest: libraryBasis.contentDigest } },
    ],
  })).data.entry

  const claimed = await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: newsMap.mapId, rootIds: [news.id], holderId: randomUUID() })
  if (claimed.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.MANAGEMENT_CLAIM_BUSY)
  const grant = claimed.data.grant
  const lease = { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
  const updatedText = 'C07 当前新闻已改写，不能冒充原依据全文。'
  const changed = (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: newsMap.mapId,
    branch: { rootIds: grant.branch.scope.rootIds, expectedVersion: grant.branch.version }, lease,
    changes: { nodes: { put: [{ id: news.id, typeId: news.typeId, typeVersion: news.typeVersion,
      payload: { content: updatedText, context: {} } }] } },
  })).data.snapshot
  await gateway.dispatch(randomUUID(), 'branch.release', { mapId: newsMap.mapId, lease })
  await gateway.dispatch(randomUUID(), 'map.delete', { mapId: newsMap.mapId, expectedRevision: changed.revision })
  await gateway.dispatch(randomUUID(), 'evidence.withdraw', { workspaceId: environment.workspaceId,
    entryId: libraryBasis.id, expectedRevision: libraryBasis.revision, reason: 'C07 明确撤回，历史依据仍保留。' })
  await expect(gateway.read('map.get', { mapId: newsMap.mapId })).rejects.toMatchObject({ status: 404 })
  expect((await gateway.read('evidence.get', { workspaceId: environment.workspaceId, entryId: saved.id })).decision.basisRefs).toEqual(saved.decision.basisRefs)

  const viewer = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
  await workspaceLogin(page, webUrl, viewer.token)
  await workspaceOpenMap(page, rootMap.name)
  await workspaceSelectFirstNode(page)
  await expect(page.getByRole('button', { name: '收录到证据库', exact: true })).toBeDisabled()
  await page.locator('.workspace-sidebar').getByRole('button', { name: /^证据库/ }).click()
  await workspaceSelectLibraryEntry(page, rootContent)
  const details = page.getByRole('complementary', { name: '证据条目详情', exact: true })
  await expect(details.getByRole('button', { name: '撤回条目', exact: true })).toHaveCount(0)
  await details.getByRole('button', { name: '阅读固定节点依据 1', exact: true }).click()
  const fixedContent = page.getByLabel('收录时固定的节点全文', { exact: true })
  await expect(fixedContent).toContainText(originalNews)
  await expect(fixedContent).not.toContainText(updatedText)
  await page.getByRole('button', { name: '返回证据库数据图', exact: true }).click()
  await workspaceSelectLibraryEntry(page, rootContent)
  await details.getByRole('button', { name: '查看固定库依据 2', exact: true }).click()
  await expect(fixedContent).toContainText(libraryContent)
  await expect(page.getByRole('region', { name: '证据固定单页', exact: true })).toContainText('已撤回')
  await expect(page.getByRole('button', { name: '撤回条目', exact: true })).toHaveCount(0)
  expect(environment.modelCalls).toHaveLength(0)
})

test('M03-C08 新收录已有条目和相反判断均展示本次结果并固定导航', async (
  /* 真实协作证据库、独立授权核对客户端和正常工作台页面。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 相同业务输入只新增一次；相反判断正常成功，结果导航保持该次条目身份。
  test.skip(storage !== 'mongo', '收录结果使用当前协作证据库。')
  const content = 'C08 同一具体事实版本的双向判断。'
  const reason = 'C08 同一范围和依据下明确作出的收录决定。'
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C08 收录结果图', content)
  const claim = map.nodes[0]
  if (!claim) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const expectedParams = { workspaceId: environment.workspaceId,
    claim: { mapId: map.mapId, nodeId: claim.id, revision: claim.revision }, confidence: 1,
    applicability: { subject: null, event: null, time: null, place: null, conditions: [] }, reason, basisRefs: [] }
  const attempts: unknown[] = []
  page.on('request', (
    /* 浏览器真正发出的公开业务请求，不读取认证头或记录其他请求。 */ request,
  ) => {
    // 只保留收录命令，用于比较业务输入和新请求身份，不输出原始内容。
    if (workspaceReadRequestMethod(request) === 'evidence.collect') attempts.push(request.postDataJSON())
  })
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  await workspaceSubmitCollection(page, '1', reason)
  await expect(page.getByRole('dialog', { name: '收录到证据库', exact: true })).not.toBeVisible()
  const first = await gateway.read('evidence.search', { workspaceId: environment.workspaceId, query: content, limit: 100 })
  expect(first.items).toHaveLength(1)
  const positive = first.items[0]
  if (!positive) throw new Error(WorkspaceAcceptanceMessage.COLLECTED_ENTRY_MISSING)
  expect(positive.confidence).toBe(1)
  const result = page.getByRole('region', { name: '本次收录结果', exact: true })
  await expect(result).toContainText('已收录新条目')

  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  await workspaceSubmitCollection(page, '1', reason)
  await expect(result).toContainText('已有相同收录，返回已有条目')
  const duplicate = await gateway.read('evidence.search', { workspaceId: environment.workspaceId, query: content, limit: 100 })
  expect(duplicate.items).toHaveLength(1)
  expect(duplicate.items[0]?.id).toBe(positive.id)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i), method: 'evidence.collect', params: expectedParams })
  expect(attempts[1]).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i), method: 'evidence.collect', params: expectedParams })
  expect(attempts[1]).not.toEqual(attempts[0])

  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  await workspaceSubmitCollection(page, '0', reason)
  await expect(result).toContainText('已收录新条目')
  await expect(result.locator('summary')).toHaveText('本次返回的相反判断（1项）')
  const both = await gateway.read('evidence.search', { workspaceId: environment.workspaceId, query: content, limit: 100 })
  expect(both.items).toHaveLength(2)
  expect(both.items.map(
    /* 后端实际返回的同一事实版本条目。 */ item => /* 保留两个明确判断，不能合并或拒绝相反条目。 */ item.confidence,
  ).sort()).toEqual([0, 1])
  await result.getByRole('button', { name: '查看本次条目', exact: true }).click()
  const fixed = page.getByRole('region', { name: '证据固定单页', exact: true })
  await expect(fixed).toContainText('0 · 确定错误')
  const opposites = result.locator('details')
  if (await opposites.getAttribute('open') === null) await result.locator('summary').click()
  await result.getByRole('button', { name: '查看相反判断条目 1', exact: true }).click()
  await expect(fixed).toContainText('1 · 确定正确')
  await result.getByRole('button', { name: '查看本次条目', exact: true }).click()
  await expect(fixed).toContainText('0 · 确定错误')
  await result.getByRole('button', { name: '关闭收录结果', exact: true }).click()
  await expect(result).toHaveCount(0)
  expect((await gateway.read('evidence.search', { workspaceId: environment.workspaceId, query: content, limit: 100 })).items).toHaveLength(2)
  expect(attempts).toHaveLength(3)
  expect(environment.modelCalls).toHaveLength(0)
})

test('M03-C08 已有收录的成功回包丢失后原请求恢复，保留原收据的相反列表', async (
  /* 真实后台提交、独立核对客户端与只改变成功回包交付的浏览器页面。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 原请求实际返回已有条目及当时相反列表；等待期间新相反条目不能改写原收据。
  test.skip(storage !== 'mongo', '收录原请求恢复使用当前协作证据库。')
  const content = 'C08 原请求恢复时保留原本的相反结果列表。'
  const reason = 'C08 原请求完全相同的业务理由。'
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C08 已有收录恢复图', content)
  const claim = map.nodes[0]
  if (!claim) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const params = { workspaceId: environment.workspaceId,
    claim: { mapId: map.mapId, nodeId: claim.id, revision: claim.revision },
    applicability: { subject: null, event: null, time: null, place: null, conditions: [] }, reason, basisRefs: [] }
  const positive = (await gateway.dispatch(randomUUID(), 'evidence.collect', { ...params, confidence: 1 })).data.entry
  const originalOpposite = (await gateway.dispatch(randomUUID(), 'evidence.collect', { ...params, confidence: 0 })).data.entry
  const laterReason = 'C08 等待原请求确认期间另一个客户端新增的独立相反理由。'
  const attempts: unknown[] = []
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  const loseFirstReply = async (
    /* 浏览器实际收录请求，认证和原POST参数均保持不变。 */ route: Route,
  ): Promise<void> => {
    // 只在真实成功后丢第一次交付，第二次原样放行服务器收据。
    if (workspaceReadRequestMethod(route.request()) !== 'evidence.collect') { await route.continue(); return }
    attempts.push(route.request().postDataJSON())
    const response = await route.fetch({ url: new URL('/api/v1/command', environment.baseUrl).href })
    const reply: unknown = await response.json()
    expect(response.ok()).toBe(true)
    expect(reply).toMatchObject({ ok: true, replayed: attempts.length === 2, data: {
      existing: true, replayed: attempts.length === 2, entry: { id: positive.id },
      conflictEntryIds: [originalOpposite.id],
    } })
    if (attempts.length === 1) {
      expect((await gateway.read('evidence.search', { workspaceId: environment.workspaceId, query: content, limit: 100 })).items).toHaveLength(2)
      await gateway.dispatch(randomUUID(), 'evidence.collect', { ...params, confidence: 0, reason: laterReason })
      expect((await gateway.read('evidence.search', { workspaceId: environment.workspaceId, query: content, confidence: 0, limit: 100 })).items).toHaveLength(2)
      await route.abort('connectionreset')
    } else await route.fulfill({ response })
  }
  await page.route('**/api/v1/command', loseFirstReply)
  try {
    await workspaceSubmitCollection(page, '1', reason)
    const collection = page.getByRole('dialog', { name: '收录到证据库', exact: true })
    await collection.getByRole('button', { name: '重试同一收录', exact: true }).click()
    await expect(collection).not.toBeVisible()
    const result = page.getByRole('region', { name: '本次收录结果', exact: true })
    await expect(result).toContainText('原收录请求已确认')
    await expect(result).toContainText('该次返回已有条目')
    await expect(result.locator('summary')).toHaveText('本次返回的相反判断（1项）')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i), method: 'evidence.collect', params: { ...params, confidence: 1 } })
    expect(attempts[1]).toEqual(attempts[0])
    await result.getByRole('button', { name: '查看本次条目', exact: true }).click()
    const fixed = page.getByRole('region', { name: '证据固定单页', exact: true })
    await expect(fixed).toContainText('1 · 确定正确')
    const opposites = result.locator('details')
    if (await opposites.getAttribute('open') === null) await result.locator('summary').click()
    await result.getByRole('button', { name: '查看相反判断条目 1', exact: true }).click()
    await expect(fixed).toContainText('0 · 确定错误')
    await expect(fixed).toContainText(reason)
    await expect(fixed).not.toContainText(laterReason)
    const saved = await gateway.read('evidence.search', { workspaceId: environment.workspaceId, query: content, limit: 100 })
    expect(saved.items).toHaveLength(3)
    expect(saved.items.filter(
      /* 当前真实库中的同陈述条目。 */ item => /* 原正向条目不得因恢复重复创建。 */ item.confidence === 1,
    )).toHaveLength(1)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    await page.unroute('**/api/v1/command', loseFirstReply)
  }
})

test('M04-C10 规划与结果审核可核对输入上下文、实际发布集合和启动时冻结证据', async (
  /* 每例独占真实后端与Host，页面批准，独立公共客户端核对正式发布。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 预置输入和上下文后由页面逐项审核；协作模式同时验证撤回不改写冻结阅读。
  const inputContent = 'C10 待核查的完整事实正文。'
  const contextContent = 'C10 新闻上下文全文，供审核者核对原始出处。'
  const frozenContent = 'C10 启动时冻结的库材料全文，不随当前撤回状态更换。'
  const collectionReason = 'C10 收录时已对照原始报告，保持明确的固定错误判断。'
  let libraryEntry: EvidenceLibraryEntry | undefined
  if (storage === 'mongo') {
    const evidenceMap = await workspacePrepareClaim(gateway, environment.workspaceId, 'C10 冻结材料来源', frozenContent)
    const evidenceClaim = evidenceMap.nodes[0]
    if (!evidenceClaim) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
    libraryEntry = (await gateway.dispatch(randomUUID(), 'evidence.collect', {
      workspaceId: environment.workspaceId,
      claim: { mapId: evidenceMap.mapId, nodeId: evidenceClaim.id, revision: evidenceClaim.revision },
      confidence: 0, applicability: { subject: 'C10 样本', event: null, time: null, place: '上海', conditions: ['仅适用本次样本'] },
      reason: collectionReason, basisRefs: [{ kind: 'manual', text: 'C10 人工收录依据：复查原始采样记录。' }],
    })).data.entry
  }
  let map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C10 人工审核图', inputContent)
  const input = map.nodes[0]
  if (!input) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const newsId = randomUUID()
  map = (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: map.mapId, branch: { rootIds: [newsId], expectedVersion: null },
    changes: { nodes: { put: [{ id: newsId, typeId: 'factcheck.news', typeVersion: 1,
      payload: { content: contextContent, context: { 审核说明: { value: 'C10 上下文隐含字段仍保留完整原文。', visibleToAI: false } } } }] } },
  })).data.snapshot
  const scope = [input.id, newsId]
  const branch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: scope })
  const claim = storage === 'mongo'
    ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: scope, holderId: randomUUID() })
    : null
  if (claim && claim.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.REVIEW_BRANCH_BUSY)
  const plan: GraphRunPlan = { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 },
    dependsOn: [], input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [input.id] } }],
    context: [{ port: 'news', source: { kind: 'scope', nodeIds: [newsId] } }], grouping: { mode: 'each' }, onEmpty: 'fail',
    ...(libraryEntry ? { libraryClaimRefs: [{ entryId: libraryEntry.id, contentDigest: libraryEntry.contentDigest }] } : {}),
  }] }
  const runId = randomUUID()
  const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, id: runId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    ...(claim?.data.status === 'claimed' ? { lease: { leaseId: claim.data.grant.leaseId,
      holderId: claim.data.grant.holderId, fence: claim.data.grant.fence } } : {}),
    scope: { nodeIds: scope }, plan, mode: 'human-in-loop' })
  if (started.data.runControl) await gateway.dispatch(randomUUID(), 'run.control.release', {
    mapId: map.mapId, runId, control: { leaseId: started.data.runControl.leaseId,
      holderId: started.data.runControl.holderId, fence: started.data.runControl.fence },
  })
  if (libraryEntry) await gateway.dispatch(randomUUID(), 'evidence.withdraw', {
    workspaceId: environment.workspaceId, entryId: libraryEntry.id, expectedRevision: libraryEntry.revision,
    reason: 'C10 启动后撤回当前库条目，已冻结运行不受影响。',
  })

  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  const panel = page.getByRole('region', { name: '运行进度与审核', exact: true })
  if (storage === 'mongo') await panel.getByRole('button', { name: '领取运行控制权', exact: true }).click()
  await panel.getByRole('button', { name: '批准执行计划', exact: true }).click()
  const approve = panel.getByRole('button', { name: '批准并发布结果', exact: true })
  await expect(approve).toBeVisible()
  const publication = panel.getByRole('region', { name: '本次将发布', exact: true })
  await expect(publication).toBeVisible()
  await expect(publication).toContainText('4 项')
  await expect(publication.getByText('直接入选', { exact: true })).toHaveCount(1)
  await expect(publication.getByText('连带发布', { exact: true })).toHaveCount(3)
  await expect(panel.getByRole('region', { name: '输入材料', exact: true })).toContainText(inputContent)
  const context = panel.getByRole('region', { name: '上下文材料', exact: true })
  await expect(context).toContainText(contextContent)
  await expect(context).toContainText('C10 上下文隐含字段仍保留完整原文。')
  for (const summary of await publication.locator('.candidate-row > summary').all()) {
    // 通过真实详情控件展开各候选，核对正文和实际使用理由的可读性。
    await summary.click()
  }
  await expect(publication).toContainText('已完成 3 个独立核查角度。')
  if (libraryEntry) {
    const frozen = panel.getByRole('region', { name: '本步骤冻结证据', exact: true })
    await frozen.locator('.frozen-row > summary').first().click()
    await expect(frozen).toContainText(frozenContent)
    await expect(frozen).toContainText('0 · 确定错误')
    await expect(frozen).toContainText(collectionReason)
    await expect(frozen).toContainText('仅适用本次样本')
    await expect(frozen).toContainText('C10 人工收录依据：复查原始采样记录。')
    await expect(frozen).toContainText('启动时状态')
    await expect(frozen).toContainText('有效')
    await expect(frozen).toContainText('白名单')
    await expect(publication).toContainText('C10 本次核查将固定库材料作为独立对照。')
    expect((await gateway.read('evidence.get', { workspaceId: environment.workspaceId, entryId: libraryEntry.id })).status).toBe('withdrawn')
  }
  const pending = await gateway.read('run.get', { mapId: map.mapId, runId })
  const operation = pending.operations.find(
    /* 本次真实运行保存的Operation。 */ item => /* 只核对当前结果审核，不用页面私有状态。 */ item.review?.kind === 'result' && item.review.state === 'pending',
  )
  if (!operation?.review) throw new Error(WorkspaceAcceptanceMessage.RESULT_REVIEW_MISSING)
  const preview = await gateway.read('run.publication.preview', { mapId: map.mapId, runId,
    operationId: operation.id, reviewId: operation.review.id, expectedReviewRevision: operation.review.revision })
  expect(preview.items).toHaveLength(4)
  await expect(approve).toBeEnabled()
  await approve.click()
  await expect(approve).toBeHidden()
  const saved = await gateway.read('run.get', { mapId: map.mapId, runId })
  expect(saved.status).toBe('completed')
  const outputRefs = saved.operations.find(
    /* 发布后保存的Operation。 */ item => /* 精确定位本次批准的原步骤。 */ item.id === operation.id,
  )?.outputRefs
  expect(outputRefs?.map(
    /* 后端正式发布的候选引用。 */ ref => /* 使用稳定候选身份独立核对权威集合。 */ ({ workId: ref.workId, key: ref.key, port: ref.port }),
  )).toEqual(preview.items.map(
    /* 批准前独立读取的权威条目。 */ item => /* 去除预览元数据，仅比较真实发布身份。 */ ({ workId: item.workId, key: item.key, port: item.port }),
  ))
  expect((await gateway.read('map.get', { mapId: map.mapId })).nodes).toHaveLength(6)
  expect(environment.errors).toEqual([])
})

test('M05-C11 历史独立查看已归档和待审核运行，关闭后保留当前运行选择与控制', async (
  /* 每例独占真实Host和存储，页面只读历史，独立客户端核对归档与当前控制。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 自动完成A后启动待规划审核的B，让真实启动行为归档A，再验证历史阅读不改变B。
  const contentA = 'C11 已完成运行A的完整输入正文，归档后仍可核对。'
  const contentB = 'C11 当前运行B的完整输入正文，等待人工批准执行计划。'
  let map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C11 运行历史独立阅读', contentA)
  const inputA = map.nodes[0]
  if (!inputA) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const inputB = randomUUID()
  map = (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: map.mapId, branch: { rootIds: [inputB], expectedVersion: null },
    changes: { nodes: { put: [{ id: inputB, typeId: 'factcheck.claim', typeVersion: 1,
      payload: { content: contentB, category: 'data' } }] } },
  })).data.snapshot

  async function startHistoryRun(
    /* 本次启动唯一使用的事实节点，避免复用A的已完成Operation。 */ nodeId: string,
    /* 随后通过目录与详情精确核对的完整运行身份。 */ runId: string,
    /* A自动发布，B等待人工规划审核。 */ mode: 'auto' | 'human-in-loop',
  ): Promise<GraphSuccess<GraphWriteResult>> {
    // 通过真实分支授权和run.start建立历史场景，不直接写入归档或运行记录。
    const branch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [nodeId] })
    const claim = storage === 'mongo'
      ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [nodeId], holderId: randomUUID() })
      : null
    if (claim && claim.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.HISTORY_BRANCH_BUSY)
    const plan: GraphRunPlan = { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 },
      dependsOn: [], input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [nodeId] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] }
    return gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, id: runId,
      branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
      ...(claim?.data.status === 'claimed' ? { lease: { leaseId: claim.data.grant.leaseId,
        holderId: claim.data.grant.holderId, fence: claim.data.grant.fence } } : {}),
      scope: { nodeIds: [nodeId] }, plan, mode })
  }

  const runA = randomUUID()
  await startHistoryRun(inputA.id, runA, 'auto')
  await expect.poll(async () => {
    // 仅查询既有run.get等待真实Host完成，页面缺少目录入口才是本例的功能红灯。
    return (await gateway.read('run.get', { mapId: map.mapId, runId: runA })).status
  }, { timeout: 25_000 }).toBe('completed')
  const savedA = await gateway.read('run.get', { mapId: map.mapId, runId: runA })
  expect(savedA.operations.flatMap(
    /* 完成A时真实保存的处理步骤。 */ operation => /* 独立统计实际发布引用，不以页面数量为依据。 */ operation.outputRefs,
  )).toHaveLength(4)
  const runB = randomUUID()
  const startedB = await startHistoryRun(inputB, runB, 'human-in-loop')
  if (startedB.data.runControl) await gateway.dispatch(randomUUID(), 'run.control.release', {
    mapId: map.mapId, runId: runB, control: { leaseId: startedB.data.runControl.leaseId,
      holderId: startedB.data.runControl.holderId, fence: startedB.data.runControl.fence },
  })
  await expect.poll(async () => {
    // B必须确实停在待规划审核，避免用完成记录掩盖历史只读门控缺口。
    return (await gateway.read('run.get', { mapId: map.mapId, runId: runB })).operations.some(
      /* B本次已保存的真实Operation。 */ operation => /* 必须是仍待决定的计划审核。 */
        operation.status === 'waiting' && operation.review?.kind === 'plan' && operation.review.state === 'pending',
    )
  }, { timeout: 20_000 }).toBe(true)
  const current = await gateway.read('map.get', { mapId: map.mapId })
  expect(current.runs.map(
    /* 当前公开快照中的未归档运行。 */ run => /* A应由启动B的真实事务移出当前集合。 */ run.id,
  )).toEqual([runB])
  expect((await gateway.read('run.get', { mapId: map.mapId, runId: runA })).status).toBe('completed')

  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  const currentPanel = page.getByRole('region', { name: '运行进度与审核', exact: true })
  // C17沿真实待审核运行核对权威步骤，不以Operation内部阶段代替整个计划。
  const currentSteps = currentPanel.getByRole('region', { name: '运行步骤', exact: true })
  await expect(currentSteps.getByRole('region', { name: '步骤 1', exact: true })).toContainText('待审核 1')
  const selector = page.getByRole('combobox', { name: /^运行任务/ })
  await expect(selector).toHaveValue(runB)
  if (storage === 'mongo') await currentPanel.getByRole('button', { name: '领取运行控制权', exact: true }).click()
  await expect(currentPanel.getByRole('button', { name: '批准执行计划', exact: true })).toBeEnabled()
  const before = (await gateway.read('map.get', { mapId: map.mapId })).runControls.find(
    /* 真实后端返回的当前控制租约。 */ control => /* 只记录B的租约，不依赖页面私有会话状态。 */ control.runId === runB,
  )
  if (storage === 'mongo' && !before) throw new Error(WorkspaceAcceptanceMessage.HISTORY_CONTROL_MISSING)
  if (storage === 'sqlite') expect(before).toBeUndefined()

  const methods: string[] = []
  const recordMethod = (
    /* 历史阅读期间页面实际发出的请求，只保留公共方法名。 */ request: Request,
  ): void => {
    // 正常续租可以继续，后续只拒绝新控制、写命令和权威发布预览。
    const method = workspaceReadRequestMethod(request)
    if (method) methods.push(method)
  }
  page.on('request', recordMethod)
  try {
    await page.getByRole('button', { name: '运行历史', exact: true }).click()
    const history = page.getByRole('dialog', { name: '运行历史', exact: true })
    await expect(history).toBeVisible()
    await history.getByRole('button', { name: `查看运行 ${runA}`, exact: true }).click()
    const details = history.getByRole('region', { name: '运行历史详情', exact: true })
    await expect(details).toContainText(contentA)
    await expect(details.getByRole('region', { name: '运行步骤', exact: true }).getByRole('region', { name: '步骤 1', exact: true })).toContainText('已完成')
    const outputs = details.getByRole('region', { name: '已发布结果', exact: true })
    await expect(outputs).toContainText('4 项')
    for (const summary of await outputs.locator('.candidate-row > summary').all()) {
      // 使用真实候选展开控件阅读已发布正文，而不只检查隐藏DOM中的摘要。
      await summary.click()
    }
    await expect(outputs).toContainText('已完成 3 个独立核查角度。')
    await history.getByRole('button', { name: `查看运行 ${runB}`, exact: true }).click()
    await expect(details).toContainText(contentB)
    await expect(details.getByRole('region', { name: '执行计划', exact: true })).toBeVisible()
    await expect(history.getByRole('button', { name: /批准|拒绝|领取.*控制|释放.*控制|暂停|继续处理|取消本次运行|预览/ })).toHaveCount(0)
    await expect(history.getByRole('region', { name: '本次将发布', exact: true })).toHaveCount(0)
    await history.getByRole('button', { name: '关闭运行历史', exact: true }).click()
    await expect(history).not.toBeVisible()
    await expect(selector).toHaveValue(runB)
    await expect(currentPanel.getByRole('button', { name: '批准执行计划', exact: true })).toBeEnabled()
    const after = (await gateway.read('map.get', { mapId: map.mapId })).runControls.find(
      /* 历史关闭后独立读取的控制租约。 */ control => /* 控制对象必须仍属于B。 */ control.runId === runB,
    )
    expect(after ? { leaseId: after.leaseId, holderId: after.holderId, fence: after.fence } : null)
      .toEqual(before ? { leaseId: before.leaseId, holderId: before.holderId, fence: before.fence } : null)
    expect(methods).toContain('run.list')
    expect(methods.filter(
      /* 历史窗口期间实际发出的公共方法。 */ method => /* 续租不是新意图，其余写入和预览均不得出现。 */
        ['branch.claim', 'branch.release', 'graph.apply', 'run.start', 'run.control.claim', 'run.control.release',
          'run.pause', 'run.resume', 'run.cancel', 'review.answer', 'run.publication.preview'].includes(method),
    )).toEqual([])
    expect((await gateway.read('run.get', { mapId: map.mapId, runId: runB })).operations.some(
      /* 关闭历史后B保存的审核。 */ operation => /* 原待决定审核不得被只读查看隐式回答。 */ operation.review?.state === 'pending',
    )).toBe(true)
    expect(environment.errors).toEqual([])
  } finally {
    page.off('request', recordMethod)
  }
})

test('M05-C12 生成与复用来源可只读定位和展开冻结规格，关闭后保留独立当前运行', async (
  /* 每例独占真实Host与存储，所有来源和复用均由正常公开命令产生。 */ { page, gateway, environment, webUrl, storage },
) => {
  // A真实生成，B合法复用；编辑原产物后独立C待审核，整段来源阅读不得控制C。
  let map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C12 生成与复用来源', 'C12 原始事实，供A生成并由B按同一规格复用。')
  const inputA = map.nodes[0]
  if (!inputA) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)

  async function startProvenanceRun(
    /* A/B使用同一输入，C使用独立事实，不直接写入历史。 */ nodeId: string,
    /* 随后独立核对来源与当前选择的完整运行身份。 */ runId: string,
    /* A/B自动完成，C停在人工规划审核。 */ mode: 'auto' | 'human-in-loop',
  ): Promise<GraphSuccess<GraphWriteResult>> {
    // 运行前只通过真实分支入口取授权，明确关闭重新生成以验证生产复用规则。
    const branch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [nodeId] })
    const claim = storage === 'mongo'
      ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [nodeId], holderId: randomUUID() })
      : null
    if (claim && claim.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.HISTORY_BRANCH_BUSY)
    const plan: GraphRunPlan = { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 },
      dependsOn: [], input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [nodeId] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] }
    return gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, id: runId,
      branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
      ...(claim?.data.status === 'claimed' ? { lease: { leaseId: claim.data.grant.leaseId,
        holderId: claim.data.grant.holderId, fence: claim.data.grant.fence } } : {}),
      scope: { nodeIds: [nodeId] }, plan, regenerate: false, mode })
  }

  const runA = randomUUID(), runB = randomUUID(), runC = randomUUID()
  await startProvenanceRun(inputA.id, runA, 'auto')
  await expect.poll(async () => {
    // 等待真实Host发布A，不把测试构造的候选当作已生成记录。
    return (await gateway.read('run.get', { mapId: map.mapId, runId: runA })).status
  }, { timeout: 25_000 }).toBe('completed')
  const savedA = await gateway.read('run.get', { mapId: map.mapId, runId: runA })
  const operationA = savedA.operations[0]
  if (!operationA) throw new Error(WorkspaceAcceptanceMessage.PROVENANCE_OPERATION_MISSING)
  const original = await gateway.read('map.get', { mapId: map.mapId })
  const output = original.nodes.find(
    /* A已经正式发布的真实产物。 */ node => /* 结论正文唯一，供后续键盘导航和版本差异核对。 */ node.typeId === 'factcheck.verification',
  )
  if (!output?.producer) throw new Error(WorkspaceAcceptanceMessage.PROVENANCE_OUTPUT_MISSING)
  const originalReason = output.payload.reason
  expect(typeof originalReason).toBe('string')
  expect(operationA.outputRefs).toHaveLength(4)
  expect(output.producer.operationId).toBe(operationA.id)
  const modelCallsAfterA = environment.modelCalls.length

  await startProvenanceRun(inputA.id, runB, 'auto')
  const savedB = await gateway.read('run.get', { mapId: map.mapId, runId: runB })
  const operationB = savedB.operations[0]
  if (!operationB) throw new Error(WorkspaceAcceptanceMessage.PROVENANCE_OPERATION_MISSING)
  expect(savedB.status).toBe('completed')
  expect(operationB.reusedFromOperationId).toBe(operationA.id)
  expect(operationB.outputRefs).toEqual(operationA.outputRefs)
  expect(operationB.stages).toEqual(operationA.stages)
  expect(environment.modelCalls).toHaveLength(modelCallsAfterA)
  const reused = await gateway.read('map.get', { mapId: map.mapId })
  expect(reused.nodes).toEqual(original.nodes)
  expect(workspaceReadNode(reused, output.id).producer).toEqual(output.producer)

  const editedReason = 'C12 当前结论已由人工补充；来源记录仍应展示最初保存的核查正文。'
  const branch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [output.id] })
  const editing = storage === 'mongo'
    ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [output.id], holderId: randomUUID() })
    : null
  if (editing && editing.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.HISTORY_BRANCH_BUSY)
  map = (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    ...(editing?.data.status === 'claimed' ? { lease: { leaseId: editing.data.grant.leaseId,
      holderId: editing.data.grant.holderId, fence: editing.data.grant.fence } } : {}),
    changes: { nodes: { put: [{ id: output.id, typeId: output.typeId, typeVersion: output.typeVersion,
      payload: { ...output.payload, reason: editedReason } }] } },
  })).data.snapshot
  if (editing?.data.status === 'claimed') await gateway.dispatch(randomUUID(), 'branch.release', {
    mapId: map.mapId, lease: { leaseId: editing.data.grant.leaseId,
      holderId: editing.data.grant.holderId, fence: editing.data.grant.fence },
  })
  const edited = workspaceReadNode(map, output.id)
  expect(edited.revision).toBe(output.revision + 1)
  expect(edited.producer).toEqual(output.producer)

  const inputC = randomUUID()
  map = (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: map.mapId, branch: { rootIds: [inputC], expectedVersion: null },
    changes: { nodes: { put: [{ id: inputC, typeId: 'factcheck.claim', typeVersion: 1,
      payload: { content: 'C12 独立当前事实，来源阅读期间保持待审核。', category: 'data' } }] } },
  })).data.snapshot
  const startedC = await startProvenanceRun(inputC, runC, 'human-in-loop')
  if (startedC.data.runControl) await gateway.dispatch(randomUUID(), 'run.control.release', {
    mapId: map.mapId, runId: runC, control: { leaseId: startedC.data.runControl.leaseId,
      holderId: startedC.data.runControl.holderId, fence: startedC.data.runControl.fence },
  })
  await expect.poll(async () => {
    // C必须确实停在待审核，历史查看不能暗中批准或推进它。
    return (await gateway.read('run.get', { mapId: map.mapId, runId: runC })).operations.some(
      /* C正常Host接受的真实Operation。 */ operation => /* 只等待尚未决定的计划审核。 */
        operation.review?.kind === 'plan' && operation.review.state === 'pending',
    )
  }, { timeout: 20_000 }).toBe(true)

  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  const currentPanel = page.getByRole('region', { name: '运行进度与审核', exact: true })
  const selector = page.getByRole('combobox', { name: /^运行任务/ })
  await expect(selector).toHaveValue(runC)
  if (storage === 'mongo') await currentPanel.getByRole('button', { name: '领取运行控制权', exact: true }).click()
  await expect(currentPanel.getByRole('button', { name: '批准执行计划', exact: true })).toBeEnabled()
  const before = (await gateway.read('map.get', { mapId: map.mapId })).runControls.find(
    /* 当前真实控制权。 */ control => /* 不借页面内部状态核对C的租约。 */ control.runId === runC,
  )
  if (storage === 'mongo' && !before) throw new Error(WorkspaceAcceptanceMessage.HISTORY_CONTROL_MISSING)
  if (storage === 'sqlite') expect(before).toBeUndefined()

  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await scene.focus()
  await scene.press('Escape')
  let selectedOutput = false
  for (let index = 0; index < map.nodes.length; index++) {
    // 用真实键盘循环选择公开画布中的节点，按唯一正文找到已编辑结论。
    await scene.press('ArrowRight')
    if ((await page.locator('.scene-selection strong').innerText()).includes(editedReason)) { selectedOutput = true; break }
  }
  expect(selectedOutput).toBe(true)
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  const source = inspector.getByRole('region', { name: '创建来源', exact: true })
  await expect(source).toBeVisible()
  await expect(source).toContainText('自动生成')
  await expect(source).toContainText(operationA.id)
  await expect(source).toContainText(output.producer.agentName)

  const methods: string[] = []
  const recordMethod = (
    /* 只读来源导航期间的真实公开请求。 */ request: Request,
  ): void => {
    // 只保存方法名，不读取认证头、令牌或任意业务负载。
    const method = workspaceReadRequestMethod(request)
    if (method) methods.push(method)
  }
  page.on('request', recordMethod)
  try {
    await source.getByRole('button', { name: '查看生成记录', exact: true }).click()
    const history = page.getByRole('dialog', { name: '运行历史', exact: true })
    const details = history.getByRole('region', { name: '运行历史详情', exact: true })
    const targetA = details.locator(`[data-operation-id="${operationA.id}"]`)
    await expect(history.getByRole('button', { name: /^查看运行 / })).toHaveCount(1)
    await expect(history.getByRole('button', { name: `查看运行 ${runA}`, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(targetA).toBeVisible()
    await expect(history).toContainText(new RegExp(`当前版本\\s*${edited.revision}`))
    await expect(history).toContainText(new RegExp(`产出版本\\s*${output.revision}`))
    const published = targetA.getByRole('region', { name: '已发布结果', exact: true })
    for (const summary of await published.locator('.candidate-row > summary').all()) {
      // 展开正式产物保存的候选，确认它没有被当前编辑后的正文替换。
      await summary.click()
    }
    await expect(published).toContainText(String(originalReason))
    await expect(published).not.toContainText(editedReason)
    await targetA.locator('summary').filter({ hasText: /^冻结执行规格$/ }).click()
    await expect(targetA).toContainText(operationA.specHash)
    const frozenSummary = targetA.locator('summary').filter({ hasText: /^完整执行规格 JSON$/ })
    await frozenSummary.click()
    const frozenJson = frozenSummary.locator('..').locator('pre')
    await expect(frozenJson).toBeVisible()
    expect(JSON.parse(await frozenJson.innerText())).toEqual(operationA.executionSpec)

    await history.getByRole('button', { name: '返回全部运行', exact: true }).click()
    await history.getByRole('button', { name: `查看运行 ${runB}`, exact: true }).click()
    const targetB = details.locator(`[data-operation-id="${operationB.id}"]`)
    await expect(targetB).toContainText('复用历史结果')
    await expect(targetB).toContainText(operationA.id)
    await targetB.getByRole('button', { name: '查看直接复用来源', exact: true }).click()
    await expect(history.getByRole('button', { name: `查看运行 ${runA}`, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(targetA).toBeVisible()
    await history.getByRole('button', { name: '关闭运行历史', exact: true }).click()
    await expect(history).not.toBeVisible()

    await page.getByRole('button', { name: '单页', exact: true }).click()
    const reader = page.getByRole('region', { name: '单页阅读', exact: true })
    const readerSource = reader.getByRole('region', { name: '创建来源', exact: true })
    await expect(readerSource).toContainText(operationA.id)
    await expect(reader.getByRole('region', { name: '节点完整内容', exact: true })).toContainText(editedReason)
    await readerSource.getByRole('button', { name: '查看生成记录', exact: true }).click()
    await expect(targetA).toBeVisible()
    await expect(history.getByRole('button', { name: `查看运行 ${runA}`, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await history.getByRole('button', { name: '关闭运行历史', exact: true }).click()
    await expect(history).not.toBeVisible()
    await page.getByRole('button', { name: '关系图', exact: true }).click()
    await expect(selector).toHaveValue(runC)
    await expect(currentPanel.getByRole('button', { name: '批准执行计划', exact: true })).toBeEnabled()
    const after = await gateway.read('map.get', { mapId: map.mapId })
    const controlAfter = after.runControls.find(
      /* 关闭来源后的当前控制记录。 */ control => /* 原租约可以续期，但身份和fence不得改变。 */ control.runId === runC,
    )
    expect(controlAfter ? { leaseId: controlAfter.leaseId, holderId: controlAfter.holderId, fence: controlAfter.fence } : null)
      .toEqual(before ? { leaseId: before.leaseId, holderId: before.holderId, fence: before.fence } : null)
    expect(workspaceReadNode(after, output.id)).toEqual(edited)
    expect((await gateway.read('run.get', { mapId: map.mapId, runId: runC })).operations.some(
      /* 原独立当前运行的已保存处理项。 */ operation => /* 所有只读来源查看不得替用户决定审核。 */ operation.review?.state === 'pending',
    )).toBe(true)
    expect(methods).toContain('run.list')
    expect(methods.filter(
      /* 来源阅读期间公开请求的方法名。 */ method => /* 正常续租允许，新增写入、领取/释放和发布预览均禁止。 */
        ['branch.claim', 'branch.release', 'graph.apply', 'run.start', 'run.control.claim', 'run.control.release',
          'run.pause', 'run.resume', 'run.cancel', 'review.answer', 'run.publication.preview'].includes(method),
    )).toEqual([])
    expect(environment.errors).toEqual([])
  } finally {
    page.off('request', recordMethod)
  }
})

test('M06-C13 精确包只读浏览后发布独立新定义，创建入口更新且旧节点和冻结运行保持', async (
  /* 正常页面、独立公共核对客户端与真实Host，不直接写定义或运行记录。 */ { page, browser, gateway, environment, webUrl, storage },
) => {
  // 先保存旧节点和真实待审核运行，再由Owner页面发布新包；Viewer只读同一目录。
  const viewer = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C13 定义发布后保留旧运行', 'C13 原事实保持类型版本1，既有冻结运行不迁移。')
  const input = map.nodes[0]
  if (!input) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const branch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [input.id] })
  const claim = storage === 'mongo'
    ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [input.id], holderId: randomUUID() })
    : null
  if (claim && claim.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.REVIEW_BRANCH_BUSY)
  const runId = randomUUID()
  const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, id: runId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    ...(claim?.data.status === 'claimed' ? { lease: { leaseId: claim.data.grant.leaseId,
      holderId: claim.data.grant.holderId, fence: claim.data.grant.fence } } : {}),
    scope: { nodeIds: [input.id] }, mode: 'human-in-loop',
    plan: { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] },
  })
  if (started.data.runControl) await gateway.dispatch(randomUUID(), 'run.control.release', {
    mapId: map.mapId, runId, control: { leaseId: started.data.runControl.leaseId,
      holderId: started.data.runControl.holderId, fence: started.data.runControl.fence },
  })
  await expect.poll(async () => {
    // 等待Host实际保存待决定计划，之后的定义发布不能替换这份冻结规格。
    return (await gateway.read('run.get', { mapId: map.mapId, runId })).operations.some(
      /* 本次真实运行保存的处理项。 */ operation => /* 必须已有封闭计划审核。 */
        operation.review?.kind === 'plan' && operation.review.state === 'pending',
    )
  }, { timeout: 20_000 }).toBe(true)
  const originalRun = await gateway.read('run.get', { mapId: map.mapId, runId })
  const originalMap = await gateway.read('map.get', { mapId: map.mapId })
  const originalDefinitions = await gateway.read('definition.get', { workspaceId: environment.workspaceId })
  const packageRef = originalDefinitions.catalog.packages[0]?.ref
  if (!packageRef) throw new Error(WorkspaceAcceptanceMessage.DEFINITION_PACKAGE_MISSING)
  const originalPackage = (await gateway.read('definition.get', { workspaceId: environment.workspaceId,
    packageId: packageRef.id, packageVersion: packageRef.version })).package
  if (!originalPackage) throw new Error(WorkspaceAcceptanceMessage.DEFINITION_PACKAGE_MISSING)
  const beforeWorkspace = await gateway.read('workspace.get', { workspaceId: environment.workspaceId })
  const packageItem: DefinitionPackage = { id: 'c13.paper-notes', version: 1, title: 'C13 纸面笔记定义包',
    schemaDialect: 'http://json-schema.org/draft-07/schema#',
    dataTypes: [{ id: 'c13.paper-note', version: 1, title: 'C13 纸面笔记',
      schema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
      successorTypes: [], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] },
      presentation: { titlePath: '/text', summaryPath: '/text', fieldLabels: { '/text': '笔记正文' } } }],
    transitions: [], dependencies: { packages: [], agents: [] } }

  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await page.getByRole('button', { name: '管理工作台', exact: true }).click()
  const management = page.getByRole('dialog', { name: '工作台管理', exact: true })
  await management.getByRole('button', { name: '定义中心', exact: true }).click()
  const center = management.getByRole('region', { name: '定义中心', exact: true })
  await expect(center.getByRole('button', { name: '当前工作区', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await center.getByRole('button', { name: `查看定义包 ${packageRef.id}@${packageRef.version}`, exact: true }).click()
  const publishedSummary = center.locator('summary').filter({ hasText: /^完整定义包 JSON$/ })
  await publishedSummary.click()
  const publishedJson = publishedSummary.locator('..').locator('pre')
  await expect(publishedJson).toBeVisible()
  expect(JSON.parse(await publishedJson.innerText())).toEqual(originalPackage)
  await expect(center.getByRole('textbox', { name: '定义包 JSON', exact: true })).toHaveCount(0)
  await center.getByRole('button', { name: '新建 JSON 草稿', exact: true }).click()
  await center.getByRole('textbox', { name: '定义包 JSON', exact: true }).fill(JSON.stringify(packageItem, null, 2))
  await center.getByRole('button', { name: '检查发布内容', exact: true }).click()
  await expect(center).toContainText(packageItem.id)
  await expect(center).toContainText(beforeWorkspace.name)
  const publication = center.getByRole('button', { name: '发布新版本', exact: true })
  await expect(publication).toBeEnabled()
  await publication.click()
  const success = center.getByRole('status').filter({ hasText: '定义包已发布' })
  await expect(success).toBeVisible()
  const definitions = await gateway.read('definition.get', { workspaceId: environment.workspaceId,
    packageId: packageItem.id, packageVersion: packageItem.version })
  expect(definitions.package).toEqual(packageItem)
  const savedPackage = definitions.catalog.packages.find(
    /* 服务器已经提交的精确包目录。 */ item => /* 不使用前端草稿计算的摘要冒充发布结果。 */
      item.ref.id === packageItem.id && item.ref.version === packageItem.version,
  )
  if (!savedPackage) throw new Error(WorkspaceAcceptanceMessage.DEFINITION_PACKAGE_MISSING)
  expect(savedPackage.digest).toMatch(/^[0-9a-f]{64}$/)
  await expect(success).toContainText(savedPackage.digest)
  await expect(center.getByRole('button', { name: `查看定义包 ${packageItem.id}@${packageItem.version}`, exact: true })).toBeVisible()
  expect((await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).revision).toBe(beforeWorkspace.revision + 1)
  const discard = center.getByRole('button', { name: '放弃草稿', exact: true })
  if (await discard.isVisible()) await discard.click()
  await center.getByRole('button', { name: '共享库', exact: true }).click()
  await expect(center.getByRole('button', { name: '共享库', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const shared = await gateway.read('definition.library.get', {})
  const sharedRef = shared.catalog.packages[0]?.ref
  if (!sharedRef) throw new Error(WorkspaceAcceptanceMessage.DEFINITION_PACKAGE_MISSING)
  const sharedExact = await gateway.read('definition.library.get', { packageId: sharedRef.id, packageVersion: sharedRef.version })
  await center.getByRole('button', { name: `查看定义包 ${sharedRef.id}@${sharedRef.version}`, exact: true }).click()
  const sharedSummary = center.locator('summary').filter({ hasText: /^完整定义包 JSON$/ })
  const sharedJson = sharedSummary.locator('..').locator('pre')
  if (!(await sharedJson.isVisible())) await sharedSummary.click()
  await expect(sharedJson).toBeVisible()
  expect(JSON.parse(await sharedJson.innerText())).toEqual(sharedExact.package)
  await expect(center.getByRole('button', { name: `查看定义包 ${packageItem.id}@${packageItem.version}`, exact: true })).toHaveCount(0)
  await expect(center.getByRole('button', { name: '新建 JSON 草稿', exact: true })).toHaveCount(0)
  expect(shared.catalog.packages.some(
    /* 真实共享库目录，不能借工作区目录。 */ item => /* 工作区新包不应串进共享范围。 */ item.ref.id === packageItem.id,
  )).toBe(false)
  await management.getByRole('button', { name: '关闭管理面板', exact: true }).click()
  await page.getByRole('button', { name: '＋ 数据', exact: true }).click()
  const creation = page.getByRole('dialog', { name: '添加数据', exact: true })
  const typeSelect = creation.getByRole('combobox', { name: /^数据类型/ })
  await expect(typeSelect.locator('option', { hasText: 'C13 纸面笔记 · 版本 1' })).toHaveCount(1)
  await typeSelect.selectOption('c13.paper-note@1')
  await expect(creation.getByRole('group', { name: '笔记正文', exact: true })).toBeVisible()
  await creation.getByRole('button', { name: '取消', exact: true }).click()
  expect((await gateway.read('map.get', { mapId: map.mapId })).nodes).toEqual(originalMap.nodes)
  expect(await gateway.read('run.get', { mapId: map.mapId, runId })).toEqual(originalRun)
  expect((await gateway.read('definition.get', { workspaceId: environment.workspaceId,
    packageId: packageRef.id, packageVersion: packageRef.version })).package).toEqual(originalPackage)

  const viewerContext = await browser.newContext()
  const viewerMethods: string[] = []
  try {
    const viewerPage = await viewerContext.newPage()
    viewerPage.on('request', (
      /* 只读成员实际浏览目录的公共请求。 */ request: Request,
    ) => {
      // 仅保留方法名，确认只读浏览没有发出发布意图。
      const method = workspaceReadRequestMethod(request)
      if (method) viewerMethods.push(method)
    })
    await workspaceLogin(viewerPage, webUrl, viewer.token)
    await viewerPage.getByRole('button', { name: '管理工作台', exact: true }).click()
    const viewerManagement = viewerPage.getByRole('dialog', { name: '工作台管理', exact: true })
    await viewerManagement.getByRole('button', { name: '定义中心', exact: true }).click()
    const readOnly = viewerManagement.getByRole('region', { name: '定义中心', exact: true })
    await readOnly.getByRole('button', { name: `查看定义包 ${packageItem.id}@${packageItem.version}`, exact: true }).click()
    await expect(readOnly).toContainText(packageItem.title)
    await expect(readOnly.getByRole('button', { name: /新建 JSON 草稿|复制为草稿|发布新版本|检查发布内容/ })).toHaveCount(0)
    expect(viewerMethods).not.toContain('definition.publish')
  } finally {
    await viewerContext.close()
  }
  expect(environment.errors).toEqual([])
})

test('M06-C14 通用智能体按精确阶段保存和改绑，保留变量身份与旧运行并隔离作用域权限', async (
  /* 一份真实后端和Host，页面编辑配置，独立API核对精确版本和冻结记录。 */ { page, browser, gateway, environment, webUrl, storage },
) => {
  // 只准备工作区专用转换和一个旧待审核Run，不启动新的Host或重写任何执行产物。
  const viewer = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
  const initialDefinitions = await gateway.read('definition.get', { workspaceId: environment.workspaceId })
  const initialAgents = await gateway.read('agent.list', { scope: { kind: 'workspace', workspaceId: environment.workspaceId } })
  const legacy = initialAgents.items.find(
    /* 服务实际保存的旧版配置。 */ agent => /* 用未绑定核查配置证明新增能力不自动迁移旧记录。 */
      agent.kind === 'verifySubAgent' && agent.bindings === undefined,
  )
  if (!legacy) throw new Error(WorkspaceAcceptanceMessage.BINDING_AGENT_MISSING)
  const verify = initialDefinitions.catalog.transitions.find(
    /* 原工作区精确目录中的真实转换。 */ transition => /* 只复制种子核查转换，不构造另一套执行规则。 */
      transition.id === 'factcheck.verify-claim' && transition.version === 1,
  )
  if (!verify) throw new Error(WorkspaceAcceptanceMessage.BINDING_TRANSITION_MISSING)
  const workspaceTransition = { ...structuredClone(verify), id: 'c14.workspace-verify', title: 'C14 工作区专用核查' }
  const dependency = initialDefinitions.catalog.packages[0]?.ref
  if (!dependency) throw new Error(WorkspaceAcceptanceMessage.DEFINITION_PACKAGE_MISSING)
  const seedPackage = (await gateway.read('definition.get', { workspaceId: environment.workspaceId,
    packageId: dependency.id, packageVersion: dependency.version })).package
  if (!seedPackage) throw new Error(WorkspaceAcceptanceMessage.DEFINITION_PACKAGE_MISSING)
  const workspace = await gateway.read('workspace.get', { workspaceId: environment.workspaceId })
  await gateway.dispatch(randomUUID(), 'definition.publish', { workspaceId: environment.workspaceId,
    expectedRevision: workspace.revision, package: { id: 'c14.workspace-stage', version: 1, title: 'C14 工作区独有阶段',
      schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes: [], transitions: [workspaceTransition],
      dependencies: { packages: initialDefinitions.catalog.packages.map(
        /* 已存在的精确发布包。 */ item => /* 重用旧类型和转换依赖，不重复声明旧定义。 */ ({ ...item.ref }),
      ), agents: structuredClone(seedPackage.dependencies.agents) } } })
  const frozenDefinitions = await gateway.read('definition.get', { workspaceId: environment.workspaceId })
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C14 改绑保留旧运行', 'C14 已冻结运行继续使用种子转换和原智能体版本。')
  const input = map.nodes[0]
  if (!input) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const branch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [input.id] })
  const claimed = storage === 'mongo'
    ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [input.id], holderId: randomUUID() }) : null
  if (claimed && claimed.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.REVIEW_BRANCH_BUSY)
  const runId = randomUUID()
  const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, id: runId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    ...(claimed?.data.status === 'claimed' ? { lease: { leaseId: claimed.data.grant.leaseId,
      holderId: claimed.data.grant.holderId, fence: claimed.data.grant.fence } } : {}),
    scope: { nodeIds: [input.id] }, mode: 'human-in-loop',
    plan: { steps: [{ id: 'verify', transitionRef: { id: verify.id, version: verify.version }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] },
  })
  if (started.data.runControl) await gateway.dispatch(randomUUID(), 'run.control.release', { mapId: map.mapId, runId,
    control: { leaseId: started.data.runControl.leaseId, holderId: started.data.runControl.holderId, fence: started.data.runControl.fence } })
  await expect.poll(async () => {
    // 旧Run必须已经保存待决定计划，避免用尚未冻结的空记录作保持性证据。
    return (await gateway.read('run.get', { mapId: map.mapId, runId })).operations.some(
      /* 真实Host接纳的处理项。 */ operation => /* 不批准或推进旧Run。 */ operation.review?.kind === 'plan' && operation.review.state === 'pending',
    )
  }, { timeout: 20_000 }).toBe(true)
  const originalRun = await gateway.read('run.get', { mapId: map.mapId, runId })

  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await page.getByRole('button', { name: '管理工作台', exact: true }).click()
  const management = page.getByRole('dialog', { name: '工作台管理', exact: true })
  await management.getByRole('button', { name: '智能体配置', exact: true }).click()
  const center = management.getByRole('region', { name: '智能体管理', exact: true })
  await center.getByRole('button', { name: '新增智能体', exact: true }).click()
  const mode = center.getByRole('combobox', { name: '配置方式', exact: true })
  await expect(mode).toBeVisible()
  await mode.selectOption({ label: '绑定已发布阶段' })
  await center.getByRole('textbox', { name: '智能体名称', exact: true }).fill('C14 精确阶段配置')
  await center.getByRole('textbox', { name: '智能体说明', exact: true }).fill('C14 先声明可参与阶段，再由后续转换版本显式引用。')
  await center.getByRole('textbox', { name: '智能体提示词', exact: true }).fill('C14 按分配阶段读取材料并产生对应结果，不替换既有冻结执行。')
  await center.locator('summary').filter({ hasText: /^身份与配置路径/ }).click()
  const agentId = 'c14-bound-agent', promptPath = 'custom/c14-bound-agent'
  await center.getByRole('textbox', { name: '智能体标识', exact: true }).fill(agentId)
  await center.getByRole('textbox', { name: '智能体配置路径', exact: true }).fill(promptPath)
  const role = center.getByRole('combobox', { name: '阶段职责', exact: true })
  const choices = center.getByRole('combobox', { name: '可绑定阶段', exact: true })
  await role.selectOption({ label: '规划任务' })
  await expect(choices.locator('option[value="factcheck.verify-claim@1:route"]')).toHaveCount(1)
  await expect(choices.locator('option[value="factcheck.verify-claim@1:assess"]')).toHaveCount(0)
  await role.selectOption({ label: '选择结果' })
  await expect(choices.locator('option[value="factcheck.split-news@1:merge"]')).toHaveCount(1)
  await expect(choices.locator('option[value="factcheck.verify-claim@1:route"]')).toHaveCount(0)
  await role.selectOption({ label: '生成内容' })
  await choices.selectOption('c14.workspace-verify@1:assess')
  await center.getByRole('button', { name: '添加绑定', exact: true }).click()
  await choices.selectOption('factcheck.verify-claim@1:assess')
  await center.getByRole('button', { name: '添加绑定', exact: true }).click()
  const bindings = center.getByRole('list', { name: '已选阶段绑定', exact: true })
  await expect(bindings.getByRole('button', { name: '移除绑定 c14.workspace-verify@1:assess', exact: true })).toBeVisible()
  await expect(bindings.getByRole('button', { name: '移除绑定 factcheck.verify-claim@1:assess', exact: true })).toBeVisible()
  await center.getByRole('checkbox', { name: 'claimContent', exact: true }).check()
  await center.getByRole('checkbox', { name: 'hint', exact: true }).check()
  const save = center.getByRole('button', { name: '保存智能体', exact: true })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(center.getByRole('status')).toContainText('配置版本 0')
  const created = (await gateway.read('agent.list', { scope: { kind: 'workspace', workspaceId: environment.workspaceId } })).items.find(
    /* 通过真实保存产生的新配置。 */ agent => /* 使用先前页面填写的稳定身份精确读取。 */ agent.id === agentId,
  )
  if (!created) throw new Error(WorkspaceAcceptanceMessage.BINDING_AGENT_MISSING)
  expect(created).toMatchObject({ id: agentId, kind: 'custom', promptPath, role: 'producer', revision: 0,
    promptVars: ['claimContent', 'hint'], bindings: [
      { transition: { id: workspaceTransition.id, version: 1 }, stageId: 'assess' },
      { transition: { id: verify.id, version: 1 }, stageId: 'assess' },
    ] })

  const draftWrites: string[] = []
  const recordDraftWrite = (
    /* 已创建配置之后、明确再次保存之前的页面请求。 */ request: Request,
  ): void => {
    // 改绑和移除变量只能改本地草稿，不能由表单按钮的默认提交发出写命令。
    const method = workspaceReadRequestMethod(request)
    if (method === 'agent.update' || method === 'agent.create') draftWrites.push(method)
  }
  page.on('request', recordDraftWrite)
  await center.getByRole('button', { name: '移除绑定 c14.workspace-verify@1:assess', exact: true }).click()
  await center.getByRole('button', { name: '移除绑定 factcheck.verify-claim@1:assess', exact: true }).click()
  await expect(save).toBeDisabled()
  await choices.selectOption('factcheck.verify-claim@1:merge')
  await center.getByRole('button', { name: '添加绑定', exact: true }).click()
  await expect(center.getByRole('button', { name: '移除变量 hint', exact: true })).toBeVisible()
  await expect(save).toBeDisabled()
  await center.getByRole('button', { name: '移除变量 hint', exact: true }).click()
  await expect(save).toBeEnabled()
  expect((await gateway.read('agent.list', { scope: { kind: 'workspace', workspaceId: environment.workspaceId } })).items.find(
    /* 明确保存前的后端记录。 */ agent => /* 本地草稿交互不能提前改写版本0配置。 */ agent.id === agentId,
  )).toEqual(created)
  expect(draftWrites).toEqual([])
  page.off('request', recordDraftWrite)
  await save.click()
  await expect(center.getByRole('status')).toContainText('配置版本 1')
  await center.getByRole('button', { name: '刷新列表', exact: true }).click()
  await expect(center.getByRole('textbox', { name: '智能体名称', exact: true })).toHaveValue(created.name)
  await expect(role).toHaveValue('producer')
  await expect(bindings.getByRole('button', { name: '移除绑定 factcheck.verify-claim@1:merge', exact: true })).toBeVisible()
  await expect(bindings.getByRole('button', { name: '移除绑定 c14.workspace-verify@1:assess', exact: true })).toHaveCount(0)
  const identity = center.getByRole('textbox', { name: '智能体标识', exact: true })
  if (!(await identity.isVisible())) await center.locator('summary').filter({ hasText: /^身份与配置路径/ }).click()
  await expect(identity).toHaveAttribute('readonly', '')
  await expect(identity).toHaveValue(agentId)
  await expect(center.getByRole('textbox', { name: '智能体配置路径', exact: true })).toHaveAttribute('readonly', '')
  const savedAgents = await gateway.read('agent.list', { scope: { kind: 'workspace', workspaceId: environment.workspaceId } })
  const updated = savedAgents.items.find(
    /* 刷新后独立读回的真实配置。 */ agent => /* 同一身份必须更新版本，而非另建配置。 */ agent.id === agentId,
  )
  expect(updated).toMatchObject({ id: agentId, kind: 'custom', promptPath, role: 'producer', revision: 1,
    promptVars: ['claimContent'], bindings: [{ transition: { id: verify.id, version: 1 }, stageId: 'merge' }] })
  expect(savedAgents.items.find(
    /* 同一工作区的原未绑定配置。 */ agent => /* 新功能不能给旧配置补绑定或改版本。 */ agent.id === legacy.id,
  )).toEqual(legacy)
  expect((await gateway.read('definition.get', { workspaceId: environment.workspaceId })).catalog.transitions)
    .toEqual(frozenDefinitions.catalog.transitions)
  expect(await gateway.read('run.get', { mapId: map.mapId, runId })).toEqual(originalRun)

  await center.getByRole('button', { name: '共享智能体库', exact: true }).click()
  await expect(center.getByRole('button', { name: '共享智能体库', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(center.getByRole('textbox', { name: '智能体名称', exact: true })).not.toBeEditable()
  await expect(center.getByRole('button', { name: '新增智能体', exact: true })).toHaveCount(0)
  await expect(center.getByRole('button', { name: /^C14 精确阶段配置/ })).toHaveCount(0)
  expect((await gateway.read('definition.library.get', {})).catalog.transitions.some(
    /* 真正的共享定义目录。 */ transition => /* 工作区专用阶段不进入共享范围。 */ transition.id === workspaceTransition.id,
  )).toBe(false)
  await center.getByRole('button', { name: '工作区智能体', exact: true }).click()
  await center.getByRole('button', { name: /^C14 精确阶段配置/ }).click()
  await expect(bindings.getByRole('button', { name: '移除绑定 factcheck.verify-claim@1:merge', exact: true })).toBeVisible()
  await management.getByRole('button', { name: '关闭管理面板', exact: true }).click()
  await expect(page.getByRole('combobox', { name: /^运行任务/ })).toHaveValue(runId)

  const viewerContext = await browser.newContext()
  const viewerMethods: string[] = []
  try {
    const viewerPage = await viewerContext.newPage()
    viewerPage.on('request', (
      /* 只读成员实际发出的公共请求。 */ request: Request,
    ) => {
      // 只保存方法名以核对只读操作，不读取令牌或配置正文。
      const method = workspaceReadRequestMethod(request)
      if (method) viewerMethods.push(method)
    })
    await workspaceLogin(viewerPage, webUrl, viewer.token)
    await viewerPage.getByRole('button', { name: '管理工作台', exact: true }).click()
    const viewerManagement = viewerPage.getByRole('dialog', { name: '工作台管理', exact: true })
    await viewerManagement.getByRole('button', { name: '智能体配置', exact: true }).click()
    const readOnly = viewerManagement.getByRole('region', { name: '智能体管理', exact: true })
    await readOnly.getByRole('button', { name: /^C14 精确阶段配置/ }).click()
    await expect(readOnly.getByRole('list', { name: '已选阶段绑定', exact: true })
      .getByRole('button', { name: '移除绑定 factcheck.verify-claim@1:merge', exact: true })).toBeDisabled()
    await expect(readOnly.getByRole('combobox', { name: '阶段职责', exact: true })).toBeDisabled()
    await expect(readOnly.getByRole('button', { name: '保存智能体', exact: true })).toHaveCount(0)
    await expect(readOnly.getByRole('button', { name: '新增智能体', exact: true })).toHaveCount(0)
    expect(viewerMethods.filter(
      /* 只读成员在管理页实际发出的公开方法。 */ method => /* 浏览不能隐式创建或改写配置。 */ method === 'agent.create' || method === 'agent.update',
    )).toEqual([])
  } finally {
    await viewerContext.close()
  }
  expect(environment.errors).toEqual([])
})

test('M07-C15 两入口经同一运行表单确认，固定材料随目标清理且实际启动参数一致', async (
  /* 原真实服务和Host，两入口实际启动但只停在计划审核，不新增完整审核链。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 保留一项无关待审核运行，验证草稿往返和两次独立确认不会改写它。
  let map = await workspacePrepareMap(gateway, environment.workspaceId, 'C15 统一运行草稿')
  const [claimA, claimB, newsId] = [randomUUID(), randomUUID(), randomUUID()].sort()
  if (!claimA || !claimB || !newsId) throw new Error(WorkspaceAcceptanceMessage.READING_IDENTITIES_MISSING)
  const contentA = 'C15 当前事实甲用于两个运行入口的相同范围'
  const contentB = 'C15 无关事实乙保持原待审核运行'
  const updatedContent = 'C15 当前事实甲已更新版本，需要重新核对固定材料'
  const libraryContent = 'C15 显式选中的固定库材料原文'
  map = (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId,
    branch: { rootIds: [claimA, claimB, newsId], expectedVersion: null }, changes: { nodes: { put: [
      { id: claimA, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: contentA, category: 'data' } },
      { id: claimB, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: contentB, category: 'data' } },
      { id: newsId, typeId: 'factcheck.news', typeVersion: 1, payload: { content: 'C15 仅用于切换转换的新闻材料', context: {} } },
    ] } } })).data.snapshot
  const definitions = await gateway.read('definition.get', { workspaceId: environment.workspaceId })
  const verify = definitions.catalog.transitions.find(
    /* 真实工作区目录中的精确转换。 */ transition => /* 两入口都使用同一默认核查合同。 */
      transition.id === 'factcheck.verify-claim' && transition.version === 1,
  )
  if (!verify) throw new Error(WorkspaceAcceptanceMessage.BINDING_TRANSITION_MISSING)
  let libraryEntry: EvidenceLibraryEntry | undefined
  if (storage === 'mongo') {
    const source = await workspacePrepareClaim(gateway, environment.workspaceId, 'C15 独立固定材料来源', libraryContent)
    const sourceClaim = source.nodes[0]
    if (!sourceClaim) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
    libraryEntry = (await gateway.dispatch(randomUUID(), 'evidence.collect', { workspaceId: environment.workspaceId,
      claim: { mapId: source.mapId, nodeId: sourceClaim.id, revision: sourceClaim.revision }, confidence: 0,
      applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
      reason: 'C15 运行只冻结显式选中的材料', basisRefs: [] })).data.entry
  }
  const unrelatedId = randomUUID()
  const unrelatedBranch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [claimB] })
  const unrelatedClaim = storage === 'mongo'
    ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [claimB], holderId: randomUUID() }) : null
  if (unrelatedClaim && unrelatedClaim.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.REVIEW_BRANCH_BUSY)
  const unrelated = await gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, id: unrelatedId,
    branch: { rootIds: unrelatedBranch.scope.rootIds, expectedVersion: unrelatedBranch.version },
    ...(unrelatedClaim?.data.status === 'claimed' ? { lease: { leaseId: unrelatedClaim.data.grant.leaseId,
      holderId: unrelatedClaim.data.grant.holderId, fence: unrelatedClaim.data.grant.fence } } : {}),
    scope: { nodeIds: [claimB] }, mode: 'human-in-loop', regenerate: false,
    plan: { steps: [{ id: 'verify', transitionRef: { id: verify.id, version: verify.version }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [claimB] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] } })
  if (unrelated.data.runControl) await gateway.dispatch(randomUUID(), 'run.control.release', { mapId: map.mapId, runId: unrelatedId,
    control: { leaseId: unrelated.data.runControl.leaseId, holderId: unrelated.data.runControl.holderId, fence: unrelated.data.runControl.fence } })
  await expect.poll(async () => {
    // 先取得无关运行已经保存的待审核状态，之后不再控制它。
    return (await gateway.read('run.get', { mapId: map.mapId, runId: unrelatedId })).operations.some(
      /* 乙分支的已接纳处理项。 */ operation => /* 只等待真正的计划审核。 */ operation.review?.kind === 'plan' && operation.review.state === 'pending',
    )
  }, { timeout: 20_000 }).toBe(true)
  const savedUnrelated = await gateway.read('run.get', { mapId: map.mapId, runId: unrelatedId })
  const starts: unknown[] = [], evidenceReads: string[] = []
  page.on('request', (
    /* 页面实际发出的公共请求，不读取令牌或组件私有状态。 */ request: Request,
  ) => {
    // 独立API准备不进入页面计数，只有明确确认后的真实浏览器启动才记录。
    const method = workspaceReadRequestMethod(request)
    if (method === 'run.start') starts.push(request.postDataJSON())
    if (method.startsWith('evidence.')) evidenceReads.push(method)
  })
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  await workspaceAcquireEditor(page, storage === 'mongo')
  const inspector = page.getByRole('region', { name: '数据详情', exact: true })
  const draftContent = 'C15 尚未保存的正文草稿，打开运行窗口后仍需保留'
  await workspaceContentInput(inspector).fill(draftContent)
  await page.getByRole('button', { name: '运行转换', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '运行数据转换', exact: true })
  await dialog.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.verify-claim@1')
  await expect(dialog.getByRole('checkbox', { name: new RegExp(contentA) })).toBeVisible()
  await expect(dialog).not.toContainText(draftContent)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(workspaceContentInput(inspector)).toHaveValue(draftContent)
  await expect(page.getByRole('button', { name: '关系图', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(starts).toHaveLength(0)
  await inspector.getByRole('button', { name: '恢复已保存内容', exact: true }).click()
  if (storage === 'mongo') await inspector.getByRole('button', { name: '释放分支编辑权', exact: true }).click()
  await inspector.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.verify-claim@1')
  await inspector.getByRole('button', { name: `配置并运行 ${verify.title}`, exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: '转换', exact: true })).toHaveValue('factcheck.verify-claim@1')
  await expect(dialog.getByRole('combobox', { name: '处理方式', exact: true })).toHaveValue('human-in-loop')
  const regenerate = dialog.getByRole('checkbox', { name: '重新生成已有结果', exact: true })
  await expect(regenerate).not.toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: new RegExp(contentA) })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: new RegExp(contentB) })).not.toBeChecked()
  const materials = dialog.getByRole('group', { name: '证据库材料 · 可选', exact: true })
  await expect(materials).toContainText('已选 0/32 条')
  if (libraryEntry) {
    await materials.getByRole('checkbox', { name: new RegExp(libraryContent) }).check()
    await expect(materials).toContainText('已选 1/32 条')
    await dialog.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.split-news@1')
    await expect(materials).toContainText('已选 0/32 条')
    await dialog.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.verify-claim@1')
    await dialog.getByRole('checkbox', { name: new RegExp(contentA) }).check()
    await materials.getByRole('checkbox', { name: new RegExp(libraryContent) }).check()
    await expect(materials).toContainText('已选 1/32 条')
  } else {
    await expect(materials.getByRole('button', { name: '检索材料', exact: true })).toBeDisabled()
    await expect(dialog.getByText('当前服务未提供证据库', { exact: true })).toBeVisible()
  }

  const updatingBranch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [claimA] })
  const updatingClaim = storage === 'mongo'
    ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [claimA], holderId: randomUUID() }) : null
  if (updatingClaim && updatingClaim.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.REVIEW_BRANCH_BUSY)
  const updated = (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId,
    branch: { rootIds: updatingBranch.scope.rootIds, expectedVersion: updatingBranch.version },
    ...(updatingClaim?.data.status === 'claimed' ? { lease: { leaseId: updatingClaim.data.grant.leaseId,
      holderId: updatingClaim.data.grant.holderId, fence: updatingClaim.data.grant.fence } } : {}),
    changes: { nodes: { put: [{ id: claimA, typeId: 'factcheck.claim', typeVersion: 1,
      payload: { content: updatedContent, category: 'data' } }] } } })).data.snapshot
  if (updatingClaim?.data.status === 'claimed') await gateway.dispatch(randomUUID(), 'branch.release', { mapId: map.mapId,
    lease: { leaseId: updatingClaim.data.grant.leaseId, holderId: updatingClaim.data.grant.holderId, fence: updatingClaim.data.grant.fence } })
  await expect(dialog.getByRole('checkbox', { name: new RegExp(updatedContent) })).toBeVisible()
  await expect(materials).toContainText('已选 0/32 条')
  await dialog.getByRole('checkbox', { name: new RegExp(updatedContent) }).uncheck()
  await dialog.getByRole('checkbox', { name: new RegExp(updatedContent) }).check()
  if (libraryEntry) await materials.getByRole('checkbox', { name: new RegExp(libraryContent) }).check()
  await dialog.getByRole('combobox', { name: '处理方式', exact: true }).selectOption('auto')
  await regenerate.check()
  await dialog.getByRole('combobox', { name: '处理方式', exact: true }).selectOption('human-in-loop')
  await expect(materials).toContainText(`已选 ${libraryEntry ? 1 : 0}/32 条`)
  expect(starts).toHaveLength(0)
  await dialog.getByRole('button', { name: '开始处理', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(starts).toHaveLength(1)
  const first = (await gateway.read('map.get', { mapId: map.mapId })).runs.find(
    /* 当前图中实际启动的Run。 */ run => /* 排除准备的乙分支运行，只有一次页面确认。 */ run.id !== unrelatedId,
  )
  if (!first) throw new Error(WorkspaceAcceptanceMessage.COMPOSER_RUN_MISSING)
  await expect.poll(async () => {
    // 页面第一个入口只走到计划审核，保持测试聚焦启动而不重复整套批准链。
    return (await gateway.read('run.get', { mapId: map.mapId, runId: first.id })).operations.some(
      /* 甲分支的真实计划审核。 */ operation => /* 必须使用统一表单确认的人工方式。 */ operation.review?.kind === 'plan' && operation.review.state === 'pending',
    )
  }, { timeout: 20_000 }).toBe(true)
  const firstRun = await gateway.read('run.get', { mapId: map.mapId, runId: first.id })
  const panel = page.getByRole('region', { name: '运行进度与审核', exact: true })
  await panel.getByRole('button', { name: '取消本次运行', exact: true }).click()
  await expect.poll(async () => {
    // 显式取消本次相关运行以释放同一分支，再由顶部独立确认相同业务输入。
    return (await gateway.read('run.get', { mapId: map.mapId, runId: first.id })).status
  }).toBe('cancelled')
  await page.getByRole('button', { name: '单页', exact: true }).click()
  const reader = page.getByRole('region', { name: '单页阅读', exact: true })
  await expect(reader.getByRole('region', { name: '节点完整内容', exact: true })).toContainText(updatedContent)
  await page.getByRole('button', { name: '关系图', exact: true }).click()
  await page.getByRole('button', { name: '运行转换', exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: '处理方式', exact: true })).toHaveValue('human-in-loop')
  await expect(regenerate).not.toBeChecked()
  await expect(materials).toContainText('已选 0/32 条')
  await dialog.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.verify-claim@1')
  await dialog.getByRole('button', { name: '清空', exact: true }).click()
  await dialog.getByRole('checkbox', { name: new RegExp(updatedContent) }).check()
  if (libraryEntry) await materials.getByRole('checkbox', { name: new RegExp(libraryContent) }).check()
  await regenerate.check()
  expect(starts).toHaveLength(1)
  await dialog.getByRole('button', { name: '开始处理', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(starts).toHaveLength(2)
  const second = (await gateway.read('map.get', { mapId: map.mapId })).runs.find(
    /* 第二次独立确认后的真实Run。 */ run => /* 原甲Run已归档，无关乙Run继续保留。 */ run.id !== unrelatedId && run.id !== first.id,
  )
  if (!second) throw new Error(WorkspaceAcceptanceMessage.COMPOSER_RUN_MISSING)
  const secondRun = await gateway.read('run.get', { mapId: map.mapId, runId: second.id })
  const business = { scope: { nodeIds: [claimA] }, mode: 'human-in-loop', regenerate: true, plan: { steps: [{
    transitionRef: { id: verify.id, version: verify.version }, dependsOn: [],
    input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [claimA] } }],
    context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail',
    ...(libraryEntry ? { libraryClaimRefs: [{ entryId: libraryEntry.id, contentDigest: libraryEntry.contentDigest }] } : {}),
  }] } }
  expect(starts[0]).toMatchObject({ method: 'run.start', params: business })
  expect(starts[1]).toMatchObject({ method: 'run.start', params: business })
  expect(firstRun).toMatchObject(business)
  expect(secondRun).toMatchObject(business)
  expect(firstRun.plan.steps.map(
    /* 第一入口实际保存的独立步骤。 */ step => /* 排除随机步骤身份，仅比较完整业务参数。 */ ({ ...step, id: 'same-business-step' }),
  )).toEqual(secondRun.plan.steps.map(
    /* 第二入口实际保存的独立步骤。 */ step => /* 随机步骤身份不代表业务差异。 */ ({ ...step, id: 'same-business-step' }),
  ))
  if (libraryEntry) {
    expect(firstRun.libraryClaimSets?.[0]?.claims).toMatchObject([{ ref: { entryId: libraryEntry.id,
      contentDigest: libraryEntry.contentDigest }, entry: { confidence: 0, claim: { nodeSnapshot: { payload: { content: libraryContent } } } } }])
    expect(secondRun.libraryClaimSets?.[0]?.claims).toEqual(firstRun.libraryClaimSets?.[0]?.claims)
  } else {
    expect(evidenceReads).toEqual([])
    expect(firstRun.plan.steps[0]).not.toHaveProperty('libraryClaimRefs')
    expect(secondRun.plan.steps[0]).not.toHaveProperty('libraryClaimRefs')
    expect(firstRun.libraryClaimSets ?? []).toEqual([])
    expect(secondRun.libraryClaimSets ?? []).toEqual([])
  }
  expect(firstRun.operations[0]?.group.inputRefs).toMatchObject([{ id: claimA, revision: workspaceReadNode(updated, claimA).revision }])
  expect(secondRun.operations[0]?.group.inputRefs).toMatchObject([{ id: claimA, revision: workspaceReadNode(updated, claimA).revision }])
  expect(await gateway.read('run.get', { mapId: map.mapId, runId: unrelatedId })).toEqual(savedUnrelated)
  expect((await gateway.read('map.get', { mapId: map.mapId })).nodes).toEqual(updated.nodes)
  await expect(page.getByRole('button', { name: '关系图', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '单页', exact: true }).click()
  await expect(reader.getByRole('region', { name: '节点完整内容', exact: true })).toContainText(updatedContent)
  expect(environment.errors).toEqual([])
})

test('M07-C16 多输入和必填上下文显式分组，后步按端口消费正式产物且材料分步冻结', async (
  /* 原页面和同一真实Host，发布定义与独立核对均使用公共API。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 复用原parse/split确定性模型；只发布一个兼容已有News输出的新转换。
  const definitions = await gateway.read('definition.get', { workspaceId: environment.workspaceId })
  const parse = definitions.catalog.transitions.find(
    /* 已发布种子转换。 */ transition => /* 使用真实parse Agent版本，不另造模型角色。 */ transition.id === 'factcheck.parse-source' && transition.version === 1,
  )
  const parseAgent = parse?.execution.stages[0]?.agentRef
  if (!parseAgent) throw new Error(WorkspaceAcceptanceMessage.COMPOSER_SOURCE_MISSING)
  const mergedRef = { id: 'c16.merge-sources', version: 1 }
  const packageItem: DefinitionPackage = { id: 'c16.multiple-sources', version: 1, title: 'C16 多来源提取',
    schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes: [],
    dependencies: { packages: definitions.catalog.packages.map(
      /* 当前真实目录的精确包身份。 */ item => /* 引用已有类型，不重复发布种子定义。 */ ({ ...item.ref }),
    ), agents: [{ ...parseAgent }] }, transitions: [{ ...mergedRef, title: 'C16 合并两份来源',
      cardinality: 'N:1', group: { mode: 'explicit-members', ready: 'sealed-all-required' },
      ports: { input: [
        { name: 'primary', inputType: { id: 'factcheck.source', version: 1 }, count: { min: 1, max: 1 } },
        { name: 'comparison', inputType: { id: 'factcheck.source', version: 1 }, count: { min: 1, max: 1 } },
      ], context: [{ name: 'background', inputType: { id: 'factcheck.news', version: 1 }, count: { min: 1, max: 1 } }],
      output: [{ name: 'news', outputType: { id: 'factcheck.news', version: 1 }, count: { min: 1, max: 1 },
        successorOf: [{ source: 'input', port: 'primary' }, { source: 'input', port: 'comparison' }] }] },
      execution: { resultStage: 'parse', stages: [{ id: 'parse', kind: 'agent', agentRef: { ...parseAgent }, dependsOn: [],
        ready: 'all-dependencies', resultMode: 'outputs', outputPorts: [{ port: 'news', count: { min: 1, max: 1 } }],
        promptBindings: { rawContent: { source: 'source-text', port: 'primary', path: '/locator' } } }] },
      review: { mode: 'none', at: 'result', onReject: 'fail' } }] }
  const workspace = await gateway.read('workspace.get', { workspaceId: environment.workspaceId })
  await gateway.dispatch(randomUUID(), 'definition.publish', { workspaceId: environment.workspaceId,
    expectedRevision: workspace.revision, package: packageItem })
  let map = await workspacePrepareMap(gateway, environment.workspaceId, 'C16 两步正式产物编排')
  const sourceIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort()
  const [primaryOne, comparisonOne, primaryTwo, comparisonTwo] = sourceIds
  if (!primaryOne || !comparisonOne || !primaryTwo || !comparisonTwo) throw new Error(WorkspaceAcceptanceMessage.READING_IDENTITIES_MISSING)
  const contextId = randomUUID(), contextContent = 'C16 只作必填上下文的旧新闻，不得冒充第一步正式产物'
  map = (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId,
    branch: { rootIds: [...sourceIds, contextId], expectedVersion: null }, changes: { nodes: { put: [
      ...sourceIds.map((/* 当前图唯一的来源身份。 */ id, /* 相同URL来源的可读序号。 */ index): GraphNodeInput =>
        /* ID与标签分别保留，候选能区分相同定位值的四个真实节点。 */ ({ id, typeId: 'factcheck.source', typeVersion: 1,
          payload: { locator: { kind: 'url', url: environment.sourceUrl }, label: `C16 来源 ${index + 1}` } })),
      { id: contextId, typeId: 'factcheck.news', typeVersion: 1, payload: { content: contextContent, context: {} } },
    ] } } })).data.snapshot
  const materialOne = 'C16 第一步单独冻结的材料', materialTwo = 'C16 第二步单独冻结的材料'
  const entries: EvidenceLibraryEntry[] = []
  if (storage === 'mongo') {
    for (const content of [materialOne, materialTwo]) {
      // 材料保持在独立来源图，不能被运行表单加入input/context或scope。
      const source = await workspacePrepareClaim(gateway, environment.workspaceId, content, content)
      const node = source.nodes[0]
      if (!node) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
      entries.push((await gateway.dispatch(randomUUID(), 'evidence.collect', { workspaceId: environment.workspaceId,
        claim: { mapId: source.mapId, nodeId: node.id, revision: node.revision }, confidence: 1,
        applicability: { subject: null, event: null, time: null, place: null, conditions: [] }, reason: content, basisRefs: [] })).data.entry)
    }
  }
  const starts: unknown[] = [], evidenceReads: string[] = []
  page.on('request', (
    /* 浏览器实际公共请求，不读Vue状态或直接写入运行记录。 */ request: Request,
  ) => {
    // 所有准备调用来自独立API；页面只能在最后确认时发出一次run.start。
    const method = workspaceReadRequestMethod(request)
    if (method === 'run.start') starts.push(request.postDataJSON())
    if (method.startsWith('evidence.')) evidenceReads.push(method)
  })
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await page.getByRole('button', { name: '运行转换', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '运行数据转换', exact: true })
  await expect(dialog.getByRole('button', { name: '添加步骤', exact: true })).toBeVisible()
  const firstEditor = dialog.getByRole('region', { name: '步骤 1', exact: true })
  await firstEditor.getByRole('combobox', { name: '转换', exact: true }).selectOption('c16.merge-sources@1')
  const primary = firstEditor.getByRole('group', { name: '输入端口 primary', exact: true })
  const comparison = firstEditor.getByRole('group', { name: '输入端口 comparison', exact: true })
  const background = firstEditor.getByRole('group', { name: '上下文端口 background', exact: true })
  for (const id of sourceIds) {
    // 两个同类型端口分别明确选择来源集，不自动将同一个选择复制到另一端口。
    await primary.getByRole('checkbox', { name: new RegExp(id) }).setChecked(id === primaryOne || id === primaryTwo)
    await comparison.getByRole('checkbox', { name: new RegExp(id) }).setChecked(id === comparisonOne || id === comparisonTwo)
  }
  const start = dialog.getByRole('button', { name: '开始处理', exact: true })
  await expect(start).toBeDisabled()
  await background.getByRole('checkbox', { name: new RegExp(contextId) }).check()
  await firstEditor.getByRole('combobox', { name: '分组方式', exact: true }).selectOption({ label: '显式分组' })
  await firstEditor.getByRole('button', { name: '添加分组', exact: true }).click()
  await firstEditor.getByRole('button', { name: '添加分组', exact: true }).click()
  const firstGroup = firstEditor.getByRole('region', { name: '分组 1', exact: true })
  const secondGroup = firstEditor.getByRole('region', { name: '分组 2', exact: true })
  await firstGroup.getByRole('group', { name: '分组端口 primary', exact: true })
    .getByRole('checkbox', { name: new RegExp(primaryOne) }).check()
  await firstGroup.getByRole('group', { name: '分组端口 comparison', exact: true })
    .getByRole('checkbox', { name: new RegExp(comparisonOne) }).check()
  await secondGroup.getByRole('group', { name: '分组端口 primary', exact: true })
    .getByRole('checkbox', { name: new RegExp(primaryTwo) }).check()
  await secondGroup.getByRole('group', { name: '分组端口 comparison', exact: true })
    .getByRole('checkbox', { name: new RegExp(comparisonTwo) }).check()
  await expect(firstGroup.getByRole('group', { name: '分组端口 background', exact: true })).toHaveCount(0)
  const firstMaterials = firstEditor.getByRole('group', { name: '证据库材料 · 可选', exact: true })
  if (storage === 'mongo') await firstMaterials.getByRole('checkbox', { name: new RegExp(materialOne) }).check()
  else await expect(firstMaterials.getByRole('button', { name: '检索材料', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '添加步骤', exact: true }).click()
  const secondEditor = dialog.getByRole('region', { name: '步骤 2', exact: true })
  await secondEditor.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.split-news@1')
  const newsSource = secondEditor.getByRole('combobox', { name: '来源 news', exact: true })
  const previousOutput = newsSource.locator('option').filter({ hasText: /^步骤 1 .*news$/ })
  await expect(previousOutput).toHaveCount(1)
  const outputSource = await previousOutput.getAttribute('value')
  if (!outputSource) throw new Error(WorkspaceAcceptanceMessage.COMPOSER_SOURCE_MISSING)
  await newsSource.selectOption(outputSource)
  await secondEditor.getByRole('combobox', { name: '分组方式', exact: true }).selectOption({ label: '逐个' })
  const secondMaterials = secondEditor.getByRole('group', { name: '证据库材料 · 可选', exact: true })
  if (storage === 'mongo') {
    await expect(secondMaterials).toContainText('已选 0/32 条')
    await secondMaterials.getByRole('checkbox', { name: new RegExp(materialTwo) }).check()
    await expect(secondMaterials.getByRole('checkbox', { name: new RegExp(materialOne) })).not.toBeChecked()
  } else await expect(secondMaterials.getByRole('button', { name: '检索材料', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '编辑步骤 1', exact: true }).click()
  if (storage === 'mongo') {
    await expect(firstMaterials).toContainText('已选 1/32 条')
    await expect(firstMaterials.getByRole('checkbox', { name: new RegExp(materialOne) })).toBeChecked()
    await expect(firstMaterials.getByRole('checkbox', { name: new RegExp(materialTwo) })).not.toBeChecked()
  }
  await dialog.getByRole('button', { name: '编辑步骤 2', exact: true }).click()
  if (storage === 'mongo') {
    await expect(secondMaterials).toContainText('已选 1/32 条')
    await expect(secondMaterials.getByRole('checkbox', { name: new RegExp(materialTwo) })).toBeChecked()
  }
  await dialog.getByRole('combobox', { name: '处理方式', exact: true }).selectOption('auto')
  await expect(dialog).toContainText('计划核对')
  expect(starts).toHaveLength(0)
  await expect(start).toBeEnabled()
  await start.click()
  await expect(dialog).not.toBeVisible()
  expect(starts).toHaveLength(1)
  const startedRun = (await gateway.read('map.get', { mapId: map.mapId })).runs[0]
  if (!startedRun) throw new Error(WorkspaceAcceptanceMessage.COMPOSER_RUN_MISSING)
  await expect.poll(async () => {
    // 等待真实Host完成两层Run步骤，不能用Operation内部阶段完成冒充前步正式产物。
    return (await gateway.read('run.get', { mapId: map.mapId, runId: startedRun.id })).status
  }, { timeout: 25_000 }).toBe('completed')
  const run = await gateway.read('run.get', { mapId: map.mapId, runId: startedRun.id })
  const saved = await gateway.read('map.get', { mapId: map.mapId })
  expect(run.plan.steps).toHaveLength(2)
  // C17使用同一两步真实产物旅程，新增步骤区域的缺失才是页面有效红灯。
  const progress = page.getByRole('region', { name: '运行进度与审核', exact: true }).getByRole('region', { name: '运行步骤', exact: true })
  await expect(progress.getByRole('region', { name: '步骤 1', exact: true })).toContainText('已完成')
  await expect(progress.getByRole('region', { name: '步骤 2', exact: true })).toContainText('已完成')
  await expect(progress).toContainText('c16.merge-sources@1')
  await expect(progress).toContainText('factcheck.split-news@1')
  const [firstStep, secondStep] = run.plan.steps
  if (!firstStep || !secondStep) throw new Error(WorkspaceAcceptanceMessage.COMPOSER_SOURCE_MISSING)
  expect([...run.scope.nodeIds].sort()).toEqual([...sourceIds, contextId].sort())
  expect(firstStep).toMatchObject({ transitionRef: mergedRef, dependsOn: [], input: [
    { port: 'primary', source: { kind: 'scope', nodeIds: [primaryOne, primaryTwo] } },
    { port: 'comparison', source: { kind: 'scope', nodeIds: [comparisonOne, comparisonTwo] } },
  ], context: [{ port: 'background', source: { kind: 'scope', nodeIds: [contextId] } }], grouping: { mode: 'explicit' } })
  if (firstStep.grouping.mode !== 'explicit') throw new Error(WorkspaceAcceptanceMessage.COMPOSER_SOURCE_MISSING)
  expect(firstStep.grouping.groups.map(
    /* 页面明确保存的成员表。 */ group => /* 组身份随机，只核对每端口真实成员且不含context。 */ group.members,
  )).toEqual([{ primary: [primaryOne], comparison: [comparisonOne] }, { primary: [primaryTwo], comparison: [comparisonTwo] }])
  expect(outputSource).toBe(`${firstStep.id}:news`)
  expect(secondStep).toMatchObject({ transitionRef: { id: 'factcheck.split-news', version: 1 }, dependsOn: [firstStep.id],
    input: [{ port: 'news', source: { kind: 'step', stepId: firstStep.id, port: 'news' } }], context: [], grouping: { mode: 'each' } })
  const firstOperations = run.operations.filter(
    /* 已完成的真实Operation。 */ operation => /* 以稳定Run步骤身份分组，不按阶段名猜测。 */ operation.stepId === firstStep.id,
  )
  const secondOperations = run.operations.filter(
    /* 已完成的真实Operation。 */ operation => /* 明确取得消费前步产物的处理项。 */ operation.stepId === secondStep.id,
  )
  expect(firstOperations).toHaveLength(2)
  expect(secondOperations).toHaveLength(2)
  for (const group of firstStep.grouping.groups) {
    // 各Operation精确保存所选两input成员和同一份必填context。
    const operation = firstOperations.find((/* 第一步的一项真实处理。 */ item) => /* 显式组身份由后端保留。 */ item.group.id === group.id)
    if (!operation) throw new Error(WorkspaceAcceptanceMessage.COMPOSER_SOURCE_MISSING)
    expect(operation.group.inputRefs.map(
      /* Operation冻结的一项结构输入。 */ ref => /* 不含随机key，完整身份、端口与版本均核对。 */ ({ port: ref.port, id: ref.id, revision: ref.revision }),
    )).toEqual([{ port: 'primary', id: group.members.primary[0], revision: 0 },
      { port: 'comparison', id: group.members.comparison[0], revision: 0 }])
    expect(operation.group.contextRefs).toMatchObject([{ port: 'background', id: contextId, revision: 0 }])
    expect(operation.outputRefs).toHaveLength(1)
    expect(operation.outputRefs[0].port).toBe('news')
  }
  const newsIds = firstOperations.flatMap(
    /* 第一步已正式发布的处理项。 */ operation => /* 下步只应读取指定news输出端口的正式节点。 */ operation.outputRefs.filter(
      (/* 一份已发布产物引用。 */ ref) => /* 不把其它端口或候选键放入输入。 */ ref.port === 'news',
    ).map((/* 已发布news引用。 */ ref) => /* 保留正式节点身份。 */ ref.id),
  )
  expect(secondOperations.flatMap(
    /* 第二步真实处理项。 */ operation => /* 输入必须恰好来自前步正式产物，不含旧context新闻。 */ operation.group.inputRefs.map(
      (/* 一项保存输入。 */ ref) => /* 比较正式身份，排除正文巧合相同。 */ ref.id,
    ),
  ).sort()).toEqual([...newsIds].sort())
  expect(newsIds).not.toContain(contextId)
  expect(saved.nodes.filter(
    /* 当前图真实节点。 */ node => /* 原context News不算新产物。 */ node.typeId === 'factcheck.news' && node.producer,
  )).toHaveLength(2)
  const claims = saved.nodes.filter(
    /* 当前图真实节点。 */ node => /* split已实际发布四个事实，而非只有候选。 */ node.typeId === 'factcheck.claim',
  )
  expect(claims).toHaveLength(4)
  expect(secondOperations.map(
    /* 第二步真实发布记录。 */ operation => /* 每份前步News分别产生两项正式Claim。 */ operation.outputRefs.length,
  )).toEqual([2, 2])
  expect(saved.nodes).toHaveLength(map.nodes.length + 6)
  expect(saved.edges.filter(
    /* 真实结构关系。 */ edge => /* 旧context正文不能成为下一步事实的结构输入。 */ edge.kind === 'successor' && edge.from === contextId,
  )).toEqual([])
  for (const node of map.nodes) {
    // 创建运行及产物不会改写原Source或context节点。
    expect(workspaceReadNode(saved, node.id)).toEqual(node)
  }
  if (storage === 'mongo') {
    expect(entries).toHaveLength(2)
    const [entryOne, entryTwo] = entries
    if (!entryOne || !entryTwo) throw new Error(WorkspaceAcceptanceMessage.COLLECTED_ENTRY_MISSING)
    const firstRef = { entryId: entryOne.id, contentDigest: entryOne.contentDigest }
    const secondRef = { entryId: entryTwo.id, contentDigest: entryTwo.contentDigest }
    expect(firstStep.libraryClaimRefs).toEqual([firstRef])
    expect(secondStep.libraryClaimRefs).toEqual([secondRef])
    expect(run.libraryClaimSets).toHaveLength(2)
    expect(run.libraryClaimSets?.find(
      /* 运行启动时保存的一步冻结材料。 */ set => /* 精确对应首步，不按当前编辑卡读取。 */ set.stepId === firstStep.id,
    )?.claims).toMatchObject([{ ref: firstRef, entry: { claim: { nodeSnapshot: { payload: { content: materialOne } } } } }])
    expect(run.libraryClaimSets?.find(
      /* 运行启动时保存的一步冻结材料。 */ set => /* 精确对应后步，不复制首步已选项。 */ set.stepId === secondStep.id,
    )?.claims).toMatchObject([{ ref: secondRef, entry: { claim: { nodeSnapshot: { payload: { content: materialTwo } } } } }])
  } else {
    expect(evidenceReads).toEqual([])
    expect(firstStep).not.toHaveProperty('libraryClaimRefs')
    expect(secondStep).not.toHaveProperty('libraryClaimRefs')
    expect(run.libraryClaimSets ?? []).toEqual([])
  }
  expect(environment.errors).toEqual([])
})

test('M09-C20 从空智能体工作区上传资产，选择精确来源位置并补必填字段', async (
  /* 原真实服务、公共核对客户端和普通页面，不写入组件内部状态。 */ { page, gateway, environment, webUrl },
) => {
  // C19与C20串成一个创建旅程；来源类型有两个位置，不能自动选目录首项。
  await workspaceLogin(page, webUrl, environment.token)
  await page.getByRole('button', { name: '创建工作区', exact: true }).first().click()
  const creation = page.getByRole('dialog', { name: '创建工作区', exact: true })
  const name = 'C19 空配置与C20资产来源'
  await creation.getByLabel('工作区名称', { exact: true }).fill(name)
  await creation.getByRole('combobox', { name: '初始智能体配置', exact: true }).selectOption('empty')
  await creation.getByRole('button', { name: '创建工作区', exact: true }).click()
  await expect(creation).not.toBeVisible()
  const directory = await gateway.read('workspace.list', {})
  const workspace = directory.items.find((/* 真实公共目录中的工作区。 */ item) => /* 不按目录位置猜新创建身份。 */ item.name === name)
  if (!workspace) throw new Error(WorkspaceAcceptanceMessage.CREATED_WORKSPACE_MISSING)
  const empty = await gateway.read('definition.get', { workspaceId: workspace.id })
  expect(empty.catalog.transitions).toEqual([])
  expect(empty.catalog.dataTypes.length).toBeGreaterThan(0)
  expect((await gateway.read('agent.list', { scope: { kind: 'workspace', workspaceId: workspace.id } })).items).toEqual([])
  const sourcePackage: DefinitionPackage = { id: 'c20.assets', version: 1, title: 'C20 双位置来源',
    schemaDialect: 'http://json-schema.org/draft-07/schema#', dependencies: { packages: [], agents: [] }, transitions: [],
    dataTypes: [{ id: 'c20.document', version: 1, title: 'C20 文件来源',
      schema: { type: 'object', properties: {
        title: { type: 'string' }, note: { type: 'string', minLength: 1, title: '来源说明' }, kind: { type: 'string', const: 'asset' },
        primary: { type: 'object', properties: { assetId: { type: 'string' }, mediaType: { type: 'string' } }, required: ['assetId'], additionalProperties: false },
        secondary: { type: 'object', properties: { assetId: { type: 'string' }, mediaType: { type: 'string' } }, required: ['assetId'], additionalProperties: false },
      }, required: ['title', 'note', 'kind'], additionalProperties: false }, successorTypes: [],
      references: [{ path: '/primary/assetId', target: { kind: 'asset' }, when: { path: '/kind', equals: 'asset' } },
        { path: '/secondary/assetId', target: { kind: 'asset' }, when: { path: '/kind', equals: 'asset' } }],
      presentation: { titlePath: '/title', fieldLabels: { '/note': '来源说明' } }, agentProjection: { include: ['/title', '/note'], mapEntryFilters: [] } }],
  }
  sourcePackage.dataTypes.push({ id: 'c20.array', version: 1, title: 'C20 非对象来源', schema: { type: 'array', items: { type: 'object',
    properties: { assetId: { type: 'string' } }, required: ['assetId'], additionalProperties: false } }, successorTypes: [],
    references: [{ path: '/*/assetId', target: { kind: 'asset' } }], agentProjection: { include: [], mapEntryFilters: [] } })
  await page.getByRole('button', { name: '创建第一张数据图', exact: true }).click()
  const mapDialog = page.getByRole('dialog', { name: '创建数据图', exact: true })
  await mapDialog.getByLabel('数据图名称', { exact: true }).fill('C20 精确文件来源')
  await mapDialog.getByRole('button', { name: '创建数据图', exact: true }).click()
  await expect(mapDialog).not.toBeVisible()
  const maps = await gateway.read('map.list', { workspaceId: workspace.id })
  const map = maps[0]
  if (!map) throw new Error(WorkspaceAcceptanceMessage.CREATED_MAP_MISSING)
  const currentWorkspace = await gateway.read('workspace.get', { workspaceId: workspace.id })
  await gateway.dispatch(randomUUID(), 'definition.publish', { workspaceId: workspace.id, expectedRevision: currentWorkspace.revision, package: sourcePackage })
  await page.getByRole('button', { name: '管理工作台', exact: true }).click()
  const management = page.getByRole('dialog', { name: '工作台管理', exact: true })
  await management.getByRole('button', { name: '资产与导入导出', exact: true }).click()
  const filename = 'C20-source.txt'
  await management.getByLabel('上传资产文件', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from('C20 原始文件全文', 'utf8') })
  await management.getByRole('button', { name: '上传资产', exact: true }).click()
  await expect(management.getByText(`已上传：${filename}`, { exact: true })).toBeVisible()
  await management.getByRole('button', { name: '将已上传资产添加为来源', exact: true }).click()
  const source = page.getByRole('dialog', { name: '添加资产来源', exact: true })
  await expect(source).toBeVisible()
  expect((await gateway.read('map.get', { mapId: map.id })).nodes).toEqual([])
  // 合法目录中的数组根不符合GraphPayload对象合同；错误应留在表单且可切回合法类型。
  await source.getByRole('combobox', { name: '来源类型', exact: true }).selectOption('c20.array@1')
  await expect(source.getByRole('alert')).toContainText('这个来源类型需要对象正文')
  await source.getByRole('combobox', { name: '来源类型', exact: true }).selectOption('c20.document@1')
  await source.getByRole('combobox', { name: '引用位置', exact: true }).selectOption('/secondary/assetId')
  const note = 'C20 必须保留的人工来源说明'
  await source.getByRole('group', { name: '来源说明', exact: true }).getByRole('textbox').fill(note)
  await source.getByRole('button', { name: '添加来源', exact: true }).click()
  await expect(source).not.toBeVisible()
  const saved = await gateway.read('map.get', { mapId: map.id })
  expect(saved.nodes).toHaveLength(1)
  const node = saved.nodes[0]
  if (!node) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  expect(node).toMatchObject({ typeId: 'c20.document', typeVersion: 1, payload: { title: filename, kind: 'asset', note } })
  expect(node.payload).not.toHaveProperty('primary')
  const secondary = node.payload.secondary
  if (!secondary || typeof secondary !== 'object' || Array.isArray(secondary) || typeof secondary.assetId !== 'string') throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const asset = await gateway.read('asset.get', { assetId: secondary.assetId })
  expect(asset).toMatchObject({ workspaceId: workspace.id, filename, mediaType: 'text/plain' })
  expect(secondary.mediaType).toBe(asset.mediaType)
  await expect(management.getByRole('button', { name: '当前图已有此来源', exact: true })).toBeDisabled()
  await management.getByRole('button', { name: '关闭管理面板', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '当前工作区', exact: true })).toHaveValue(workspace.id)
  expect(environment.modelCalls).toHaveLength(0)
})

test('M10-C21 真实审核与暂停状态显示在三维节点和二维回退，终态不残留执行提示', async (
  /* 同一真实Run由正常WebGL和一个禁用WebGL的新context分别阅读。 */ { page, browser, gateway, environment, webUrl, storage },
) => {
  // 不制造活动事件；真实Host停在人工规划审核，状态来自公开快照。
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C21 图内状态', 'C21 节点的实际处理与审核状态')
  const node = map.nodes[0]
  if (!node) throw new Error(WorkspaceAcceptanceMessage.CREATED_NODE_MISSING)
  const branch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [node.id] })
  const claim = storage === 'mongo' ? await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId, rootIds: [node.id], holderId: randomUUID() }) : null
  if (claim && claim.data.status !== 'claimed') throw new Error(WorkspaceAcceptanceMessage.REVIEW_BRANCH_BUSY)
  const runId = randomUUID()
  const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, id: runId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    ...(claim?.data.status === 'claimed' ? { lease: { leaseId: claim.data.grant.leaseId, holderId: claim.data.grant.holderId, fence: claim.data.grant.fence } } : {}),
    scope: { nodeIds: [node.id] }, mode: 'human-in-loop', plan: { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [node.id] } }], context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] } })
  if (started.data.runControl) await gateway.dispatch(randomUUID(), 'run.control.release', { mapId: map.mapId, runId, control: {
    leaseId: started.data.runControl.leaseId, holderId: started.data.runControl.holderId, fence: started.data.runControl.fence } })
  await expect.poll(async () => {
    // 等真实审核保存，避免仅凭未完成模型Promise推测待审核。
    return (await gateway.read('run.get', { mapId: map.mapId, runId })).operations.some((/* 实际运行处理项。 */ operation) => /* 本次未回答的审核才可显示。 */ operation.status === 'waiting' && operation.review?.state === 'pending')
  }).toBe(true)
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  const selected = page.locator('.scene-selection')
  await expect(selected.getByLabel('节点活动', { exact: true })).toContainText('等待审核')
  const panel = page.getByRole('region', { name: '运行进度与审核', exact: true })
  if (storage === 'mongo') await panel.getByRole('button', { name: '领取运行控制权', exact: true }).click()
  await panel.getByRole('button', { name: '暂停处理', exact: true }).click()
  await expect(selected.getByLabel('节点活动', { exact: true })).toContainText('已暂停')
  if (storage === 'mongo') await panel.getByRole('button', { name: '释放控制权', exact: true }).click()
  const fallback = await browser.newContext()
  try {
    await fallback.addInitScript(() => {
      // 只在这个测试context模拟没有WebGL，不改变用户预览或系统图形配置。
      HTMLCanvasElement.prototype.getContext = () => /* 触发既有SVG降级路径。 */ null
    })
    const fallbackPage = await fallback.newPage()
    await workspaceLogin(fallbackPage, webUrl, environment.token)
    await workspaceOpenMap(fallbackPage, map.name)
    const card = fallbackPage.locator('.graph-canvas').locator(`[data-node-id="${node.id}"]`)
    await expect(card.locator('.node-status')).toContainText('已暂停')
    const fallbackPanel = fallbackPage.getByRole('region', { name: '运行进度与审核', exact: true })
    if (storage === 'mongo') await fallbackPanel.getByRole('button', { name: '领取运行控制权', exact: true }).click()
    await fallbackPanel.getByRole('button', { name: '继续处理', exact: true }).click()
    await expect(card.locator('.node-status')).toContainText('等待审核')
    await fallbackPanel.getByRole('button', { name: '取消本次运行', exact: true }).click()
    await expect(card.locator('.node-status')).toContainText('处理已取消')
    expect((await gateway.read('run.get', { mapId: map.mapId, runId })).status).toBe('cancelled')
  } finally { await fallback.close() }
})

test('M11-C22 四种窗口尺寸保留纸面阅读、侧栏与运行表单，取消不写数据', async (
  /* 相同保存节点在四种真实视口阅读，不制造额外运行或编辑事实。 */ { page, gateway, environment, webUrl, storage },
) => {
  // 跨模块收口聚焦窄屏/键盘/只读取消，不重复审核及创建矩阵。
  const content = 'C22 纸面正文第一行。\n第二行保留来源说明，调整窗口后全文仍然可读。'
  const map = await workspacePrepareClaim(gateway, environment.workspaceId, 'C22 窗口适配与阅读', content)
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await workspaceSelectFirstNode(page)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }, { width: 900, height: 620 }, { width: 650, height: 700 }]) {
    // 同一保存身份跨尺寸保留，窄屏显式打开原抽屉。
    await page.setViewportSize(viewport)
    if (viewport.width < 700) await page.getByRole('button', { name: '节点详情', exact: true }).click()
    const inspector = page.getByRole('region', { name: '数据详情', exact: true })
    await expect(workspaceContentInput(inspector)).toHaveValue(content)
    if (viewport.width < 700) await page.getByRole('button', { name: '节点详情', exact: true }).click()
    await page.getByRole('button', { name: '单页', exact: true }).click()
    await expect(page.getByRole('region', { name: '节点完整内容', exact: true })).toContainText(content)
    expect(await page.evaluate(() => {
      // 验证外层页面无水平溢出，内部滚动仍由各面板拥有。
      return document.documentElement.scrollWidth <= window.innerWidth
    })).toBe(true)
    if (viewport.width === 1440 || viewport.width === 650) await page.screenshot({ path: `test-results/c17-c22-baseline-5a7b1e330a32/c22-paper-${storage}-${viewport.width}.png` })
    await page.getByRole('button', { name: '返回关系图', exact: true }).click()
    await page.getByRole('button', { name: '运行转换', exact: true }).click()
    const composer = page.getByRole('dialog', { name: '运行数据转换', exact: true })
    await composer.getByRole('combobox', { name: '转换', exact: true }).selectOption('factcheck.verify-claim@1')
    await expect(composer.getByRole('checkbox', { name: new RegExp('C22 纸面正文第一行') })).toBeVisible()
    await composer.press('Escape')
    await expect(composer).not.toBeVisible()
    await expect(page.getByRole('button', { name: '关系图', exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
  const saved = await gateway.read('map.get', { mapId: map.mapId })
  expect(saved.nodes).toEqual(map.nodes)
  expect(saved.edges).toEqual(map.edges)
  expect(saved.runs).toEqual([])
  expect(environment.modelCalls).toHaveLength(0)
})
