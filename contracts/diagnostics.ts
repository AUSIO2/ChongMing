export type DiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type DiagnosticContext = Partial<Record<
  'requestId' | 'mapId' | 'runId' | 'operationId' | 'workId' | 'phase' | 'route' | 'reason',
  string | number | boolean
>>
export interface DiagnosticEvent {
  name: string
  severity: DiagnosticSeverity
  errorId?: string
  context?: DiagnosticContext
  error?: unknown
}
export interface DiagnosticReporter {
  report(event: DiagnosticEvent): string
  close(): Promise<void>
}
