// 业务错误携带 HTTP 状态、稳定错误码及可选当前版本，供传输层统一映射。
export class GraphError extends Error {
  constructor(
    /* 映射到 HTTP 响应的状态码。 */ readonly status: number,
    /* 供客户端分支处理的稳定业务错误码。 */ readonly code: string,
    /* 可公开返回给调用方的错误说明。 */ message: string,
    /* 发生版本冲突时服务端观察到的最新版本。 */ readonly currentRevision?: number,
  ) {
    // 保存可公开的状态、错误码和冲突版本，并将错误名称固定为 GraphError。
    super(message)
    this.name = 'GraphError'
  }
}
