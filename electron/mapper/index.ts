import { langGraphAgentLoop } from '../agent-loop/langgraph'
import { createMapper } from './service'

export const mapperService = createMapper(langGraphAgentLoop)

export type {
  MapperAPI,
  MapperCommand,
  MapperQuery,
  MapperSnapshot,
} from './types'
