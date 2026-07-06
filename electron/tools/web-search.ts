import { tool } from '@langchain/core/tools'
import { appReadTavilyKey } from '../shared/app-settings'

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const DEFAULT_MAX_RESULTS = 5

interface TavilyResult {
  title?: string
  url?: string
  content?: string
}

interface TavilyResponse {
  results?: TavilyResult[]
}

function clampMaxResults(value: number | undefined): number {
  const n = value ?? DEFAULT_MAX_RESULTS
  if (!Number.isFinite(n)) return DEFAULT_MAX_RESULTS
  return Math.min(Math.max(Math.trunc(n), 1), 10)
}

function formatResults(query: string, results: TavilyResult[]): string {
  if (results.length === 0) {
    return `No results found for: ${query}`
  }

  return results
    .map((item, index) => {
      const title = item.title?.trim() || '(no title)'
      const url = item.url?.trim() || ''
      const content = item.content?.trim() || ''
      return `[${index + 1}] ${title}\nURL: ${url}\n${content}`
    })
    .join('\n\n')
}

async function searchWeb(query: string, maxResults: number): Promise<string> {
  const apiKey = appReadTavilyKey()
  if (!apiKey) {
    return 'Error: Tavily API Key 未配置，请在智能体设置或 .env 中配置 TAVILY_API_KEY。'
  }

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
      search_depth: 'basic',
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const detail = body.slice(0, 200)
    return `Error: web search failed (${response.status})${detail ? `: ${detail}` : '.'}`
  }

  const data = (await response.json()) as TavilyResponse
  return formatResults(query, data.results ?? [])
}

/** 互联网搜索 — SubAgent ReAct 用，失败时返回错误字符串而非抛异常。 */
export const webSearchTool = tool(
  async ({ query, maxResults }) => {
    const q = typeof query === 'string' ? query.trim() : ''
    if (!q) {
      return 'Error: query must be a non-empty string.'
    }

    try {
      return await searchWeb(q, clampMaxResults(maxResults))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error: web search failed: ${msg}`
    }
  },
  {
    name: 'web_search',
    description:
      'Search the public web for current information, sources, and evidence. '
      + 'Use when verifying claims, checking sources, or looking up facts that need external corroboration. '
      + 'Pass a focused search query; returns titles, URLs, and snippets.',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query in Chinese or English',
        },
        maxResults: {
          type: 'number',
          description: 'Max results to return (1-10, default 5)',
        },
      },
      required: ['query'],
    },
  },
)
