export type ChromeMenuId = 'file' | 'database' | 'tools' | 'agents'

export type ChromeMenuAction =
  | 'placeholder'
  | 'file:save'
  | 'file:export-graph'
  | 'file:export-verify'
  | 'file:export-report'
  | 'db:settings'
  | 'db:reconnect'
  | 'db:status'
  | 'tool:dedup-claims'
  | 'tool:batch-subagent-params'
  | 'tool:batch-priority'
  | 'agent:manager'
  | 'agent:create'
  | 'agent:reload'

export interface ChromeMenuItem {
  id: string
  label: string
  action: ChromeMenuAction
  enabled?: boolean
  separator?: boolean
  hint?: string
}

export interface ChromeMenuDef {
  id: ChromeMenuId
  label: string
  items: ChromeMenuItem[]
}
