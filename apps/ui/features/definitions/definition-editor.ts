// 定义包JSON草稿的轻量核对：不读取网关，也不替代后端Schema、依赖和不可变验证。
import type { DefinitionCatalog, DefinitionPackage, DefinitionRef } from '../../../../contracts/data-definition'

export interface DefinitionDraftMetadata extends DefinitionRef {
  title: string
  dataTypes: DefinitionRef[]
  transitions: DefinitionRef[]
  dependencies: { packages: DefinitionRef[]; agents: DefinitionRef[] }
}
export interface DefinitionDraft { data: unknown; metadata: DefinitionDraftMetadata | null; errors: string[]; warnings: string[] }

export function definitionReadDraft(
  /* 用户当前完整JSON文本，不视为已验证发布DTO。 */ text: string,
  /* 当前范围已发布目录，仅用于可以证明的精确身份提示。 */ catalog: DefinitionCatalog | null,
): DefinitionDraft {
  // 分开原始输入、轻量元信息和错误；目录刷新不修改文本或自动改版本。
  let data: unknown
  try { data = JSON.parse(text) }
  catch { return { data: null, metadata: null, errors: ['请输入语法完整的定义包 JSON。'], warnings: [] } }
  const metadata = readMetadata(data)
  if (!metadata) return { data, metadata: null, errors: ['定义包需要标题、有效精确版本、类型与转换列表，以及精确依赖；包、类型、转换版本从 1 开始，智能体版本可为 0。'], warnings: [] }
  const warnings: string[] = []
  if (catalog) {
    if (catalog.packages.some((/* 当前目录已发布的包身份。 */ item) => /* 同包版本不可改写。 */ sameRef(item.ref, metadata))) {
      warnings.push(`包 ${formatRef(metadata)} 的精确版本已发布，不能用同版本覆盖内容。`)
    }
    for (const [kind, refs] of [['dataType', metadata.dataTypes], ['transition', metadata.transitions]] as const) {
      for (const ref of refs) {
        const occupied = catalog.index.find((/* 已发布精确定义所属包。 */ item) => /* 类型和转换分别占用自己的精确身份。 */ item.kind === kind && sameRef(item.ref, ref))
        if (occupied) warnings.push(`${kind === 'dataType' ? '数据类型' : '转换'} ${formatRef(ref)} 的精确版本已归属 ${formatRef(occupied.packageRef)}；改包版本不会升级内部定义，请改用新定义版本或依赖旧包。`)
      }
    }
    for (const ref of metadata.dependencies.packages) {
      if (!catalog.packages.some((/* 当前目录已发布的包身份。 */ item) => /* 依赖必须精确匹配，不能回落latest。 */ sameRef(item.ref, ref))) {
        warnings.push(`当前目录未列出包依赖 ${formatRef(ref)}，发布时由后端核对依赖闭包。`)
      }
    }
  }
  return { data, metadata, errors: [], warnings }
}

export function definitionCreateVersionDraft(
  /* 已读取的不可变精确包，只作为独立编辑起点。 */ pkg: DefinitionPackage,
): string {
  // 保留所有原始版本和引用；用户显式编辑，不自动升级或改写引用图。
  return JSON.stringify(pkg, null, 2)
}

export function definitionReadChangeSummary(
  /* 已经做完JSON和基本形状核对的文本投影。 */ draft: DefinitionDraft,
  /* 可选的复制起点，不会因目录刷新而替换草稿。 */ baseline?: DefinitionPackage,
): Array<{ label: string; value: string }> {
  // 分别列包、内部定义和精确依赖；移出新包不表示删除历史全局定义。
  const current = draft.metadata
  if (!current) return []
  const rows = [{ label: '包', value: `${formatRef(current)}${baseline ? `（编辑起点 ${formatRef(baseline)}）` : ' · 新草稿'}` }]
  for (const [label, refs, previous] of [
    ['数据类型', current.dataTypes, baseline?.dataTypes ?? []], ['转换', current.transitions, baseline?.transitions ?? []],
  ] as const) {
    if (!refs.length) rows.push({ label, value: '本包未声明' })
    for (const ref of refs) {
      const prior = previous.find((/* 复制起点的同类定义。 */ item) => /* 版本变化按相同ID核对，不借用包版本。 */ item.id === ref.id)
      let change = '新声明'
      if (prior && prior.version === ref.version) change = '沿用精确版本，发布前须核对归属'
      else if (prior) change = `新版本，编辑起点 v${prior.version}`
      rows.push({ label, value: `${formatRef(ref)} · ${change}` })
    }
    for (const ref of previous) {
      if (!refs.some((/* 草稿当前声明的精确身份。 */ item) => /* 原版本不再随新包重声明。 */ sameRef(item, ref))) {
        rows.push({ label, value: `${formatRef(ref)} · 本包不再包含；旧定义仍保留` })
      }
    }
  }
  for (const [label, refs] of [['包依赖', current.dependencies.packages], ['智能体依赖', current.dependencies.agents]] as const) {
    if (!refs.length) rows.push({ label, value: '无' })
    for (const ref of refs) rows.push({ label, value: formatRef(ref) })
  }
  return rows
}

function readMetadata(
  /* JSON解析后的未知包输入。 */ value: unknown,
): DefinitionDraftMetadata | null {
  // 仅建立页面需要的元信息，不解析Schema语义、阶段绑定或Agent归档可用性。
  if (!isObject(value) || !isRef(value, 1) || typeof value.title !== 'string' || !value.title.trim()
    || value.schemaDialect !== 'http://json-schema.org/draft-07/schema#'
    || !Array.isArray(value.dataTypes) || !Array.isArray(value.transitions) || !isObject(value.dependencies)) return null
  const dataTypes = readRefs(value.dataTypes, 1)
  const transitions = readRefs(value.transitions, 1)
  const packages = readRefs(value.dependencies.packages, 1)
  const agents = readRefs(value.dependencies.agents, 0)
  if (!dataTypes || !transitions || !packages || !agents) return null
  return { id: value.id, version: value.version, title: value.title, dataTypes, transitions, dependencies: { packages, agents } }
}

function readRefs(
  /* 未校验的精确身份列表，可包含额外定义字段。 */ value: unknown,
  /* 该类身份允许的最低版本，Agent为0，其余为1。 */ minimum: number,
): DefinitionRef[] | null {
  // 只复制id和version，避免把未验证定义正文伪装成可靠DTO。
  if (!Array.isArray(value) || !value.every((/* 一项未知身份。 */ item) => /* 每项独立验证自己的版本。 */ isRef(item, minimum))) return null
  return value.map((/* 已核对精确身份的项目。 */ item) => /* 不共享用户输入对象。 */ ({ id: item.id, version: item.version }))
}

function isRef(
  /* 尚未建立精确身份的JSON值。 */ value: unknown,
  /* 该类精确版本允许的下界。 */ minimum: number,
): value is DefinitionRef {
  // 接受精确非空ID和安全整数版本，不补默认版本或转换字符串。
  return isObject(value) && typeof value.id === 'string' && !!value.id.trim() && Number.isSafeInteger(value.version) && Number(value.version) >= minimum
}

function isObject(
  /* 来自JSON的未知输入。 */ value: unknown,
): value is Record<string, unknown> {
  // 排除null和数组，供最外层基本形状核对使用。
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameRef(
  /* 一份已建立的精确身份。 */ left: DefinitionRef,
  /* 待对照的同类精确身份。 */ right: DefinitionRef,
): boolean {
  // ID相同但版本不同仍是独立的不可变定义。
  return left.id === right.id && left.version === right.version
}

function formatRef(
  /* 页面需要核对的保存精确身份。 */ ref: DefinitionRef,
): string {
  // 保留版本0，不借助真假值回落其它版本。
  return `${ref.id} · v${ref.version}`
}
