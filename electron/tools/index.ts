import type { StructuredToolInterface } from '@langchain/core/tools'
import { AppError, ErrorCode } from '../shared/errors'
import { webSearchTool } from './web-search'

export { webSearchTool }

/** 工具名 → 实例（配置文件 tools 字段引用此处的 key） */
export const TOOL_REGISTRY: Record<string, StructuredToolInterface> = {
  web_search: webSearchTool,
}

/** 将配置中的工具名解析为 LangChain tool 实例；空列表返回 undefined */
export function resolveTools(
  names?: string[],
): StructuredToolInterface[] | undefined {
  if (!names?.length) return undefined

  return names.map((name) => {
    const tool = TOOL_REGISTRY[name]
    if (!tool) {
      throw new AppError(
        ErrorCode.CONFIG_UNKNOWN_TOOL,
        `Unknown tool "${name}". Registered: ${Object.keys(TOOL_REGISTRY).join(', ')}`,
      )
    }
    return tool
  })
}
