<script setup lang="ts">
import { computed } from 'vue'
import type { MapAgentStream } from '../../flow-map'
import { labelFormatAgent } from '../../flow-map'

const props = defineProps<{
  agentStream?: MapAgentStream | null
  running?: boolean
}>()

const visible = computed(() => {
  const s = props.agentStream
  if (!s) return false
  return !!(s.thinking || s.text) || !!props.running
})

const title = computed(() => {
  const node = props.agentStream?.node
  return node ? `全局 · ${labelFormatAgent(node)}` : '全局 Agent'
})

const thinking = computed(() => props.agentStream?.thinking ?? '')
const text = computed(() => props.agentStream?.text ?? '')
const showCaret = computed(
  () => !!props.running && !!props.agentStream,
)
</script>

<template>
  <aside
    v-if="visible"
    class="flow-map-agent-panel"
    @click.stop
    @pointerdown.stop
  >
    <header class="agent-panel-head">
      {{ title }}
    </header>
    <div class="agent-panel-viewport">
      <div
        v-if="thinking"
        class="agent-panel-thinking"
      >
        {{ thinking }}
      </div>
      <div
        v-if="text"
        class="agent-panel-text"
      >
        {{ text }}
      </div>
      <span
        v-if="showCaret"
        class="agent-panel-caret"
        aria-hidden="true"
      />
    </div>
  </aside>
</template>

<style scoped>
.flow-map-agent-panel {
  /* 跟随父级（由缩放条撑开）宽度，自身内容不反向撑大父级 */
  width: 0;
  min-width: 100%;
  max-height: 180px;
  display: flex;
  flex-direction: column;
  background: var(--flow-node-bg, #fff);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
  overflow: hidden;
  font-family: var(--ui-font);
}

.agent-panel-head {
  flex: 0 0 auto;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim, #64748b);
  border-bottom: 1px solid var(--border-subtle);
  letter-spacing: 0.02em;
}

.agent-panel-viewport {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 148px;
  padding: 8px 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 6px;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-panel-thinking {
  color: var(--text-dim, #94a3b8);
  font-size: 11px;
}

.agent-panel-text {
  color: var(--text, #0f172a);
}

.agent-panel-caret {
  display: inline-block;
  width: 0.5em;
  color: var(--accent, #2563eb);
  animation: agent-caret-blink 1s step-end infinite;
}

.agent-panel-caret::before {
  content: '▋';
}

@keyframes agent-caret-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
