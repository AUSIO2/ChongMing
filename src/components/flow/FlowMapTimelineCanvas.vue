<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { MAP_COLUMN_LABEL } from '../../flow-map/columns'
import {
  frameReadCanvasWidth,
  frameReadCellWidth,
  frameReadGutterWidth,
  frameReadRulerHeight,
  frameToX,
  layoutYScale,
  type DataFrameIndex,
  type FrameIndex,
} from '../../flow-map/timeline-frame'
import type { TimelineLine } from '../../flow-map/timeline-project'

const props = defineProps<{
  lines: TimelineLine[]
  mapHeight: number
  globalStart: FrameIndex
  dataEnd: DataFrameIndex
  playheadFrame: FrameIndex
  scrollToFrame: FrameIndex | null
}>()

const LABEL_WIDTH = 120
const RULER_H = frameReadRulerHeight()
const GUTTER = frameReadGutterWidth()
const CELL_W = frameReadCellWidth()
const CANVAS_W = frameReadCanvasWidth()
const FRAME_INDICES = [0, 1, 2, 3, 4, 5, 6] as const

const scrollEl = ref<HTMLElement | null>(null)

const svgWidth = computed(() => LABEL_WIDTH + CANVAS_W)
const contentHeight = computed(() => {
  const lineCount = Math.max(1, props.lines.length)
  return RULER_H + lineCount * 28 + 16
})

const playheadX = computed(() => LABEL_WIDTH + frameToX(props.playheadFrame))
const endX = computed(() => LABEL_WIDTH + frameToX(props.dataEnd))
const startX = computed(() => LABEL_WIDTH + frameToX(props.globalStart))

function lineY(index: number, layoutY: number): number {
  const top = RULER_H + 8
  const inner = Math.max(28, props.lines.length * 28)
  if (props.mapHeight <= 0) return top + index * 28 + 14
  return layoutYScale(layoutY, props.mapHeight, top, inner)
}

function segmentX(f: FrameIndex): number {
  return LABEL_WIDTH + frameToX(f)
}

watch(
  () => props.scrollToFrame,
  (f) => {
    if (f == null || !scrollEl.value) return
    const x = segmentX(f) - scrollEl.value.clientWidth / 2
    scrollEl.value.scrollLeft = Math.max(0, x)
  },
)
</script>

<template>
  <div ref="scrollEl" class="timeline-canvas-scroll">
    <svg
      class="timeline-canvas"
      :width="svgWidth"
      :height="contentHeight"
      :viewBox="`0 0 ${svgWidth} ${contentHeight}`"
    >
      <defs>
        <pattern
          id="frame-grid"
          :width="CELL_W"
          :height="contentHeight"
          patternUnits="userSpaceOnUse"
          :x="LABEL_WIDTH + GUTTER"
          y="0"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            :y2="contentHeight"
            stroke="var(--border-subtle)"
            stroke-width="1"
          />
        </pattern>
      </defs>

      <rect
        :x="LABEL_WIDTH"
        y="0"
        :width="CANVAS_W"
        :height="contentHeight"
        fill="url(#frame-grid)"
      />

      <rect
        :x="LABEL_WIDTH"
        y="0"
        :width="CANVAS_W"
        :height="RULER_H"
        fill="var(--bg-panel)"
      />

      <line
        :x1="LABEL_WIDTH"
        :y1="RULER_H"
        :x2="LABEL_WIDTH + CANVAS_W"
        :y2="RULER_H"
        stroke="var(--border)"
        stroke-width="1"
      />

      <g v-for="f in FRAME_INDICES" :key="`ruler-${f}`">
        <text
          :x="segmentX(f)"
          :y="RULER_H - 10"
          text-anchor="middle"
          class="ruler-tick"
        >
          {{ f }}
        </text>
        <text
          :x="segmentX(f)"
          :y="RULER_H - 2"
          text-anchor="middle"
          class="ruler-label"
        >
          {{ MAP_COLUMN_LABEL[f] }}
        </text>
      </g>

      <rect
        :x="Math.min(startX, endX)"
        :y="RULER_H"
        :width="Math.abs(endX - startX)"
        :height="contentHeight - RULER_H"
        class="range-shade"
      />

      <line
        :x1="endX"
        :y1="RULER_H"
        :x2="endX"
        :y2="contentHeight"
        class="end-marker"
      />

      <g v-for="(line, i) in lines" :key="line.rootId">
        <text
          :x="LABEL_WIDTH - 8"
          :y="lineY(i, line.layoutY)"
          text-anchor="end"
          dominant-baseline="middle"
          class="line-label"
        >
          {{ line.label }}
        </text>

        <line
          :x1="segmentX(line.xStart)"
          :y1="lineY(i, line.layoutY)"
          :x2="segmentX(line.xEnd)"
          :y2="lineY(i, line.layoutY)"
          class="timeline-line"
        />

        <circle
          :cx="segmentX(line.xStart)"
          :cy="lineY(i, line.layoutY)"
          r="3"
          class="line-cap start"
        />
        <circle
          :cx="segmentX(line.xEnd)"
          :cy="lineY(i, line.layoutY)"
          r="3"
          class="line-cap end"
        />

        <template v-for="f in FRAME_INDICES" :key="`${line.rootId}-dot-${f}`">
          <circle
            v-if="
              f !== line.xStart
              && f !== line.xEnd
              && line.frames[f]?.length
            "
            :cx="segmentX(f)"
            :cy="lineY(i, line.layoutY)"
            r="2"
            class="line-dot"
          />
        </template>
      </g>

      <line
        :x1="playheadX"
        :y1="0"
        :x2="playheadX"
        :y2="contentHeight"
        class="playhead"
      />
      <text
        :x="playheadX"
        y="10"
        text-anchor="middle"
        class="playhead-cap"
      >
        {{ playheadFrame }}
      </text>
    </svg>
  </div>
</template>

<style scoped>
.timeline-canvas-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--bg-viewport);
}

.timeline-canvas {
  display: block;
  min-width: 100%;
}

.ruler-tick {
  font-size: 9px;
  fill: var(--text-dim);
}

.ruler-label {
  font-size: 10px;
  fill: var(--text-muted);
}

.line-label {
  font-size: 10px;
  fill: var(--text-muted);
}

.range-shade {
  fill: color-mix(in srgb, var(--accent, #2563eb) 6%, transparent);
  pointer-events: none;
}

.end-marker {
  stroke: var(--warning, #d97706);
  stroke-width: 1;
  stroke-dasharray: 4 3;
  pointer-events: none;
}

.timeline-line {
  stroke: var(--accent, #2563eb);
  stroke-width: 2;
  stroke-linecap: round;
}

.line-cap.start {
  fill: var(--accent, #2563eb);
}

.line-cap.end {
  fill: var(--warning, #d97706);
}

.line-dot {
  fill: var(--text-dim);
}

.playhead {
  stroke: var(--accent, #2563eb);
  stroke-width: 2;
  pointer-events: none;
}

.playhead-cap {
  font-size: 9px;
  fill: #fff;
  paint-order: stroke;
  stroke: var(--accent, #2563eb);
  stroke-width: 8;
  stroke-linejoin: round;
}
</style>
