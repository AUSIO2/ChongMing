// 定义冻结执行规格中已解析的 Agent 内容、工具与模型配置。

// 已解析供执行使用的 Agent 内容、工具和模型设置。
export interface GraphAgentProfile {
  id: string
  name: string
  description: string
  content: string
  tools: string[]
  provider: string
  model: string
  // Run启动时解析的非秘密调用地址；API Key不属于Agent或执行规格。
  baseUrl?: string
  promptVars?: string[]
  defaultPriority?: 'high' | 'medium' | 'low'
  claimCategory?: 'data' | 'quote' | 'causal' | null
}
