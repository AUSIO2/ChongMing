// 工作区和Agent拥有模型连接；公开视图不包含可恢复密钥。
export type ModelScope =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'agent'; workspaceId: string; agentId: string }

// null继承工作区；apiKey省略保持、null移除、非空字符串替换。
export interface ModelConnectionInput {
  provider: string | null
  model: string | null
  baseUrl: string | null
  apiKey?: string | null
}

export interface ModelConnectionView {
  scope: ModelScope
  revision: number
  provider: string | null
  model: string | null
  baseUrl: string | null
  apiKeyConfigured: boolean
  effective: {
    provider: string | null
    model: string | null
    baseUrl: string | null
    apiKeyConfigured: boolean
    apiKeySource: 'agent' | 'workspace' | null
  }
}

// 只由持有当前Work proof的可信执行器读取，禁止放入公开图或模型提示词。
export interface ModelWorkConfiguration { provider: string; model: string; baseUrl: string; apiKey: string }

export enum ModelConnectionMessage {
  INVALID_SCOPE = '模型连接只能属于工作区或该工作区的智能体。',
  INVALID_PROVIDER = '模型提供方须为 DeepSeek 或 OpenAI。',
  INVALID_FIELD = '模型连接字段须为非空文本或继承值。',
  INVALID_BASE_URL = '请填写提供方官方 HTTPS API 地址。',
  INVALID_KEY = 'API Key 须为非空文本，移除请使用明确的清除操作。',
  KEY_TARGET_CHANGED = '服务地址或提供方已改变，请重新指定或移除该 API Key。',
  CONFIGURATION_MISSING = '请先在工作区或智能体中配置模型、API 地址及可用的 API Key。',
  SECRETS_UNAVAILABLE = '模型密钥存储暂不可用。',
  FROZEN_TARGET_CHANGED = '本次运行的模型地址已改变，请重新启动运行。',
  REVISION_CONFLICT = '模型连接已被修改，请刷新后重试。',
}
