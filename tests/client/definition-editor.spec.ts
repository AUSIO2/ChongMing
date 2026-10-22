// C13先行：JSON草稿只作轻量核对，不修改已发布定义或冒充后端发布验证。
import { describe, expect, it } from 'vitest'

import { LIBRARY_TEST_PACKAGE, libraryTestCatalog } from '../backend/fixtures/library-claims'
import { definitionCreateVersionDraft, definitionReadChangeSummary, definitionReadDraft } from '../../apps/ui/features/definitions/definition-editor'

describe('C13 independent definition JSON drafts', () => {
  // 包、类型、转换和Agent版本分别表达，精确不可变语义仍由后端裁定。
  it('reads original unknown JSON with metadata without claiming semantic validation', () => {
    // 未解释的字段保留在原输入，轻量元信息只供界面核对。
    const source = { ...structuredClone(LIBRARY_TEST_PACKAGE), extraFutureField: { saved: true } }
    const draft = definitionReadDraft(JSON.stringify(source), null)
    expect(draft.data).toEqual(source)
    expect(draft.metadata).toMatchObject({ id: source.id, version: 1, title: source.title,
      dataTypes: source.dataTypes.map((/* 包内精确类型。 */ type) => /* 不把包版本当类型版本。 */ ({ id: type.id, version: type.version })),
      transitions: source.transitions.map((/* 包内精确转换。 */ transition) => /* 保留转换自身版本。 */ ({ id: transition.id, version: transition.version })),
      dependencies: source.dependencies })
    expect(draft.errors).toEqual([])
  })

  it.each(['', '{broken', 'null', '[]', '"text"', '{"id":"partial"}'])('keeps malformed or incomplete draft %s unpublishable', (/* 用户输入的坏JSON或基本形状。 */ text) => {
    // 坏草稿有明确错误而没有可供提交核对的metadata。
    const draft = definitionReadDraft(text, null)
    expect(draft.errors.length).toBeGreaterThan(0)
    expect(draft.metadata).toBeNull()
    expect(definitionReadChangeSummary(draft)).toEqual([])
  })

  it('copies a package into independent text while retaining every original version', () => {
    // 复制只是编辑起点，不替用户重写版本、依赖或schema引用。
    const source = structuredClone(LIBRARY_TEST_PACKAGE)
    const before = structuredClone(source)
    const text = definitionCreateVersionDraft(source)
    const parsed = JSON.parse(text)
    expect(parsed).toEqual(before)
    parsed.version = 9
    parsed.dataTypes[0].version = 8
    parsed.dependencies.agents[0].version = 0
    expect(source).toEqual(before)
  })

  it('keeps package type transition and Agent versions independent including Agent zero', () => {
    // Agent版本0合法；包版本变大不自动改变类型和转换版本。
    const source = structuredClone(LIBRARY_TEST_PACKAGE)
    source.version = 4
    source.dataTypes[0].version = 2
    source.transitions[0].version = 3
    source.dependencies.agents[0].version = 0
    const draft = definitionReadDraft(JSON.stringify(source), null)
    expect(draft.errors).toEqual([])
    expect(draft.metadata).toMatchObject({ version: 4, dataTypes: [{ id: source.dataTypes[0].id, version: 2 }, { id: source.dataTypes[1].id, version: source.dataTypes[1].version }],
      transitions: [{ id: source.transitions[0].id, version: 3 }], dependencies: { agents: [{ id: source.dependencies.agents[0].id, version: 0 }] } })
  })

  it.each(['package', 'dataType', 'transition'] as const)('rejects zero as the %s version without normalizing it', (/* 独立不可变身份的类别。 */ kind) => {
    // 草稿不能把非法版本补成默认1或用包版本覆盖内部定义。
    const source = structuredClone(LIBRARY_TEST_PACKAGE)
    if (kind === 'package') source.version = 0
    else if (kind === 'dataType') source.dataTypes[0].version = 0
    else source.transitions[0].version = 0
    const draft = definitionReadDraft(JSON.stringify(source), null)
    expect(draft.errors.length).toBeGreaterThan(0)
    expect(draft.metadata).toBeNull()
  })

  it('warns about exact package and definition ownership even when content is unchanged', () => {
    // 已被目录占用的精确身份不可因相同正文而另包重声明。
    const catalog = libraryTestCatalog()
    const same = definitionReadDraft(JSON.stringify(LIBRARY_TEST_PACKAGE), catalog)
    expect(same.warnings.join('\n')).toContain(`${LIBRARY_TEST_PACKAGE.id}`)
    const source = structuredClone(LIBRARY_TEST_PACKAGE)
    source.version += 1
    const upgraded = definitionReadDraft(JSON.stringify(source), catalog)
    expect(upgraded.errors).toEqual([])
    for (const ref of [...source.dataTypes, ...source.transitions]) {
      expect(upgraded.warnings.join('\n')).toContain(ref.id)
    }
    expect(upgraded.warnings.join('\n')).toContain('精确版本')
  })

  it('does not reject archived Agent versions just because no current Agent list is supplied', () => {
    // 当前目录并不枚举归档Agent，本地不能声称其缺失或已验证可用。
    const source = structuredClone(LIBRARY_TEST_PACKAGE)
    source.dependencies.agents = [{ id: 'archived-only-agent', version: 0 }]
    const draft = definitionReadDraft(JSON.stringify(source), libraryTestCatalog())
    expect(draft.errors).toEqual([])
    expect(draft.metadata?.dependencies.agents).toEqual(source.dependencies.agents)
    expect(draft.warnings.some((/* 轻量提示。 */ text) => /* 不凭当前配置给归档Agent下错误结论。 */ text.includes('archived-only-agent') && text.includes('不存在'))).toBe(false)
  })

  it('summarizes separate declarations exact dependencies and definitions omitted from the new package', () => {
    // 移出草稿只代表新包不再包含，旧全局定义仍保留。
    const source = structuredClone(LIBRARY_TEST_PACKAGE)
    source.version = 2
    source.dataTypes = [{ ...source.dataTypes[0], version: 2 }]
    source.transitions = []
    source.dependencies.packages = [{ id: LIBRARY_TEST_PACKAGE.id, version: 1 }]
    source.dependencies.agents = [{ id: 'archived-only-agent', version: 0 }]
    const draft = definitionReadDraft(JSON.stringify(source), libraryTestCatalog())
    const rows = definitionReadChangeSummary(draft, LIBRARY_TEST_PACKAGE)
    const text = rows.map((/* 直接用于界面的一行核对信息。 */ row) => /* 标签和值都对用户可见。 */ `${row.label} ${row.value}`).join('\n')
    expect(text).toContain('包')
    expect(text).toContain('数据类型')
    expect(text).toContain('转换')
    expect(text).toContain('本包不再包含')
    expect(text).toContain('旧定义仍保留')
    expect(text).toContain(`${LIBRARY_TEST_PACKAGE.id} · v1`)
    expect(text).toContain('archived-only-agent · v0')
  })

  it('does not mutate the published catalog baseline or draft while computing warnings and changes', () => {
    // 刷新或核对都是纯读取，不偷偷替草稿升版或重写定义引用。
    const catalog = libraryTestCatalog()
    const baseline = structuredClone(LIBRARY_TEST_PACKAGE)
    const before = structuredClone({ catalog, baseline })
    const draft = definitionReadDraft(definitionCreateVersionDraft(baseline), catalog)
    const savedDraft = structuredClone(draft)
    definitionReadChangeSummary(draft, baseline)
    expect({ catalog, baseline }).toEqual(before)
    expect(draft).toEqual(savedDraft)
  })
})
