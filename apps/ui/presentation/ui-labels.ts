// 界面标签只转换显示文字，保留协议枚举、用户输入和技术标识原值。
import { RuntimeMessage } from '../../../contracts/messages'
import { EvidenceMessage } from '../../../contracts/evidence-library'

const runStatuses: Record<string, string> = {
  pending: '待处理', running: '处理中', waiting: '等待审核', completed: '已完成',
  failed: '未完成', cancelled: '已取消', skipped: '已跳过',
}
const agentRoles: Record<string, string> = { producer: '生成内容', planner: '规划任务', selector: '选择结果' }
const resultModes: Record<string, string> = { outputs: '生成内容', selection: '选择结果', plan: '执行计划' }
const agentKinds: Record<string, string> = {
  parseExtract: '来源解析', splitRoute: '拆分路由', splitSubAgent: '拆分智能体', splitMerge: '拆分汇总',
  verifyRoute: '核查路由', verifySubAgent: '核查智能体', verifyMerge: '核查汇总',
}
const stages: Record<string, string> = { parse: '解析来源', route: '规划任务', extract: '提取事实', assess: '核查评估', merge: '汇总结果' }
const ports: Record<string, string> = {
  source: '来源', news: '新闻', claim: '事实', claims: '事实', evidence: '证据',
  opinion: '核查意见', opinions: '核查意见', verification: '核查结论',
}

function uiReadKnownLabel(labels: Record<string, string>, value: string): string {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : value
}

export function uiReadRunStatus(status: string): string { return uiReadKnownLabel(runStatuses, status) }
export function uiReadAgentRole(role: string | undefined): string { return role ? uiReadKnownLabel(agentRoles, role) : '未指定' }
export function uiReadResultMode(mode: string): string { return uiReadKnownLabel(resultModes, mode) }
export function uiReadAgentKind(kind: string): string { return uiReadKnownLabel(agentKinds, kind) }
export function uiReadStage(stage: string): string { return uiReadKnownLabel(stages, stage) }
export function uiReadPort(port: string): string { return uiReadKnownLabel(ports, port) }

const errorMessages: Partial<Record<RuntimeMessage | EvidenceMessage, string>> = {
  [RuntimeMessage.PUBLICATION_PREVIEW_CHANGED]: '发布预览已变化，请重新核对后再批准。',
  [RuntimeMessage.RUN_HISTORY_CURSOR_INVALID]: '翻页位置与当前运行目录不匹配，请刷新列表。',
  [RuntimeMessage.RUN_HISTORY_CURSOR_EXPIRED]: '运行目录已变化，请刷新列表后重新查看。',
  [RuntimeMessage.RUN_HISTORY_LIMIT_INVALID]: '每页运行数量须为1至100的整数。',
  [EvidenceMessage.UNAVAILABLE]: '当前服务未提供证据库。',
  [EvidenceMessage.WORKSPACE_MISMATCH]: '请选择当前工作区的固定证据。',
  [EvidenceMessage.NOT_FOUND]: '这条固定证据当前不可用，原引用和理由仍保留。',
  [EvidenceMessage.BASIS_INVALID]: '这份依据不可用或内容摘要不符，请重新核对所选材料。',
  [EvidenceMessage.SOURCE_VERSION_CONFLICT]: '所选节点版本已变化，请重新核对后再收录。',
  [EvidenceMessage.DIGEST_MISMATCH]: '引用的内容摘要与固定证据不一致，请重新核对。',
  [EvidenceMessage.INACTIVE]: '这条证据已撤回或被替代，不能新增引用。',
  [EvidenceMessage.USE_REASON_REQUIRED]: '请填写本次使用这条证据的理由。',
  [EvidenceMessage.SELECTION_LIMIT]: '本次最多引用32条不同的固定证据。',
  [EvidenceMessage.INPUT_LIMIT]: '引用内容或使用理由超过允许大小。',
  [EvidenceMessage.INPUT_INVALID]: '证据引用的字段或内容无效，请重新核对。',
  [RuntimeMessage.A_USER_TOKEN_IS_REQUIRED]: '请填写用户令牌。',
  [RuntimeMessage.A_VALID_USER_TOKEN_IS_REQUIRED]: '用户令牌无效，请重新登录。',
  [RuntimeMessage.ENTER_A_VALID_SERVICE_TOKEN]: '请填写有效的用户令牌。',
  [RuntimeMessage.ENTER_A_VALID_HTTP_S_SERVICE_ADDRESS]: '请填写有效的服务地址。',
  [RuntimeMessage.SERVICE_ADDRESS_MUST_BE_AN_HTTP_S_ORIGIN_WITHOUT_CREDENTIALS_PATH_QUERY]: '服务地址应为 HTTP 或 HTTPS 地址，不包含账号、路径、查询参数或片段。',
  [RuntimeMessage.ENDPOINT_MUST_BE_AN_HTTP_S_URL_WITHOUT_CREDENTIALS]: '服务地址应为 HTTP 或 HTTPS 地址，不包含账号信息。',
  [RuntimeMessage.CONNECT_TO_THE_SERVICE_FIRST]: '请先连接服务。',
  [RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED]: '连接设置已变化，请重新连接。',
  [RuntimeMessage.CONNECTION_WAS_CLOSED]: '连接已关闭，请重新连接。',
  [RuntimeMessage.DESKTOP_CLIENT_BRIDGE_IS_UNAVAILABLE]: '桌面连接暂不可用，请重新打开应用。',
  [RuntimeMessage.DESKTOP_BRIDGE_RETURNED_NO_RESULT]: '桌面服务没有返回结果，请重试。',
  [RuntimeMessage.LOCAL_SERVICE_IS_UNAVAILABLE]: '本机服务暂不可用，请重新启动。',
  [RuntimeMessage.REQUEST_WAS_CANCELLED]: '请求已取消。',
  [RuntimeMessage.REQUEST_TIMED_OUT_RETRY_WITH_THE_SAME_REQUEST_ID]: '请求超时，请重试同一操作。',
  [RuntimeMessage.ENDPOINT_REQUEST_FAILED]: '连接服务失败，请检查地址并重试。',
  [RuntimeMessage.SERVICE_REQUEST_FAILED]: '服务请求失败，请重试。',
  [RuntimeMessage.SERVICE_REQUEST_FAILED_OR_AN_HTTP_REDIRECT_WAS_REFUSED]: '服务请求失败，请检查服务地址并重试。',
  [RuntimeMessage.SERVICE_IS_STOPPING]: '服务正在停止，请稍后重新连接。',
  [RuntimeMessage.REAL_TIME_CONNECTION_ENDED_RECONNECT_FOR_A_FRESH_SNAPSHOT]: '实时连接已结束，请重新连接以更新数据。',
  [RuntimeMessage.REAL_TIME_CONNECTION_FAILED]: '实时连接失败，请重试。',
  [RuntimeMessage.REAL_TIME_CONNECTION_STOPPED_RESPONDING]: '实时连接暂时没有响应，请重试。',
  [RuntimeMessage.ACTIVITY_MESSAGING_IS_RECONNECTING]: '正在重新连接处理进度。',
  [RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT]: '当前工作区权限不足。',
  [RuntimeMessage.HOST_ADMINISTRATOR_PERMISSION_IS_REQUIRED]: '此操作需要主机管理员权限。',
  [RuntimeMessage.BRANCH_VERSION_CHANGED]: '数据分支已变化，请刷新后再保存。',
  [RuntimeMessage.BRANCH_EDIT_LEASE_WAS_LOST]: '分支编辑权已失效，请重新领取。',
  [RuntimeMessage.BRANCH_IS_CURRENTLY_OWNED_BY_ANOTHER_CLIENT]: '另一客户端或运行任务正在使用此分支。',
  [RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP]: '此分支与另一正在使用的分支重叠。',
  [RuntimeMessage.A_VALID_BRANCH_EDIT_LEASE_IS_REQUIRED]: '请先领取分支编辑权。',
  [RuntimeMessage.ACTIVE_RUN_MUST_BE_CANCELLED_BEFORE_DELETING_MAP]: '请先取消此数据图中未结束的运行任务。',
  [RuntimeMessage.RELEASE_ACTIVE_BRANCHES_BEFORE_DELETING_MAP]: '数据图正被占用，请先释放编辑权后重试。',
  [RuntimeMessage.CANCEL_ACTIVE_RUNS_BEFORE_DELETING_THE_WORKSPACE]: '请先取消工作区中未结束的运行任务。',
  [RuntimeMessage.CURRENT_MAP_MUST_BE_OPEN]: '请先打开数据图。',
  [RuntimeMessage.AGENT_LIBRARY_CHANGED]: '智能体目录已变化，请刷新后重试。',
  [RuntimeMessage.AGENT_NOT_FOUND]: '智能体已不存在，请刷新列表。',
  [RuntimeMessage.FIXED_PROFILES_CANNOT_BE_DELETED]: '固定智能体配置需要保留。',
  [RuntimeMessage.A_REFERENCED_ASSET_IS_NOT_AVAILABLE]: '引用的文件资源暂不可用。',
  [RuntimeMessage.ASSET_IS_NOT_AVAILABLE]: '文件资源暂不可用。',
  [RuntimeMessage.ASSET_WAS_DELETED]: '文件资源已删除。',
  [RuntimeMessage.ASSET_IS_REFERENCED_BY_A_MAP]: '文件资源正被数据图引用，请先移除引用。',
  [RuntimeMessage.ASSET_EXCEEDS_64_MIB]: '文件大小超过 64 MiB。',
  [RuntimeMessage.ASSET_IS_TOO_LARGE]: '文件过大，请选择较小的文件。',
  [RuntimeMessage.DOWNLOAD_EXCEEDS_64_MIB]: '下载文件超过 64 MiB。',
  [RuntimeMessage.ASSET_DIGEST_DOES_NOT_MATCH]: '文件校验不一致，请重新上传。',
  [RuntimeMessage.ASSET_LENGTH_OR_CHECKSUM_DOES_NOT_MATCH]: '文件长度或校验不一致，请重新上传。',
  [RuntimeMessage.DOWNLOADED_FILE_CHECKSUM_DOES_NOT_MATCH]: '下载文件校验失败，请重新下载。',
  [RuntimeMessage.DOWNLOADED_FILE_LENGTH_DOES_NOT_MATCH]: '下载文件不完整，请重新下载。',
  [RuntimeMessage.SOURCE_ANCHOR_VERSION_CHANGED]: '原文版本已变化，请重新选择来源行。',
  [RuntimeMessage.SOURCE_ANCHOR_QUOTE_DOES_NOT_MATCH]: '来源摘录与选中的原文行不一致，请重新标注。',
  [RuntimeMessage.SOURCE_ANCHORS_REQUIRE_A_SUCCESSOR_RELATION]: '请先建立来源与子节点的派生关系。',
  [RuntimeMessage.GRAPH_SUCCESSOR_TYPE_IS_NOT_ALLOWED]: '这两种节点不能建立后继关系。',
  [RuntimeMessage.SUCCESSOR_RELATIONS_MUST_NOT_CONTAIN_A_CYCLE]: '后继关系不能形成环，请调整起点或终点。',
  [RuntimeMessage.EDGE_REFERENCES_A_MISSING_NODE]: '关系节点已不存在，请关闭后重新选择。',
  [RuntimeMessage.DELETED_EDGE_IDS_CANNOT_BE_REUSED]: '这条关系已删除，请重新打开添加窗口。',
  [RuntimeMessage.SOURCE_REQUEST_FAILED]: '来源读取失败，请重试。',
  [RuntimeMessage.SOURCE_REQUEST_TIMED_OUT]: '来源读取超时，请重试。',
}

export function uiReadErrorMessage(
  /* 后端或界面提供的错误文字；只翻译已登记条目，其余保持通用提示。 */ message: string,
): string {
  // 已有中文由原模块负责；未知系统错误仍留在错误对象中供诊断。
  if (/[\u3400-\u9fff]/u.test(message)) return message
  const label = Object.prototype.hasOwnProperty.call(errorMessages, message) ? errorMessages[message as RuntimeMessage | EvidenceMessage] : undefined
  return label ?? '操作未完成，请按错误编号查看详情或重试。'
}
