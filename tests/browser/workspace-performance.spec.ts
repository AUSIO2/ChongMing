// M00 真实单 Map 性能先行用例；小型校准与正式容量、持续负载分别标记。
import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { ClientError, type ClientGateway } from '../../contracts/client'
import type { GraphNode } from '../../contracts/graph'
import type { GraphBranchLeaseProof } from '../../contracts/graph-branch'
import type { GraphSnapshot } from '../../contracts/graph-api'
import { test, expect, workspaceCreateActor, workspaceLogin, workspaceOpenMap } from './workspace-fixture'
import { workspacePrepareDataset } from './workspace-dataset'
import { workspaceReadLoadSettings, type WorkspaceLoadSettings } from './workspace-load.config'

enum PerformanceError {
  EMPTY_DATASET = 'M00 性能数据集没有提供可读正文或独立写入根。',
  WEBGL_UNAVAILABLE = 'M00 当前页面没有可用三维画布，二维回退不能计作三维性能成绩。',
  NODE_NOT_IDENTIFIED = 'M00 公开正文未能唯一对应真实图内节点。',
  RAF_TIMEOUT = 'M00 RAF 代理在期限内没有完成采样。',
  NO_GRAPH_BOUNDS = 'M00 公开画布没有可操作的尺寸。',
  BRANCH_BUSY = 'M00 混合负载未取得目标独立分支的编辑权。',
  WRITE_NOT_CONFIRMED = 'M00 混合负载未确认本次写入的身份、正文与版本。',
  LOAD_FAILED = 'M00 混合负载包含失败、超时、未确认结果或未完成节拍。',
  LOAD_OVERLAP_MISSING = 'M00 混合负载没有观察到重叠的真实公共 HTTP 调用。',
  INVALID_METRIC = 'M00 性能采样包含非有限或负值，拒绝丢弃样本后继续报告。',
  PREPARE_PAYLOAD_INVALID = 'M00 数据准备阶段被公开 payload schema 校验拒绝。',
  PREPARE_PAYLOAD_LIMIT = 'M00 数据准备阶段超过公开请求大小或成员上限。',
  PREPARE_DEFINITION_INVALID = 'M00 数据准备阶段缺少合法精确定义。',
  PREPARE_PUBLIC_REJECTED = 'M00 数据准备阶段被其他公开协议错误拒绝。',
  PREPARE_TYPE_ERROR = 'M00 数据准备阶段出现测试装配类型错误。',
  PREPARE_FAILED = 'M00 数据准备阶段出现尚未分类的前置失败。',
}

enum MetricName {
  GRAPH_DOM = 'graph_dom_available_ms', GRAPH_DOM_MEDIAN = 'graph_dom_available_median_ms', GRAPH_DOM_MAX = 'graph_dom_available_max_ms',
  GRAPH_DOM_STATUS = 'graph_dom_sample_status', SELECT = 'node_selection_ms', SELECT_MEDIAN = 'node_selection_median_ms',
  SELECT_MAX = 'node_selection_max_ms', SELECT_STATUS = 'node_selection_sample_status', PAGE = 'page_content_ms',
  PAGE_MEDIAN = 'page_content_median_ms', PAGE_MAX = 'page_content_max_ms', PAGE_STATUS = 'page_content_sample_status',
  ROUND_TRIP = 'round_trip_ms', ROUND_TRIP_STATUS = 'round_trip_status', RAF = 'raf_interval_ms', RAF_MEDIAN = 'raf_interval_median_ms', RAF_P95 = 'raf_interval_p95_ms',
  BROWSER_HEAP = 'browser_js_heap_bytes', BROWSER_HEAP_LIMIT = 'browser_js_heap_limit_bytes', SERVICE_MEMORY = 'service_memory_bytes',
  GPU_COMPLETE = 'gpu_render_complete_ms', SCENE_NODES = 'scene_declared_nodes', SCENE_EDGES = 'scene_declared_edges',
  GPU_NODES = 'gpu_drawn_nodes', CAMERA_PROJECTION = 'camera_projection_available', API_P95 = 'logical_api_p95_ms', API_P99 = 'logical_api_p99_ms',
}

type LoadPhase = 'stress8' | 'stress16' | 'endurance'
type LoadMetricSuffix = 'operation_ms' | 'read_ms' | 'write_ms' | 'operation_status' | 'auxiliary_http_ms'
  | 'ui_round_trip_ms' | 'client_http_concurrency' | 'logical_concurrency' | 'operation_index'
  | 'operation_started_ms' | 'operation_ended_ms' | 'operation_kind'
type PerformanceMetricName = MetricName | `${LoadPhase}_${LoadMetricSuffix}`
interface Metric { name: PerformanceMetricName; unit: 'ms' | 'bytes' | 'count'; values: number[]; unavailable: boolean }
type Dataset = Awaited<ReturnType<typeof workspacePrepareDataset>>
interface PerformanceReport {
  schemaVersion: 1
  caseId: 'M00-P01' | 'M00-P02' | 'M00-P03'
  profile: WorkspaceLoadSettings['profile']['name']
  storage: 'sqlite' | 'mongo'
  thresholdStatus: 'proposed'
  measurementClock: 'driver-monotonic-with-browser-raf'
  counts: { nodes: number; edges: number; derivedReferences: number; payloadBytes: number; jsonBytes: number }
  metrics: Metric[]
  environment?: { nodeVersion: string; chromiumVersion: string; platform: NodeJS.Platform; arch: string;
    viewportWidth: number; viewportHeight: number; deviceScaleFactor: number; gpuMode: 'unavailable' | 'software' | 'hardware' | 'unknown' }
  load?: Record<string, number>
}
interface TimedSamples { values: number[]; statuses: number[] }
interface BrowserMemory { used: number | null; limit: number | null }

/** 只按固定公开错误码/异常名定位准备阶段，不检查或输出原始 message、stack 或参数值。 */
async function workspacePrepareMeasuredDataset(
  /* 当前隔离服务的真实公共 owner 客户端。 */ gateway: ClientGateway,
  /* 当前用例已具备写权限的工作区身份。 */ workspaceId: string,
  /* 本轮已经冻结的规模配置。 */ profile: WorkspaceLoadSettings['profile'],
): Promise<Dataset> {
  try { return await workspacePrepareDataset(gateway, workspaceId, profile) }
  catch (cause) {
    const problem = cause !== null && typeof cause === 'object' ? cause as { code?: unknown; name?: unknown } : {}
    if (problem.code === 'PAYLOAD_INVALID') throw new Error(PerformanceError.PREPARE_PAYLOAD_INVALID, { cause })
    if (problem.code === 'PAYLOAD_LIMIT' || problem.code === 'PAYLOAD_TOO_LARGE') throw new Error(PerformanceError.PREPARE_PAYLOAD_LIMIT, { cause })
    if (problem.code === 'DEFINITION_INVALID' || problem.code === 'DEFINITION_NOT_FOUND') throw new Error(PerformanceError.PREPARE_DEFINITION_INVALID, { cause })
    if (problem.name === 'ClientError') throw new Error(PerformanceError.PREPARE_PUBLIC_REJECTED, { cause })
    if (problem.name === 'TypeError') throw new Error(PerformanceError.PREPARE_TYPE_ERROR, { cause })
    throw new Error(PerformanceError.PREPARE_FAILED, { cause })
  }
}

/** 固定指标名和单位，只保存有限数值；缺失观测用 unavailable，不填零冒充。 */
function workspaceMetric(
  /* 本模块登记的固定指标身份。 */ name: PerformanceMetricName,
  /* 本指标实际采用的量纲。 */ unit: Metric['unit'],
  /* 原始样本，默认空数组表示没有取得该观测。 */ values: readonly number[] = [],
): Metric {
  if (values.some((/* 单个原始数值样本，非法值不能被过滤掩盖。 */ value) => !Number.isFinite(value) || value < 0)) throw new Error(PerformanceError.INVALID_METRIC)
  return { name, unit, values: [...values], unavailable: values.length === 0 }
}

/** 使用经验次序统计量；样本门槛由调用位置明确决定。 */
function workspaceQuantile(
  /* 已完成采样的原始有限数值，原数组不排序或删样本。 */ values: readonly number[],
  /* 需要报告的经验分位位置。 */ percentile: number,
): number {
  const ordered = [...values].sort((/* 左侧有限样本。 */ left, /* 右侧有限样本。 */ right) => left - right)
  return ordered[Math.ceil(ordered.length * percentile) - 1]
}

/** 对同一单调时钟中的真实 UI 动作计时，失败尝试仍保留耗时与状态。 */
async function workspaceMeasure(
  /* 本组操作的原始耗时及状态向量；0 成功、1 错误、2 超时。 */ samples: TimedSamples,
  /* 真正执行的用户操作及其公开可观察完成条件。 */ action: () => Promise<void>,
): Promise<void> {
  const started = performance.now()
  let status = 0
  try { await action() }
  catch (cause) { status = cause instanceof Error && cause.name === 'TimeoutError' ? 2 : 1; throw cause }
  finally { samples.values.push(performance.now() - started); samples.statuses.push(status) }
}

/** 建立没有正文、令牌或机器路径的测量报告，只通过专用附件交给安全报告器。 */
function workspaceCreateReport(
  /* 本轮登记的 P 场景身份。 */ caseId: PerformanceReport['caseId'],
  /* 当前固定规模及候选阈值配置。 */ settings: WorkspaceLoadSettings,
  /* 当前项目实际使用的存储类型。 */ storage: PerformanceReport['storage'],
  /* 已经通过真实公共命令准备并核对的数据集。 */ dataset: Dataset,
): PerformanceReport {
  return { schemaVersion: 1, caseId, profile: settings.profile.name, storage, thresholdStatus: 'proposed', measurementClock: 'driver-monotonic-with-browser-raf',
    counts: { nodes: dataset.expectedNodes, edges: dataset.expectedEdges, derivedReferences: dataset.derivedReferenceCount,
      payloadBytes: dataset.payloadBytes, jsonBytes: dataset.jsonBytes }, metrics: [
      workspaceMetric(MetricName.SERVICE_MEMORY, 'bytes'), workspaceMetric(MetricName.GPU_COMPLETE, 'ms'),
      workspaceMetric(MetricName.GPU_NODES, 'count'),
    ] }
}

/** 仅附加本模块生成的受控数字报告；不调用 console 或自行写入绕过报告策略。 */
async function workspaceAttachReport(
  /* Playwright 用例元信息，报告器只接纳固定附件名。 */ testInfo: TestInfo,
  /* 不含业务正文或凭据的测量 DTO。 */ report: PerformanceReport,
): Promise<void> {
  await testInfo.attach('m00-performance', { body: Buffer.from(JSON.stringify(report)), contentType: 'application/json' })
}

/** 读取浏览器自己公开的近似 JS 堆信息；服务端/Node 内存不替代此值。 */
async function workspaceReadBrowserMemory(/* 需要观测的真实浏览器页面。 */ page: Page): Promise<BrowserMemory> {
  return page.evaluate(() => {
    // Chromium 的 performance.memory 仅为浏览器报告的 JS 堆代理，其他引擎可无此值。
    const memory = Reflect.get(performance, 'memory') as { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown } | undefined
    return { used: typeof memory?.usedJSHeapSize === 'number' && Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize : null,
      limit: typeof memory?.jsHeapSizeLimit === 'number' && Number.isFinite(memory.jsHeapSizeLimit) ? memory.jsHeapSizeLimit : null }
  })
}

/** 从公开平台与独立 WebGL 查询记录设备条件，不接触应用 Three 场景。 */
async function workspaceReadEnvironment(
  /* 当前测试复用的真实 Chromium 实例。 */ browser: Browser,
  /* 当前实测页面，只查询公开浏览器 API。 */ page: Page,
): Promise<NonNullable<PerformanceReport['environment']>> {
  const observed = await page.evaluate(() => {
    // 独立短生命周期画布仅用于识别软件渲染，不能证明业务场景完成绘制。
    const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    let gpuMode: 'unavailable' | 'software' | 'hardware' | 'unknown' = 'unavailable'
    if (gl) {
      const debug = gl.getExtension('WEBGL_debug_renderer_info')
      const renderer: unknown = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null
      gpuMode = typeof renderer !== 'string' ? 'unknown' : /swiftshader|llvmpipe|software/i.test(renderer) ? 'software'
        : /apple|nvidia|amd|intel|radeon|geforce|adreno|mali|powervr/i.test(renderer) ? 'hardware' : 'unknown'
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, deviceScaleFactor: window.devicePixelRatio, gpuMode }
  })
  const version = browser.version()
  return { nodeVersion: /^[v\d.]+$/.test(process.version) ? process.version : '',
    chromiumVersion: /^[v\d.]+$/.test(version) ? version : '', platform: process.platform, arch: process.arch, ...observed }
}

/** 以公开表单语义读取正文，不依赖组件私有状态。 */
function workspaceContentInput(/* 当前页面或已限定范围的真实表单。 */ container: Page | Locator): Locator {
  return container.getByRole('region', { name: '数据详情', exact: true }).getByRole('group', { name: '正文', exact: true }).getByRole('textbox')
}

/** 选择真实画布键盘顺序首节点，再用完整正文唯一匹配独立 API 事实。 */
async function workspaceSelectMeasuredNode(
  /* 已通过侧栏打开规模图的真实页面。 */ page: Page,
  /* 独立公共查询取得的原始正式快照。 */ snapshot: GraphSnapshot,
  /* 为关系保持场景选择确有一跳关系的正文节点，默认只测首节点选择。 */ requireRelations = false,
): Promise<GraphNode> {
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await scene.focus(); await scene.press('Escape'); await scene.press('ArrowRight')
  const input = workspaceContentInput(page)
  for (let attempt = 0; attempt < Math.min(snapshot.nodes.length, 32); attempt++) {
    await expect(input).toBeVisible()
    const content = await input.inputValue()
    const matching = snapshot.nodes.filter((/* 独立快照中的真实节点。 */ node) => node.payload.content === content)
    if (matching.length !== 1 || !matching[0]) throw new Error(PerformanceError.NODE_NOT_IDENTIFIED)
    const selected = matching[0]
    if (!requireRelations || snapshot.edges.some((/* 已保存的一跳关系。 */ edge) => edge.from === selected.id || edge.to === selected.id)) return selected
    await scene.press('ArrowRight')
    await expect(input).not.toHaveValue(content)
  }
  throw new Error(PerformanceError.NODE_NOT_IDENTIFIED)
}

/** 确认公开 DOM 的数据数量与可操作三维画布；这不声称 GPU 绘制已经完成。 */
async function workspaceWaitForGraph(
  /* 正在首次打开规模图的实际页面。 */ page: Page,
  /* 已经独立核对的规模图元信息。 */ dataset: Dataset,
): Promise<void> {
  await expect(page.locator('.view-label strong')).toHaveText(dataset.mapName)
  await expect(page.locator('.view-count')).toHaveText(`${dataset.expectedNodes} 个节点 · ${dataset.expectedEdges} 条关系`)
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  if (await page.locator('.graph-canvas').isVisible()) throw new Error(PerformanceError.WEBGL_UNAVAILABLE)
  await expect(scene).toBeVisible()
  await expect(scene.locator('canvas')).toBeVisible()
  await expect(page.locator('.workspace-views .scene-topline small')).toHaveText(`${dataset.expectedNodes} 节点 · ${dataset.expectedEdges} 连线`)
}

/** 打开当前选择的单页并核对完整正文，不用摘要或乐观状态作为完成条件。 */
async function workspaceOpenMeasuredPage(
  /* 已选中真实节点的实际页面。 */ page: Page,
  /* 来自独立公共快照的该节点全文。 */ content: string,
): Promise<void> {
  await page.getByRole('button', { name: '单页', exact: true }).click()
  await expect(page.getByRole('region', { name: '节点完整内容', exact: true }).getByText(content, { exact: true })).toBeVisible()
}

/** 将一组原始计时与固定状态向量附入报告，同时显式报告五次样本的 median/max。 */
function workspaceAddTiming(
  /* 本用例的受控测量报告。 */ report: PerformanceReport,
  /* 本组已完成或失败的原始计时样本。 */ samples: TimedSamples,
  /* 原始耗时、median、max 和状态的固定指标身份。 */ names: readonly [MetricName, MetricName, MetricName, MetricName],
): void {
  report.metrics.push(workspaceMetric(names[0], 'ms', samples.values), workspaceMetric(names[3], 'count', samples.statuses),
    workspaceMetric(names[1], 'ms', samples.values.length ? [workspaceQuantile(samples.values, 0.5)] : []),
    workspaceMetric(names[2], 'ms', samples.values.length ? [Math.max(...samples.values)] : []))
}

test('M00-P01 预热后五个新会话首次打开规模图并读取全文', async (
  /* 真实浏览器、公开准备客户端、隔离后端和当前存储项目。 */ { browser, gateway, environment, webUrl, storage },
  /* 本轮报告的唯一 Playwright 归属。 */ testInfo,
) => {
  // 预热与测量使用相同数据；每次新 viewer 自然拥有空偏好，不把热复访冒充首次打开。
  const settings = workspaceReadLoadSettings()
  testInfo.setTimeout(180_000)
  const dataset = await workspacePrepareMeasuredDataset(gateway, environment.workspaceId, settings.profile)
  const snapshot = await gateway.read('map.get', { mapId: dataset.mapId })
  const report = workspaceCreateReport('M00-P01', settings, storage, dataset)
  const opening: TimedSamples = { values: [], statuses: [] }, selecting: TimedSamples = { values: [], statuses: [] }, reading: TimedSamples = { values: [], statuses: [] }
  try {
    for (let iteration = -1; iteration < settings.firstOpenSamples; iteration++) {
      const actor = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      try {
        const page = await context.newPage()
        await workspaceLogin(page, webUrl, actor.token)
        const tabs = page.getByRole('navigation', { name: '打开的数据图', exact: true })
        await expect(tabs.getByRole('button', { name: dataset.mapName, exact: true })).toHaveCount(0)
        await expect(page.locator('.view-label strong')).not.toHaveText(dataset.mapName)
        if (!report.environment) report.environment = await workspaceReadEnvironment(browser, page)
        const open = async () => { /* 计时区只包含真实侧栏打开及公开数据/DOM 可用。 */
          await workspaceOpenMap(page, dataset.mapName); await workspaceWaitForGraph(page, dataset)
        }
        if (iteration < 0) { await open(); continue }
        await workspaceMeasure(opening, open)
        let selected: GraphNode | undefined
        await workspaceMeasure(selecting, async () => { /* 按真实键盘交互选点并取得完整正文。 */ selected = await workspaceSelectMeasuredNode(page, snapshot) })
        if (!selected || typeof selected.payload.content !== 'string') throw new Error(PerformanceError.EMPTY_DATASET)
        const content = selected.payload.content
        await workspaceMeasure(reading, async () => { /* 等待该节点完整单页文本真正出现。 */ await workspaceOpenMeasuredPage(page, content) })
      } finally { await context.close() }
    }
    expect(opening.values).toHaveLength(settings.firstOpenSamples)
    expect(selecting.values).toHaveLength(settings.firstOpenSamples)
    expect(reading.values).toHaveLength(settings.firstOpenSamples)
    if (settings.enforceCandidates) {
      expect(Math.max(...opening.values)).toBeLessThanOrEqual(settings.thresholds.graphDomMs)
      expect(Math.max(...selecting.values)).toBeLessThanOrEqual(settings.thresholds.interactionMs)
      expect(Math.max(...reading.values)).toBeLessThanOrEqual(settings.thresholds.interactionMs)
    }
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    workspaceAddTiming(report, opening, [MetricName.GRAPH_DOM, MetricName.GRAPH_DOM_MEDIAN, MetricName.GRAPH_DOM_MAX, MetricName.GRAPH_DOM_STATUS])
    workspaceAddTiming(report, selecting, [MetricName.SELECT, MetricName.SELECT_MEDIAN, MetricName.SELECT_MAX, MetricName.SELECT_STATUS])
    workspaceAddTiming(report, reading, [MetricName.PAGE, MetricName.PAGE_MEDIAN, MetricName.PAGE_MAX, MetricName.PAGE_STATUS])
    const observed = opening.statuses.includes(0)
    report.metrics.push(workspaceMetric(MetricName.SCENE_NODES, 'count', observed ? [snapshot.nodes.length] : []), workspaceMetric(MetricName.SCENE_EDGES, 'count', observed ? [snapshot.edges.length] : []))
    await workspaceAttachReport(testInfo, report)
  }
})

/** 从公开 DOM 投影观测返回后的相机行为；位置缺失时不伪造私有相机证明。 */
async function workspaceReadProjection(/* 当前展示实际三维图的浏览器页面。 */ page: Page): Promise<{ left: number; top: number } | null> {
  const label = page.locator('.workspace-views .scene-label.selected')
  if (await label.count() !== 1) return null
  return label.evaluate((/* 应用实际绘制的可见选中标签。 */ element) => ({ left: Number.parseFloat((element as HTMLElement).style.left), top: Number.parseFloat((element as HTMLElement).style.top) }))
}

/** 在浏览器自己单调时钟内采 RAF 间隔，保留所有样本并有界释放回调。 */
async function workspaceReadRaf(
  /* 接收真实鼠标旋转/缩放的页面。 */ page: Page,
  /* 本轮完整采样时长，单位毫秒。 */ durationMs: number,
): Promise<number[]> {
  const result = await page.evaluate(async (/* RAF 代理采样时长。 */ duration) => {
    // RAF 仅反映调度回调，不访问 Three、GPU 查询或应用 store。
    return new Promise<{ values: number[]; complete: boolean }>((/* 采样结束时返回原始间隔与完成标记。 */ resolve) => {
      const values: number[] = [], started = performance.now()
      let previous: number | undefined, frame = 0, finished = false
      /** 采样和看门狗共同释放浏览器资源，不留下后台 RAF。 */
      function finish(/* 正常达到完整采样窗口时为真。 */ complete: boolean): void {
        if (finished) return
        finished = true; cancelAnimationFrame(frame); clearTimeout(timer); resolve({ values, complete })
      }
      /** 接纳浏览器帧回调的单调时间戳。 */
      function tick(/* 真实 RAF 回调时刻。 */ timestamp: number): void {
        if (previous !== undefined) values.push(timestamp - previous)
        previous = timestamp
        if (timestamp - started >= duration) finish(true)
        else frame = requestAnimationFrame(tick)
      }
      const timer = setTimeout(() => { /* 后台或卡死页面不能伪称完整采样。 */ finish(false) }, duration + 5_000)
      frame = requestAnimationFrame(tick)
    })
  }, durationMs)
  if (!result.complete || result.values.length < 2) throw new Error(PerformanceError.RAF_TIMEOUT)
  return result.values
}

test('M00-P02 二十次图与单页往返以及十秒真实旋转的调度与浏览器堆观测', async (
  /* 当前用例独占的真实规模图、浏览器页面和公共核对客户端。 */ { browser, page, gateway, environment, webUrl, storage },
  /* 归属本次性能样本的安全附件位置。 */ testInfo,
) => {
  const settings = workspaceReadLoadSettings()
  testInfo.setTimeout(180_000)
  const dataset = await workspacePrepareMeasuredDataset(gateway, environment.workspaceId, settings.profile)
  const snapshot = await gateway.read('map.get', { mapId: dataset.mapId })
  const report = workspaceCreateReport('M00-P02', settings, storage, dataset)
  const roundTrips: TimedSamples = { values: [], statuses: [] }, heap: number[] = [], heapLimit: number[] = []
  try {
    await workspaceLogin(page, webUrl, environment.token)
    await workspaceOpenMap(page, dataset.mapName); await workspaceWaitForGraph(page, dataset)
    report.environment = await workspaceReadEnvironment(browser, page)
    const selected = await workspaceSelectMeasuredNode(page, snapshot, true)
    if (typeof selected.payload.content !== 'string') throw new Error(PerformanceError.EMPTY_DATASET)
    const content = selected.payload.content, projection = await workspaceReadProjection(page)
    let relations: string[] | undefined
    for (let iteration = 0; iteration < settings.roundTrips; iteration++) {
      await workspaceMeasure(roundTrips, async () => {
        // 每轮经真实按钮往返，并核对全文、公开关系列表和返回选择。
        await workspaceOpenMeasuredPage(page, content)
        const current = await page.getByRole('complementary', { name: '关联材料', exact: true }).locator('.related-entry').allTextContents()
        if (!relations) relations = current
        else expect(current).toEqual(relations)
        await page.getByRole('button', { name: '返回关系图', exact: true }).click()
        await expect(workspaceContentInput(page)).toHaveValue(content)
        await expect(page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })).toBeFocused()
        if (projection) {
          const after = await workspaceReadProjection(page)
          expect(after?.left).toBeCloseTo(projection.left, 0)
          expect(after?.top).toBeCloseTo(projection.top, 0)
        }
      })
      const memory = await workspaceReadBrowserMemory(page)
      if (memory.used !== null) heap.push(memory.used)
      if (memory.limit !== null) heapLimit.push(memory.limit)
    }
    const canvas = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true }).locator('canvas'), bounds = await canvas.boundingBox()
    if (!bounds) throw new Error(PerformanceError.NO_GRAPH_BOUNDS)
    const raf = workspaceReadRaf(page, settings.rotationDurationMs)
    const rotationEnd = performance.now() + settings.rotationDurationMs
    let turn = 0
    let intervals: number[] = []
    try {
      while (performance.now() < rotationEnd) {
        // 鼠标移动真实触发 OrbitControls；无需触摸相机对象或注入组件状态。
        await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5)
        await page.mouse.down()
        await page.mouse.move(bounds.x + bounds.width * 0.5 + (turn % 2 ? -45 : 45), bounds.y + bounds.height * 0.5 + 20, { steps: 5 })
        await page.mouse.up(); await page.mouse.wheel(0, turn++ % 2 ? -30 : 30)
      }
    } finally { intervals = await raf }
    report.metrics.push(workspaceMetric(MetricName.RAF, 'ms', intervals), workspaceMetric(MetricName.RAF_MEDIAN, 'ms', [workspaceQuantile(intervals, 0.5)]),
      workspaceMetric(MetricName.RAF_P95, 'ms', [workspaceQuantile(intervals, 0.95)]), workspaceMetric(MetricName.CAMERA_PROJECTION, 'count', [projection ? 1 : 0]))
    await workspaceOpenMeasuredPage(page, content)
    expect(await page.getByRole('complementary', { name: '关联材料', exact: true }).locator('.related-entry').allTextContents()).toEqual(relations)
    const confirmed = await gateway.read('map.get', { mapId: dataset.mapId })
    expect(confirmed.nodes).toEqual(snapshot.nodes); expect(confirmed.edges).toEqual(snapshot.edges)
    expect(roundTrips.values).toHaveLength(settings.roundTrips)
    if (settings.enforceCandidates) {
      expect(workspaceQuantile(intervals, 0.5)).toBeLessThanOrEqual(settings.thresholds.rafMedianMs)
      expect(workspaceQuantile(intervals, 0.95)).toBeLessThanOrEqual(settings.thresholds.rafP95Ms)
    }
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    report.metrics.push(workspaceMetric(MetricName.ROUND_TRIP, 'ms', roundTrips.values), workspaceMetric(MetricName.ROUND_TRIP_STATUS, 'count', roundTrips.statuses), workspaceMetric(MetricName.BROWSER_HEAP, 'bytes', heap),
      workspaceMetric(MetricName.BROWSER_HEAP_LIMIT, 'bytes', heapLimit))
    await workspaceAttachReport(testInfo, report)
  }
})

interface LoadSample { index: number; kind: 0 | 1; startedMs: number; endedMs: number; status: 0 | 1 | 2 | 3 | 4 }
interface LoadPhaseResult {
  samples: LoadSample[]; auxiliaryMs: number[]; httpConcurrency: number[]; logicalConcurrency: number[]
  started: number; durationMs: number; targetDurationMs: number; scheduled: number; incomplete: boolean; concurrencyLimit: number; operationLimit: number
  uiFailures: number; logicalPending: number; httpPending: number; maxQueueDelayMs: number; auxiliaryCount: number
}
interface LoadState {
  expected: Map<string, GraphNode>
  originals: Map<string, GraphNode>
  roots: string[]
  tails: Map<string, Promise<void>>
  uncertainRoots: Set<string>
  leasesRequired: boolean
}
interface LoadControl { running: boolean; failedUi: boolean }

/** 显式按单调时钟节拍等待；这用于负载发起速率，不用于猜测业务竞态。 */
async function workspaceWaitUntil(/* 本轮单调时钟中的目标发起时刻。 */ deadline: number): Promise<void> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await new Promise<void>((/* 到达本轮节拍时释放调度器。 */ resolve) => { timer = setTimeout(resolve, remaining) }) }
  finally { clearTimeout(timer) }
}

/** 观测一次真实公共 HTTP 调用的在途区间，不把此代理称为数据库并行。 */
async function workspaceMeasureHttp<T>(
  /* 本阶段的原始调用计数与在途观测。 */ phase: LoadPhaseResult,
  /* branch.get/claim/release 等辅助 HTTP 为真，逻辑业务请求为假。 */ auxiliary: boolean,
  /* 真正发起公共 HTTP 客户端调用，不能由假响应替代。 */ action: () => Promise<T>,
): Promise<T> {
  const started = performance.now()
  phase.httpConcurrency.push(++phase.httpPending)
  if (auxiliary) phase.auxiliaryCount += 1
  try { return await action() }
  finally { phase.httpPending -= 1; if (auxiliary) phase.auxiliaryMs.push(performance.now() - started) }
}

/** 每五项中一项写入；同根串行，其余根及读操作可真实重叠。 */
async function workspaceLoadOperation(
  /* 独立于两浏览器会话的真实授权 owner 网关。 */ gateway: ClientGateway,
  /* 本轮目标图与既定规模事实。 */ dataset: Dataset,
  /* 本次逻辑业务序号，0–3 为读、4 为写并循环。 */ index: number,
  /* 本次压力或耐久阶段的固定身份。 */ phaseName: LoadPhase,
  /* 本阶段记录在内存的全部原始样本。 */ phase: LoadPhaseResult,
  /* 独立根、精确节点版本和同根排队所有权。 */ state: LoadState,
  /* 已经冻结的请求期限和节拍约束。 */ settings: WorkspaceLoadSettings,
): Promise<void> {
  const sample: LoadSample = { index, kind: index % 5 === 4 ? 1 : 0, startedMs: performance.now() - phase.started, endedMs: 0, status: 0 }
  const controller = new AbortController(), timer = setTimeout(() => { /* 本项实际请求期限结束。 */ controller.abort() }, settings.requestDeadlineMs)
  phase.logicalConcurrency.push(++phase.logicalPending)
  let releaseQueue: (() => void) | undefined, lease: GraphBranchLeaseProof | undefined, submitted = false, confirmed = false
  let rootId: string | undefined
  try {
    if (sample.kind === 0) {
      const snapshot = await workspaceMeasureHttp(phase, false, async () => {
        // 每项读都是实际 map.get，完整响应计入耗时，不复用 Node 内存快照。
        return gateway.read('map.get', { mapId: dataset.mapId }, controller.signal)
      })
      if (snapshot.mapId !== dataset.mapId || snapshot.nodes.length !== dataset.expectedNodes || snapshot.edges.length !== dataset.expectedEdges) throw new Error(PerformanceError.WRITE_NOT_CONFIRMED)
    } else {
      rootId = state.roots[Math.floor(index / 5) % state.roots.length]
      const previous = state.tails.get(rootId) ?? Promise.resolve()
      const gate = new Promise<void>((/* 本根写入完成后才允许下一项占用。 */ resolve) => { releaseQueue = resolve })
      state.tails.set(rootId, previous.then(() => { /* 不同根拥有独立队列。 */ return gate }))
      const queued = performance.now()
      await previous
      phase.maxQueueDelayMs = Math.max(phase.maxQueueDelayMs, performance.now() - queued)
      if (controller.signal.aborted || state.uncertainRoots.has(rootId)) { sample.status = controller.signal.aborted ? 2 : 4; return }
      const current = state.expected.get(rootId), original = state.originals.get(rootId)
      if (!current || !original || typeof original.payload.content !== 'string') throw new Error(PerformanceError.EMPTY_DATASET)
      const branch = await workspaceMeasureHttp(phase, true, async () => {
        // 每次写入采用后端当前分支版本；此辅助读不计入 80/20 业务比例。
        return gateway.read('branch.get', { mapId: dataset.mapId, rootIds: [rootId!] }, controller.signal)
      })
      let expectedVersion = branch.version
      if (state.leasesRequired) {
        const claimed = await workspaceMeasureHttp(phase, true, async () => {
          // 协作项目尊重真实排他编辑租约，不绕过生产校验。
          return gateway.dispatch(randomUUID(), 'branch.claim', { mapId: dataset.mapId, rootIds: [rootId!], holderId: randomUUID() }, controller.signal)
        })
        if (claimed.data.status !== 'claimed') throw new Error(PerformanceError.BRANCH_BUSY)
        lease = { leaseId: claimed.data.grant.leaseId, holderId: claimed.data.grant.holderId, fence: claimed.data.grant.fence }
        expectedVersion = claimed.data.grant.branch.version
      }
      const payload = { ...current.payload, content: `${original.payload.content}\nM00-P03 ${phaseName} 操作 ${index}` }
      submitted = true
      const result = await workspaceMeasureHttp(phase, false, async () => {
        // 每项写入一个已存在独立根，稳定业务请求编号只用于本次真实提交。
        return gateway.dispatch(randomUUID(), 'graph.apply', { mapId: dataset.mapId,
          branch: { rootIds: [rootId!], expectedVersion }, ...(lease ? { lease } : {}),
          changes: { nodes: { put: [{ id: current.id, typeId: current.typeId, typeVersion: current.typeVersion, payload }] } },
        }, controller.signal)
      })
      const node = result.data.snapshot.nodes.find((/* 正式提交响应中的实际节点。 */ item) => item.id === current.id)
      if (!node || node.revision !== current.revision + 1 || JSON.stringify(node.payload) !== JSON.stringify(payload)) throw new Error(PerformanceError.WRITE_NOT_CONFIRMED)
      state.expected.set(node.id, node); confirmed = true
    }
  } catch (cause) {
    // 未收到写入确认时保留 unknown，后续不再用该根猜测成功或回滚。
    sample.status = submitted && !confirmed ? 4 : controller.signal.aborted ? 2
      : cause instanceof ClientError && cause.status === 409 ? 3 : 1
    if (rootId && submitted && !confirmed) state.uncertainRoots.add(rootId)
  } finally {
    clearTimeout(timer)
    if (lease) {
      const releaseController = new AbortController(), releaseTimer = setTimeout(() => { /* 辅助释放也有独立期限。 */ releaseController.abort() }, 5_000)
      try {
        const proof = lease
        await workspaceMeasureHttp(phase, true, async () => {
          // 主请求被取消也不能直接丢弃已经取得的真实租约。
          return gateway.dispatch(randomUUID(), 'branch.release', { mapId: dataset.mapId, lease: proof }, releaseController.signal)
        })
      } catch { if (sample.status === 0) sample.status = 1 }
      finally { clearTimeout(releaseTimer) }
    }
    releaseQueue?.(); phase.logicalPending -= 1
    sample.endedMs = performance.now() - phase.started
    phase.samples.push(sample)
  }
}

/** 运行固定并发闭环或固定速率完整耐久窗口，然后排空所有已发起操作。 */
async function workspaceRunLoadPhase(
  /* 实际发起所有 HTTP 业务与辅助调用的独立网关。 */ gateway: ClientGateway,
  /* 已独立核对的真实规模数据图。 */ dataset: Dataset,
  /* 当前阶段固定身份。 */ phaseName: LoadPhase,
  /* 共享原节点和写入版本，不在阶段之间重新 seed。 */ state: LoadState,
  /* 冻结后的负载节拍与停止条件。 */ settings: WorkspaceLoadSettings,
  /* 两个真实 UI 观察者的失败/停止信号。 */ control: LoadControl,
): Promise<LoadPhaseResult> {
  const endurance = phaseName === 'endurance', concurrency = phaseName === 'stress16' ? 16 : 8
  const duration = endurance ? settings.enduranceDurationMs : settings.stressDurationMs
  const limit = endurance ? settings.enduranceOperationLimit : settings.stressOperationLimit
  const phase: LoadPhaseResult = { samples: [], auxiliaryMs: [], httpConcurrency: [], logicalConcurrency: [],
    started: performance.now(), durationMs: 0, targetDurationMs: duration, scheduled: 0, incomplete: false,
    concurrencyLimit: concurrency, operationLimit: limit, uiFailures: 0, logicalPending: 0, httpPending: 0, maxQueueDelayMs: 0, auxiliaryCount: 0 }
  const pending = new Set<Promise<void>>()
  /** 登记一项真实逻辑业务，完成后从在途集合移除，失败样本仍留在 phase。 */
  function launch(): void {
    const index = phase.scheduled++
    const operation = workspaceLoadOperation(gateway, dataset, index, phaseName, phase, state, settings)
      .finally(() => { /* 无论状态如何都释放本项调度容量。 */ pending.delete(operation) })
    pending.add(operation)
  }
  try {
    if (endurance) {
      const target = Math.ceil(duration * settings.enduranceRate / 1000)
      for (let index = 0; index < target; index++) {
        const due = phase.started + index * 1000 / settings.enduranceRate
        await workspaceWaitUntil(due)
        if (control.failedUi || phase.scheduled >= limit) { phase.incomplete = true; break }
        if (pending.size >= concurrency) await Promise.race(pending)
        phase.maxQueueDelayMs = Math.max(phase.maxQueueDelayMs, performance.now() - due)
        if (phase.maxQueueDelayMs > settings.maxQueueDelayMs) { phase.incomplete = true; break }
        launch()
      }
      if (!phase.incomplete) await workspaceWaitUntil(phase.started + duration)
      if (phase.scheduled !== target) phase.incomplete = true
    } else {
      while (!control.failedUi && performance.now() - phase.started < duration && phase.scheduled < limit) {
        while (pending.size < concurrency && !control.failedUi && performance.now() - phase.started < duration && phase.scheduled < limit) launch()
        if (pending.size) await Promise.race(pending)
      }
      if (control.failedUi) phase.incomplete = true
    }
  } finally {
    await Promise.all(pending)
    phase.durationMs = performance.now() - phase.started
    control.running = false
  }
  if (endurance && phase.durationMs < duration) phase.incomplete = true
  return phase
}

/** 同时保留两个真实浏览器的阅读往返，不用 HTTP 客户端替代 UI 在负载中的存活检查。 */
async function workspaceObserveLoad(
  /* 持续展示当前原始数据集的真实页面。 */ page: Page,
  /* 不由压力写入修改的已选节点全文。 */ content: string,
  /* 驱动器完成或另一页面失败时通知本观察者结束。 */ control: LoadControl,
  /* 本页全部真实往返耗时。 */ values: number[],
): Promise<void> {
  const started = performance.now()
  let tick = 0
  try {
    while (control.running) {
      const before = performance.now()
      await workspaceOpenMeasuredPage(page, content)
      await page.getByRole('button', { name: '返回关系图', exact: true }).click()
      await expect(workspaceContentInput(page)).toHaveValue(content)
      values.push(performance.now() - before)
      await workspaceWaitUntil(started + ++tick * 1000)
    }
  } catch { control.failedUi = true; throw new Error(PerformanceError.LOAD_FAILED) }
}

/** 投影原始业务/辅助样本；统计状态不删除失败，p95/p99 的样本门槛在汇总处执行。 */
function workspaceAddLoadReport(
  /* 本次唯一的受控数值报告。 */ report: PerformanceReport,
  /* 固定的压力或耐久阶段身份。 */ phaseName: LoadPhase,
  /* 真实完成的阶段及所有操作样本。 */ phase: LoadPhaseResult,
  /* 两浏览器在此阶段的真实 UI 往返耗时。 */ uiValues: readonly number[],
): void {
  const samples = [...phase.samples].sort((/* 左侧逻辑操作。 */ left, /* 右侧逻辑操作。 */ right) => left.index - right.index)
  const duration = (/* 一次逻辑操作从发起到结束的完整记录。 */ sample: LoadSample): number => sample.endedMs - sample.startedMs
  report.metrics.push(
    workspaceMetric(`${phaseName}_operation_ms`, 'ms', samples.map(duration)),
    workspaceMetric(`${phaseName}_read_ms`, 'ms', samples.filter((/* 本阶段的一次逻辑业务。 */ item) => item.kind === 0).map(duration)),
    workspaceMetric(`${phaseName}_write_ms`, 'ms', samples.filter((/* 本阶段的一次逻辑业务。 */ item) => item.kind === 1).map(duration)),
    workspaceMetric(`${phaseName}_operation_index`, 'count', samples.map((/* 已记录逻辑操作。 */ item) => item.index)),
    workspaceMetric(`${phaseName}_operation_kind`, 'count', samples.map((/* 已记录逻辑操作，0 读 1 写。 */ item) => item.kind)),
    workspaceMetric(`${phaseName}_operation_status`, 'count', samples.map((/* 0 成功、1 错误、2 超时、3 冲突、4 未确认。 */ item) => item.status)),
    workspaceMetric(`${phaseName}_operation_started_ms`, 'ms', samples.map((/* 相对本阶段开始的实际发起时刻。 */ item) => item.startedMs)),
    workspaceMetric(`${phaseName}_operation_ended_ms`, 'ms', samples.map((/* 相对本阶段开始的实际结束时刻。 */ item) => item.endedMs)),
    workspaceMetric(`${phaseName}_auxiliary_http_ms`, 'ms', phase.auxiliaryMs), workspaceMetric(`${phaseName}_ui_round_trip_ms`, 'ms', uiValues),
    workspaceMetric(`${phaseName}_client_http_concurrency`, 'count', phase.httpConcurrency), workspaceMetric(`${phaseName}_logical_concurrency`, 'count', phase.logicalConcurrency),
  )
  const load = report.load ??= {}
  load[`${phaseName}TargetDurationMs`] = phase.targetDurationMs; load[`${phaseName}ActualDurationMs`] = phase.durationMs
  load[`${phaseName}Scheduled`] = phase.scheduled; load[`${phaseName}Completed`] = phase.samples.length
  load[`${phaseName}ReadCount`] = samples.filter((/* 所有读尝试，失败仍计数。 */ item) => item.kind === 0).length
  load[`${phaseName}WriteCount`] = samples.filter((/* 所有写尝试，失败仍计数。 */ item) => item.kind === 1).length
  load[`${phaseName}AuxiliaryCount`] = phase.auxiliaryCount; load[`${phaseName}Incomplete`] = phase.incomplete ? 1 : 0
  load[`${phaseName}UiFailures`] = phase.uiFailures
  load[`${phaseName}MaxQueueDelayMs`] = phase.maxQueueDelayMs
  load[`${phaseName}ConcurrencyLimit`] = phase.concurrencyLimit; load[`${phaseName}OperationLimit`] = phase.operationLimit
  load[`${phaseName}ActualRate`] = phase.scheduled / (phase.durationMs / 1000)
  for (let status = 0; status <= 4; status++) load[`${phaseName}Status${status}`] = samples.filter((/* 一次已记录逻辑操作。 */ item) => item.status === status).length
}

test('M00-P03 两个真实会话与八十读二十写的压力闭环和完整耐久节拍', async (
  /* 独立浏览器、真实 owner HTTP 网关、原数据集环境与所选存储。 */ { browser, gateway, environment, webUrl, storage },
  /* 归属本轮完整原始样本的安全附件。 */ testInfo,
) => {
  const settings = workspaceReadLoadSettings()
  testInfo.setTimeout(2 * settings.stressDurationMs + settings.enduranceDurationMs + 180_000)
  const dataset = await workspacePrepareMeasuredDataset(gateway, environment.workspaceId, settings.profile)
  const initial = await gateway.read('map.get', { mapId: dataset.mapId })
  const bootstrap = await gateway.read('app.bootstrap', {})
  const report = workspaceCreateReport('M00-P03', settings, storage, dataset)
  const contexts: BrowserContext[] = [], pages: Page[] = [], selected: GraphNode[] = []
  const allDurations: number[] = [], memory: number[] = []
  try {
    for (let index = 0; index < 2; index++) {
      const actor = await workspaceCreateActor(environment, 'viewer', environment.workspaceId)
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); contexts.push(context)
      const page = await context.newPage(); pages.push(page)
      await workspaceLogin(page, webUrl, actor.token)
      await workspaceOpenMap(page, dataset.mapName); await workspaceWaitForGraph(page, dataset)
      selected.push(await workspaceSelectMeasuredNode(page, initial))
    }
    const roots = dataset.rootIds.filter((/* 公开 API 准备的独立结构根。 */ id) => !selected.some((/* 两个页面保持读取的节点。 */ node) => node.id === id))
    if (roots.length < 4) throw new Error(PerformanceError.EMPTY_DATASET)
    const state: LoadState = { expected: new Map(initial.nodes.map((/* 原快照中的一个节点。 */ node) => [node.id, node])),
      originals: new Map(initial.nodes.map((/* 不修改的原始正文和版本。 */ node) => [node.id, node])),
      roots, tails: new Map(), uncertainRoots: new Set(), leasesRequired: bootstrap.metadata.clientLeases !== 'none' }
    report.environment = await workspaceReadEnvironment(browser, pages[0]!)
    report.load = { formalDuration: settings.duration === 'calibration' ? 0 : 1, targetReadPercent: 80, targetWritePercent: 20,
      enduranceTargetRate: settings.enduranceRate, browserContexts: contexts.length, browserObservationRate: 1 }
    let failed = false
    for (const phaseName of ['stress8', 'stress16', 'endurance'] as const) {
      const control: LoadControl = { running: true, failedUi: false }, uiValues: number[] = []
      const driver = workspaceRunLoadPhase(gateway, dataset, phaseName, state, settings, control)
      const observers = pages.map(async (/* 每个真实浏览器观察者页面。 */ page, /* 对应不变的选中节点序号。 */ index) => {
        // 先开始真实 HTTP 驱动，再持续从两个正常页面完成阅读往返。
        const content = selected[index]?.payload.content
        if (typeof content !== 'string') { control.failedUi = true; throw new Error(PerformanceError.EMPTY_DATASET) }
        await workspaceObserveLoad(page, content, control, uiValues)
      })
      const results = await Promise.allSettled([driver, ...observers])
      const phase = await driver
      phase.uiFailures = results.filter((/* 已排空的驱动和观察任务。 */ result) => result.status === 'rejected').length
      workspaceAddLoadReport(report, phaseName, phase, uiValues)
      allDurations.push(...phase.samples.map((/* 每项业务的完整耗时，失败仍保留。 */ item) => item.endedMs - item.startedMs))
      if (phase.incomplete || phase.uiFailures || phase.samples.some((/* 任意失败、超时、冲突或未确认项。 */ item) => item.status !== 0)) failed = true
      if (phaseName !== 'endurance' && Math.max(...phase.httpConcurrency) < 2) throw new Error(PerformanceError.LOAD_OVERLAP_MISSING)
      expect(phase.samples).toHaveLength(phase.scheduled)
      const writes = phase.samples.filter((/* 按逻辑业务身份核对 80/20 调度。 */ item) => item.kind === 1).length
      expect(Math.abs(writes - phase.samples.length * 0.2)).toBeLessThanOrEqual(1)
      for (const page of pages) { const sample = await workspaceReadBrowserMemory(page); if (sample.used !== null) memory.push(sample.used) }
    }
    const final = await gateway.read('map.get', { mapId: dataset.mapId })
    // 逐节点核对成功写入的最终版本；未确认写入不得被假定回滚或忽略。
    expect(final.mapId).toBe(initial.mapId); expect(final.nodes).toHaveLength(initial.nodes.length); expect(final.edges).toEqual(initial.edges)
    for (const node of final.nodes) {
      const expected = state.expected.get(node.id)
      expect(expected !== undefined).toBe(true)
      expect(node.payload).toEqual(expected?.payload); expect(node.revision).toBe(expected?.revision)
    }
    if (failed || state.uncertainRoots.size) throw new Error(PerformanceError.LOAD_FAILED)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    report.metrics.push(workspaceMetric(MetricName.API_P95, 'ms', allDurations.length >= 100 ? [workspaceQuantile(allDurations, 0.95)] : []),
      workspaceMetric(MetricName.API_P99, 'ms', allDurations.length >= 1_000 ? [workspaceQuantile(allDurations, 0.99)] : []),
      workspaceMetric(MetricName.BROWSER_HEAP, 'bytes', memory))
    try { await workspaceAttachReport(testInfo, report) }
    finally { await Promise.all(contexts.map(async (/* 此用例创建并持有的独立浏览器 context。 */ context) => { await context.close() })) }
  }
})
