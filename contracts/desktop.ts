// 定义不含连接凭据的本地服务状态，供桌面主进程向界面发布。
// 本地服务对外状态；故障可附公开文案和诊断编号，连接令牌单独返回。
export interface LocalServiceState {
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
  message?: string
  errorId?: string
}
