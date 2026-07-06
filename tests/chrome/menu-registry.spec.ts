import { describe, expect, it } from 'vitest'
import { CHROME_MENUS, chromeReadItemIds } from '@chrome/menu-registry'

describe('chrome menu-registry', () => {
  it('四组顶栏菜单', () => {
    expect(CHROME_MENUS.map(m => m.id)).toEqual(['file', 'database', 'tools', 'agents'])
    expect(CHROME_MENUS.map(m => m.label)).toEqual(['文件', '数据库', '工具', '智能体'])
  })

  it('菜单项 id 不重复', () => {
    const ids = chromeReadItemIds()
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每项有 action', () => {
    for (const menu of CHROME_MENUS) {
      for (const item of menu.items) {
        if (item.separator) continue
        expect(item.action).toBeTruthy()
        expect(item.label.length).toBeGreaterThan(0)
      }
    }
  })
})
