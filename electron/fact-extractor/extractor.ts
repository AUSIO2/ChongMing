import type {
  AIProvider, SplitSubAgent, SplitMainAgent,
  NewsDocument, SplitClaim, NewsContext, VisibleContext,
  SubAgentSplitRecord,
} from './types'
import { NewsModel } from './database'

/**
 * FactExtractor — 事实拆分协调层
 *
 * 职责：
 * 1. 从数据库读取新闻文档
 * 2. 扇出：并发调用多个 SplitSubAgent
 * 3. 汇聚：调用 SplitMainAgent 合并去重
 * 4. 分配 claimId，写回文档
 */
export class FactExtractor {
  private subAgents: SplitSubAgent[]
  private mainAgent: SplitMainAgent
  private provider: AIProvider

  constructor(
    provider: AIProvider,
    subAgents: SplitSubAgent[],
    mainAgent: SplitMainAgent,
  ) {
    this.provider = provider
    this.subAgents = subAgents
    this.mainAgent = mainAgent
  }

  /** 从 NewsContext 中提取 visibleToAI: true 的字段 */
  private extractVisibleContext(context: NewsContext): VisibleContext {
    const visible: VisibleContext = {}
    for (const [key, field] of Object.entries(context)) {
      if (field?.visibleToAI) {
        visible[key] = String(field.value)
      }
    }
    return visible
  }

  /**
   * 对指定新闻执行拆分
   * @param newsId 新闻文档 ID
   * @returns 更新后的文档
   */
  async split(newsId: string): Promise<NewsDocument> {
    const doc = await NewsModel.findById(newsId)
    if (!doc) {
      throw new Error(`News document not found: ${newsId}`)
    }

    const visibleContext = this.extractVisibleContext(
      doc.context as unknown as NewsContext,
    )

    // 1. 扇出：并发调用所有 SubAgent
    const subAgentResults: SubAgentSplitRecord[] = await Promise.all(
      this.subAgents.map(async (agent) => {
        const prompt = agent.buildPrompt(doc.content, visibleContext)
        const rawResponse = await this.provider.complete(prompt)
        const claims = agent.parseResponse(rawResponse)
        return { agentName: agent.name, claims, rawResponse }
      }),
    )

    // 2. 汇聚：MainAgent 合并去重
    const mergePrompt = this.mainAgent.buildPrompt(doc.content, subAgentResults)
    const rawMergeResponse = await this.provider.complete(mergePrompt)
    const mergedClaims = this.mainAgent.parseResponse(rawMergeResponse)

    // 3. 分配 claimId + 写回文档
    const claims: SplitClaim[] = mergedClaims.map((raw, index) => ({
      claimId: String(index + 1),
      content: raw.content,
      category: raw.category,
    }))

    doc.set('claims', claims)
    doc.set('splitMeta', {
      model: this.provider.name,
      subAgentResults,
      rawMergeResponse,
      splitAt: new Date(),
    })
    await doc.save()

    return doc.toObject() as unknown as NewsDocument
  }
}
