<!-- 共用 WebGL 场景：只消费展示节点、真实连线和字符串身份，不持有 Map 或证据业务状态。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GraphSceneFallback from './GraphSceneFallback.vue'
import type { Graph3DLayout, Graph3DNode } from './graph-3d-layout'

const props = withDefaults(defineProps<{
  layout: Graph3DLayout
  sceneKey: string
  selectedId: string | null
  nodeStatus?: ReadonlyMap<string, string>
  active?: boolean
  label?: string
  emptyLabel?: string
}>(), {
  active: true,
  label: '三维关系图',
  emptyLabel: '添加第一份数据，开始构建三维关系图。',
})
const emit = defineEmits<{ select: [id: string | null]; open: [id: string] }>()

// 每个场景实例拥有 WebGL、相机、指针和监听资源；降级或卸载时统一释放。
const host = ref<HTMLElement | null>(null)
const fallback = ref<InstanceType<typeof GraphSceneFallback> | null>(null)
const failed = ref(false)
const hoveredId = ref<string | null>(null)
const labelPositions = ref<Array<{ id: string; title: string; x: number; y: number; selected: boolean }>>([])
const selectedNode = computed(() => /* 从当前场景中读取仍存在的选中节点。 */
  props.layout.nodes.find((/* 待比较的展示节点。 */ node) => /* 用独立展示身份定位选中项。 */ node.id === props.selectedId) ?? null)
const hoveredNode = computed(() => /* 从当前场景中读取指针悬停节点。 */
  props.layout.nodes.find((/* 待比较的展示节点。 */ node) => /* 用指针命中的展示身份定位悬停项。 */ node.id === hoveredId.value) ?? null)
const nodeLegend = computed(() => {
  const types = new Map<string, { key: string; title: string; color: string }>()
  for (const node of props.layout.nodes) {
    const key = `${node.typeId}:${node.color}`
    if (!types.has(key)) types.set(key, { key, title: node.title, color: node.color })
  }
  return [...types.values()]
})

const NODE_RADIUS = 0.25

let renderer: THREE.WebGLRenderer | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let scene: THREE.Scene | null = null
let content: THREE.Group | null = null
let nodeMesh: THREE.InstancedMesh | null = null
let selectedEdges: THREE.InstancedMesh | null = null
let halo: THREE.Group | null = null
let resizeObserver: ResizeObserver | null = null
let currentSceneKey: string | null = null
let pendingFit = false
let pointerStart: { x: number; y: number } | null = null
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const nodeIndex = new Map<string, number>()
const nodePosition = new Map<string, THREE.Vector3>()

function disposeObject(
  /* 本场景拥有、已停止展示的 Three 对象树。 */
  object: THREE.Object3D,
): void {
  // 释放节点、连线和网格的几何与材质，防止重建场景后累积 GPU 资源。
  object.traverse((/* 当前遍历的场景子对象。 */ item) => {
    // 只释放可绘制对象实际持有的几何和材质，灯光与 Group 无需处理。
    if (!(item instanceof THREE.Mesh || item instanceof THREE.Line || item instanceof THREE.Points)) return
    if (item instanceof THREE.InstancedMesh) item.dispose()
    item.geometry.dispose()
    if (Array.isArray(item.material)) {
      item.material.forEach((/* 对象拥有的一份材质。 */ material) => /* 释放当前材质占用的 GPU 资源。 */ material.dispose())
    } else {
      item.material.dispose()
    }
  })
}

function renderScene(): void {
  // 仅在场景可见且尺寸有效时绘制，并投影有限数量的 HTML 标签。
  const activeCamera = camera
  const activeHost = host.value
  if (!props.active || !renderer || !scene || !activeCamera || !activeHost) return
  const width = activeHost.clientWidth
  const height = activeHost.clientHeight
  if (width < 1 || height < 1) return
  renderer.render(scene, activeCamera)
  const selected = props.selectedId
  const labeled = props.layout.nodes.length <= 36
    ? props.layout.nodes
    : props.layout.nodes.filter((/* 候选标签节点。 */ node, /* 当前节点在场景中的序号。 */ index) =>
      /* 限制普通标签数量，并始终保留选中和悬停节点。 */ index < 35 || node.id === selected || node.id === hoveredId.value)
  labelPositions.value = labeled.flatMap((/* 需要投影标签的展示节点。 */ node) => {
    // 排除相机视野之外的标签，避免标签覆盖视口边界。
    const position = nodePosition.get(node.id)?.clone().project(activeCamera)
    if (!position || position.z < -1 || position.z > 1 || Math.abs(position.x) > 1.15 || Math.abs(position.y) > 1.15) return []
    return [{
      id: node.id,
      title: node.title,
      x: (position.x + 1) * width / 2 + 13,
      y: (1 - position.y) * height / 2 - 10,
      selected: node.id === selected,
    }]
  })
}

function resizeScene(): void {
  // 按容器实际尺寸同步渲染器和相机，隐藏场景不接受零尺寸投影。
  if (!host.value || !renderer || !camera) return
  const width = host.value.clientWidth
  const height = host.value.clientHeight
  if (width < 1 || height < 1) return
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  if (pendingFit) fitScene()
  else renderScene()
}

function fitScene(): void {
  // 将相机对准全部真实展示节点，并保留空图的可旋转初始视角。
  if (!camera || !controls || !host.value) return
  const width = host.value.clientWidth, height = host.value.clientHeight
  // 隐藏期间保留取景意图，显示后由尺寸观察使用真实宽高完成，普通resize仍保留用户视角。
  if (width < 1 || height < 1) { pendingFit = true; return }
  pendingFit = false
  camera.aspect = width / height
  const positions = [...nodePosition.values()]
  const box = positions.length ? new THREE.Box3().setFromPoints(positions) : new THREE.Box3(
    new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
  const center = box.getCenter(new THREE.Vector3())
  const span = box.getSize(new THREE.Vector3())
  const radius = Math.max(2.6, span.length() * 0.68)
  const verticalAngle = THREE.MathUtils.degToRad(camera.fov / 2)
  const limitingAngle = Math.atan(Math.tan(verticalAngle) * Math.min(1, camera.aspect))
  const distance = radius / Math.tan(limitingAngle) * 1.5
  // 大跨度或很窄的画布不能再被交互距离上限裁掉；常规图保留原范围，并给本次取景留出缩小余量。
  controls.maxDistance = Math.max(700, distance * 2)
  controls.target.copy(center)
  camera.position.copy(center).add(new THREE.Vector3(0.76, 0.58, 1.35).normalize().multiplyScalar(distance))
  camera.near = Math.max(0.02, distance / 2000)
  camera.far = Math.max(1000, distance * 10)
  camera.updateProjectionMatrix()
  controls.update()
  renderScene()
}

function zoom(
  /* 相机相对观察中心的距离倍率；大于一缩小，小于一放大。 */
  factor: number,
): void {
  // 围绕当前观察中心缩放，保留旋转角度与平移位置。
  if (!props.active || !camera || !controls) return
  const direction = camera.position.clone().sub(controls.target).multiplyScalar(factor)
  camera.position.copy(controls.target).add(direction)
  controls.update()
  renderScene()
}

function createLineSegments(
  /* 已提交关系的展示端点，只读取能够找到坐标的连线。 */
  edges: ReadonlyArray<{ from: string; to: string }>,
  /* 当前关系种类的展示颜色。 */
  color: string,
  /* 连线的不透明度，范围零到一。 */
  opacity: number,
): THREE.LineSegments | null {
  // 将实际关系批量转换为线段几何，避免为每条关系维护独立对象。
  const coordinates: number[] = []
  for (const edge of edges) {
    const from = nodePosition.get(edge.from)
    const to = nodePosition.get(edge.to)
    if (!from || !to) continue
    coordinates.push(from.x, from.y, from.z, to.x, to.y, to.z)
  }
  if (!coordinates.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(coordinates, 3))
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }))
}

function createSelectedEdges(): THREE.InstancedMesh | null {
  // 为选中节点相邻的实际连线生成突出显示，缺失端点不进入实例集合。
  const incident: Array<{ from: THREE.Vector3; to: THREE.Vector3 }> = []
  for (const edge of props.layout.edges) {
    if (edge.from !== props.selectedId && edge.to !== props.selectedId) continue
    const from = nodePosition.get(edge.from)
    const to = nodePosition.get(edge.to)
    if (from && to) incident.push({ from, to })
  }
  if (!incident.length) return null
  const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.014, 0.014, 1, 6),
    new THREE.MeshBasicMaterial({ color: '#b94334', transparent: true, opacity: 0.88, depthWrite: false }), incident.length)
  const matrix = new THREE.Matrix4()
  const midpoint = new THREE.Vector3()
  const direction = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const unitY = new THREE.Vector3(0, 1, 0)
  incident.forEach((/* 当前相邻连线的两个坐标。 */ edge, /* 实例网格中的连线序号。 */ index) => {
    // 沿实际端点方向拉伸圆柱，并将它放到端点中间。
    direction.copy(edge.to).sub(edge.from)
    midpoint.copy(edge.from).add(edge.to).multiplyScalar(0.5)
    quaternion.setFromUnitVectors(unitY, direction.clone().normalize())
    matrix.compose(midpoint, quaternion, new THREE.Vector3(1, direction.length(), 1))
    mesh.setMatrixAt(index, matrix)
  })
  mesh.instanceMatrix.needsUpdate = true
  return mesh
}

function updateSelection(): void {
  // 类型颜色始终保持；选择通过相邻连线和光环突出，避免重置相机。
  if (!content || !nodeMesh) return

  if (selectedEdges) {
    content.remove(selectedEdges)
    disposeObject(selectedEdges)
    selectedEdges = null
  }
  if (halo) {
    content.remove(halo)
    disposeObject(halo)
    halo = null
  }
  const position = props.selectedId === null ? undefined : nodePosition.get(props.selectedId)
  if (position) {
    selectedEdges = createSelectedEdges()
    if (selectedEdges) content.add(selectedEdges)
    halo = new THREE.Group()
    for (const rotation of [0.55, 1.25]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(NODE_RADIUS * 1.6, 0.009, 6, 64),
        new THREE.MeshBasicMaterial({ color: selectedNode.value?.color ?? '#ad6d4f', transparent: true, opacity: 0.9, depthWrite: false }))
      ring.rotation.x = rotation
      ring.rotation.y = rotation * 0.42
      halo.add(ring)
    }
    halo.position.copy(position)
    content.add(halo)
  }
  renderScene()
}

function rebuildScene(): void {
  // 替换本实例拥有的展示网格；新场景或新增节点重新适应，正文与状态更新保留相机。
  if (!content) return
  const resetCamera = currentSceneKey !== props.sceneKey || nodeIndex.size === 0
    || props.layout.nodes.length > nodeIndex.size
  currentSceneKey = props.sceneKey
  for (const child of [...content.children]) {
    content.remove(child)
    disposeObject(child)
  }
  nodeMesh = null
  selectedEdges = null
  halo = null
  nodeIndex.clear()
  nodePosition.clear()
  const nodes = props.layout.nodes
  nodes.forEach((/* 新布局中的展示节点。 */ node, /* 节点在实例网格中的序号。 */ index) => {
    // 建立射线命中与空间坐标索引，由当前布局重建并统一拥有。
    nodeIndex.set(node.id, index)
    nodePosition.set(node.id, new THREE.Vector3(node.x, node.y, node.z))
  })

  if (nodes.length) {
    const geometry = new THREE.IcosahedronGeometry(NODE_RADIUS, 1)
    const material = new THREE.MeshStandardMaterial({ roughness: 0.34, metalness: 0.07, flatShading: false })
    const mesh = new THREE.InstancedMesh(geometry, material, nodes.length)
    const matrix = new THREE.Matrix4()
    nodes.forEach((/* 需要绘制的展示节点。 */ node, /* 节点在实例网格中的序号。 */ index) => {
      // 按布局定位节点；陈旧项降低饱和度而保留原来的类型色相。
      matrix.makeTranslation(node.x, node.y, node.z)
      mesh.setMatrixAt(index, matrix)
      const color = new THREE.Color(node.color)
      if (node.stale) color.lerp(new THREE.Color('#fffdf8'), 0.45)
      mesh.setColorAt(index, color)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    nodeMesh = mesh
    content.add(mesh)
  }

  const successors = createLineSegments(props.layout.edges.filter((/* 场景中的实际关系。 */ edge) =>
    /* 单独批量绘制后继关系。 */ edge.kind === 'successor'), '#ab806a', 0.5)
  const references = createLineSegments(props.layout.edges.filter((/* 场景中的实际关系。 */ edge) =>
    /* 单独批量绘制引用关系。 */ edge.kind === 'reference'), '#79918b', 0.32)
  if (successors) content.add(successors)
  if (references) content.add(references)

  const positions = [...nodePosition.values()]
  const box = positions.length ? new THREE.Box3().setFromPoints(positions) : null
  const gridSize = Math.max(24, box ? Math.max(...box.getSize(new THREE.Vector3()).toArray()) + 12 : 24)
  const grid = new THREE.GridHelper(gridSize, Math.min(44, Math.max(16, Math.floor(gridSize))), '#d7cbb9', '#e8e0d5')
  grid.position.y = (box?.min.y ?? 0) - 1.7
  content.add(grid)

  updateSelection()
  if (resetCamera) fitScene()
  else renderScene()
}

function hitNode(
  /* 当前指针或双击的浏览器事件，坐标相对于视口。 */
  event: PointerEvent | MouseEvent,
): Graph3DNode | null {
  // 将屏幕位置转换为相机射线，返回真正命中的节点实例。
  if (!renderer || !camera || !nodeMesh) return null
  const rect = renderer.domElement.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObject(nodeMesh, false)[0]
  return hit?.instanceId === undefined ? null : props.layout.nodes[hit.instanceId] ?? null
}

function onPointerDown(
  /* 渲染画布收到的指针按下事件，用于辨别点击和旋转拖动。 */
  event: PointerEvent,
): void {
  // 记录按下位置，让拖动结束时不会误触发节点选择。
  if (!props.active) return
  pointerStart = { x: event.clientX, y: event.clientY }
}

function onPointerUp(
  /* 当前指针释放事件，用于核对按键和拖动距离。 */
  event: PointerEvent,
): void {
  // 只将左键短距离点击转为选择，背景点击清空当前选择。
  if (!pointerStart) return
  const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y)
  pointerStart = null
  if (!props.active || event.button !== 0 || moved > 5) return
  const id = hitNode(event)?.id ?? null
  if (id !== props.selectedId) emit('select', id)
}

function onPointerCancel(): void {
  // 取消尚未完成的点击判定，避免失去指针后残留拖动状态。
  pointerStart = null
}

function onPointerMove(
  /* 画布当前指针位置，用于未拖动时的节点悬停。 */
  event: PointerEvent,
): void {
  // 更新悬停标签和指针形状，旋转期间保持选择交互安静。
  if (!props.active || pointerStart || !renderer) return
  const id = hitNode(event)?.id ?? null
  if (hoveredId.value === id) return
  hoveredId.value = id
  renderer.domElement.style.cursor = id ? 'pointer' : 'grab'
  renderScene()
}

function onDoubleClick(
  /* 双击画布的浏览器事件，用于射线命中真实展示节点。 */
  event: MouseEvent,
): void {
  // 发出当前节点的字符串身份，由业务包装组件决定打开何种单页。
  if (!props.active) return
  const node = hitNode(event)
  if (node) emit('open', node.id)
}

function onKeydown(
  /* 场景焦点接收的键盘事件，支持打开、清空和循环选择。 */
  event: KeyboardEvent,
): void {
  // 用键盘在当前节点集合中导航，陈旧选择不会打开已离开的节点。
  if (!props.active) return
  const nodes = props.layout.nodes
  if (event.key === 'Enter' && selectedNode.value) {
    event.preventDefault()
    emit('open', selectedNode.value.id)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('select', null)
  } else if (event.key.startsWith('Arrow') && nodes.length) {
    event.preventDefault()
    const current = nodes.findIndex((/* 场景中待定位的展示节点。 */ node) =>
      /* 找到当前选择在循环键盘顺序中的位置。 */ node.id === props.selectedId)
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    emit('select', nodes[(current + delta + nodes.length) % nodes.length].id)
  }
}

async function focusSelectedNode(): Promise<void> {
  // 单页返回后恢复场景键盘焦点，默认降级画布会定位实际选中节点。
  await nextTick()
  if (failed.value) {
    await fallback.value?.focusSelectedNode()
    return
  }
  host.value?.focus({ preventScroll: true })
  resizeScene()
}
defineExpose({ focusSelectedNode })

function releaseScene(): void {
  // 统一结束观察和输入监听、销毁 GPU 资源；初始化失败和卸载均可重复调用。
  resizeObserver?.disconnect()
  resizeObserver = null
  controls?.removeEventListener('change', renderScene)
  controls?.dispose()
  controls = null
  if (renderer) {
    renderer.domElement.removeEventListener('pointerdown', onPointerDown)
    renderer.domElement.removeEventListener('pointerup', onPointerUp)
    renderer.domElement.removeEventListener('pointercancel', onPointerCancel)
    renderer.domElement.removeEventListener('pointermove', onPointerMove)
    renderer.domElement.removeEventListener('dblclick', onDoubleClick)
  }
  if (content) disposeObject(content)
  renderer?.dispose()
  renderer?.domElement.remove()
  renderer = null
  camera = null
  scene = null
  content = null
  nodeMesh = null
  selectedEdges = null
  halo = null
  pointerStart = null
  nodeIndex.clear()
  nodePosition.clear()
  labelPositions.value = []
}

onMounted(() => {
  // 仅图形上下文不可用时降级；场景逻辑异常交给全局错误边界。
  if (!host.value) return
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  } catch {
    // 浏览器没有可用 WebGL 时继续提供既有 SVG 选择和打开能力。
    failed.value = true
    return
  }
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    const paperBackground = getComputedStyle(host.value).getPropertyValue('--bg-viewport').trim() || '#faf9f5'
    renderer.setClearColor(paperBackground)
    renderer.domElement.className = 'graph-3d-canvas'
    renderer.domElement.setAttribute('aria-hidden', 'true')
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    host.value.append(renderer.domElement)
    scene = new THREE.Scene()
    scene.background = new THREE.Color(paperBackground)
    scene.add(new THREE.AmbientLight('#ffffff', 1.75))
    const light = new THREE.DirectionalLight('#fff2dc', 2.1)
    light.position.set(6, 10, 8)
    scene.add(light)
    const backLight = new THREE.DirectionalLight('#e7c7ae', 0.7)
    backLight.position.set(-5, 2, -6)
    scene.add(backLight)
    content = new THREE.Group()
    scene.add(content)
    camera = new THREE.PerspectiveCamera(45, 1, 0.02, 1000)
    controls = new OrbitControls(camera, renderer.domElement)
    controls.enabled = props.active
    controls.enableDamping = false
    controls.enablePan = true
    controls.minDistance = 1.5
    controls.maxDistance = 700
    controls.rotateSpeed = 0.66
    controls.addEventListener('change', renderScene)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('pointercancel', onPointerCancel)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('dblclick', onDoubleClick)
    resizeObserver = new ResizeObserver(resizeScene)
    resizeObserver.observe(host.value)
    resizeScene()
    rebuildScene()
  } catch (cause) {
    // 释放本实例已建立的资源，同时保留程序异常供统一诊断。
    releaseScene()
    throw cause
  }
})

watch(() => /* 用布局对象和场景身份检测业务展示集合的替换。 */ [props.layout, props.sceneKey] as const, () => {
  // 同一场景更新重新构建对象，场景身份切换同时重置观察范围。
  rebuildScene()
})
watch(() => /* 读取业务拥有的当前选择身份。 */ props.selectedId, () => {
  // 选择变化只更新颜色和相邻关系，保持用户相机视角。
  updateSelection()
})
watch(() => /* 读取场景是否仍处于可见交互模式。 */ props.active, async (/* 切换后的场景可见状态。 */ active) => {
  // 隐藏时关闭相机输入并结束点击判定，显示后按恢复的实际尺寸重绘。
  if (controls) controls.enabled = active
  if (!active) {
    pointerStart = null
    return
  }
  await nextTick()
  resizeScene()
})

onBeforeUnmount(releaseScene)
</script>

<template>
  <section class="graph-3d" :aria-label="label">
    <slot v-if="failed" name="fallback">
      <GraphSceneFallback ref="fallback" :layout="layout" :scene-key="sceneKey" :selected-id="selectedId"
        :active="active" :label="label" :empty-label="emptyLabel" @select="emit('select', $event)" @open="emit('open', $event)" />
    </slot>
    <template v-else>
      <div ref="host" class="scene-host" tabindex="0" role="group" :aria-label="`${label}，拖拽旋转、右键平移、滚轮缩放`" @keydown="onKeydown" />
      <div class="scene-topline"><span class="scene-dot" />{{ label }} <small>{{ layout.nodes.length }} 节点 · {{ layout.edges.length }} 连线</small></div>
      <div class="scene-controls">
        <button type="button" :aria-label="`缩小${label}`" :disabled="!active" @click="zoom(1.25)">−</button>
        <button type="button" :aria-label="`重置${label}视角`" :disabled="!active" @click="fitScene">适应</button>
        <button type="button" :aria-label="`放大${label}`" :disabled="!active" @click="zoom(0.8)">＋</button>
      </div>
      <div v-if="nodeLegend.length" class="scene-legend" aria-label="节点颜色说明"><span v-for="item in nodeLegend.slice(0, 8)" :key="item.key"><i :style="{ backgroundColor: item.color }" />{{ item.title }}</span><span v-if="nodeLegend.length > 8">另 {{ nodeLegend.length - 8 }} 类</span></div>
      <span v-for="position in labelPositions" :key="position.id" class="scene-label" :class="{ selected: position.selected }"
        :style="{ left: `${position.x}px`, top: `${position.y}px` }">{{ position.title }}<small v-if="nodeStatus?.get(position.id)" class="node-activity"> · {{ nodeStatus.get(position.id) }}</small></span>
      <div v-if="selectedNode" class="scene-selection">
        <small>已选节点 · {{ selectedNode.title }}</small>
        <strong>{{ selectedNode.summary }}</strong>
        <p v-if="nodeStatus?.get(selectedNode.id)" aria-label="节点活动">{{ nodeStatus.get(selectedNode.id) }}</p>
        <button type="button" :disabled="!active" @click="emit('open', selectedNode.id)">打开单页 ↗</button>
      </div>
      <div v-else-if="hoveredNode" class="scene-hover">{{ hoveredNode.title }}</div>
      <p v-if="!layout.nodes.length" class="scene-empty">{{ emptyLabel }}</p>
      <p class="scene-help">拖拽旋转 · 右键平移 · 滚轮缩放 · 双击打开</p>
    </template>
  </section>
</template>

<style scoped>
.graph-3d { position:relative; flex:1; min-width:0; min-height:0; overflow:hidden; background:var(--bg-viewport); }
.scene-host { position:absolute; inset:0; outline:none; cursor:grab; touch-action:none; }
.scene-host:active { cursor:grabbing; }
.scene-host:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; }
.scene-topline { position:absolute; top:14px; left:16px; display:flex; align-items:center; gap:7px; padding:6px 0; border:0; background:transparent; color:var(--text-muted); font-size:11px; font-weight:600; pointer-events:none; }
.scene-topline small { color:var(--text-muted); font-size:10px; font-weight:400; }
.scene-dot { width:5px; height:5px; border-radius:50%; background:var(--accent); }
.scene-controls { position:absolute; top:14px; right:15px; display:flex; gap:4px; }
.scene-controls button { min-width:31px; min-height:31px; padding:3px 8px; border-radius:var(--radius-control); background:var(--bg-viewport); white-space:nowrap; }
.scene-controls button:hover { border-color:var(--accent); color:var(--accent); }
.scene-legend { position:absolute; top:54px; left:16px; right:16px; display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; color:var(--text-muted); font-size:10px; pointer-events:none; }
.scene-legend>span { display:flex; align-items:center; gap:5px; padding:3px 0; background:transparent; }
.scene-legend i { width:7px; height:7px; border-radius:50%; }
.scene-label { position:absolute; z-index:1; max-width:155px; overflow:hidden; padding:4px 7px; border:1px solid var(--border-subtle); border-radius:0; background:var(--bg-viewport); color:var(--text-muted); font-size:11px; line-height:1.2; text-overflow:ellipsis; white-space:nowrap; pointer-events:none; }
.scene-label.selected { border-color:var(--accent); color:var(--accent); font-weight:600; }
.node-activity,.scene-selection p { font-size:10px;line-height:1.6;color:var(--text-muted); }
.scene-selection { position:absolute; z-index:2; bottom:42px; left:16px; display:grid; gap:7px; width:min(280px,calc(100% - 32px)); padding:12px 14px; border:0; border-left:2px solid var(--accent); border-radius:0; background:var(--bg-viewport); }
.scene-selection small { color:var(--text-muted); font-size:11px; }
.scene-selection strong { display:-webkit-box; overflow:hidden; color:var(--text); font:500 13px/1.55 var(--content-font); -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow-wrap:anywhere; }
.scene-selection button { justify-self:start; padding:4px 8px; border:0; background:transparent; color:var(--accent); font-size:11px; }
.scene-hover { position:absolute; bottom:46px; left:16px; color:var(--text-muted); font-size:12px; pointer-events:none; }
.scene-empty { position:absolute; top:50%; left:50%; width:min(280px,85%); color:var(--text-muted); font:15px/1.8 var(--content-font); text-align:center; transform:translate(-50%,-50%); pointer-events:none; }
.scene-help { position:absolute; right:16px; bottom:12px; color:var(--text-muted); font-size:10px; pointer-events:none; }
@media(max-width:900px) { .scene-topline small,.scene-help { display:none; } .scene-topline { top:10px; left:10px; } .scene-controls { top:10px; right:10px; } .scene-legend { top:49px; left:10px; right:10px; } .scene-selection { bottom:12px; left:10px; padding:9px 11px; } }
</style>
