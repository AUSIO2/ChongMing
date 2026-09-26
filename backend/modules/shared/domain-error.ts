export class GraphError extends Error {
  // 用途：初始化GraphError实例。
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message)
    this.name = 'GraphError'
  }
}
