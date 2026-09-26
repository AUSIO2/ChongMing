export interface LocalServiceState {
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
  message?: string
  errorId?: string
}
