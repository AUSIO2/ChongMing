// 集中定义桌面主进程与预加载桥接共用的 IPC 通道名称。
export const CLIENT_CHANNELS = {
  connectLocal: 'client:connect-local',
  localState: 'client:local-state',
  localChanged: 'client:local-changed',
  diagnostic: 'client:diagnostic',
  connection: 'client:connection',
  connect: 'client:connect',
  disconnect: 'client:disconnect',
  read: 'client:read',
  dispatch: 'client:dispatch',
  upload: 'client:upload',
  download: 'client:download',
  watch: 'client:watch',
  stream: 'client:stream',
  cancel: 'client:cancel',
} as const
