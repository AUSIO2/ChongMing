import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PromptConfig } from './types'

let configuredPromptsRoot: string | null = null

/**
 * 解析 prompts 根目录
 * 优先级：setPromptsRoot > PROMPTS_ROOT > APP_ROOT/prompts > 相对模块路径
 */
export function resolvePromptsRoot(): string {
  if (configuredPromptsRoot) return configuredPromptsRoot
  if (process.env.PROMPTS_ROOT) return process.env.PROMPTS_ROOT
  if (process.env.APP_ROOT) return path.join(process.env.APP_ROOT, 'prompts')

  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  return path.join(moduleDir, '../../prompts')
}

/** 显式设置 prompts 根目录（CLI / 测试 / Electron 启动时调用） */
export function setPromptsRoot(root: string): void {
  configuredPromptsRoot = root
}

/**
 * 加载提示词配置文件
 * @param promptPath 相对路径（不含 .json），如 "fact-extractor/sub-agents/data-claims"
 *                   对应文件 prompts/fact-extractor/sub-agents/data-claims.json
 */
export function loadPrompt(promptPath: string): PromptConfig {
  const fullPath = path.join(resolvePromptsRoot(), `${promptPath}.json`)
  const raw = readFileSync(fullPath, 'utf-8')
  return JSON.parse(raw) as PromptConfig
}

/**
 * 模板变量替换
 * 将 {{varName}} 替换为 vars 中对应的值
 */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}
