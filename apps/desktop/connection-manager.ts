// 协调桌面本地与远程连接的选择、模式持久化和关闭。
import { RuntimeMessage } from '../../contracts/messages'
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { clientCreateGateway, type ClientConnectionStore } from '../../client/graph-client'
import type { ClientGateway, ClientConnectInput } from '../../contracts/client'
import type { ClientService } from './local-service-process'

export function clientCreateDesktop(/* 桌面装配依赖：模式文件目录、远程凭据存储和本地服务控制器，均由调用方提供。 */ input: { directory: string; remoteStore: ClientConnectionStore; service: ClientService }) {
  // 为桌面统一提供本地/远程网关，持久化所选模式，并串行处理连接切换以避免身份交叉覆盖。
  const remote = clientCreateGateway({ baseUrl: 'http://127.0.0.1:4320', store: input.remoteStore })
  const local = clientCreateGateway({ baseUrl: 'http://127.0.0.1:4320' })
  const modeFile = path.join(input.directory, 'client-mode.json')
  // 本实例拥有模式和切换队列；本地网关不接凭据存储，因此切换本地模式不会覆盖已保存的远程凭据。
  let mode: 'local' | 'remote' | null = null, closed = false, tail = Promise.resolve()
  const initialized = (async () => {
    // 恢复上次选择的模式；首次使用允许文件不存在，其他读取或内容错误留给后续操作报告。
    try {
      const value = JSON.parse(await readFile(modeFile, 'utf8'))
      if (value.mode !== 'local' && value.mode !== 'remote') throw new Error(RuntimeMessage.INVALID_DESKTOP_MODE)
      mode = value.mode
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  })()
  void initialized.catch(() => {
    // 立即观察初始化拒绝，避免尚无请求时出现未处理拒绝；原 Promise 仍向后续操作传播错误。
  })
  function clientReadGateway() {
    // 按当前模式选择请求目标，尚未选择模式时使用远程网关。
    return mode === 'local' ? local : remote
  }
  function clientRunConnection<T>(/* 等待初始化及前序切换完成后才执行的连接变更，结果返回原调用方。 */ operation: () => Promise<T>): Promise<T> {
    // 将连接变更加入串行队列，待模式恢复后再执行，并拒绝关闭开始后尚未执行的操作。
    const task = tail.then(async () => {
      // 前序操作结束后重新检查关闭状态，防止排队期间退出的桌面重新建立连接。
      await initialized; if (closed) throw new Error(RuntimeMessage.DESKTOP_IS_CLOSING); return operation()
    })
    tail = task.then(() => {
      // 成功后只保留队列完成信号，操作结果由 task 返回给原调用方。
    }, () => {
      // 隔离单次操作失败，保证后续切换仍可执行；原调用方继续收到 task 的拒绝。
    })
    return task
  }
  async function clientWriteMode(/* 即将生效的模式；null 表示断开并删除保存的模式选择。 */ next: 'local' | 'remote' | null) {
    // 先切换内存模式，再替换模式文件；断开时删除文件，使下次启动恢复默认选择。
    mode = next
    if (!next) { await rm(modeFile, { force: true }); return }
    await mkdir(input.directory, { recursive: true })
    const temporary = modeFile + '.' + randomUUID() + '.tmp'
    // 同目录临时文件写完后再重命名，避免下次启动读取到只写入一半的模式 JSON。
    try { await writeFile(temporary, JSON.stringify({ mode: next }), { mode: 0o600 }); await rename(temporary, modeFile) }
    finally { await rm(temporary, { force: true }) }
  }
  async function clientConnectLocal() {
    // 启动本地服务并用其临时凭据连接，连接成功后保存本地模式，令牌不进入远程凭据存储。
    const info = await input.service.start()
    const result = await local.connect({ ...info, remember: false })
    await clientWriteMode('local')
    return result
  }
  const gateway: ClientGateway = {
    getConnection: () => /* 通过切换队列读取连接，必要时恢复上次选中的本地服务。 */ clientRunConnection(async () => {
      // 本地模式在首次读取连接时才拉起服务，再返回选中网关的状态及桌面模式。
      if (mode === 'local' && !(await local.getConnection()).configured) await clientConnectLocal()
      return { ...await clientReadGateway().getConnection(), mode: mode ?? 'remote' }
    }),
    connect: (/* 用户提交的远程地址、令牌和记住意愿，转交远程网关验证。 */ value: ClientConnectInput) => /* 将切换远程连接加入队列，避免与本地连接或断开交错。 */ clientRunConnection(async () => {
      // 先验证并建立远程连接，成功后断开本地网关并保存远程模式。
      const result = await remote.connect(value)
      if (mode === 'local') await local.disconnect()
      await clientWriteMode('remote')
      return result
    }),
    connectLocal: () => /* 将本地服务启动与模式切换作为同一次串行连接操作。 */ clientRunConnection(clientConnectLocal),
    disconnect: () => /* 将当前连接的断开操作排在已有切换之后。 */ clientRunConnection(async () => {
      // 清除当前网关的连接及其保存的凭据，并删除桌面模式选择。
      await clientReadGateway().disconnect(); await clientWriteMode(null)
    }),
    read: async (/* 调用方选择的公开查询方法，随当前模式转发。 */ method, /* 与查询方法匹配的业务参数，本层不修改。 */ params, /* 调用方可选的查询取消信号，直接交给选中的网关。 */ signal) => {
      // 等待模式恢复和当前连接队列结束，再向选中网关发送读取请求。
      await initialized; await tail; return clientReadGateway().read(method, params, signal)
    },
    dispatch: async (/* 调用方持有的稳定业务请求编号，重试相同写入时必须沿用。 */ requestId, /* 待提交的公开写命令名称。 */ method, /* 与写命令匹配的业务参数，本层不修改。 */ params, /* 调用方可选的写入取消信号，取消并不等于服务端回滚。 */ signal) => {
      // 等待当前连接变更完成后发送写命令，沿用调用方的幂等请求编号和取消信号。
      await initialized; await tail; return clientReadGateway().dispatch(requestId, method, params, signal)
    },
    upload: async (/* 上传的稳定幂等编号，不随连接队列等待而重新生成。 */ requestId, /* 包含目标工作区、文件元信息和字节的上传输入，交给当前网关验证。 */ value, /* 调用方可选的上传取消信号。 */ signal) => {
      // 等待当前连接变更完成，将上传交给选中网关并保留请求编号与取消信号。
      await initialized; await tail; return clientReadGateway().upload(requestId, value, signal)
    },
    download: async (/* 包含资源类型和编号的下载目标，不接受任意地址。 */ value, /* 调用方可选的下载取消信号。 */ signal) => {
      // 等待当前连接变更完成，再从选中网关下载资产。
      await initialized; await tail; return clientReadGateway().download(value, signal)
    },
    watch: async (/* 需要订阅实时变化的图编号。 */ mapId, /* 调用方提供的事件观察者，由实际网关逐条通知。 */ onEvent, /* 调用方可选的订阅取消信号，负责结束持续订阅。 */ signal) => {
      // 等待当前连接变更完成，再向选中网关订阅图事件并转交回调和取消信号。
      await initialized; await tail; return clientReadGateway().watch(mapId, onEvent, signal)
    },
  }
  return { gateway,
    async close() {
      // 拒绝后续连接操作，立即关闭两侧网关，再等待本地服务退出及已排队操作结束。
      closed = true; remote.close(); local.close(); await input.service.close(); await tail
    } }
}
