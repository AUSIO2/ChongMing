import type { ChromeMenuDef } from './types'

export const CHROME_MENUS: ChromeMenuDef[] = [
  {
    id: 'file',
    label: '文件',
    items: [
      { id: 'file-save', label: '保存', action: 'file:save', hint: '写入 MongoDB' },
      { id: 'file-sep-1', label: '', action: 'placeholder', separator: true },
      { id: 'file-export-graph', label: '导出图文件…', action: 'file:export-graph' },
    ],
  },
  {
    id: 'database',
    label: '数据库',
    items: [
      { id: 'db-settings', label: '连接设置…', action: 'db:settings' },
      { id: 'db-reconnect', label: '重新连接', action: 'db:reconnect' },
      { id: 'db-sep-1', label: '', action: 'placeholder', separator: true },
      { id: 'db-status', label: '当前连接', action: 'db:status' },
    ],
  },
  {
    id: 'tools',
    label: '工具',
    items: [
      { id: 'tool-dedup', label: 'Claim 去重…', action: 'tool:dedup-claims' },
      { id: 'tool-batch-params', label: '批量改 SubAgent 参数…', action: 'tool:batch-subagent-params' },
      { id: 'tool-batch-priority', label: '批量改优先级…', action: 'tool:batch-priority' },
    ],
  },
  {
    id: 'agents',
    label: '智能体',
    items: [
      { id: 'agent-manager', label: '管理智能体…', action: 'agent:manager' },
      { id: 'agent-create', label: '新建智能体…', action: 'agent:create' },
      { id: 'agent-sep-1', label: '', action: 'placeholder', separator: true },
      { id: 'agent-reload', label: '重新加载目录', action: 'agent:reload' },
    ],
  },
]

export function chromeReadMenu(id: ChromeMenuDef['id']): ChromeMenuDef | undefined {
  return CHROME_MENUS.find(m => m.id === id)
}

export function chromeReadItemIds(): string[] {
  return CHROME_MENUS.flatMap(m => m.items.filter(i => !i.separator).map(i => i.id))
}
