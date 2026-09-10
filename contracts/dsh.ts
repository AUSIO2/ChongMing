export type DshJson =
  | null
  | boolean
  | number
  | string
  | DshJson[]
  | { [key: string]: DshJson }

export interface DshRuntimeConfig {
  dshBin: string
  dshHome: string
  cwd: string
  processCwd: string
  profile?: string
  patches?: string[]
  provider: string
  model: string
  maxTokens?: number
}

export interface DshRunInput {
  prompt: string
  sessionId?: string
}

export interface DshEvent {
  method: string
  params: Record<string, DshJson>
}

export interface DshRunResult {
  sessionId: string
  finalResponse: string
  events: DshEvent[]
}

export interface DshRuntimeAPI {
  start(): Promise<void>
  run(input: DshRunInput, onEvent?: (event: DshEvent) => void): Promise<DshRunResult>
  close(): Promise<void>
}
