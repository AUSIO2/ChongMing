export { FactExtractor } from './extractor'
export { NewsModel, connectDB, disconnectDB } from './database'
export { loadPrompt, renderPrompt } from './prompt-loader'
export type {
  AIProvider, SplitSubAgent, SplitMainAgent, PromptConfig,
  ContextField, NewsContext, VisibleContext,
  NewsDocument, RawClaim, SplitClaim, SplitMeta, SubAgentSplitRecord,
} from './types'
