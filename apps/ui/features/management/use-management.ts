// 管理请求状态：隔离编辑草稿，保留原请求重试，并在作用域释放时取消请求。
import { RuntimeMessage } from '../../../../contracts/messages'
import { getCurrentScope, onScopeDispose, ref, shallowRef, toRaw } from 'vue'
import type { ClientErrorData, ClientGateway, CommandInputMap, CommandOutputMap, QueryInputMap, QueryOutputMap } from '../../../../contracts/client'
import type { GraphSuccess } from '../../../../contracts/graph'
import { clientReadError } from '../../../../client/graph-client'

/** 提交参数只包含普通数据和上传字节，需递归解除 Vue 草稿引用。 */
function managementReadPayload<T>(/* 来自界面或调用者的待提交值，可能带 Vue 代理；递归复制以隔离草稿和字节。 */ value: T): T {
  // 递归复制普通对象、数组和上传字节，解除 Vue 代理及编辑草稿与提交参数之间的引用。
  if (value instanceof Uint8Array) return value.slice() as T
  if (Array.isArray(value)) return value.map(managementReadPayload) as T
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(toRaw(value)).map((
    /* 原对象解构出的字段名及字段值；保留键名并复制对应值。 */ [key, item]
  ) =>
    /* 保留对象字段名，并递归复制对应字段值。 */
    [key, managementReadPayload(item)])) as T
  return value
}

export function useManagementTask(
  /* 管理页提供的网关与认证失效通知；本任务持有请求取消和重试状态。 */ options: { gateway: ClientGateway; onUnauthorized: () => void | Promise<void> }
) {
  // 持有管理面板请求、错误和重试状态，在作用域释放时取消请求。
  const busy = ref(false), canRetry = ref(false)
  const error = shallowRef<ClientErrorData | null>(null)
  const controller = new AbortController()
  let closed = false
  let retryOperation: (() => Promise<unknown>) | null = null

  async function run<I, O>(
    /* 调用者的当前操作输入，提交前复制，原草稿后续修改不影响重试。 */ input: I,
    /* 由调用者提供的异步执行步骤，每次尝试获得独立参数副本与同一请求身份。 */ execute: (
      /* 本次尝试独占的参数副本，允许传输层修改而不污染保留的重试输入。 */ input: I,
      /* 管理任务生成的业务幂等标识，重试复用原值。 */ requestId: string,
      /* 任务作用域的取消信号；组件释放后执行步骤应尽快停止。 */ signal: AbortSignal
    ) => Promise<O>,
    /* 可选的成功接纳回调，仅在任务仍有效时调用；支持异步刷新。 */ accept?: (
      /* 执行步骤成功返回的结果，作为界面接纳回调的输入。 */ result: O
    ) => void | Promise<void>
  ): Promise<O | null> {
    // 固定本次操作的参数和请求标识，只在空闲且无待重试操作时接受新操作。
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
  function command<K extends keyof CommandInputMap>(
    /* 公开命令方法名，决定参数及成功响应的类型。 */ method: K,
    /* 匹配命令协议的界面输入，run 会复制后保存用于重试。 */ params: CommandInputMap[K],
    /* 可选的命令成功接纳回调，不在失败或任务已关闭时调用。 */ accept?: (
      /* 已由网关验证的完整命令响应，含业务数据及重放标记。 */ result: GraphSuccess<CommandOutputMap[K]>
    ) => void | Promise<void>
  ) {
    // 通过管理操作生命周期提交命令，并在成功后调用结果接纳函数。
    return run(params, (
      /* 当前尝试的命令参数副本，原编辑草稿保持独立。 */ payload,
      /* 当前操作固定的幂等身份，供网关提交或重放。 */ requestId,
      /* 管理任务拥有的取消信号，用于终止命令等待。 */ signal
    ) =>
      /* 将固定的请求标识、复制后的参数和取消信号发送给网关。 */
      options.gateway.dispatch(requestId, method, payload, signal), accept)
  }
  function read<K extends keyof QueryInputMap>(
    /* 公开查询方法名，决定查询参数和返回值类型。 */ method: K,
    /* 界面提供的查询参数，执行前复制以隔离后续变化。 */ params: QueryInputMap[K],
    /* 可选的查询成功接纳回调；任务关闭后不再接纳。 */ accept?: (
      /* 由网关验证的查询业务结果。 */ result: QueryOutputMap[K]
    ) => void | Promise<void>
  ) {
    // 通过管理操作生命周期读取查询结果，并在成功后交给接纳函数。
    return run(params, (
      /* 当前尝试独占的查询参数副本。 */ payload,
      /* 通用任务分配的操作身份；查询协议不需要该标识，此处不使用。 */ _requestId,
      /* 管理任务拥有的取消信号，用于终止查询等待。 */ signal
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
