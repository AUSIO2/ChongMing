<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useFlowMapStore } from '../../stores/flow-map'
import { useWorkspaceStore } from '../../stores/workspace'
import {
  RUN_PHASE_LABEL,
  timelineCreateDefault,
  timelineReadEffectiveIndex,
  timelineReadScope,
  labelFormatFocusNode,
  labelFormatHitl,
  type ExecutionMode,
} from '../../flow-map'
import {
  frameReadDataIndex,
  frameReadStateIndex,
  type DataFrameIndex,
  type FrameIndex,
} from '../../flow-map/timeline-frame'
import {
  timelineProjectLines,
  timelineReadDataEnd,
  timelineReadGlobalFrame,
  timelineReadGlobalStart,
} from '../../flow-map/timeline-project'
import { layoutReadSnapshot } from '../../flow-map/layout'
import FlowMapTimelinePlayer from './FlowMapTimelinePlayer.vue'
import FlowMapTimelineCanvas from './FlowMapTimelineCanvas.vue'
import { shortcutFormatRunContinueHint } from '../../shortcuts'

const store = useFlowMapStore()
const workspace = useWorkspaceStore()
const {
  snapshot,
  selectedNodeId,
  isRunning,
  runPhase,
  mode,
  isInterrupted,
} = storeToRefs(store)
const { currentMap } = storeToRefs(workspace)

const timeline = computed(() => snapshot.value?.timeline ?? timelineCreateDefault())

const scope = computed(() => {
  if (!snapshot.value) return ''
  return timelineReadScope(snapshot.value, timeline.value, selectedNodeId.value)
})

const effectiveX = computed(() => {
  if (!snapshot.value) return 0
  return timelineReadEffectiveIndex(
    timeline.value,
    snapshot.value,
    currentMap.value?.claims ?? [],
    scope.value,
  )
})

const lines = computed(() =>
  snapshot.value ? timelineProjectLines(snapshot.value) : [],
)

const mapHeight = computed(() =>
  snapshot.value ? layoutReadSnapshot(snapshot.value).height : 0,
)

const globalStart = computed(() => timelineReadGlobalStart(lines.value))
const dataEnd = computed(() => timelineReadDataEnd(timeline.value))

const playheadFrame = computed<FrameIndex>(() => {
  let f = Math.max(
    timelineReadGlobalFrame(lines.value),
    frameReadDataIndex(effectiveX.value),
  )
  const s = snapshot.value
  if (s?.activeNodeId) {
    const layout = layoutReadSnapshot(s)
    const ln = layout.nodes.find(n => n.node.id === s.activeNodeId)
    if (ln) f = Math.max(f, ln.depth)
  }
  return f as FrameIndex
})

const statusLabel = computed(() => RUN_PHASE_LABEL[runPhase.value])

const primaryAction = computed<'run' | 'continue' | null>(() => {
  if (!snapshot.value) return null
  if (runPhase.value === 'idle' || runPhase.value === 'error' || runPhase.value === 'completed') {
    return 'run'
  }
  if (runPhase.value === 'interrupted') return 'continue'
  return null
})

const primaryLabel = computed(() =>
  primaryAction.value === 'continue' ? '继续' : '运行',
)

const primaryDisabled = computed(() => primaryAction.value == null)

const primaryHint = computed(() => {
  let base: string
  if (!snapshot.value) base = '等待 Map 加载…'
  else if (runPhase.value === 'running') base = '执行中'
  else if (runPhase.value === 'interrupted') {
    base = focusText.value || '已暂停，点继续推进'
  } else if (runPhase.value === 'completed') base = '本阶段已完成'
  else if (runPhase.value === 'error') base = '上次出错，可重新运行'
  else base = '按结束帧自动调度过渡'

  if (primaryAction.value) {
    return `${base}（${shortcutFormatRunContinueHint()}）`
  }
  return base
})

const canCancel = computed(
  () => runPhase.value === 'running'
    || runPhase.value === 'interrupted'
    || runPhase.value === 'completed'
    || runPhase.value === 'error',
)

const focusText = computed(() => {
  const s = snapshot.value
  if (!s?.activeNodeId) return ''
  const n = s.nodes.find(x => x.id === s.activeNodeId)
  if (!n) return `焦点 · ${s.activeNodeId}`
  const t = s.pendingTool ? `（${labelFormatHitl(s.pendingTool, 'pending')}）` : ''
  return `焦点 · ${labelFormatFocusNode(n)}${t}`
})

const scrollToFrame = ref<FrameIndex | null>(null)

function onModeChange(next: ExecutionMode) {
  void store.setMode(next)
}

function onPrimary() {
  if (primaryAction.value === 'continue') {
    void store.continueStep()
    return
  }
  if (primaryAction.value === 'run') {
    void store.runTimeline()
  }
}

async function onDataEndChange(data: DataFrameIndex) {
  if (isRunning.value) return
  await store.updateTimeline({ endX: frameReadStateIndex(data) })
}

function onJumpStart() {
  scrollToFrame.value = globalStart.value
}

function onJumpEnd() {
  scrollToFrame.value = dataEnd.value
}
</script>

<template>
  <div v-if="snapshot" class="timeline-panel">
    <FlowMapTimelinePlayer
      :status-label="statusLabel"
      :run-phase="runPhase"
      :mode="mode"
      :is-running="isRunning"
      :is-interrupted="isInterrupted"
      :primary-label="primaryLabel"
      :primary-disabled="primaryDisabled"
      :primary-hint="primaryHint"
      :can-cancel="canCancel"
      :focus-text="focusText || primaryHint"
      :data-end="dataEnd"
      :playhead-frame="playheadFrame"
      @mode-change="onModeChange"
      @primary="onPrimary"
      @cancel="store.cancelRun()"
      @data-end-change="onDataEndChange"
      @jump-start="onJumpStart"
      @jump-end="onJumpEnd"
    />

    <FlowMapTimelineCanvas
      :lines="lines"
      :map-height="mapHeight"
      :global-start="globalStart"
      :data-end="dataEnd"
      :playhead-frame="playheadFrame"
      :scroll-to-frame="scrollToFrame"
    />
  </div>
</template>

<style scoped>
.timeline-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-header);
  font-size: var(--ui-font-size);
}
</style>
