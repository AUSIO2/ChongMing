// 管理请求状态：隔离编辑草稿，保留原请求重试，并在作用域释放时取消请求。
import { RuntimeMessage } from '../../../../contracts/messages'
import { getCurrentScope, onScopeDispose, ref, shallowRef, toRaw } from 'vue'
import type { ClientErrorData, ClientGateway, CommandInputMap, CommandOutputMap, QueryInputMap, QueryOutputMap } from '../../../../contracts/client'
import type { GraphSuccess } from '../../../../contracts/graph'
import { clientReadError } from '../../../../client/graph-client'

/** 提交参数只包含普通数据和上传字节，需递归解除 Vue 草稿引用。 */
/**
 * 递归复制普通对象、数组和上传字节，解除 Vue 代理及编辑草稿与提交参数之间的引用。
 *
 * @param value 来自界面或调用者的待提交值，可能带 Vue 代理；递归复制以隔离草稿和字节。
 */
function managementReadPayload<T>(value: T): T {
  if (value instanceof Uint8Array) return value.slice() as T
  if (Array.isArray(value)) return value.map(managementReadPayload) as T
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(toRaw(value)).map((
    [key, item]
  ) =>
    /* 保留对象字段名，并递归复制对应字段值。 */
    [key, managementReadPayload(item)])) as T
  return value
}

/**
 * 持有管理面板请求、错误和重试状态，在作用域释放时取消请求。
 *
 * @param options 管理页提供的网关与认证失效通知；本任务持有请求取消和重试状态。
 */
export function useManagementTask(
  options: { gateway: ClientGateway; onUnauthorized: () => void | Promise<void> }
) {
  const busy = ref(false), canRetry = ref(false)
  const error = shallowRef<ClientErrorData | null>(null)
  const controller = new AbortController()
  let closed = false
  let retryOperation: (() => Promise<unknown>) | null = null

  /**
   * 固定本次操作的参数和请求标识，只在空闲且无待重试操作时接受新操作。
   *
   * @param input 调用者的当前操作输入，提交前复制，原草稿后续修改不影响重试。
   * @param execute 由调用者提供的异步执行步骤，每次尝试获得独立参数副本与同一请求身份。
   * @param accept 可选的成功接纳回调，仅在任务仍有效时调用；支持异步刷新。
   */
  async function run<I, O>(
    input: I,
    execute: (
      input: I,
      requestId: string,
      signal: AbortSignal
    ) => Promise<O>,
    accept?: (
      result: O
    ) => void | Promise<void>
  ): Promise<O | null> {
    if (closed || busy.value || canRetry.value) return null
    const payload = managementReadPayload(input), requestId = crypto.randomUUID()
    const attempt = async (): Promise<O | null> => {
      // 执行原请求的一次尝试，接纳有效结果；认证失效时通知调用者，可恢复失败时保留重试入口。
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
  /**
   * 通过管理操作生命周期提交命令，并在成功后调用结果接纳函数。
   *
   * @param method 公开命令方法名，决定参数及成功响应的类型。
   * @param params 匹配命令协议的界面输入，run 会复制后保存用于重试。
   * @param accept 可选的命令成功接纳回调，不在失败或任务已关闭时调用。
   */
  function command<K extends keyof CommandInputMap>(
    method: K,
    params: CommandInputMap[K],
    accept?: (
      result: GraphSuccess<CommandOutputMap[K]>
    ) => void | Promise<void>
  ) {
    return run(params, (
      payload,
      requestId,
      signal
    ) =>
      /* 将固定的请求标识、复制后的参数和取消信号发送给网关。 */
      options.gateway.dispatch(requestId, method, payload, signal), accept)
  }
  /**
   * 通过管理操作生命周期读取查询结果，并在成功后交给接纳函数。
   *
   * @param method 公开查询方法名，决定查询参数和返回值类型。
   * @param params 界面提供的查询参数，执行前复制以隔离后续变化。
   * @param accept 可选的查询成功接纳回调；任务关闭后不再接纳。
   */
  function read<K extends keyof QueryInputMap>(
    method: K,
    params: QueryInputMap[K],
    accept?: (
      result: QueryOutputMap[K]
    ) => void | Promise<void>
  ) {
    return run(params, (
      payload,
      _requestId,
      signal
    ) => /* 使用复制后的查询参数和取消信号调用网关。 */ options.gateway.read(method, payload, signal), accept)
  }
  async function retry(): Promise<boolean> {
    // 重试保留的原操作，并报告是否获得非空结果。
    return retryOperation ? (await retryOperation()) !== null : false
  }
  function clearError() {
    // 空闲时清除错误提示并丢弃原操作重试入口。
    if (busy.value) return; error.value = null; canRetry.value = false; retryOperation = null
  }
  function dispose() {
    // 关闭管理任务，取消未完成请求并清空忙碌与重试状态。
    closed = true; controller.abort(); busy.value = false; canRetry.value = false; retryOperation = null
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { busy, error, canRetry, run, command, read, retry, clearError, dispose }
}
