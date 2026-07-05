import type { GraphSplitRecord } from '../fact-extractor/types'

export interface ParseGraphConfig {
  defaultModel: import('@langchain/core/language_models/chat_models').BaseChatModel
  extractPromptPath: string
}

export interface ParseSourceParams {
  uri: string
  kind: 'file' | 'url'
  label?: string
}

export type ParseWorkerRecord = GraphSplitRecord
