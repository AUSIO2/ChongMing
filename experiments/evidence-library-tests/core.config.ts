// 本阶段只筛选四个已实现操作对应的原用例，完整套件仍保留未实现功能的验收。
import { defineConfig } from 'vitest/config'

const coreCases = [
  '固定判断与收录快照',
  '合法重放、重复收录与冲突',
  '管理命令拒绝覆盖固定字段',
  '撤回的错误预期版本',
  'viewer 可以读取',
  '非成员知道',
  '来源 Claim 必须',
  '撤权后合法收录',
  '收录失败时条目',
  '按判断',
  '关键词分页',
  '游标绑定',
  '跨页期间',
  '陈述内容与输入边界',
  '未显式收录的 Claim',
  '空库及零命中',
  '主体和事件筛选',
  '拒绝无效分页大小',
  '撤回合法重放',
  '同一管理请求身份改变理由',
]

export default defineConfig({
  test: {
    environment: 'node', globals: false, maxWorkers: 1,
    include: ['experiments/evidence-library-tests/functional.spec.ts', 'experiments/evidence-library-tests/business-boundaries.spec.ts'],
    testNamePattern: coreCases.join('|'),
    testTimeout: 30_000, hookTimeout: 60_000,
  },
})
