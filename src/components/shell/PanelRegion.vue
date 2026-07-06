<script setup lang="ts">
const props = withDefaults(defineProps<{
  title: string
  collapsible?: boolean
  headOnly?: boolean
}>(), {
  collapsible: true,
  headOnly: false,
})

const expanded = defineModel<boolean>('expanded', { default: true })

function toggle() {
  if (!props.collapsible) return
  expanded.value = !expanded.value
}
</script>

<template>
  <section
    v-if="!headOnly"
    class="panel-region"
    :class="{ collapsed: collapsible && !expanded }"
  >
    <header
      class="panel-region-head"
      :class="{ clickable: collapsible }"
      @click="toggle"
    >
      <div class="panel-title-row">
        <span v-if="collapsible" class="chevron" aria-hidden="true">
          {{ expanded ? '▾' : '▸' }}
        </span>
        <h2 class="panel-title">{{ title }}</h2>
      </div>
      <div v-if="$slots.actions" class="panel-actions" @click.stop>
        <slot name="actions" />
      </div>
    </header>
    <div v-show="!collapsible || expanded" class="panel-region-body">
      <slot />
    </div>
  </section>
  <header
    v-else
    class="panel-region-head"
    :class="{ clickable: collapsible }"
    @click="toggle"
  >
    <div class="panel-title-row">
      <span v-if="collapsible" class="chevron" aria-hidden="true">
        {{ expanded ? '▾' : '▸' }}
      </span>
      <h2 class="panel-title">{{ title }}</h2>
    </div>
    <div v-if="$slots.actions" class="panel-actions" @click.stop>
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.panel-region {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel-region.collapsed {
  flex: 0 0 auto;
}

.panel-region-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  height: var(--workspace-head-height);
  min-height: var(--workspace-head-height);
  padding: 0 var(--space-md);
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.panel-region-head.clickable {
  cursor: pointer;
  user-select: none;
}

.panel-region-head.clickable:hover {
  background: var(--bg-hover);
}

.panel-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  min-width: 0;
}

.chevron {
  flex-shrink: 0;
  width: 10px;
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1;
}

.panel-title {
  font-size: var(--ui-font-size);
  font-weight: 600;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-shrink: 0;
}

.panel-region-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
