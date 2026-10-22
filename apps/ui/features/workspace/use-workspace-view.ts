// 持有当前窗口的 Map/单页选择与仅存在于会话内的阅读位置。
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { graphCreateNodeIdentityKey, graphNodeIdentitiesEqual, type NodeIdentity } from '../graph/node-identity'
import type { GraphSourceAnchor } from '../../../../contracts/graph'
import type { ReaderSourceFocus } from '../reader/reader-sources'

export type WorkspaceViewMode = 'map' | 'page'

export interface WorkspaceReaderBookmark {
  scrollTop: number
}

export interface WorkspaceViewContext {
  userId: string | null
  workspaceId: string | null
  mapId: string | null
  selectedId: string | null
  selectedNodePresent: boolean
  loading: boolean
}

export interface WorkspaceViewState {
  mode: ComputedRef<WorkspaceViewMode>
  pageIdentity: ComputedRef<NodeIdentity | null>
  sourceFocus: ComputedRef<ReaderSourceFocus | null>
  selectedIdentity: ComputedRef<NodeIdentity | null>
  canOpenPage: ComputedRef<boolean>
  openPage(identity: NodeIdentity, anchor?: GraphSourceAnchor): boolean
  showMap(): void
  readBookmark(identity: NodeIdentity): WorkspaceReaderBookmark | null
  saveBookmark(identity: NodeIdentity, bookmark: WorkspaceReaderBookmark): boolean
}

/**
 * 为一个 Vue 生命周期持有窗口级展示状态，浏览位置不进入共享 GraphSnapshot。
 *
 * @param context 页面当前身份、Map、选中节点和加载状态的只读实时投影。
 */
export function useWorkspaceView(context: Readonly<Ref<WorkspaceViewContext>>): WorkspaceViewState {
  const modeValue = ref<WorkspaceViewMode>('map')
  const pageIdentityValue = ref<NodeIdentity | null>(null)
  const sourceFocusValue = ref<ReaderSourceFocus | null>(null)
  const bookmarks = new Map<string, WorkspaceReaderBookmark>()
  const mode = computed(() => modeValue.value)
  const pageIdentity = computed(() => pageIdentityValue.value)
  const sourceFocus = computed(() => sourceFocusValue.value)
  const selectedIdentity = computed(() => workspaceCreateSelectedIdentity(context.value))
  const canOpenPage = computed(() => selectedIdentity.value !== null)

  onScopeDispose(() => {
    // 页面会话结束时释放缓存，使登出和卸载不会留下上一身份的内容。
    workspaceClearSelection()
  })

  // 用户或工作区切换会隔离本会话的所有阅读位置；换 Map 只退出单页。
  watch(() => [context.value.userId, context.value.workspaceId, context.value.mapId] as const, (next, previous) => {
    if (!previous) return
    if (next[0] !== previous[0] || next[1] !== previous[1]) workspaceClearSelection()
    else if (next[2] !== previous[2]) workspaceClearPage()
  }, { flush: 'sync' })

  return { mode, pageIdentity, sourceFocus, selectedIdentity, canOpenPage, openPage, showMap, readBookmark, saveBookmark }

  function openPage(identity: NodeIdentity, anchor?: GraphSourceAnchor): boolean {
    const selected = selectedIdentity.value
    if (!selected || !graphNodeIdentitiesEqual(selected, identity)) return false
    pageIdentityValue.value = { ...identity }
    sourceFocusValue.value = anchor ? { target: { ...identity }, anchor: { ...anchor } } : null
    modeValue.value = 'page'
    return true
  }

  function showMap(): void {
    // 只切换页面显示，保留已选节点和其阅读位置。
    modeValue.value = 'map'
  }

  function readBookmark(identity: NodeIdentity): WorkspaceReaderBookmark | null {
    // 返回副本，避免单页组件改写会话状态中的滚动位置。
    const bookmark = bookmarks.get(workspaceCreateBookmarkKey(context.value, identity))
    return bookmark ? { ...bookmark } : null
  }

  function saveBookmark(identity: NodeIdentity, bookmark: WorkspaceReaderBookmark): boolean {
    const current = context.value
    if (modeValue.value !== 'page' || !graphNodeIdentitiesEqual(pageIdentityValue.value, identity)
      || current.userId === null || current.workspaceId !== identity.workspaceId || current.mapId !== identity.mapId
      || !Number.isFinite(bookmark.scrollTop) || bookmark.scrollTop < 0) return false
    bookmarks.set(workspaceCreateBookmarkKey(current, identity), { scrollTop: bookmark.scrollTop })
    return true
  }

  function workspaceClearPage(): void {
    // Map 变化时取消过期页面目标，防止新图单页暂时显示旧图内容。
    pageIdentityValue.value = null
    sourceFocusValue.value = null
    modeValue.value = 'map'
  }

  function workspaceClearSelection(): void {
    // 跨身份清理单页与书签；会话保留全新的身份与图数据所有权。
    workspaceClearPage()
    bookmarks.clear()
  }
}

/**
 * 仅为通过当前快照身份检查的选择创建阅读目标。
 *
 * @param current 会话导出的只读用户、工作区、Map 与节点选择状态。
 */
function workspaceCreateSelectedIdentity(current: WorkspaceViewContext): NodeIdentity | null {
  if (current.userId === null || current.workspaceId === null || current.mapId === null
    || current.selectedId === null || !current.selectedNodePresent || current.loading) return null
  return { workspaceId: current.workspaceId, mapId: current.mapId, nodeId: current.selectedId }
}

/**
 * 为单条书签计算包含所有身份维度的 Map 键。
 *
 * @param current 当前会话归属，用于隔离不同用户的本地阅读状态。
 * @param identity 书签对应的 Workspace、Map 和 Node 身份。
 */
function workspaceCreateBookmarkKey(current: WorkspaceViewContext, identity: NodeIdentity): string {
  return JSON.stringify([current.userId, graphCreateNodeIdentityKey(identity)])
}
