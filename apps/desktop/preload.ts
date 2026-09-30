// 在隔离预加载环境中向渲染器暴露固定 IPC 能力，隐藏 Electron 原始接口。
import { contextBridge, ipcRenderer } from 'electron'
import { CLIENT_CHANNELS } from './ipc-channels'
import type { ClientBridge } from '../../contracts/client'

const bridge: ClientBridge = {
  connectLocal: () => /* 请求主进程建立本地服务连接。 */  ipcRenderer.invoke(CLIENT_CHANNELS.connectLocal),
  localState: () => /* 请求主进程返回本地服务状态。 */  ipcRenderer.invoke(CLIENT_CHANNELS.localState),
  /**
   * 注册本地状态消息监听，并返回解除该监听的函数。
   *
   * @param listener 页面提供的本地状态观察者，调用方持有返回的退订函数。
   */
  onLocalState: listener => {
    /**
     * @param _event Electron IPC 元信息，不把该对象暴露给页面。
     * @param state 主进程发布的服务状态负载，原样交给页面观察者。
     */
    const receive = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => /* 剥离 Electron 事件对象，仅把服务状态交给页面回调。 */  listener(state)
    ipcRenderer.on(CLIENT_CHANNELS.localChanged, receive)
    return () => {
      // 移除当前调用注册的本地状态监听。
       ipcRenderer.removeListener(CLIENT_CHANNELS.localChanged, receive) }
  },
  /**
   * 向主进程发送渲染器诊断编号与来源。
   *
   * @param input 页面提供的诊断编号和固定来源标签，由主进程再次验证。
   */
  reportError: input => {
     ipcRenderer.send(CLIENT_CHANNELS.diagnostic, input) },
  /**
   * @param watchId 页面分配的订阅生命周期编号，用于隔离消息及取消。
   * @param mapId 待订阅的图编号，由主进程校验后发起订阅。
   */
  watch: (watchId, mapId) => /* 携带订阅编号和图编号向主进程发起持续订阅。 */  ipcRenderer.invoke(CLIENT_CHANNELS.watch, watchId, mapId),
  /**
   * 注册图事件流监听，并返回解除该监听的函数。
   *
   * @param listener 页面提供的流消息观察者，收到消息后自行按 watchId 隔离。
   */
  onStream: listener => {
    /**
     * @param _event Electron IPC 元信息，仅预加载层可见，不向页面转交。
     * @param message 主进程发出的带订阅编号和序号的图事件消息。
     */
    const receive = (_event: Electron.IpcRendererEvent, message: Parameters<Parameters<ClientBridge['onStream']>[0]>[0]) => /* 剥离 Electron 事件对象，仅把带序号的流消息交给页面。 */  listener(message)
    ipcRenderer.on(CLIENT_CHANNELS.stream, receive)
    return () => {
      // 移除当前调用注册的图事件监听。
       ipcRenderer.removeListener(CLIENT_CHANNELS.stream, receive) }
  },
  getConnection: () => /* 请求主进程返回连接配置状态。 */  ipcRenderer.invoke(CLIENT_CHANNELS.connection),
  /**
   * @param input 页面提交的连接地址、令牌和记住意愿，交给主进程验证。
   */
  connect: input => /* 将连接输入交给主进程校验和执行。 */  ipcRenderer.invoke(CLIENT_CHANNELS.connect, input),
  disconnect: () => /* 请求主进程断开当前连接。 */  ipcRenderer.invoke(CLIENT_CHANNELS.disconnect),
  /**
   * @param callId 此次查询的取消关联编号，由渲染器适配器生成。
   * @param method 待调用的公开查询名，由主进程限制白名单。
   * @param params 与查询方法对应的对象参数，主进程再次检查。
   */
  read: (callId, method, params) => /* 转发带调用编号的查询，供主进程登记取消状态。 */  ipcRenderer.invoke(CLIENT_CHANNELS.read, callId, method, params),
  /**
   * @param callId 此次 IPC 写调用的取消关联编号。
   * @param requestId 业务写入的稳定幂等编号，重试时与原内容一同保留。
   * @param method 待提交的公共写命令名。
   * @param params 写命令对应的业务参数，不在预加载层执行或修改。
   */
  dispatch: (callId, requestId, method, params) => /* 转发调用编号、幂等请求编号和写命令。 */  ipcRenderer.invoke(CLIENT_CHANNELS.dispatch, callId, requestId, method, params),
  /**
   * @param callId 此次上传的生命周期编号，用于取消。
   * @param requestId 文件上传的稳定幂等编号，用于服务端收据判重。
   * @param input 文件字节、工作区和元信息，传给主进程校验和上传。
   */
  upload: (callId, requestId, input) => /* 把文件及两个请求编号交给主进程上传。 */  ipcRenderer.invoke(CLIENT_CHANNELS.upload, callId, requestId, input),
  /**
   * @param callId 此次下载的生命周期编号，用于取消。
   * @param input 指定资源类型和编号的下载目标。
   */
  download: (callId, input) => /* 把下载目标和调用编号交给主进程执行。 */  ipcRenderer.invoke(CLIENT_CHANNELS.download, callId, input),
  /**
   * 按调用编号向主进程发送取消消息。
   *
   * @param callId 需要取消的本次调用编号，不包含 AbortSignal 对象。
   */
  cancel: callId => {
     ipcRenderer.send(CLIENT_CHANNELS.cancel, callId) },
}
contextBridge.exposeInMainWorld('chongmingClient', bridge)
