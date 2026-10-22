// 文件职责：将DeepSeek独立Search API接到DSH现有web_search能力，复用工具层的限额和超时。
import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'chongming-deepseek-search'
export const inject = ['web']
const SearchMessage = Object.freeze({
  KEY_MISSING: 'DeepSeek search requires this work’s DeepSeek API key',
  INVALID_QUERY: 'DeepSeek search requires a non-blank query of at most 128 Unicode characters and a result count from 1 to 50',
  HTTP_STATUS: 'DeepSeek search returned HTTP {0}',
  INVALID_RESPONSE: 'DeepSeek search returned an invalid results list',
  REQUEST_FAILED: 'DeepSeek search request failed',
  ABORTED: 'DeepSeek search aborted',
})

/** 工作环境只为deepseek-official注入DEEPSEEK_API_KEY，不借用其他供应商或服务器凭据。 */
export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: 'chongming-deepseek-search',
    available: () => Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    async search({ query, maxResults = 10 }, signal) {
      const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
      if (!apiKey) throw new WebError(SearchMessage.KEY_MISSING, 'WEB_PROVIDER_CREDENTIAL_MISSING')
      if (typeof query !== 'string' || !query.trim() || [...query].length > 128
        || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
        throw new WebError(SearchMessage.INVALID_QUERY, 'WEB_INVALID_QUERY')
      }
      // 地址同样来自本Work已验证的模型连接，兼容官方根地址与/v1；测试只注入回环端点。
      const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
      const endpoint = (baseUrl.endsWith('/v1') ? baseUrl : baseUrl + '/v1') + '/tools/search'
      try {
        const response = await fetch(endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({ query, count: maxResults, need_content: false }),
        })
        // 错误正文可能回显请求或密钥，不进入工具结果、模型上下文或日志。
        if (!response.ok) {
          await response.body?.cancel()
          throw new WebError(SearchMessage.HTTP_STATUS.replace('{0}', String(response.status)), 'WEB_PROVIDER_ERROR')
        }
        const data = await response.json()
        if (!Array.isArray(data?.results) || data.results.some(item => !item || typeof item.url !== 'string' || !item.url.trim())) {
          throw new WebError(SearchMessage.INVALID_RESPONSE, 'WEB_PROVIDER_ERROR')
        }
        const sources = data.results.map(item => ({
          url: item.url,
          ...(typeof item.title === 'string' && item.title ? { title: item.title } : {}),
          ...(typeof item.summary === 'string' && item.summary ? { snippet: item.summary }
            : typeof item.snippet === 'string' && item.snippet ? { snippet: item.snippet } : {}),
          ...(typeof item.date === 'string' && item.date ? { publishedAt: item.date } : {}),
        }))
        return { sources, truncated: false }
      } catch (error) {
        if (signal?.aborted) throw new WebError(SearchMessage.ABORTED, 'WEB_ABORTED')
        if (error instanceof WebError) throw error
        throw new WebError(SearchMessage.REQUEST_FAILED, 'WEB_PROVIDER_ERROR')
      }
    },
  })
}
