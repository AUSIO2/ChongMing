// 渲染进程网关：选择 HTTP 或桌面桥接，管理 IPC 取消与订阅顺序。
import { clientCreateGateway } from '../../../client/graph-client'
import { ClientError, type ClientBridge, type ClientBridgeResult, type ClientGateway } from '../../../contracts/client'
import { RuntimeMessage } from '../../../contracts/messages'

/**
 * 验证桌面桥接响应结构，返回成功值或抛出结构化客户端错误。
 *
 * @param result 跨桌面桥接返回的结果包装，运行时先核对成功标记再解包或抛错。
 */
function apiReadResult<T>(result: ClientBridgeResult<T>): T {
  if (!result || typeof result.ok !== 'boolean') throw new ClientError({ code: 'INVALID_BRIDGE_RESPONSE', message: RuntimeMessage.DESKTOP_BRIDGE_RETURNED_NO_RESULT, status: 0, retryable: false })
  if (!result.ok) throw new ClientError(result.error)
  return result.value
}
function apiCreateAbortError(): ClientError {
  // 为尚未开始或已被中断的桥接请求建立统一取消错误。
  return new ClientError({ code: 'REQUEST_ABORTED', message: RuntimeMessage.REQUEST_WAS_CANCELLED, status: 0, retryable: false })
}
/**
 * 按运行环境选择桌面 IPC 或 HTTP 网关，桌面桥接缺失时明确报告连接不可用。
 *
 * @param input 可选网关装配项，默认空对象；优先显式 bridge，否则探测桌面桥接或推导 HTTP 地址。
 */
export function apiCreateGateway(
  input: { bridge?: ClientBridge; baseUrl?: string } = {}
): ClientGateway {
  const bridge = input.bridge ?? (typeof window === 'undefined' ? undefined : window.chongmingClient)
  if (!bridge) {
    if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
      const apiRejectRequest = async (): Promise<never> => {
        // 桌面预加载桥接缺失时拒绝调用，避免从文件页面误走 HTTP。
        throw new ClientError({ code: 'DESKTOP_BRIDGE_UNAVAILABLE', message: RuntimeMessage.DESKTOP_CLIENT_BRIDGE_IS_UNAVAILABLE, status: 0, retryable: false })
      }
      return { watch: apiRejectRequest, getConnection: apiRejectRequest, connect: apiRejectRequest, disconnect: apiRejectRequest, read: apiRejectRequest, dispatch: apiRejectRequest, upload: apiRejectRequest, download: apiRejectRequest }
    }
    return clientCreateGateway({ baseUrl: input.baseUrl ?? (typeof window === 'undefined' ? 'http://127.0.0.1:4320' : window.location.origin) })
  }
  /**
   * 为桥接调用分配标识，将取消信号与请求竞争，并在结束后移除取消监听。
   *
   * @param operation 实际桥接调用步骤，由本函数分配调用身份并处理取消。
   * @param signal 可选的调用者取消信号；省略时不提供外部中断入口。
   */
  const apiRunCall = async <T>(
    operation: (
      callId: string
    ) => Promise<ClientBridgeResult<T>>,
    signal?: AbortSignal
  ): Promise<T> => {
    if (signal?.aborted) throw apiCreateAbortError()
    const callId = crypto.randomUUID()
    let started = false
    /**
     * @param reason 统一取消错误，交给本地 Promise 的拒绝入口。
     */
    let rejectAbort: (reason: ClientError) => void = () => {
      // 初始化取消拒绝入口，在 Promise 安装真实拒绝函数前不执行操作。
    }
    const aborted = new Promise<never>((
      _resolve,
      reject
    ) => {
      // 保存取消 Promise 的拒绝函数，供信号触发时立即结束等待。
      rejectAbort = reject
    })
    const abort = () => {
      // 取消已启动的 IPC 调用，并拒绝本地等待 Promise。
      if (started) bridge.cancel(callId)
      rejectAbort(apiCreateAbortError())
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          // 再次检查取消状态后启动桥接调用，并解包其结果。
          if (signal?.aborted) throw apiCreateAbortError()
          started = true
          return apiReadResult(await operation(callId))
        }),
        aborted,
      ])
    } finally { signal?.removeEventListener('abort', abort) }
  }
  return {
    async connectLocal() {
      // 通过桌面桥接连接本机服务并解包启动信息。
      return apiReadResult(await bridge.connectLocal())
    },
    /**
     * 通过桥接订阅图事件，核对 watchId 和连续序号，退出时取消调用并释放消息监听。
     *
     * @param mapId 要订阅的真实图身份，交由主进程校验与读取。
     * @param onEvent 调用者的事件接纳回调；同步抛错会终止本次订阅。
     * @param signal 可选的视图取消信号，用于关闭 IPC 调用和事件监听。
     */
    async watch(
      mapId,
      onEvent,
      signal
    ) {
      if (signal?.aborted) throw apiCreateAbortError()
      let dispose = () => {
        // 在桥接监听尚未建立时提供空清理函数。
      }, closed = false
      const lifetime = new AbortController()
      const abort = () => /* 将调用者取消传递到订阅自身生命周期。 */ lifetime.abort()
      signal?.addEventListener('abort', abort, { once: true })
      /**
       * @param error 事件序号校验或调用者处理产生的异常，用于拒绝订阅等待。
       */
      let rejectStream!: (error: unknown) => void
      const failed = new Promise<never>((
        _resolve,
        reject
      ) => {
        // 保存事件处理失败的拒绝入口，用于中断订阅等待。
        rejectStream = reject
      })
      try {
        await Promise.race([apiRunCall(watchId => {
          // 先注册带序号检查的事件监听，再启动对应 watchId 的订阅。
          let sequence = 0
          dispose = bridge.onStream(message => {
            // 只接纳当前订阅的连续消息，回调或序号出错时关闭订阅并拒绝等待。
            if (closed || message.watchId !== watchId) return
            try {
              if (message.sequence !== sequence + 1) throw new ClientError({ code: 'STREAM_SEQUENCE', message: RuntimeMessage.REAL_TIME_UPDATES_ARRIVED_OUT_OF_SEQUENCE, status: 0, retryable: true })
              sequence = message.sequence
              onEvent(message.event)
            } catch (error) { closed = true; rejectStream(error); lifetime.abort() }
          })
          return bridge.watch(watchId, mapId)
        }, lifetime.signal), failed])
      } finally { closed = true; dispose(); lifetime.abort(); signal?.removeEventListener('abort', abort) }
    },
    async getConnection() {
      // 通过桌面桥接取得当前连接信息。
      return apiReadResult(await bridge.getConnection())
    },
    /**
     * 把远程连接参数交给桌面桥接并解包登录结果。
     *
     * @param input 用户的服务地址、令牌及记住登录选项，通过桥接发送给主进程。
     */
    async connect(input) {
      return apiReadResult(await bridge.connect(input))
    },
    async disconnect() {
      // 让桌面桥接退出登录，失败时抛出对应客户端错误。
      apiReadResult(await bridge.disconnect())
    },
    /**
     * 在可取消调用生命周期内发送查询。
     *
     * @param method 公开查询方法名，由 ClientGateway 上下文类型限定。
     * @param params 与查询方法对应的参数，按原协议送往桥接。
     * @param signal 可选取消信号，映射为本次 IPC 的取消动作。
     */
    read(
      method,
      params,
      signal
    ) {
      return apiRunCall(callId => /* 将本次 callId 和查询参数发送给桌面桥接。 */ bridge.read(callId, method, params), signal)
    },
    /**
     * 在可取消调用生命周期内发送带稳定请求标识的命令。
     *
     * @param requestId 稳定的业务命令身份，重试复用；不同于每次 IPC 的 callId。
     * @param method 公开命令方法名，决定业务参数和响应类型。
     * @param params 匹配命令方法的提交参数，交给主进程执行协议校验。
     * @param signal 可选取消信号，用于中断本次命令调用等待。
     */
    dispatch(
      requestId,
      method,
      params,
      signal
    ) {
      return apiRunCall(callId => /* 将 IPC 调用标识与业务请求标识一起发送给桌面桥接。 */ bridge.dispatch(callId, requestId, method, params), signal)
    },
    /**
     * 在可取消调用生命周期内上传资产字节。
     *
     * @param requestId 上传的稳定幂等身份，重试保持不变。
     * @param input 待上传的工作区身份、文件元信息和字节，通过桥接传递。
     * @param signal 可选取消信号，用于终止本次上传调用。
     */
    upload(
      requestId,
      input,
      signal
    ) {
      return apiRunCall(callId => /* 将上传参数及两类请求标识发送给桌面桥接。 */ bridge.upload(callId, requestId, input), signal)
    },
    /**
     * 在可取消调用生命周期内下载资产或导出包。
     *
     * @param input 下载对象的类型与业务身份，不接收任意下载 URL。
     * @param signal 可选取消信号，用于终止本次下载调用。
     */
    download(input, signal) {
      return apiRunCall(callId => /* 将下载参数和本次调用标识发送给桌面桥接。 */ bridge.download(callId, input), signal)
    },
  }
}

/** 构造网关时不发起业务请求；Node 环境也不依赖浏览器全局对象。 */
export const api = apiCreateGateway()
