// ==========================================
// 事实拆分模块 — 类型与接口定义
// ==========================================

/** 上下文字段 — 包装值和 AI 可见性 */
export interface ContextField<T = string> {
  value: T
  visibleToAI: boolean
}

/** 新闻环境上下文 — 每个字段都是 ContextField */
export interface NewsContext {
  [key: string]: ContextField | undefined
}

/** Strategy / SubAgent 解析出的原始条目（未分配 ID） */
export interface RawClaim {
  content: string
  category?: string
}

/** 拆分出的单条可核查事实（嵌入子文档） */
export interface SplitClaim {
  claimId: string
  content: string
  category?: string
}

/** 单个 SubAgent 的拆分记录 */
export interface SubAgentSplitRecord {
  agentName: string
  claims: RawClaim[]
  rawResponse: string
}

/** 拆分过程元数据 */
export interface SplitMeta {
  model: string
  subAgentResults: SubAgentSplitRecord[]
  rawMergeResponse: string
  splitAt: Date
}

/** 顶层文档 — 一条新闻 + 拆分结果 */
export interface NewsDocument {
  _id: string
  content: string
  context: NewsContext
  claims: SplitClaim[]
  splitMeta?: SplitMeta
  createdAt: Date
  updatedAt: Date
}

/** 从 context 中提取 AI 可见字段后的扁平结构 */
export type VisibleContext = Record<string, string>

/** 提示词配置（对应 prompts/ 下的 JSON 文件） */
export interface PromptConfig {
  description: string
  content: string
}

// ==========================================
// 抽象接口
// ==========================================

/** 拆分 SubAgent — 从特定角度拆分文本 */
export interface SplitSubAgent {
  name: string
  promptPath: string
  buildPrompt(content: string, visibleContext: VisibleContext): string
  parseResponse(raw: string): RawClaim[]
}

/** 拆分 MainAgent — 汇总多个 SubAgent 的结果 */
export interface SplitMainAgent {
  promptPath: string
  buildPrompt(content: string, subResults: SubAgentSplitRecord[]): string
  parseResponse(raw: string): RawClaim[]
}

/** AI 调用提供者 */
export interface AIProvider {
  name: string
  complete(prompt: string): Promise<string>
}
