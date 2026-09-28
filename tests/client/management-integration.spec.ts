// 管理端集成测试：覆盖真实配置保存、文件流转、导入幂等和成员权限。
import { randomUUID } from 'node:crypto'
import { effectScope, reactive } from 'vue'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { clientCreateGateway } from '../../client/graph-client'
import { ClientError, type ClientGateway } from '../../contracts/client'
import type { AgentInput, AgentProfile, Asset, ImportResult, PromptKind, WorkspaceView } from '../../contracts/control'
import { useManagementTask } from '../../apps/ui/features/management/use-management'
import { fixtureCreateEnvironment, type UiFixture } from './ui-fixture'

let fixture: UiFixture, gateway: ClientGateway
const connections: ClientGateway[] = [], scopes: ReturnType<typeof effectScope>[] = []
beforeAll(async () => {
  // 启动真实验收服务并用工作区用户令牌建立连接。
  fixture = await fixtureCreateEnvironment()
  gateway = await connect(fixture.token)
}, 30_000)
afterEach(() => {
  // 每个用例结束后停止管理任务的 Vue 作用域。
  for (const scope of scopes.splice(0)) scope.stop()
})
afterAll(async () => {
  // 退出所有测试连接并释放真实验收环境。
  await Promise.all(connections.map(/* 用例登记的已登录网关，由清理流程调用退出。 */ connection => /* 退出一个登记过的客户端连接。 */ connection.disconnect()))
  await fixture?.close()
}, 30_000)
async function connect(/* 测试用户的访问令牌，来自验收后端签发接口。 */ token: string) {
  // 使用指定用户令牌登录并登记连接，供统一清理。
  const connection = clientCreateGateway({ baseUrl: fixture.baseUrl, timeoutMs: 5000 })
  await connection.connect({ baseUrl: fixture.baseUrl, token, remember: false }); connections.push(connection)
  return connection
}
function management(/* 管理任务使用的客户端连接，默认采用本文件已登录网关。 */ connection = gateway, /* 可选的认证失效观察回调，默认空操作。 */ onUnauthorized = () => {
    // 未指定认证失效观察行为时不执行额外操作。
}) {
  // 在可清理的 Vue 作用域中创建管理任务。
  const scope = effectScope(); scopes.push(scope)
  return scope.run(() => /* 让管理任务的请求生命周期归属于当前测试作用域。 */ useManagementTask({ gateway: connection, onUnauthorized }))!
}
async function workspace() {
  // 创建拥有共享库配置副本的独立管理验收工作区。
  return (await gateway.dispatch(randomUUID(), 'workspace.create', { id: randomUUID(), name: '管理验收工作区', description: '', agentSource: 'library' })).data
}
async function createMap(/* 作为新图所属范围的工作区，只使用其身份并重新读取最新版本。 */ value: WorkspaceView) {
  // 取得工作区最新版本后创建用于文件流转测试的数据图。
  const current = await gateway.read('workspace.get', { workspaceId: value.id })
  return (await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: value.id, expectedRevision: current.revision, id: randomUUID(), name: '文件流转图' })).data.snapshot
}
function input(/* 已保存的只读 Agent 配置，复制可编辑字段与数组供测试提交。 */ profile: AgentProfile): AgentInput {
  // 复制已保存 Agent 的可编辑字段和数组，供更新请求使用。
  return { id: profile.id, kind: profile.kind, promptPath: profile.promptPath, name: profile.name, description: profile.description,
    content: profile.content, provider: profile.provider, model: profile.model, tools: [...profile.tools], promptVars: [...profile.promptVars],
    defaultPriority: profile.defaultPriority, claimCategory: profile.claimCategory }
}
const lostReply = () =>
  /* 模拟后端已提交但客户端丢失成功响应的可重试网络错误。 */
  new ClientError({ code: 'NETWORK_ERROR', message: 'Fixture lost the committed response', status: 0, retryable: true })

describe('Management tasks against authenticated API and file endpoints', () => {
  // 覆盖真实认证 API 下的智能体配置、文件流转、分阶段导入和成员权限。
  it('saves all seven profile kinds without losing ordered fields and leaves an existing Run frozen', async () => {
    // 验证七类配置保留有序字段，修改配置不改变已有运行的冻结副本，固定角色不能删除。
    const ws = await workspace(), task = management()
    const scope = { kind: 'workspace' as const, workspaceId: ws.id }
    let list = await gateway.read('agent.list', { scope })
    const bootstrap = await gateway.read('app.bootstrap', {})
    const kinds: PromptKind[] = ['parseExtract', 'splitRoute', 'splitSubAgent', 'splitMerge', 'verifyRoute', 'verifySubAgent', 'verifyMerge']
    for (const kind of kinds) {
      const profile = list.items.find(/* 目录中的配置项，用本轮待验收角色匹配。 */ agent => /* 查找当前待验证角色的智能体。 */ agent.kind === kind)!
      const agent = reactive({ ...input(profile), content: profile.content + '\n管理页自定义配置', provider: null, model: null,
        promptVars: [...bootstrap.metadata.variables[kind]].reverse(), defaultPriority: 'low' as const, claimCategory: kind === 'splitSubAgent' ? 'data' as const : null })
      const saved = await task.command('agent.update', { scope, expectedRevision: list.revision, agentId: profile.id, expectedAgentRevision: profile.revision, agent })
      expect(saved, task.error.value?.message).not.toBeNull()
      list = saved!.data
      expect(list.items.find(/* 更新后的配置项，用原 Agent 身份核对保存结果。 */ item => /* 按原标识查找保存后的配置进行字段核对。 */ item.id === profile.id)).toMatchObject(agent)
    }
    const map = await createMap(ws), claimId = randomUUID()
    const edited = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId, expectedRevision: map.revision,
      changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: '管理配置冻结验收', category: null } }] } } })
    const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, expectedRevision: edited.data.snapshot.revision,
      id: randomUUID(), scope: { nodeIds: [claimId] }, until: 'verified', mode: 'human-in-loop' })
    const frozen = started.data.snapshot.run!.configuration
    const currentList = await gateway.read('agent.list', { scope })
    const original = currentList.items.find(/* 当前目录中的配置项，用类型选择可更改的核查子 Agent。 */ agent => /* 选择核查子 Agent，验证后续配置变更不影响已启动运行。 */ agent.kind === 'verifySubAgent')!
    await task.command('agent.update', { scope, expectedRevision: currentList.revision, agentId: original.id,
      expectedAgentRevision: original.revision, agent: { ...input(original), content: '以后运行使用的新提示词' } })
    expect((await gateway.read('map.get', { mapId: map.mapId })).run!.configuration).toEqual(frozen)
    const fixed = currentList.items.find(/* 当前目录中的配置项，用不可删除标记选择固定角色。 */ agent => /* 选取不可删除的固定角色供拒绝删除断言。 */ !agent.deletable)!
    const latest = await gateway.read('agent.list', { scope })
    await expect(gateway.dispatch(randomUUID(), 'agent.delete', { scope, expectedRevision: latest.revision,
      agentId: fixed.id, expectedAgentRevision: fixed.revision })).rejects.toMatchObject({ code: 'FIXED_ROLE' })
  }, 20_000)

  it('restricts shared-library edits to HostAdmin and copies merge/replace into the explicit Workspace', async () => {
    // 验证只有主机管理员能改共享库，并确认合并与替换只作用于显式目标工作区。
    const ws = await workspace()
    const admin = await fixture.application.auth.createUser({ id: randomUUID(), displayName: '隔离管理员', hostAdmin: true })
    const token = await fixture.application.auth.createToken(admin.userId)
    const adminGateway = await connect(token.token), libraryScope = { kind: 'library' as const }
    const library = await adminGateway.read('agent.list', { scope: libraryScope })
    const fixed = library.items.find(/* 共享库中的配置项，用解析角色类型选择更新目标。 */ agent => /* 选择共享库的固定解析角色进行更新。 */ agent.kind === 'parseExtract')!
    const update = { scope: libraryScope, expectedRevision: library.revision, agentId: fixed.id,
      expectedAgentRevision: fixed.revision, agent: { ...input(fixed), content: fixed.content + '\n库中明确更新' } }
    await expect(gateway.dispatch(randomUUID(), 'agent.update', update)).rejects.toMatchObject({ status: 403 })
    const changedLibrary = (await adminGateway.dispatch(randomUUID(), 'agent.update', update)).data
    const scope = { kind: 'workspace' as const, workspaceId: ws.id }
    const list = await gateway.read('agent.list', { scope })
    const source = list.items.find(/* 工作区中的配置项，用核查子 Agent 类型选择自定义副本来源。 */ agent => /* 选取可复制为工作区自定义配置的核查子 Agent。 */ agent.kind === 'verifySubAgent')!
    const customId = randomUUID()
    const custom = await gateway.dispatch(randomUUID(), 'agent.create', { scope, expectedRevision: list.revision,
      agent: { ...input(source), id: customId, promptPath: 'custom/' + customId, name: '仅当前工作区' } })
    const oldFixed = list.items.find(/* 原工作区配置项，用解析角色类型追踪被覆盖身份。 */ agent => /* 找到工作区已有的解析角色，核对复制覆盖保持身份。 */ agent.kind === 'parseExtract')!
    const task = management()
    const merged = await task.command('agent.copy', { workspaceId: ws.id, expectedRevision: custom.data.revision,
      libraryRevision: changedLibrary.revision, agentIds: changedLibrary.items.map(/* 更新后的共享库配置，提取全部身份供合并复制。 */ agent =>
        /* 提取全部共享库配置标识作为合并复制范围。 */
        agent.id), mode: 'merge' })
    expect(merged!.data.agents.some(/* 合并后的工作区配置，用自定义身份确认未选配置保留。 */ agent => /* 检查合并后工作区自定义配置仍被保留。 */ agent.id === customId)).toBe(true)
    expect(merged!.data.agents.find(/* 合并后的工作区配置，用原路径确认覆盖仍保留目标身份。 */ agent =>
      /* 按配置路径查找被共享库覆盖的原工作区角色。 */
      agent.promptPath === oldFixed.promptPath)).toMatchObject({ id: oldFixed.id, content: update.agent.content })
    const replaced = await task.command('agent.copy', { workspaceId: ws.id, expectedRevision: merged!.data.revision,
      libraryRevision: changedLibrary.revision, agentIds: changedLibrary.items.map(/* 更新后的共享库配置，提取全部身份供替换复制。 */ agent => /* 提取全部共享库配置标识作为替换范围。 */ agent.id), mode: 'replace' })
    expect(replaced!.data.id).toBe(ws.id)
    expect(replaced!.data.agents.some(/* 替换后的工作区配置，用自定义身份检查它已被移除。 */ agent => /* 检查替换后原自定义配置是否已经移除。 */ agent.id === customId)).toBe(false)
    expect(replaced!.data.agents.filter(/* 替换后的工作区配置，用不可删除标记统计固定角色。 */ agent => /* 统计替换后仍保留的固定角色。 */ !agent.deletable)).toHaveLength(5)
  })

  it('retains the uploaded Asset across lost replies and failed Source creation, then lists and exports it', async () => {
    // 验证上传响应丢失与来源创建冲突不会丢失资产，随后可分页查看并导出它。
    const ws = await workspace(), map = await createMap(ws), task = management()
    const original = new TextEncoder().encode('共享原稿：数据与来源必须保持一致。')
    const draft = reactive({ workspaceId: ws.id, filename: 'source.txt', mediaType: 'text/plain', bytes: original.slice() })
    const uploadIds: string[] = []
    let first = true, asset: Asset | null = null
    const pending = task.run(draft, async (
      /* 管理任务生成的上传输入副本，需保持原文件名和原始字节。 */ payload,
      /* 本轮上传的稳定幂等身份，记录后用于比较两次尝试。 */ requestId,
      /* 管理任务提供的取消信号，原样交给真实上传网关。 */ signal
    ) => {
      // 记录上传请求身份，实际提交后仅丢弃首个响应以测试幂等重试。
      uploadIds.push(requestId)
      const result = await gateway.upload(requestId, payload, signal)
      if (first) { first = false; throw lostReply() }
      return result
    }, /* 幂等上传确认后的响应，取服务端资产记录用于后续引用。 */ result => {
      // 接纳重试确认后的资产对象。
      asset = result.data
    })
    draft.filename = 'changed-after-submission.txt'; draft.bytes.fill(0)
    expect(await pending).toBeNull()
    expect(task.canRetry.value).toBe(true)
    expect(await task.retry()).toBe(true)
    expect(new Set(uploadIds).size).toBe(1)
    const saved = asset as unknown as Asset
    expect(saved.filename).toBe('source.txt')
    expect((await gateway.download({ kind: 'asset', id: saved.id })).bytes).toEqual(original)
    const altered = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId, expectedRevision: map.revision,
      changes: { nodes: { put: [{ id: randomUUID(), data: { kind: 'news', content: '先发生的并发修改', context: {} } }] } } })
    const source = { id: randomUUID(), data: { kind: 'source' as const, locator: { kind: 'asset' as const, assetId: saved.id, mediaType: saved.mediaType }, label: saved.filename } }
    expect(await task.command('graph.apply', { mapId: map.mapId, expectedRevision: map.revision, changes: { nodes: { put: [source] } } })).toBeNull()
    expect(task.error.value?.code).toBe('REVISION_CONFLICT')
    expect((await gateway.read('asset.get', { assetId: saved.id })).id).toBe(saved.id)
    task.clearError()
    expect(await task.command('graph.apply', { mapId: map.mapId, expectedRevision: altered.data.snapshot.revision, changes: { nodes: { put: [source] } } })).not.toBeNull()
    expect(uploadIds).toHaveLength(2)
    for (const filename of ['second.txt', 'third.txt']) await gateway.upload(randomUUID(), { workspaceId: ws.id, filename, mediaType: 'text/plain', bytes: original })
    const page = await gateway.read('asset.list', { workspaceId: ws.id, limit: 2 })
    expect(page.items).toHaveLength(2); expect(page.nextCursor).not.toBeNull()
    const next = await gateway.read('asset.list', { workspaceId: ws.id, limit: 2, cursor: page.nextCursor! })
    expect(new Set([...page.items, ...next.items].map(/* 分页合并后的资产条目，用身份检查没有重复或遗漏。 */ item => /* 提取跨页资产标识以检查分页去重。 */ item.id)).size).toBe(3)
    const file = await gateway.download({ kind: 'map', id: map.mapId })
    const bundle = JSON.parse(new TextDecoder().decode(file.bytes))
    expect(bundle).toMatchObject({ format: 'chongming-map', version: 3 })
    expect(bundle.map).not.toHaveProperty('run'); expect(bundle.map).not.toHaveProperty('leases')
    expect(bundle.assets.map((/* 导出包中的资产记录，提取身份核对被引用文件已包含。 */ item: Asset) => /* 提取导出包资产标识，确认引用文件被包含。 */ item.id)).toContain(saved.id)
    expect(JSON.parse(new TextDecoder().decode((await gateway.download({ kind: 'workspace', id: ws.id })).bytes)).format).toBe('chongming-workspace')
  })

  it('imports an exported map through two stable stages and confirms a single Workspace after a lost response', async () => {
    // 验证暂存和导入使用稳定身份，丢失响应后重试只创建一个目标工作区。
    const ws = await workspace(), map = await createMap(ws)
    const file = await gateway.download({ kind: 'map', id: map.mapId })
    const task = management()
    const staged = await task.run({ workspaceId: ws.id, filename: 'map-package.json', mediaType: 'application/json', bytes: file.bytes },
      (
        /* 暂存导入包的参数副本，含目标暂存工作区和导出字节。 */ payload,
        /* 暂存上传的稳定请求身份，由管理任务负责重试复用。 */ requestId,
        /* 管理任务取消信号，交给真实文件上传。 */ signal
      ) => /* 用管理任务保存的请求身份上传待导入包。 */ gateway.upload(requestId, payload, signal))
    expect(staged).not.toBeNull()
    let lost = false, imported: ImportResult | null = null, importedName = ''
    const ids: string[] = [], bodies: string[] = []
    const dropReply: ClientGateway = { ...gateway, async dispatch(
      /* 被包装命令的业务请求身份，记录后核对重试保持一致。 */ requestId,
      /* 被包装的公开命令方法，原样转发给真实网关。 */ method,
      /* 被包装命令的参数副本，序列化记录用于重试内容比较。 */ params,
      /* 被包装调用的可选取消信号，原样转发。 */ signal
    ) {
      // 记录导入请求身份和参数，实际提交后丢弃第一次成功响应。
      ids.push(requestId); bodies.push(JSON.stringify(params))
      const result = await gateway.dispatch(requestId, method, params, signal)
      if (!lost) { lost = true; throw lostReply() }
      return result
    } }
    const importing = management(dropReply)
    const params = reactive({ id: randomUUID(), bundleAssetId: staged!.data.id, stagingWorkspaceId: ws.id, name: '仅创建一次的新工作区' })
    const targetId = params.id
    const pending = importing.run(params, async (
      /* 管理任务保留的导入参数副本，包含固定的新工作区身份和名称。 */ payload,
      /* 整个导入操作的稳定幂等身份，模拟响应丢失后仍复用。 */ requestId,
      /* 管理任务取消信号，同时用于导入和名称查询。 */ signal
    ) => {
      // 执行导入后查询新工作区名称，使重试验证整个接纳流程。
      const result = await dropReply.dispatch(requestId, 'workspace.import', payload, signal)
      const workspace = await dropReply.read('workspace.get', { workspaceId: result.data.workspaceId }, signal)
      return { imported: result.data, name: workspace.name }
    }, /* 导入及名称查询成功的组合结果，作为界面接纳观察值。 */ result => {
      // 记录成功导入的结果和工作区名称。
      imported = result.imported; importedName = result.name
    })
    params.id = randomUUID(); params.name = '不应采用的新草稿'
    expect(await pending).toBeNull(); expect(importing.canRetry.value).toBe(true)
    expect(await importing.retry()).toBe(true)
    const result = imported as unknown as ImportResult
    expect(result.workspaceId).toBe(targetId)
    expect(importedName).toBe('仅创建一次的新工作区')
    expect(new Set(ids).size).toBe(1); expect(new Set(bodies).size).toBe(1)
    expect((await gateway.read('workspace.get', { workspaceId: targetId })).name).toBe('仅创建一次的新工作区')
    expect((await gateway.read('workspace.list', {})).items.filter(/* 后端工作区列表条目，用目标身份验证仅创建一次。 */ item => /* 筛选目标工作区，断言重试没有重复创建。 */ item.id === targetId)).toHaveLength(1)
    expect((await gateway.read('map.list', { workspaceId: targetId }))).toHaveLength(1)
    expect((await gateway.read('asset.get', { assetId: staged!.data.id })).id).toBe(staged!.data.id)
  })

  it('enforces Viewer/Editor file permissions and reports real token revocation without accepting late UI state', async () => {
    // 验证只读成员与编辑者的文件权限，以及令牌撤销后不接纳界面结果。
    const ws = await workspace(), map = await createMap(ws)
    const editor = await fixture.application.auth.createUser({ id: randomUUID(), displayName: '隔离编辑者', hostAdmin: false })
    const viewer = await fixture.application.auth.createUser({ id: randomUUID(), displayName: '隔离只读成员', hostAdmin: false })
    for (const [userId, role] of [[editor.userId, 'editor'], [viewer.userId, 'viewer']] as const) {
      const current = await gateway.read('workspace.get', { workspaceId: ws.id })
      await gateway.dispatch(randomUUID(), 'member.set', { workspaceId: ws.id, expectedRevision: current.revision, userId, role })
    }
    const editorToken = await fixture.application.auth.createToken(editor.userId), viewerToken = await fixture.application.auth.createToken(viewer.userId)
    const editorGateway = await connect(editorToken.token), viewerGateway = await connect(viewerToken.token)
    const upload = { workspaceId: ws.id, filename: 'permissions.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('权限验收') }
    await expect(viewerGateway.upload(randomUUID(), upload)).rejects.toMatchObject({ status: 403 })
    const asset = (await editorGateway.upload(randomUUID(), upload)).data
    expect((await viewerGateway.read('asset.list', { workspaceId: ws.id })).items.some(/* 只读成员可见的资产条目，用已上传资产身份验证读取权限。 */ item =>
      /* 检查只读成员仍能在资产列表中看到已上传文件。 */
      item.id === asset.id)).toBe(true)
    expect((await viewerGateway.download({ kind: 'asset', id: asset.id })).bytes).toEqual(upload.bytes)
    expect((await viewerGateway.download({ kind: 'map', id: map.mapId })).bytes.length).toBeGreaterThan(0)
    await expect(viewerGateway.download({ kind: 'workspace', id: ws.id })).rejects.toMatchObject({ status: 403 })
    await expect(editorGateway.dispatch(randomUUID(), 'asset.delete', { assetId: asset.id, expectedSha256: asset.sha256 })).rejects.toMatchObject({ status: 403 })
    await editorGateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId, expectedRevision: map.revision, changes: { nodes: { put: [{ id: randomUUID(),
      data: { kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: '编辑者来源' } }] } } })
    await expect(gateway.dispatch(randomUUID(), 'asset.delete', { assetId: asset.id, expectedSha256: asset.sha256 })).rejects.toMatchObject({ status: 409 })
    let unauthorized = 0, accepted = false
    const task = management(viewerGateway, () => {
      // 统计管理任务发出的认证失效通知。
      unauthorized++
    })
    await fixture.application.auth.revokeToken(viewerToken.tokenId)
    expect(await task.read('asset.list', { workspaceId: ws.id }, () => {
      // 标记是否错误接纳了撤销令牌后的查询结果。
      accepted = true
    })).toBeNull()
    expect(unauthorized).toBe(1); expect(accepted).toBe(false); expect(task.canRetry.value).toBe(false)
  })
})
