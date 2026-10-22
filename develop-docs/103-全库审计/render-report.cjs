// 从已归并的证据生成可读报告；先运行finish-audit.cjs --final，不重新建立基线。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'))
const summary = read('verification.json'), inventory = read('inventory.json')
const { groups } = read('findings.json'), coverage = read('coverage.json'), prior = read('prior-findings.json').prior
const scopeNames = ['scope-domain.json', 'scope-runtime.json', 'scope-ui.json', 'scope-root.json', 'scope-root-experiments.json', 'scope-ui-browser.json', 'scope-ui-infrastructure.json']
const scopes = scopeNames.map(name => ({ name, data: read(name) }))
for (const key of ['pending', 'drift', 'addedCode', 'ruleMissing']) assert.equal(summary[key].length, 0, 'Audit not closed: ' + key)
const runs = read('reproduction-runs.json').runs
assert.ok(runs.every(run => run.exitCode === 0), 'A reproduction did not finish successfully')
const decisions = scopes.map(scope => ({ source: scope.name, retained: scope.data.retained, unresolved: scope.data.unresolved,
  flows: scope.data.flows, transversal: scope.data.transversal }))
fs.writeFileSync(path.join(__dirname, 'decisions-and-flows.json'), JSON.stringify({ scopes: decisions }, null, 2) + '\n')
const cell = value => String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>')
const names = { behavior: '行为缺陷', redundancy: '重复/无效逻辑', minor: '低影响小项', production: '运行代码', test: '测试', experiment: '实验工具', 'build-verification': '构建/验证' }
const source = site => `[${site.file}:${site.line}](../../${site.file})`
function text(value) {
  if (typeof value === 'string') return value.replaceAll(inventory.root + '/', '')
  if (Array.isArray(value)) return value.map(text).join('；')
  return JSON.stringify(value).replaceAll(inventory.root + '/', '')
}
function family(file) {
  if (file.startsWith('tests/')) return 'tests'
  if (file.startsWith('experiments/')) return 'experiments'
  for (const prefix of ['backend/modules/graph/', 'backend/modules/workspace/', 'backend/modules/assets/', 'backend/modules/evidence-library/', 'backend/modules/shared/', 'backend/modules/identity/', 'backend/application/', 'backend/adapters/', 'backend/execution/', 'backend/ports/', 'apps/ui/', 'client/', 'contracts/', 'platform/']) if (file.startsWith(prefix)) return prefix.slice(0, -1)
  if (file.startsWith('apps/')) return 'apps 其他入口/配置'
  return 'scripts / 根构建验证配置'
}
const families = [...new Set(coverage.files.map(row => family(row.file)))]
const retainedRows = [], unresolvedRows = []
for (const scope of scopes) {
  for (const item of scope.data.retained) retainedRows.push({ scope: scope.name, ...item })
  for (const item of scope.data.unresolved) unresolvedRows.push({ scope: scope.name, ...item })
}
const scopeLabels = group => group.areas.map(area => names[area]).join('／')
const productionCounts = Object.fromEntries(['behavior', 'redundancy', 'minor'].map(kind => [kind, groups.filter(group => group.kind === kind && group.areas.includes('production')).length]))
const lines = [
  '# 103 — 全库防御逻辑覆盖审计报告', '',
  `本轮完成固定工作区快照的只读审计：**${summary.files} 个 TS/JS/Vue 文件、${summary.categoryChecks} 个文件×类别记录**，另固定 ${summary.contextFiles} 个配置/资源/说明文件的哈希用于核对合同。受审源码、测试及上下文文件均未变化，没有新增范围外源码。`, '',
  `归并后确证 **${summary.rootCauseGroups} 个主题**：${summary.productionGroups} 个涉及运行代码，${summary.toolingOnlyGroups} 个仅涉及测试/实验/构建验证。按性质为 ${summary.kinds.behavior} 组行为缺陷、${summary.kinds.redundancy} 组重复或无效逻辑、${summary.kinds.minor} 处低影响小项。原始 ${summary.rawFindings} 条分区记录中，同一根因的多处位置已合并；这些数不是“新增问题数”或可直接删掉的条件数。`, '',
  `涉及运行代码的 ${summary.productionGroups} 个主题中，${productionCounts.behavior} 组影响行为、${productionCounts.redundancy} 组是重复/无效逻辑、${productionCounts.minor} 处是低影响整理。余下工具主题单独标注，未混算成生产缺陷。`, '',
  '**本轮没有修复实现。** 行为缺陷含“缺少真正必要边界”的情况，不能把它们当作删除校验任务。小项是可读性/维护机会，收益与行为缺陷分开。', '',
  '## 优先处理的行为风险', '',
  '- 合法原型同名键在 JSON、投影、表单、端口与工具统计中读写失配；已有隔离复现观察到数据丢失和进程内原型字段被写入。',
  '- 合法 A 工作授权搭配 B Operation 身份时，在最终拒绝前已经读取并缓存了 B 的外部来源。',
  '- 输入 JSON 的非法 UTF-8 被替换后继续处理；Host 初领部分标识允许数字进入 runner；Map 响应缺少实际 reader 必需的边日期仍获接纳。',
  '- 混合 JSON 枚举经字符串化选择错值；切换 Run 后迟到控制权仍获接纳续租；拖动期间卸载后仍处理事件直到鼠标松开。',
  '- 次生清理覆盖主错分布于 SSE、启动入口及验证工具；资源取得后清理责任建立过晚的问题单列。', '',
  '## 范围、方法和完成含义', '',
  `文件组成：${summary.runtimeSourceFiles} 个运行端源码/声明文件、${summary.areas.implementation - summary.runtimeSourceFiles} 个根构建配置/验证脚本、${summary.areas.test} 个测试文件、${summary.areas.experiment} 个实验文件。第三方依赖、生成产物、用户数据库与历史开发文档不作为当前实现审计范围；个别已安装库函数仅用于验证调用假设。`, '',
  'F=默认值/强转；E=异常与清理；V=校验归属；S=状态不变量/死分支/兼容；P=重复解析/遍历/读取；K=字典自有键/指针；L=生命周期/身份代次。逐文件记录包含实际依据；没有相关运行逻辑的类别可以明确不适用。', '',
  `通用 AST 索引有 ${summary.genericAstCandidates} 个表达式候选，仅作导航；8 条高信号规则的 ${summary.highSignalCandidates} 个候选已逐条归类：${summary.ruleDispositions.confirmed} 个位置归入确证主题，${summary.ruleDispositions.retained} 个保留，${summary.ruleDispositions.unresolved} 个证据不足。位置数不等于独立问题数，也不证明所有表达式已自动判定。Vue 模板、调用链及嵌入测试代码仍由人工阅读补齐。`, '',
  '覆盖闭环表示：固定文件清单及七类记录齐全、已知清单逐项对账、同类横扫、确证主题有来源与证据、必要保留及证据不足单独记录、交叉复查、最终源码哈希一致。**不宣称证明全库从此没有任何遗漏。**', '',
  '## 模块×类别覆盖', '',
  '单元格为“已审阅／不适用”文件数；不表示测试通过数或缺陷数。每文件实际依据见 [coverage.json](./coverage.json) 及相应 scope 记录。', '',
  '| 模块 | 文件数 | F | E | V | S | P | K | L |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
]
for (const name of families) {
  const rows = coverage.files.filter(row => family(row.file) === name)
  const cells = inventory.categories.map(category => `${rows.filter(row => row.categories[category].status === 'reviewed').length}/${rows.filter(row => row.categories[category].status === 'not-applicable').length}`)
  lines.push(`| ${cell(name)} | ${rows.length} | ${cells.join(' | ')} |`)
}
lines.push('', '## 确证主题索引', '', '| ID | 性质 | 范围 | 主题 |', '|---|---|---|---|')
for (const group of groups) lines.push(`| [${group.id}](#${group.id.toLowerCase()}) | ${names[group.kind]} | ${scopeLabels(group)} | ${cell(group.title)} |`)
lines.push('', '## 完整证据与建议', '')
for (const group of groups) {
  lines.push(`<a id="${group.id.toLowerCase()}"></a>`, `### ${group.id} — ${group.title}`, '',
    `性质：${names[group.kind]}。范围：${scopeLabels(group)}。原始记录：${group.rawIds.join('、')}。`, '',
    '位置：' + group.sites.map(source).join('；') + '。', '')
  for (const item of group.items) {
    lines.push(`**${item.id}：${item.title}**`, '', text(item.evidence), '', `建议：${text(item.proposedChange)}`, '', `必须保留：${text(item.boundariesToKeep)}`, '')
    if (item.reproduction) lines.push(`证据入口：${text(item.reproduction)}`, '')
    if (item.relatedSitesStaticOnly) lines.push('同类仅静态核对、未声称逐入口复现：' + item.relatedSitesStaticOnly.map(site => source({ ...site, file: site.file.startsWith(inventory.root + '/') ? site.file.slice(inventory.root.length + 1) : site.file })).join('；') + '。', '')
  }
}
lines.push('## 前轮 14 组主要问题与 7 处小项对账', '', '全部 21 条已按当前源码重新确认。原条目与本轮合并主题的对应如下；保留它们不表示本轮已经修复。', '', '| 原条目 | 内容 | 本轮主题 |', '|---|---|---|')
for (const item of prior) lines.push(`| ${item.id} | ${cell(item.title)} | [${item.groupId}](#${item.groupId.toLowerCase()})（${item.rawId}） |`)
lines.push('', '## 必要保留与证据不足', '',
  '鉴权/授权写栅栏、Receipt 优先与输入摘要、CAS 最终条件、真实历史/可选字段、跨异步阶段的身份与租约复核、未知存储/响应边界、导入重映射后新值校验，均按实际合同保留。不同阶段或不同值的验证没有仅凭语法相似列为重复。', '',
  '完整保留、待确认及调用链依据见 [decisions-and-flows.json](./decisions-and-flows.json)。下列待确认/排除项不作为删除建议：', '')
for (const item of unresolvedRows) lines.push(`- ${cell(item.topic || item.question || item.title || item.id)}：${text(item.limit || item.evidence || item.reason || item.decision || item.resolution || item.basis)}（${item.scope}）`)
lines.push('', '高信号规则仍有两处实际清理双失败可达性证据不足，保留原实现：', '')
for (const item of read('rule-review.json').candidates.filter(row => row.disposition === 'unresolved')) lines.push(`- ${item.id}：${item.basis}`)
lines.push('', '## 复现与限制', '',
  `${runs.length} 份隔离复现脚本最终组合均正常退出；命令、输出、stderr、退出码与时间见 [reproduction-runs.json](./reproduction-runs.json)。**这是观察缺陷/重复工作的审计证据，不是修复后的产品绿色验收。**`, '',
  '复现使用实际导出函数、实际公共客户端、受控回环 HTTP、已有存储/runner seam、Vue 内存 renderer，或精确源码函数体的受控依赖。每份记录分别注明这些层次；没有运行真实 Mongo/Rabbit/模型/浏览器/桌面打包，也没有把函数体故障注入称作完整集成测试。原型字段只在自有子进程内使用并清理。', '',
  '本轮未重跑产品测试套件，未用历史 370 项测试通过充当当前证明。没有改业务/测试/构建实现，所以本轮验证针对审计工件、隔离复现与源码未变性。', '',
  '语义限制包括：第三方 SDK 的全部跨进程错误传播、真实浏览器/GPU/桌面生命周期、任意部署历史数据及全部故障组合未被穷举。尚不能证明多余的行为保留或明确列为证据不足，未以“看着像兜底”删除。', '',
  '## 可核对工件与重跑', '',
  '- [inventory.json](./inventory.json)：固定清单、SHA-256、函数及导入索引；[coverage.json](./coverage.json)：301×7 记录。',
  '- [findings.json](./findings.json)：合并主题及全部原始证据；[raw-findings.json](./raw-findings.json)：分区原始记录；[prior-findings.json](./prior-findings.json)：21 条对账。',
  '- [rule-candidates.json](./rule-candidates.json) / [rule-review.json](./rule-review.json)：214 个高信号候选与逐项结论；[candidate-index.json](./candidate-index.json)：通用 AST 导航。',
  '- [decisions-and-flows.json](./decisions-and-flows.json)：必要保留、待确认及完整调用链；`cross-review*.json` / `runtime-cross-review.json`：独立交叉记录。',
  '- [verification.json](./verification.json)：覆盖无空项、源码/上下文无漂移、无范围外新增源码、候选无漏项的最终结果。', '',
  '```sh', 'node develop-docs/103-全库审计/candidate-rules.cjs', 'node develop-docs/103-全库审计/run-reproductions.cjs', 'node develop-docs/103-全库审计/finish-audit.cjs --final', 'node develop-docs/103-全库审计/render-report.cjs', '```', '',
  '`index-sources.cjs` 是建立新审计基线的工具，会重写初始清单；验证本轮时不要用它替代哈希核验。源码改变后，本轮结论不能自动沿用，应重新审核受影响文件与调用链。', '',
  '本轮只新增 103 审计工件并维护编号。未提交、推送、部署或迁移用户数据。', '',
)
fs.writeFileSync(path.join(__dirname, 'audit-report.md'), lines.join('\n'))
console.log(JSON.stringify({ report: 'audit-report.md', groups: groups.length, files: summary.files, rules: summary.highSignalCandidates }))
