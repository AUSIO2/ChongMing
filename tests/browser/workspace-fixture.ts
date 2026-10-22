// 先行浏览器用例装配：复用现有真实服务，每个测试独立创建数据库、Web 服务及用户状态。
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test as base, expect, type Page } from '@playwright/test'
import { require as tsRequire } from 'tsx/cjs/api'
import { createServer, type ViteDevServer } from 'vite'
import { clientCreateGateway } from '../../client/graph-client'
import type { ClientGateway } from '../../contracts/client'
import type { Role } from '../../contracts/control'
import type { UiFixture } from '../client/ui-fixture'
import { workspaceCreateStaticDocumentPlugin } from './workspace-vite'

export interface WorkspaceOptions {
  storage: 'sqlite' | 'mongo'
  accountMail: boolean
}

interface WorkspaceFixtures extends WorkspaceOptions {
  environment: UiFixture
  gateway: ClientGateway
  webUrl: string
}

export interface WorkspaceActor {
  readonly userId: string
  readonly displayName: string
  readonly token: string
  readonly tokenId: string
}

enum WorkspaceFixtureMessage {
  WEB_ADDRESS_MISSING = '测试 Web 服务没有提供回环监听地址。',
}

// 每个用例独占现有 fixture；这里不实现未来的服务重启、故障代理或持久 runtime。
export const test = base.extend<WorkspaceFixtures>({
  storage: ['sqlite', { option: true }],
  accountMail: [true, { option: true }],
  environment: [async (
    /* 当前项目明确选择的真实存储类型与邮件装配。 */ { storage, accountMail },
    /* Playwright 在用例期间借用本次独立服务。 */ use,
  ) => {
    // 在任何浏览器页面建立之前创建独立后端，并始终等待真实关闭。
    // 使用项目已有 tsx 加载真实服务，保持其 import.meta 资源定位，不改生产模块格式。
    const fixtureModule: typeof import('../client/ui-fixture') = tsRequire(
      path.resolve('tests/client/ui-fixture.ts'),
      pathToFileURL(path.resolve('tests/browser/workspace-fixture.ts')).href,
    )
    // 项目当前是 CJS；作用域 tsx require 保留其 import.meta 资源定位且不接管其他测试。
    const { fixtureCreateEnvironment } = fixtureModule
    const environment = await fixtureCreateEnvironment({ storage, accountMail })
    try {
      await use(environment)
    } finally {
      await environment.close()
    }
  }, { timeout: 120_000 }],
  gateway: async (
    /* 此测试独占的真实后端及已签发初始化身份。 */ { environment },
    /* 只在当前测试中提供独立公共 HTTP 客户端。 */ use,
  ) => {
    // 准备与核对通过真实授权网关完成，不读取页面会话或数据库记录。
    const gateway = clientCreateGateway({ baseUrl: environment.baseUrl })
    try {
      await gateway.connect({ baseUrl: environment.baseUrl, token: environment.token, remember: false })
      await use(gateway)
    } finally {
      await gateway.disconnect()
    }
  },
  webUrl: async (
    /* 真实 API 地址和由当前用例持有的临时目录。 */ { environment },
    /* 页面可访问的独立 Vite origin，仅在本次用例内有效。 */ use,
  ) => {
    // 当前配置只装配 Web 模式；顺序用例结束后恢复测试进程原环境。
    const previousWeb = process.env.CHONGMING_WEB
    const previousApi = process.env.CHONGMING_GRAPH_API
    process.env.CHONGMING_WEB = '1'
    process.env.CHONGMING_GRAPH_API = environment.baseUrl
    let server: ViteDevServer | undefined
    try {
      server = await createServer({
        configFile: path.resolve('vite.config.ts'),
        cacheDir: path.join(environment.directory, 'vite-cache'),
        logLevel: 'silent',
        clearScreen: false,
        plugins: [workspaceCreateStaticDocumentPlugin()],
        server: {
          host: '127.0.0.1',
          // Vite 5 不将零值视为随机端口；使用原生端口递增，避开用户正在运行的预览。
          strictPort: false,
          proxy: { '/api/v1': { target: environment.baseUrl, changeOrigin: true, followRedirects: false } },
        },
      })
      await server.listen()
      const address = server.httpServer?.address()
      if (!address || typeof address === 'string') throw new Error(WorkspaceFixtureMessage.WEB_ADDRESS_MISSING)
      await use(`http://127.0.0.1:${address.port}`)
    } finally {
      try {
        await server?.close()
      } finally {
        if (previousWeb === undefined) delete process.env.CHONGMING_WEB
        else process.env.CHONGMING_WEB = previousWeb
        if (previousApi === undefined) delete process.env.CHONGMING_GRAPH_API
        else process.env.CHONGMING_GRAPH_API = previousApi
      }
    }
  },
})

export { expect }

export async function workspaceCreateActor(
  /* 当前测试独占的真实身份/控制服务。 */ environment: UiFixture,
  /* 加入指定工作区时的角色；没有工作区时只创建空账号。 */ role: Role = 'owner',
  /* 显式授权的目标工作区，省略时不加入任何工作区。 */ workspaceId?: string,
): Promise<WorkspaceActor> {
  // 用户和令牌由真实身份服务签发，成员修改仍走公开授权命令。
  const identity = await environment.application.auth.createUser({
    id: randomUUID(),
    displayName: `验收成员 ${randomUUID().slice(0, 8)}`,
    hostAdmin: false,
  })
  const credential = await environment.application.auth.createToken(identity.userId)
  if (workspaceId) {
    const owner = clientCreateGateway({ baseUrl: environment.baseUrl })
    try {
      await owner.connect({ baseUrl: environment.baseUrl, token: environment.token, remember: false })
      const workspace = await owner.read('workspace.get', { workspaceId })
      await owner.dispatch(randomUUID(), 'member.set', {
        workspaceId,
        expectedRevision: workspace.revision,
        userId: identity.userId,
        role,
      })
    } finally {
      await owner.disconnect()
    }
  }
  return { ...identity, ...credential }
}

export async function workspaceLogin(
  /* 当前用例真实浏览器页面，不注入任何应用私有状态。 */ page: Page,
  /* 独立 Vite 页面的 origin。 */ webUrl: string,
  /* 当前测试用户的私有令牌，不放入标题或报告。 */ token: string,
  /* 默认使用同源 Vite 代理，也允许测试明确提供服务地址。 */ baseUrl = webUrl,
): Promise<void> {
  // 从正常连接表单登录，空账号也以真实工作台就绪作为完成条件。
  await page.goto(webUrl)
  await workspaceConnectPage(page, baseUrl, token)
}

export async function workspaceConnectPage(
  /* 已经打开连接表单的同一个页面实例，不执行导航或刷新。 */ page: Page,
  /* 连接表单使用的实际 Web/服务 origin。 */ baseUrl: string,
  /* 当前账号的测试令牌，只进入真实密码控件和认证请求。 */ token: string,
): Promise<void> {
  // 错误恢复和换账号都复用原页面，避免重载掩盖 Vue 内存状态残留。
  const tokenEntry = page.getByText('使用访问令牌', { exact: true })
  await expect(tokenEntry).toBeVisible()
  if (!await page.getByLabel('用户访问令牌', { exact: true }).isVisible()) await tokenEntry.click()
  await page.getByLabel('服务地址', { exact: true }).fill(baseUrl)
  await page.getByLabel('用户访问令牌', { exact: true }).fill(token)
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
}

export async function workspaceOpenMap(
  /* 已登录真实工作台的页面。 */ page: Page,
  /* 当前账号有权访问的数据图名称，用于公开导航定位。 */ mapName: string,
): Promise<void> {
  // 从实际侧栏打开图，完成条件为中心工具栏显示同一名称。
  await page.getByRole('navigation', { name: '当前工作区的数据图' }).getByText(mapName, { exact: true }).click()
  await expect(page.locator('.view-label strong')).toHaveText(mapName)
}
