// 定义 DSH 运行时配置、执行输入、事件与可等待的启动关闭接口。
// DSH 事件可携带的递归 JSON 值。
export type DshJson =
  | null
  | boolean
  | number
  | string
  | DshJson[]
  | { [key: string]: DshJson }

// 运行时进程、工作目录、模型及补丁配置，由调用入口提供。
export interface DshRuntimeConfig {
  dshBin?: string
  dshHome: string
  cwd: string
  processCwd: string
  profile?: string
  patches?: string[]
  provider: string
  model: string
  maxTokens?: number
  env?: Record<string, string | undefined>
}

// 一轮模型提示词及可选已有会话编号。
export interface DshRunInput {
  prompt: string
  sessionId?: string
}

// DSH 方法名及对应的 JSON 参数负载。
export interface DshEvent {
  method: string
  params: Record<string, DshJson>
}

// 一轮执行的会话编号、最终文本和收集到的事件。
export interface DshRunResult {
  sessionId: string
  finalResponse: string
  events: DshEvent[]
}

// 调用方持有的 DSH 生命周期能力，创建实例后显式启动并负责关闭。
export interface DshRuntimeAPI {
  // 启动运行时并完成可执行准备；关闭后的实例不能重新启动。
  start(): Promise<void>
  /**
   * 执行一轮会话并可观察执行事件，返回会话编号、最终响应及累计事件。
   *
   * @param input 一轮提示词及可选会话编号；省略会话编号时由运行时建立会话。
   * @param onEvent 可选事件观察者，不负责运行时资源释放。
   */
  run(input: DshRunInput, onEvent?: (event: DshEvent) => void): Promise<DshRunResult>
  // 停止运行时及其资源，调用方可等待清理结束。
  close(): Promise<void>
}
