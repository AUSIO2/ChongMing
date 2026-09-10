export class GraphError extends Error {
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
