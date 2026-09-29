// 定义可注册数据类型、转换流程及一次 Agent 工作所冻结的公共协议。
import type { GraphAgentProfile } from './graph'

// JSON 字段值；定义、实例 payload 与冻结合同都必须可持久化和稳定摘要。
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

// 注册定义的精确身份；version 始终指向一个不可变版本，不表示 latest。
export interface DefinitionRef { id: string; version: number }

// 一份输入数据的身份、内容版本和精确类型，用于冻结执行依赖。
export interface DataInstanceRef { id: string; revision: number; type: DefinitionRef }

// 受限来源正文读取可以使用的资产或 HTTP(S) 定位值。
export type SourceLocatorValue =
  | { kind: 'asset'; assetId: string; mediaType: string }
  | { kind: 'url'; url: string }

// 一次转换允许的结构输入与正式输出数量关系。
export type Cardinality = '1:1' | '1:N' | 'N:1' | 'N:M'

// 首版支持的 JSON Schema draft-07 子集；服务端拒绝这里未声明的关键字。
export interface DataSchema {
  $schema?: 'http://json-schema.org/draft-07/schema#'
  $ref?: string
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
    | Array<'string' | 'number' | 'integer' | 'boolean' | 'null'>
  properties?: Record<string, DataSchema>
  required?: string[]
  additionalProperties?: boolean | DataSchema
  definitions?: Record<string, DataSchema>
  items?: DataSchema
  enum?: JsonValue[]
  const?: JsonValue
  oneOf?: DataSchema[]
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  format?: 'date-time' | 'uri' | 'uuid'
  title?: string
  description?: string
  default?: JsonValue
}

// payload 内真实资产或节点引用的声明，供访问检查、删除和导入导出使用。
export interface DataReferenceDefinition {
  path: string
  target: { kind: 'asset' } | { kind: 'node'; types: DefinitionRef[] }
  when?: { path: string; equals: JsonValue }
}

// 模型可见字段白名单及字典项可见性过滤，不会扩大调用方已有访问权限。
export interface AgentProjectionDefinition {
  include: string[]
  mapEntryFilters: Array<{ path: string; visibleWhen: string }>
}

// 声明式展示提示，客户端可据此选择标题、摘要、字段顺序和标签。
export interface DataPresentationDefinition {
  titlePath?: string
  summaryPath?: string
  fieldOrder?: string[]
  fieldLabels?: Record<string, string>
  enumLabels?: Record<string, Record<string, string>>
}

// 一个不可变数据类型版本，包含内容约束、结构后继许可和模型投影。
export interface DataTypeDefinition extends DefinitionRef {
  title: string
  description?: string
  schema: DataSchema
  successorTypes: DefinitionRef[]
  presentation?: DataPresentationDefinition
  references: DataReferenceDefinition[]
  agentProjection: AgentProjectionDefinition
}

// 端口在一次封闭输入组或正式发布中的允许数量。
export interface DefinitionCount { min: number; max: number }

// 转换的结构输入或只读上下文端口。
export interface TransitionInputPort {
  name: string
  inputType: DefinitionRef
  count: DefinitionCount
}

// 转换的正式输出端口；结构锚点显式区分输入和同批输出端口。
export interface TransitionOutputPort {
  name: string
  outputType: DefinitionRef
  count: DefinitionCount
  successorOf: Array<{ source: 'input' | 'output'; port: string }>
}

// 提示词变量从冻结输入、依赖结果、可选 Agent 或受限来源正文中取值。
export type PromptBinding =
  | { source: 'input' | 'context'; port: string; path?: string; format: 'text' | 'json' | 'text-lines'; required?: boolean }
  | { source: 'stage'; stageId: string; format: 'json' | 'text-lines' }
  | { source: 'agents'; format: 'json' }
  | { source: 'source-text'; port: string; path: string }

// 阶段可以提交新候选、选择依赖候选，或生成受限的后续槽位计划。
export type StageResultMode = 'outputs' | 'selection' | 'plan'

// 一个转换内的 Agent 阶段模板；agentRef 精确绑定发布时存在的 Agent 配置版本。
export interface TransitionStageDefinition {
  id: string
  kind: 'agent'
  agentRef: DefinitionRef
  dependsOn: string[]
  ready: 'all-dependencies'
  resultMode: StageResultMode
  outputPorts: Array<{ port: string; count: DefinitionCount }>
  promptBindings?: Record<string, PromptBinding>
  plan?: { stageIds: string[]; agentRefs: DefinitionRef[]; maxSlots: number }
}

// 一个不可变转换版本，声明端口、数量、有限阶段依赖和审核边界。
export interface TransitionDefinition extends DefinitionRef {
  title: string
  description?: string
  ports: {
    input: TransitionInputPort[]
    context: TransitionInputPort[]
    output: TransitionOutputPort[]
  }
  cardinality: Cardinality
  group: { mode: 'explicit-members'; ready: 'sealed-all-required' }
  execution: { stages: TransitionStageDefinition[]; resultStage: string }
  review: { mode: 'none' | 'required'; at: 'result'; onReject: 'fail' }
  publication?: { includeReferencedCandidates: boolean; candidateStages?: string[] }
}

// 一个原子发布的定义包；依赖只接受精确引用。
export interface DefinitionPackage extends DefinitionRef {
  title: string
  description?: string
  schemaDialect: 'http://json-schema.org/draft-07/schema#'
  dataTypes: DataTypeDefinition[]
  transitions: TransitionDefinition[]
  dependencies: {
    packages: DefinitionRef[]
    agents: DefinitionRef[]
  }
}

// 已发布目录的只读快照，摘要绑定包内容并用于客户端缓存与执行冻结。
export interface DefinitionCatalog {
  revision: number
  packages: Array<{ ref: DefinitionRef; digest: string }>
  index: Array<{ kind: 'dataType' | 'transition'; ref: DefinitionRef; packageRef: DefinitionRef }>
  dataTypes: DataTypeDefinition[]
  transitions: TransitionDefinition[]
}

// Run 启动可使用的完整工作区执行目录；每个引用和 Agent 配置均为精确版本。
export interface ExecutionCatalog {
  definitions: DefinitionCatalog
  agents: ExecutionAgentDefinition[]
  tools: Array<{ name: string; description: string }>
  maxSlots: number
}

// Agent 目录中的精确配置版本；profile 是解析共享默认值后的独立快照。
export interface ExecutionAgentDefinition {
  ref: DefinitionRef
  profile: GraphAgentProfile
}

// 工作可以提交的一个输出端口合同，包含精确类型、数量及完整 schema。
export interface OutputPortContract {
  port: string
  type: DefinitionRef
  count: DefinitionCount
  schema: DataSchema
  references: DataReferenceDefinition[]
  successorOf: Array<{ source: 'input' | 'output'; port: string }>
}

// 某阶段使用的输出工具合同，模式决定允许提交 outputs、selection 或 plan。
export interface OutputContract {
  mode: StageResultMode
  ports: OutputPortContract[]
}

// 一次实际 Agent 工作的冻结阶段；不再从可变 Agent 或工具目录读取配置。
export interface ExecutionStageSpec {
  id: string
  dependsOn: string[]
  agent: ExecutionAgentDefinition
  tools: Array<{ name: string; description: string }>
  promptBindings: Record<string, PromptBinding>
  outputContract: OutputContract
  plan?: { stageIds: string[]; agents: ExecutionAgentDefinition[]; tools: Array<{ name: string; description: string }>; maxSlots: number }
}

// Operation 的不可变执行规格，绑定定义闭包、输入版本、阶段及结果边界。
export interface ExecutionSpec {
  transition: TransitionDefinition
  dataTypes: DataTypeDefinition[]
  inputs: Record<string, DataInstanceRef[]>
  context: Record<string, DataInstanceRef[]>
  stages: ExecutionStageSpec[]
  resultStage: string
  review: TransitionDefinition['review']
  definitionDigests: string[]
  specHash: string
}
