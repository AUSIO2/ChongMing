import { RuntimeMessage } from '../../../../contracts/messages'
import { getCurrentScope, onScopeDispose, ref, shallowRef, toRaw } from 'vue'
import type { ClientErrorData, ClientGateway, CommandInputMap, CommandOutputMap, QueryInputMap, QueryOutputMap } from '../../../../contracts/client'
import type { GraphSuccess } from '../../../../contracts/graph'
import { clientReadError } from '../../../../client/graph-client'

/** Client inputs contain plain data and upload bytes; recursively detach Vue drafts. */
// 用途：读取载荷，并把结构化结果交给调用方。
function managementReadPayload<T>(value: T): T {
  if (value instanceof Uint8Array) return value.slice() as T
  if (Array.isArray(value)) return value.map(managementReadPayload) as T
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(toRaw(value)).map(([key, item]) => [key, managementReadPayload(item)])) as T
  return value
}

// 用途：处理界面相关工作，并把结果交给调用方。
export function useManagementTask(options: { gateway: ClientGateway; onUnauthorized: () => void | Promise<void> }) {
  const busy = ref(false), canRetry = ref(false)
  const error = shallowRef<ClientErrorData | null>(null)
  const controller = new AbortController()
  let closed = false
  let retryOperation: (() => Promise<unknown>) | null = null

  // 用途：执行当前异步操作。
  async function run<I, O>(input: I, execute: (input: I, requestId: string, signal: AbortSignal) => Promise<O>, accept?: (result: O) => void | Promise<void>): Promise<O | null> {
    if (closed || busy.value || canRetry.value) return null
    const payload = managementReadPayload(input), requestId = crypto.randomUUID()
    const attempt = async (): Promise<O | null> => {
      if (closed || busy.value) return null
      busy.value = true; error.value = null; canRetry.value = false; retryOperation = null
      try {
        const result = await execute(managementReadPayload(payload), requestId, controller.signal)
        if (closed) return null
        await accept?.(result)
        return closed ? null : result
      } catch (cause) {
        if (closed) return null
        const problem = clientReadError(cause)
        error.value = problem.code === 'REVISION_CONFLICT'
          ? { ...problem, message: RuntimeMessage.SERVER_VERSION_CHANGED_DRAFT_RETAINED }
          : problem
        if (problem.status === 401 || problem.code === 'UNAUTHORIZED') await options.onUnauthorized()
        else if (problem.retryable) { canRetry.value = true; retryOperation = attempt }
        return null
      } finally { if (!closed) busy.value = false }
    }
    return attempt()
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function command<K extends keyof CommandInputMap>(method: K, params: CommandInputMap[K], accept?: (result: GraphSuccess<CommandOutputMap[K]>) => void | Promise<void>) {
    return run(params, (payload, requestId, signal) => options.gateway.dispatch(requestId, method, payload, signal), accept)
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function read<K extends keyof QueryInputMap>(method: K, params: QueryInputMap[K], accept?: (result: QueryOutputMap[K]) => void | Promise<void>) {
    return run(params, (payload, _requestId, signal) => options.gateway.read(method, payload, signal), accept)
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function retry(): Promise<boolean> { return retryOperation ? (await retryOperation()) !== null : false }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function clearError() { if (busy.value) return; error.value = null; canRetry.value = false; retryOperation = null }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function dispose() { closed = true; controller.abort(); busy.value = false; canRetry.value = false; retryOperation = null }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { busy, error, canRetry, run, command, read, retry, clearError, dispose }
}
