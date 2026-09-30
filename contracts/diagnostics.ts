// 定义诊断事件、允许的上下文和输出器接口，关联错误而不传递业务负载。
// 诊断事件的严重程度，从调试信息到需终止进程的故障。
export type DiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
// 允许携带的关联标识和阶段信息白名单，值限制为标量。
export type DiagnosticContext = Partial<Record<
  'requestId' | 'mapId' | 'runId' | 'operationId' | 'workId' | 'phase' | 'route' | 'reason',
  string | number | boolean
>>
// 诊断输入，原始 error 仅交输出器处理，不直接作为公开消息。
export interface DiagnosticEvent {
  name: string
  severity: DiagnosticSeverity
  errorId?: string
  context?: DiagnosticContext
  error?: unknown
}
// 输出诊断并返回关联编号的能力，由持有者负责结束输出。
export interface DiagnosticReporter {
  /**
   * 记录诊断并返回可向用户展示的关联编号，由实现负责敏感内容筛除。
   *
   * @param event 组件提交的诊断事件，可含原始错误供实现脱敏处理，但不能原样公开。
   */
  report(event: DiagnosticEvent): string
  // 停止后续输出并等待实现需要完成的清理。
  close(): Promise<void>
}
