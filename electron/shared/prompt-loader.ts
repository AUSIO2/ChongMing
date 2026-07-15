import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentDoc, PromptConfig } from './types'

let configuredRoot: string | null = null
/** 工作区 Agent 内容覆盖（运行时优先于磁盘） */
let promptOverlay = new Map<string, PromptConfig>()

/**
 * 解析 subagentconfig 根目录
 * 优先级：promptUpdateConfigRoot > SUBAGENT_CONFIG_ROOT > APP_ROOT/subagentconfig > 相对模块路径
 */
export function promptReadConfigRoot(): string {
  if (configuredRoot) return configuredRoot
  if (process.env.SUBAGENT_CONFIG_ROOT) return process.env.SUBAGENT_CONFIG_ROOT
  if (process.env.APP_ROOT) return path.join(process.env.APP_ROOT, 'subagentconfig')

  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  return path.join(moduleDir, '../../subagentconfig')
}

/** 显式设置 subagentconfig 根目录（CLI / 测试 / Electron 启动时调用） */
export function promptUpdateConfigRoot(root: string): void {
  configuredRoot = root
}

/** 用工作区 Agent 列表覆盖 promptRead；传 null/空则清空 */
export function promptUpdateOverlay(agents: AgentDoc[] | null | undefined): void {
  promptOverlay.clear()
  if (!agents?.length) return
  for (const agent of agents) {
    promptOverlay.set(agent.promptPath, {
      description: agent.description,
      content: agent.content,
      promptVars: agent.promptVars,
      claimCategory: agent.claimCategory,
      model: agent.model,
      baseUrl: agent.baseUrl,
    })
  }
}

/**
 * 加载提示词配置
 * 优先工作区 overlay，否则读磁盘 subagentconfig。
 * @param promptPath 相对路径（不含 .json），如 "fact-extractor/sub-agents/data-claims"
 */
export function promptRead(promptPath: string): PromptConfig {
  const overlay = promptOverlay.get(promptPath)
  if (overlay) return overlay
  const fullPath = path.join(promptReadConfigRoot(), `${promptPath}.json`)
  const raw = readFileSync(fullPath, 'utf-8')
  return JSON.parse(raw) as PromptConfig
}

/**
 * 模板变量替换
 * 将 {{varName}} 替换为 vars 中对应的值
 */
export function promptFormat(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}
