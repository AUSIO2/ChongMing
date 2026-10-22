// 账户网关测试使用显式HTTP seam，核对激活、轮换和代次，不调用外部邮件或账户服务。
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AuthSession } from '../../contracts/auth'
import type { AppBootstrap } from '../../contracts/control'
import { clientCreateGateway } from '../../client/graph-client'

const origin = 'https://account.example'
const bootstrap: AppBootstrap = { identity: { userId: 'account-user', displayName: '账户用户', hostAdmin: false },
  settings: { revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 2 } }, metadata: { variables: {} } }
const gateways: ReturnType<typeof clientCreateGateway>[] = []
afterEach(() => {
  // 结束本例网关并恢复时钟，避免账户状态影响原令牌测试。
  for (const gateway of gateways.splice(0)) gateway.close()
  vi.restoreAllMocks()
})

function session(
  /* 本轮访问/刷新凭据序号，不使用任何真实凭据。 */ version = 1,
): AuthSession {
  // 使用当前测试时钟生成明确期限，刷新只由网关调用前判断触发。
  return { identity: bootstrap.identity, accessToken: `access-${version}`, refreshToken: `refresh-${version}`,
    accessExpiresAt: new Date(Date.now() + 120_000).toISOString(), refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }
}
function success(/* 显式测试响应的公开数据。 */ data: unknown): Response {
  // 认证没有业务写入的重放语义，信封不宣称replayed。
  return Response.json({ ok: true, requestId: 'test-response', data })
}
function fixture(
  /* 对指定认证动作覆盖响应，默认正常登录与轮换。 */ respond?: (path: string, body: Record<string, unknown>) => Promise<Response> | Response | undefined,
) {
  // 记录请求地址、业务JSON和测试授权值，供断言无跨服务refresh或自动重放。
  const requests: Array<{ origin: string; path: string; body: Record<string, unknown>; authorization: string | null }> = []
  const fetcher = vi.fn<typeof fetch>(async (/* 已由网关规范化的固定地址。 */ input, /* 本次原请求选项。 */ init) => {
    const url = new URL(String(input))
    const value: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('测试请求不是对象')
    const body = Object.fromEntries(Object.entries(value))
    requests.push({ origin: url.origin, path: url.pathname, body, authorization: new Headers(init?.headers).get('authorization') })
    if (url.pathname.startsWith('/api/v1/auth/')) {
      const supplied = respond?.(url.pathname, body)
      if (supplied) return supplied
      if (url.pathname.endsWith('/refresh')) return success(session(2))
      if (url.pathname.endsWith('/login') || url.pathname.endsWith('/verify-email') || url.pathname.endsWith('/change-password') || url.pathname.endsWith('/register-username') || url.pathname.endsWith('/login-username')) return success(session())
      return success({ message: '测试动作已完成' })
    }
    return Response.json({ ok: true, requestId: typeof body.requestId === 'string' ? body.requestId : 'test-response', replayed: false, data: bootstrap })
  })
  const gateway = clientCreateGateway({ baseUrl: origin, fetch: fetcher })
  gateways.push(gateway)
  const account = gateway.account
  if (!account) throw new Error('账户能力尚未实现')
  return { gateway, account, fetcher, requests }
}

describe('账户HTTP网关', () => {
  it.each(['registerUsername', 'loginUsername'] as const)('username %s activates through its own endpoint and keeps credentials out of public connection state', async (action) => {
    // 无邮件认证仍经过同服务bootstrap检查，不把访问或刷新凭据交给界面。
    const f = fixture(), input = { baseUrl: origin, username: 'Reader_01', password: 'username-password-2026', remember: true }
    const result = action === 'registerUsername' ? await f.account.registerUsername({ ...input, displayName: '读者' }) : await f.account.loginUsername(input)
    expect(result).toEqual(bootstrap)
    expect(f.requests.map(request => request.path)).toEqual([`/api/v1/auth/${action === 'registerUsername' ? 'register-username' : 'login-username'}`, '/api/v1/query'])
    expect(f.requests[0]?.body).toEqual({ username: input.username, password: input.password, remember: true, ...(action === 'registerUsername' ? { displayName: '读者' } : {}) })
    expect(f.requests[0]?.authorization).toBeNull()
    expect(f.requests[0]?.body).not.toHaveProperty('email')
    expect(f.requests[1]?.authorization).toBe('Bearer access-1')
    expect(await f.gateway.getConnection()).toMatchObject({ baseUrl: origin, configured: true, account: true })
    expect(JSON.stringify(await f.gateway.getConnection())).not.toMatch(/access-1|refresh-1|username-password/)
  })

  it.each(['registerUsername', 'loginUsername'] as const)('username %s failure and a late success preserve the newer connection', async (action) => {
    // 新的无邮件入口也必须遵守原账户意图代次，不能让迟到响应复活已断开的身份。
    let resolve: (response: Response) => void = () => { /* 请求开始后替换。 */ }
    let waiting = false
    const f = fixture((path, body) => {
      if (!path.endsWith('-username')) return undefined
      if (body.password === 'wrong') return Response.json({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: '用户名或密码错误。', retryable: false } }, { status: 401 })
      waiting = true
      return new Promise<Response>(complete => { resolve = complete })
    })
    await f.gateway.connect({ baseUrl: origin, token: 'existing-token', remember: false })
    const input = { baseUrl: origin, username: 'reader', remember: false }
    const authenticate = (password: string) => action === 'registerUsername' ? f.account.registerUsername({ ...input, displayName: '读者', password }) : f.account.loginUsername({ ...input, password })
    await expect(authenticate('wrong')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    await f.gateway.read('app.bootstrap', {})
    expect(f.requests.at(-1)?.authorization).toBe('Bearer existing-token')
    const pending = authenticate('correct-password-2026')
    await vi.waitFor(() => { expect(waiting).toBe(true) })
    await f.gateway.disconnect()
    resolve(success(session()))
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' })
    expect(await f.gateway.getConnection()).toMatchObject({ configured: false })
  })

  it('手工访问令牌只保存服务地址，即使存储误报也不标记为记住账户', async () => {
    // 手工令牌继续可以连接，但旧remember选项不能把访问令牌写入新凭据存储。
    const f = fixture()
    const save = vi.fn(async () => true)
    const gateway = clientCreateGateway({ baseUrl: origin, fetch: f.fetcher, store: {
      load: async () => null, save, clear: async () => { /* 本例只观察保存参数。 */ }, canRemember: () => true,
    } })
    gateways.push(gateway)
    await gateway.connect({ baseUrl: origin, token: 'manual-access', remember: true })
    expect(save).toHaveBeenCalledWith({ baseUrl: origin, remember: false })
    expect(await gateway.getConnection()).toMatchObject({ configured: true, remembered: false })
  })

  it('恢复安全保存的refresh后先轮换，再以新access读取并保存新的refresh', async () => {
    // 访问令牌只存在当前网关内存，重启恢复只消费存储中的刷新凭据。
    const f = fixture()
    const save = vi.fn(async () => true)
    const gateway = clientCreateGateway({ baseUrl: 'https://unused.example', fetch: f.fetcher, store: {
      load: async () => ({ baseUrl: origin, refreshToken: 'saved-refresh', remembered: true }), save,
      clear: async () => { /* 本例不主动退出。 */ }, canRemember: () => true,
    } })
    gateways.push(gateway)
    expect(await gateway.getConnection()).toMatchObject({ baseUrl: origin, configured: true, account: true })
    expect(f.requests).toHaveLength(0)
    await gateway.read('app.bootstrap', {})
    expect(f.requests[0]).toMatchObject({ origin, path: '/api/v1/auth/refresh', body: { refreshToken: 'saved-refresh' }, authorization: null })
    expect(f.requests[1]?.authorization).toBe('Bearer access-2')
    expect(save).toHaveBeenCalledWith({ baseUrl: origin, refreshToken: 'refresh-2', remember: true })
  })

  it('登录和邮箱验证通过同服务认证后激活，界面状态不含会话凭据', async () => {
    const f = fixture()
    expect(await f.account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: false })).toEqual(bootstrap)
    expect(await f.gateway.getConnection()).toMatchObject({ configured: true, account: true, baseUrl: origin })
    expect(f.requests.map((/* 实际请求摘要。 */ request) => /* 验证正常公开认证与bootstrap顺序。 */ request.path))
      .toEqual(['/api/v1/auth/login', '/api/v1/query'])
    expect(f.requests[0]?.authorization).toBeNull()
    expect(f.requests[1]?.authorization).toBe('Bearer access-1')
    expect(JSON.stringify(await f.gateway.getConnection())).not.toMatch(/access-1|refresh-1/)
    await f.account.verifyEmail({ baseUrl: origin, email: 'user@example.com', code: '123456', remember: false })
    expect(f.requests.some((/* 实际请求。 */ request) => /* 验证使用独立公开验证端点。 */ request.path === '/api/v1/auth/verify-email')).toBe(true)
  })

  it('账户辅助动作保留同服务参数，修改密码成功轮换并保持身份', async () => {
    const f = fixture()
    expect(await f.account.register({ baseUrl: origin, email: 'user@example.com', displayName: '用户', password: '测试密码足够长' })).toEqual({ message: '测试动作已完成' })
    await f.account.resendVerification({ baseUrl: origin, email: 'user@example.com' })
    await f.account.forgotPassword({ baseUrl: origin, email: 'user@example.com' })
    await f.account.resetPassword({ baseUrl: origin, email: 'user@example.com', code: '123456', password: '新测试密码足够长' })
    await f.account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: false })
    expect(await f.account.changePassword({ currentPassword: '测试密码足够长', newPassword: '新测试密码足够长', remember: false })).toEqual(bootstrap)
    const changed = f.requests.find((/* 实际请求。 */ request) => /* 当前账户改密只能发往当前服务。 */ request.path.endsWith('/change-password'))
    expect(changed).toMatchObject({ origin, authorization: 'Bearer access-1', body: { currentPassword: '测试密码足够长', newPassword: '新测试密码足够长', remember: false } })
  })

  it('到期前并发请求合并一次refresh，后续query和watch使用新access', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const f = fixture()
    await f.account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: false })
    clock.mockReturnValue(now + 100_000)
    await Promise.all([f.gateway.read('app.bootstrap', {}), f.gateway.read('app.bootstrap', {})])
    expect(f.requests.filter((/* 实际请求。 */ request) => /* 刷新会话不能被并发读取重复轮换。 */ request.path.endsWith('/refresh'))).toHaveLength(1)
    expect(f.requests.slice(-2).every((/* 刷新后的实际查询。 */ request) => /* 两者都使用新访问凭据。 */ request.authorization === 'Bearer access-2')).toBe(true)
    const controller = new AbortController()
    f.fetcher.mockImplementationOnce(async (/* 新事件订阅的实际地址。 */ input, /* SSE原请求选项。 */ init) => {
      expect(String(input)).toContain('/events')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-2')
      controller.abort()
      return new Response(null)
    })
    await expect(f.gateway.watch('00000000-0000-4000-8000-000000000001', () => { /* 本例只核对请求授权，不接受伪造事件。 */ }, controller.signal)).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
  })

  it('未知业务写入失败不自动refresh或重发，原requestId保持', async () => {
    const f = fixture()
    await f.account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: false })
    f.fetcher.mockRejectedValueOnce(new TypeError('connection reset'))
    await expect(f.gateway.dispatch('same-request', 'map.create', { workspaceId: 'workspace', expectedRevision: 0, id: 'map', name: '图' }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(f.fetcher).toHaveBeenCalledTimes(3)
    expect(f.requests.some((/* 已记录认证请求。 */ request) => /* 业务失败不能触发认证重放。 */ request.path.endsWith('/refresh'))).toBe(false)
    const init = f.fetcher.mock.calls[2]?.[1]
    expect(typeof init?.body === 'string' ? JSON.parse(init.body) : null).toMatchObject({ requestId: 'same-request' })
  })

  it('失败的新账户登录保留旧有效令牌连接，换服务不发送旧refresh', async () => {
    const f = fixture((/* 指定的认证动作。 */ path, /* 只对明确错误的密码拒绝。 */ body) => /* 明确模拟账户密码错误。 */ path.endsWith('/login') && body.password === '错误密码'
      ? Response.json({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误。', retryable: false } }, { status: 401 }) : undefined)
    await f.gateway.connect({ baseUrl: origin, token: 'legacy-token', remember: false })
    await expect(f.account.login({ baseUrl: 'https://other.example', email: 'user@example.com', password: '错误密码', remember: false })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    expect(await f.gateway.getConnection()).toMatchObject({ baseUrl: origin, configured: true })
    await f.gateway.read('app.bootstrap', {})
    expect(f.requests.at(-1)?.authorization).toBe('Bearer legacy-token')
    const other = f.requests.find((/* 实际认证请求。 */ request) => /* 只检查新服务得到的内容。 */ request.origin === 'https://other.example')
    expect(other?.body).not.toHaveProperty('refreshToken')
    expect(other?.authorization).toBeNull()
    await f.account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: false })
    await expect(f.account.login({ baseUrl: 'https://third.example', email: 'user@example.com', password: '错误密码', remember: false })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    expect(await f.gateway.getConnection()).toMatchObject({ baseUrl: origin, configured: true, account: true })
    const third = f.requests.find((/* 新服务收到的认证请求。 */ request) => /* 此时旧账户确有refresh，仍不能泄漏。 */ request.origin === 'https://third.example')
    expect(third?.body).not.toHaveProperty('refreshToken')
    expect(third?.authorization).toBeNull()
  })

  it('退出账户按正式空body和访问授权撤销，随后清客户端并拒绝后续业务', async () => {
    const f = fixture()
    await f.account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: false })
    await f.account.logout()
    expect(f.requests.find((/* 实际认证请求。 */ request) => /* 账户退出具有服务端撤销动作。 */ request.path.endsWith('/logout')))
      .toMatchObject({ origin, body: {}, authorization: 'Bearer access-1' })
    expect(await f.gateway.getConnection()).toMatchObject({ configured: false })
    await expect(f.gateway.read('app.bootstrap', {})).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })

  it('较晚完成的旧登录不能覆盖后一次成功连接', async () => {
    let resolveLogin: (response: Response) => void = () => { /* 首次请求进入后才替换。 */ }
    let count = 0
    const f = fixture((/* 认证请求端点。 */ path) => {
      // 用受控响应顺序重现旧登录在新连接之后返回。
      if (!path.endsWith('/login')) return undefined
      count += 1
      if (count === 1) return new Promise<Response>((/* 首次登录的受控完成入口。 */ resolve) => { resolveLogin = resolve })
      return success(session(2))
    })
    const old = f.account.login({ baseUrl: origin, email: 'first@example.com', password: '测试密码足够长', remember: false })
    await vi.waitFor(() => { expect(count).toBe(1) })
    await f.account.login({ baseUrl: 'https://new.example', email: 'next@example.com', password: '测试密码足够长', remember: false })
    resolveLogin(success(session()))
    await expect(old).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' })
    expect(await f.gateway.getConnection()).toMatchObject({ baseUrl: 'https://new.example', configured: true })
    expect(f.requests.some((/* 真实请求记录。 */ request) => /* 已过期的登录响应不能继续向旧服务读取bootstrap。 */ request.origin === origin && request.path === '/api/v1/query')).toBe(false)
  })

  it('旧refresh在本机断开后返回也不能恢复客户端', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    let resolveRefresh: (response: Response) => void = () => { /* 刷新请求进入后才替换。 */ }
    let refreshing = false
    const f = fixture((/* 认证动作。 */ path) => {
      if (!path.endsWith('/refresh')) return undefined
      refreshing = true
      return new Promise<Response>((/* 受控旧刷新响应。 */ resolve) => { resolveRefresh = resolve })
    })
    await f.account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: false })
    clock.mockReturnValue(now + 100_000)
    const pending = f.gateway.read('app.bootstrap', {})
    await vi.waitFor(() => { expect(refreshing).toBe(true) })
    await f.gateway.disconnect()
    resolveRefresh(success(session(2)))
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' })
    expect(await f.gateway.getConnection()).toMatchObject({ configured: false })
  })

  it('改密的迟到凭据保存不能越过退出清理重新记住会话', async () => {
    // 在真实存储seam控制保存完成顺序，退出必须在已开始保存之后清理。
    const f = fixture()
    const events: string[] = []
    let saveCount = 0
    let completeSave: (value: boolean) => void = () => { /* 第二次保存进入后替换。 */ }
    const gateway = clientCreateGateway({ baseUrl: origin, fetch: f.fetcher, store: {
      load: async () => null, canRemember: () => true,
      save: async () => {
        saveCount += 1
        if (saveCount === 2) {
          const result = await new Promise<boolean>((/* 改密保存的受控完成入口。 */ resolve) => { completeSave = resolve })
          events.push('save-completed')
          return result
        }
        return true
      },
      clear: async () => { events.push('clear') },
    } })
    gateways.push(gateway)
    const account = gateway.account
    if (!account) throw new Error('账户能力尚未实现')
    await account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: true })
    const changed = account.changePassword({ currentPassword: '测试密码足够长', newPassword: '新测试密码足够长', remember: true })
    await vi.waitFor(() => { expect(saveCount).toBe(2) })
    const exited = account.logout()
    await vi.waitFor(() => { expect(f.requests.some((/* 已发送的正式账户请求。 */ request) => /* 服务端撤销已到达，存储仍有受控保存。 */ request.path.endsWith('/logout'))).toBe(true) })
    completeSave(true)
    await expect(changed).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' })
    await exited
    expect(events).toEqual(['save-completed', 'clear'])
    expect(await gateway.getConnection()).toMatchObject({ configured: false, remembered: false })
  })

  it('旧账户退出的迟到响应不能断开后来成功登录的新服务', async () => {
    // 服务端撤销只针对退出开始时的账户，迟到清理不能覆盖后一次成功激活。
    let completeLogout: (response: Response) => void = () => { /* 退出请求进入后替换。 */ }
    let exiting = false
    const f = fixture((/* 固定认证动作。 */ path) => {
      if (!path.endsWith('/logout')) return undefined
      exiting = true
      return new Promise<Response>((/* 旧账户退出响应的受控完成入口。 */ resolve) => { completeLogout = resolve })
    })
    await f.account.login({ baseUrl: origin, email: 'user@example.com', password: '测试密码足够长', remember: false })
    const exited = f.account.logout()
    await vi.waitFor(() => { expect(exiting).toBe(true) })
    await f.account.login({ baseUrl: 'https://new.example', email: 'user@example.com', password: '测试密码足够长', remember: false })
    completeLogout(success(null))
    await exited
    expect(await f.gateway.getConnection()).toMatchObject({ baseUrl: 'https://new.example', configured: true, account: true })
  })
})
