// 在隔离预加载环境中向渲染器暴露固定 IPC 能力，隐藏 Electron 原始接口。
import { contextBridge, ipcRenderer } from 'electron'
import { CLIENT_CHANNELS } from './ipc-channels'
import type { ClientBridge } from '../../contracts/client'

const bridge: ClientBridge = {
  connectLocal: () => /* 请求主进程建立本地服务连接。 */  ipcRenderer.invoke(CLIENT_CHANNELS.connectLocal),
  localState: () => /* 请求主进程返回本地服务状态。 */  ipcRenderer.invoke(CLIENT_CHANNELS.localState),
  onLocalState: /* 页面提供的本地状态观察者，调用方持有返回的退订函数。 */ listener => {
    // 注册本地状态消息监听，并返回解除该监听的函数。
    const receive = (/* Electron IPC 元信息，不把该对象暴露给页面。 */ _event: Electron.IpcRendererEvent, /* 主进程发布的服务状态负载，原样交给页面观察者。 */ state: Parameters<typeof listener>[0]) => /* 剥离 Electron 事件对象，仅把服务状态交给页面回调。 */  listener(state)
    ipcRenderer.on(CLIENT_CHANNELS.localChanged, receive)
    return () => {
      // 移除当前调用注册的本地状态监听。
       ipcRenderer.removeListener(CLIENT_CHANNELS.localChanged, receive) }
  },
  reportError: /* 页面提供的诊断编号和固定来源标签，由主进程再次验证。 */ input => {
    // 向主进程发送渲染器诊断编号与来源。
     ipcRenderer.send(CLIENT_CHANNELS.diagnostic, input) },
  watch: (/* 页面分配的订阅生命周期编号，用于隔离消息及取消。 */ watchId, /* 待订阅的图编号，由主进程校验后发起订阅。 */ mapId) => /* 携带订阅编号和图编号向主进程发起持续订阅。 */  ipcRenderer.invoke(CLIENT_CHANNELS.watch, watchId, mapId),
  onStream: /* 页面提供的流消息观察者，收到消息后自行按 watchId 隔离。 */ listener => {
    // 注册图事件流监听，并返回解除该监听的函数。
    const receive = (/* Electron IPC 元信息，仅预加载层可见，不向页面转交。 */ _event: Electron.IpcRendererEvent, /* 主进程发出的带订阅编号和序号的图事件消息。 */ message: Parameters<Parameters<ClientBridge['onStream']>[0]>[0]) => /* 剥离 Electron 事件对象，仅把带序号的流消息交给页面。 */  listener(message)
    ipcRenderer.on(CLIENT_CHANNELS.stream, receive)
    return () => {
      // 移除当前调用注册的图事件监听。
       ipcRenderer.removeListener(CLIENT_CHANNELS.stream, receive) }
  },
  getConnection: () => /* 请求主进程返回连接配置状态。 */  ipcRenderer.invoke(CLIENT_CHANNELS.connection),
  connect: /* 页面提交的连接地址、令牌和记住意愿，交给主进程验证。 */ input => /* 将连接输入交给主进程校验和执行。 */  ipcRenderer.invoke(CLIENT_CHANNELS.connect, input),
  disconnect: () => /* 请求主进程断开当前连接。 */  ipcRenderer.invoke(CLIENT_CHANNELS.disconnect),
  read: (/* 此次查询的取消关联编号，由渲染器适配器生成。 */ callId, /* 待调用的公开查询名，由主进程限制白名单。 */ method, /* 与查询方法对应的对象参数，主进程再次检查。 */ params) => /* 转发带调用编号的查询，供主进程登记取消状态。 */  ipcRenderer.invoke(CLIENT_CHANNELS.read, callId, method, params),
  dispatch: (/* 此次 IPC 写调用的取消关联编号。 */ callId, /* 业务写入的稳定幂等编号，重试时与原内容一同保留。 */ requestId, /* 待提交的公共写命令名。 */ method, /* 写命令对应的业务参数，不在预加载层执行或修改。 */ params) => /* 转发调用编号、幂等请求编号和写命令。 */  ipcRenderer.invoke(CLIENT_CHANNELS.dispatch, callId, requestId, method, params),
  upload: (/* 此次上传的生命周期编号，用于取消。 */ callId, /* 文件上传的稳定幂等编号，用于服务端收据判重。 */ requestId, /* 文件字节、工作区和元信息，传给主进程校验和上传。 */ input) => /* 把文件及两个请求编号交给主进程上传。 */  ipcRenderer.invoke(CLIENT_CHANNELS.upload, callId, requestId, input),
  download: (/* 此次下载的生命周期编号，用于取消。 */ callId, /* 指定资源类型和编号的下载目标。 */ input) => /* 把下载目标和调用编号交给主进程执行。 */  ipcRenderer.invoke(CLIENT_CHANNELS.download, callId, input),
  cancel: /* 需要取消的本次调用编号，不包含 AbortSignal 对象。 */ callId => {
    // 按调用编号向主进程发送取消消息。
     ipcRenderer.send(CLIENT_CHANNELS.cancel, callId) },
}
contextBridge.exposeInMainWorld('chongmingClient', bridge)
