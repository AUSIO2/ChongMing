import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PromptConfig } from './types'

/** prompts 目录根路径 */
const PROMPTS_ROOT = path.join(process.env.APP_ROOT ?? '.', 'prompts')

/**
 * 加载提示词配置文件
 * @param promptPath 相对路径（不含 .json），如 "fact-extractor/sub-agents/data-claims"
 *                   对应文件 prompts/fact-extractor/sub-agents/data-claims.json
 */
export function loadPrompt(promptPath: string): PromptConfig {
  const fullPath = path.join(PROMPTS_ROOT, `${promptPath}.json`)
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
