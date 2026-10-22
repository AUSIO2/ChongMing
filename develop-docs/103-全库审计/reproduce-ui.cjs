// 仅在本进程装配合法定义及内存流，复核UI自有键、枚举值和次要清理错误；不接数据库或服务。
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const { definitionsReadPackage, definitionsValidateCatalog, definitionsValidatePayload } = require(path.join(root, 'backend/modules/shared/data-definition.ts'))
const { controlReadAgent } = require(path.join(root, 'backend/modules/workspace/workspace-input.ts'))
const { payloadReadPointer } = require(path.join(root, 'apps/ui/features/graph/data-payload.ts'))
const { payloadReadValueLabel } = require(path.join(root, 'apps/ui/features/graph/payload-labels.ts'))
const { clientCreateApi } = require(path.join(root, 'client/graph-client.ts'))
const { sessionCreateState } = require(path.join(root, 'apps/ui/state/client-session.ts'))
const { readerReadSourceNotes } = require(path.join(root, 'apps/ui/features/reader/reader-sources.ts'))
const { createRenderer } = require('vue')
const { usePanelResize } = require(path.join(root, 'apps/ui/composables/usePanelResize.ts'))
const { useBottomDockResize } = require(path.join(root, 'apps/ui/composables/useBottomDockResize.ts'))

function readSfc(file) {
  // 提取真实SFC的script区域，避免复制被审函数实现。
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  return { source, ast: ts.createSourceFile(file + '.ts', script, ts.ScriptTarget.Latest, true) }
}
function readFunction(file, name) {
  // 只转译目标纯函数；其Vue状态及emit由当前独立内存fixture提供。
  const { ast } = readSfc(file)
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  return ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
}
function readInitializer(file, name) {
  // 从当前受审文件取得真实声明，便于复现同名键查找与computed回调。
  const { ast } = readSfc(file)
  for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations.find(item => item.name.getText(ast) === name)
    if (declaration) return declaration.initializer.getText(ast)
  }
  throw new Error('Expected audited declaration: ' + name)
}
function report(id, details) {
  // 每项只输出输入类别、观察值和预期语义，不输出凭据或环境数据。
  process.stdout.write(JSON.stringify({ id, ...details }) + '\n')
}
function readSessionFixture() {
  // 复用现有会话测试的完整当前Run、Map和Workspace构造，不执行Vitest或实际传输。
  const file = path.join(root, 'tests/client/session.spec.ts')
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = new Set(['time', 'claimType', 'definitions', 'runControl', 'map', 'branch', 'currentRun', 'workspace', 'success', 'controlled'])
  const selected = []
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && names.has(statement.name?.text)) selected.push(statement.getText(ast))
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (names.has(declaration.name.getText(ast))) selected.push('const ' + declaration.getText(ast))
    }
  }
  const source = ts.transpileModule(selected.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  return new Function(source + ';return {map, workspace, currentRun, controlled, success}')()
}

async function main() {
  // 先走实际发布解析和目录校验，避免把非法schema当作UI行为缺陷。
  const type = { id: 'audit.payload', version: 1, title: '审计JSON字段', schema: { type: 'object', properties: {
    choice: { type: ['integer', 'string'], enum: [0, '0'] },
    dictionary: { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: { type: 'string' } },
    kind: { type: 'string', enum: ['asset', 'constructor', 'toString'] },
  } }, successorTypes: [], references: [], agentProjection: { include: [], mapEntryFilters: [] },
  presentation: { enumLabels: { '/kind': { asset: '文件' } } } }
  const pack = definitionsReadPackage({ id: 'audit.package', version: 1, title: 'UI审计合法正例',
    schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes: [type], transitions: [], dependencies: { packages: [], agents: [] } })
  const catalog = definitionsValidateCatalog([pack])
  definitionsValidatePayload(catalog, { id: type.id, version: 1 }, { choice: '0', dictionary: { constructor: '应显示正文' }, kind: 'constructor' })
  const schema = catalog.dataTypes[0].schema

  const renamed = { value: null }
  const rename = new Function('objectValue', 'emit', readFunction('apps/ui/features/graph/DataPayloadEditor.vue', 'editorRenameObject') + ';return editorRenameObject')(
    { value: { field: 0 } }, (_event, value) => { renamed.value = value },
  )
  rename('field', '__proto__')
  report('U10-rename', { json: JSON.stringify(renamed.value), ownsProto: Object.hasOwn(renamed.value, '__proto__'), expected: 'own __proto__:0' })

  const setPointer = new Function(readFunction('apps/ui/features/assets/AssetManagement.vue', 'assetSetPointer') + ';return assetSetPointer')()
  const payload = {}
  try {
    setPointer(payload, '/__proto__/assetId', 'audit-asset')
    report('U10-pointer-write', { json: JSON.stringify(payload), modifiedObjectPrototype: Object.prototype.assetId === 'audit-asset', expected: 'own nested JSON container; Object.prototype unchanged' })
  } finally { delete Object.prototype.assetId }
  report('U10-pointer-read', { observedType: typeof payloadReadPointer({}, '/constructor'), expected: 'undefined for absent own member' })

  const dynamic = readInitializer('apps/ui/features/graph/DataPayloadEditor.vue', 'dynamicFields')
  const computeDynamic = new Function('computed', 'objectValue', 'resolved', 'return ' + dynamic)
  report('U10-dynamic-fields', { visible: computeDynamic(fn => fn(), { value: { constructor: '应显示正文' } }, { value: schema.properties.dictionary }), expected: ['constructor'] })
  const knownKinds = new Function('return ' + readInitializer('apps/ui/features/agents/AgentManagement.vue', 'kinds'))()
  const agent = controlReadAgent({ id: 'audit-agent', name: '合法自定义种类', description: '审计正例', content: '内容', kind: 'toString', tools: [], promptVars: [],
    provider: null, model: null, promptPath: 'custom/audit-agent', defaultPriority: 'medium', claimCategory: null,
    role: 'producer', bindings: [{ transition: { id: 'factcheck.verify-claim', version: 1 }, stageId: 'assess' }] })
  report('U13-agent-kind', { parsedKind: agent.kind, hasOwnKind: Object.hasOwn(knownKinds, agent.kind), fallbackOptionVisible: !knownKinds[agent.kind], expected: 'fallback option visible' })
  report('retained-enum-labels', { constructor: payloadReadValueLabel('/kind', 'constructor', type.presentation.enumLabels), toString: payloadReadValueLabel('/kind', 'toString', type.presentation.enumLabels) })

  const editor = readSfc('apps/ui/features/graph/DataPayloadEditor.vue').source
  const select = editor.split('\n').find(line => line.includes('<select v-else-if="resolved.enum"'))
  const change = select.match(/@change="([^"]+)"/)[1]
  const emitted = { value: null }
  const choose = new Function('resolved', '$event', 'emit', ts.transpileModule(change, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText)
  choose(schema.properties.choice, { target: { value: String('0') } }, (_event, value) => { emitted.value = value })
  report('U14-enum-stringification', { requestedType: 'string', emitted: emitted.value, emittedType: typeof emitted.value, expected: 'string 0; original JSON type preserved' })

  const api = clientCreateApi({ baseUrl: 'http://127.0.0.1:12345', token: 'audit-token', fetch: async () => new Response(new ReadableStream({ cancel() { throw new Error('secondary cleanup failure') } }), { headers: { 'content-type': 'application/json' } }) })
  try { await api.watch('10000000-0000-4000-8000-000000000001', () => {}) }
  catch (error) { report('U11-sse-cleanup', { code: error.code ?? null, message: error.message, expected: 'INVALID_STREAM retained' }) }
  finally { api.close() }

  // 同图切换Run不推进viewEpoch，迟到A控制权不应成为当前B视图长期续租的授权。
  const fixture = readSessionFixture()
  let finishClaim
  const pending = new Promise(resolve => { finishClaim = resolve })
  const calls = []
  const session = sessionCreateState({ dispatch: async (_id, method) => {
    calls.push(method)
    if (method === 'run.control.claim') return pending
    return fixture.success({ released: true, ownershipRevision: 2 })
  } })
  const snapshot = fixture.map('map-a')
  const run = fixture.currentRun()
  const second = JSON.parse(JSON.stringify(run).replaceAll('map-a-claim', 'map-a-claim-b').replaceAll('run-a', 'run-b').replaceAll('operation-a', 'operation-b'))
  snapshot.nodes.push({ ...snapshot.nodes[0], id: 'map-a-claim-b' })
  snapshot.runs = [run, second]
  session.workspace.value = fixture.workspace('workspace-a')
  session.snapshot.value = snapshot
  session.activeMapId.value = snapshot.mapId
  session.selectedRunId.value = run.id
  session.online.value = true
  try {
    const claiming = session.claimRunControl(run.id)
    await session.selectRun(second.id)
    finishClaim(fixture.controlled())
    report('U17-late-run-control', { accepted: await claiming, selectedRun: session.selectedRunId.value,
      heldRun: session.selectedRunControl.value?.runId, releasedBeforeDispose: calls.includes('run.control.release'),
      expected: 'obsolete A claim rejected/released; B selection owns no A renewal' })
  } finally { session.dispose() }

  // 公共HTTP成功DTO仅缺边createdAt，验证实际reader消费会否在边界之后抛TypeError。
  const edgeMapId = '10000000-0000-4000-8000-000000000010'
  const edgeWorkspaceId = '10000000-0000-4000-8000-000000000011'
  const edgeSnapshot = fixture.map(edgeMapId, edgeWorkspaceId)
  edgeSnapshot.nodes[0].id = '10000000-0000-4000-8000-000000000012'
  edgeSnapshot.nodes.push({ ...edgeSnapshot.nodes[0], id: '10000000-0000-4000-8000-000000000013' }, { ...edgeSnapshot.nodes[0], id: '10000000-0000-4000-8000-000000000014' })
  edgeSnapshot.edges = edgeSnapshot.nodes.slice(1).map((node, index) => ({ id: `10000000-0000-4000-8000-00000000002${index}`,
    revision: 0, kind: 'successor', from: edgeSnapshot.nodes[0].id, to: node.id, updatedAt: edgeSnapshot.updatedAt }))
  const edgeApi = clientCreateApi({ baseUrl: 'http://127.0.0.1:12345', token: 'audit-token', fetch: async () => new Response(JSON.stringify(fixture.success(edgeSnapshot)), { headers: { 'content-type': 'application/json' } }) })
  try {
    const accepted = await edgeApi.read('map.get', { mapId: edgeMapId })
    try { readerReadSourceNotes(accepted, { workspaceId: edgeWorkspaceId, mapId: edgeMapId, nodeId: accepted.nodes[0].id }, null, 'outgoing') }
    catch (error) { report('U20-edge-required-boundary', { publicClientAccepted: true, readerError: error.name, message: error.message,
      expected: 'INVALID_RESPONSE at public edge.createdAt boundary' }) }
  } finally { edgeApi.close() }

  // 复用被审测试本身的fixture，单独切换目标proof条件与无关node日期，确认断言归因。
  const clientTestPath = path.join(root, 'tests/client/graph-client.spec.ts')
  const clientTestAst = ts.createSourceFile(clientTestPath, fs.readFileSync(clientTestPath, 'utf8'), ts.ScriptTarget.Latest, true)
  let snapshotInitializer, testBody
  function findClientTest(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(clientTestAst) === 'snapshot' && !snapshotInitializer) snapshotInitializer = node.initializer.getText(clientTestAst)
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'rejects a write response that combines a current snapshot with an older committed branch proof') testBody = node.arguments[1].body
    ts.forEachChild(node, findClientTest)
  }
  findClientTest(clientTestAst)
  const fixtureDeclarations = testBody.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ['branch', 'current'].includes(item.name.getText(clientTestAst))))
  const testFixture = new Function('const snapshot=' + snapshotInitializer + ';' + fixtureDeclarations.map(node => node.getText(clientTestAst)).join('\n') + '; return {branch,current}')()
  for (const validNodeDates of [false, true]) for (const matchingProof of [false, true]) {
    const current = structuredClone(testFixture.current)
    if (validNodeDates) for (const node of current.nodes) node.createdAt = node.updatedAt = '2026-10-20T00:00:00.000Z'
    const branch = { ...testFixture.branch, mapRevision: matchingProof ? current.revision : testFixture.branch.mapRevision }
    const proofApi = clientCreateApi({ baseUrl: 'http://127.0.0.1:12345', token: 'audit-token', fetch: async () => Response.json(fixture.success({ snapshot: current, createdNodeIds: [], createdEdgeIds: [], branch }, 'request')) })
    let outcome = 'accepted'
    try { await proofApi.dispatch('request', 'graph.apply', { mapId: 'map', branch: { rootIds: ['node'], expectedVersion: 'base' }, changes: { name: 'Name' } }) }
    catch (error) { outcome = error.code ?? error.name }
    finally { proofApi.close() }
    report('U22-masked-branch-proof-oracle', { validNodeDates, matchingProof, outcome })
  }

  // 真实Vue组件挂载/卸载驱动实际composable hooks；SFC取真实mousedown函数，窗口只用本进程EventTarget。
  const priorGlobals = Object.fromEntries(['window', 'document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  try {
    for (const axis of ['left', 'bottom']) {
      const listeners = new Map(), writes = []
      class AuditWindow extends EventTarget {
        innerHeight = 1000
        addEventListener(type, listener, options) { super.addEventListener(type, listener, options); if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) }
        removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); listeners.get(type)?.delete(listener) }
      }
      const window = new AuditWindow()
      Object.defineProperties(globalThis, { window: { configurable: true, value: window }, document: { configurable: true, value: { body: { style: { userSelect: '' } } } },
        localStorage: { configurable: true, value: { getItem() { return null }, setItem(key, value) { writes.push({ key, value }) } } } })
      const renderer = createRenderer({ createElement() { return {} }, createComment() { return {} }, createText() { return {} },
        insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode() { return null }, nextSibling() { return null }, patchProp() {} })
      let state, onMouseDown
      const app = renderer.createApp({ setup() {
        // AppShell实际同时拥有两类尺寸状态；仅当前分隔条开始拖动。
        const panels = usePanelResize(), bottom = useBottomDockResize()
        state = axis === 'left' ? panels.leftWidth : bottom.dockHeight
        const emit = (_event, position) => axis === 'left' ? panels.startResizeLeft(position) : bottom.startResizeBottom(position)
        onMouseDown = new Function('emit', readFunction(axis === 'left' ? 'apps/ui/components/shell/ResizableSplit.vue' : 'apps/ui/components/shell/ResizableRowSplit.vue', 'onMouseDown') + ';return onMouseDown')(emit)
        return () => null
      } })
      app.mount({})
      onMouseDown({ clientX: 100, clientY: 100, preventDefault() {} })
      const before = state.value
      app.unmount()
      const listenersAfterUnmount = [...listeners.values()].reduce((total, set) => total + set.size, 0)
      window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 150, clientY: 50 }))
      const after = state.value
      window.dispatchEvent(new Event('mouseup'))
      report('U24-resize-unmount', { axis, listenersAfterUnmount, before, after, writesAfterUnmount: writes.length,
        expected: 'unmount removes current drag listeners; later mouse movement/up does not mutate or persist disposed layout' })
    }
  } finally {
    for (const [key, descriptor] of Object.entries(priorGlobals)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  }
}
main().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1 })
