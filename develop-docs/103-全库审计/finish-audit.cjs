// 汇总只读审计并核对覆盖、候选闭环及固定源码基线；不修改任何受审实现。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'))
const save = (file, value) => fs.writeFileSync(path.join(__dirname, file), JSON.stringify(value, null, 2) + '\n')
const inventory = read('inventory.json')
const categories = inventory.categories
const scopeNames = ['scope-domain.json', 'scope-runtime.json', 'scope-ui.json', 'scope-root.json', 'scope-root-experiments.json', 'scope-ui-browser.json', 'scope-ui-infrastructure.json']
const scopes = scopeNames.map(name => ({ name, data: read(name) }))
const completed = value => value && ['reviewed', 'not-applicable'].includes(value.status) && typeof value.basis === 'string' && value.basis.trim().length > 0
function relative(file) {
  if (file.startsWith(inventory.root + '/')) return file.slice(inventory.root.length + 1)
  if (file.startsWith(root + '/')) return file.slice(root.length + 1)
  return file
}
const byFile = new Map(inventory.files.map(file => [file.file, file]))
const coverage = inventory.files.map(file => {
  const rows = scopes.flatMap(scope => scope.data.files.filter(row => row.file === file.file).map(row => ({ scope: scope.name, row })))
  const checks = Object.fromEntries(categories.map(category => {
    const matches = rows.filter(entry => completed(entry.row.categories[category]))
    return [category, matches.length ? { status: matches[0].row.categories[category].status,
      basis: matches[0].row.categories[category].basis, sourceRecords: matches.map(entry => entry.scope) } : { status: 'pending', basis: '', sourceRecords: [] }]
  }))
  return { file: file.file, owner: file.owner, area: file.area, sha256: file.sha256, lines: file.lines, categories: checks }
})
const pending = coverage.flatMap(row => categories.filter(category => !completed(row.categories[category])).map(category => ({ file: row.file, category })))
const drift = []
for (const item of [...inventory.files, ...inventory.supportFiles]) {
  const target = path.join(root, item.file)
  if (!fs.existsSync(target)) { drift.push({ file: item.file, change: 'missing' }); continue }
  if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== item.sha256) drift.push({ file: item.file, change: 'changed' })
}
const current = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
const addedCode = current.filter(file => !file.startsWith('develop-docs/') && /\.(?:[cm]?js|[cm]?tsx?|vue)$/.test(file) && !byFile.has(file))
const raw = scopes.flatMap(scope => scope.data.findings.map(finding => ({ ...finding, sourceRecord: scope.name,
  sites: finding.sites.map(site => ({ ...site, file: relative(site.file) })) })))
const rawIds = new Set()
for (const item of raw) {
  assert.equal(rawIds.has(item.id), false, 'Duplicate raw finding ' + item.id)
  rawIds.add(item.id)
  assert.ok(item.evidence && item.proposedChange && item.boundariesToKeep, 'Finding lacks evidence/change/boundaries: ' + item.id)
  for (const site of item.sites) {
    assert.ok(byFile.has(site.file), 'Unknown finding source: ' + item.id + ' ' + site.file)
    assert.ok(Number.isInteger(site.line) && site.line >= 1 && site.line <= byFile.get(site.file).lines, 'Invalid finding line: ' + item.id)
  }
}
const mergeSets = [
  { title: '动态字典没有按自有字段读写，导致合法同名键丢失、类型失配或原型污染', ids: ['P01', 'D04', 'R05', 'U10', 'U13', 'E05'] },
  { title: '次生清理失败覆盖主错误；部分路径还跳过后续清理', ids: ['P05', 'U11', 'R07', 'E02'] },
  { title: '取得资源后初始化清理责任建立过晚，中途失败遗留自有资源', ids: ['PT01', 'E03'] },
  { title: '私有分位数 helper 在已保证非空/有效分位的分支保留不可达回落', ids: ['B02', 'E06'] },
]
const consumed = new Set(), groups = []
function areas(item) {
  return [...new Set(item.sites.map(site => site.file.startsWith('tests/') ? 'test' : site.file.startsWith('experiments/') ? 'experiment'
    : site.file.startsWith('scripts/') || !site.file.includes('/') ? 'build-verification' : 'production'))]
}
function addGroup(title, items) {
  const kinds = new Set(items.map(item => item.kind))
  groups.push({ id: '', title, kind: kinds.has('behavior') ? 'behavior' : kinds.has('redundancy') ? 'redundancy' : 'minor',
    rawIds: items.map(item => item.id), areas: [...new Set(items.flatMap(areas))],
    sites: [...new Map(items.flatMap(item => item.sites).map(site => [`${site.file}:${site.line}`, site])).values()], items })
}
for (const merge of mergeSets) {
  const items = merge.ids.map(id => { const found = raw.find(item => item.id === id); assert.ok(found, 'Missing merge member ' + id); consumed.add(id); return found })
  addGroup(merge.title, items)
}
for (const item of raw.filter(item => !consumed.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))) addGroup(item.title, [item])
groups.forEach((group, index) => { group.id = 'G' + String(index + 1).padStart(2, '0') })
const aliases = Object.fromEntries(groups.flatMap(group => group.rawIds.map(id => [id, group.id])))
const priorTopics = [
  ['Q01', '合法端口名与原型同名导致运行报错', 'P01'], ['Q02', 'UI原型同名键写入丢失/继承对象写入', 'U10'],
  ['Q03', '通配资产媒体约束失效', 'D03'], ['Q04', 'SSE次生清理覆盖协议错误', 'U11'],
  ['Q05', '删除资产逐图编译目录', 'D01'], ['Q06', '候选即时自动发布重复解析与扫描', 'D02'],
  ['Q07', 'HTTP委托重复解析信封', 'R02'], ['Q08', 'Host续租同响应重复校验', 'R01'],
  ['Q09', '证据输入重复对象形状检查', 'P03'], ['Q10', '客户端续租DTO重复扫描', 'U05'],
  ['Q11', '运行目录Map身份二验', 'U01'], ['Q12', '来源定位修改字段双解析', 'U02'],
  ['Q13', 'Reader ready后重新证明上下文', 'U03'], ['Q14', '连接成功时死active清理', 'U04'],
  ['Q15', '动态字段添加不可达schema回落', 'U06'], ['Q16', '单页可打开重复loading检查', 'U07'],
  ['Q17', '基线单根长度重复检查', 'U08'], ['Q18', '同一读取异常重复归一化', 'U09'],
  ['Q19', '理由重复非空检查', 'PM01'], ['Q20', '固定collect又防御其他方法', 'PM02'],
  ['Q21', '布局已存在父节点的零回落遗留', 'U12'],
]
const prior = priorTopics.map(([id, title, rawId]) => { assert.ok(aliases[rawId], 'Unclosed prior finding ' + id); return { id, title, rawId, groupId: aliases[rawId], disposition: 'reconfirmed', note: '本轮只读复核，代码未修改；同根项可能合并，非本轮新增问题。' } })
const rules = read('rule-candidates.json')
const ruleRecords = ['rule-review-root.json', 'rule-review-domain.json', 'rule-review-runtime.json', 'rule-review-ui-domain.json']
  .flatMap(name => read(name).candidates.map(row => ({ ...row, sourceRecord: name })))
const ruleIds = new Set(rules.candidates.map(row => row.id)), seenRuleIds = new Set()
for (const row of ruleRecords) {
  assert.ok(ruleIds.has(row.id) && !seenRuleIds.has(row.id), 'Unknown/duplicate reviewed rule candidate ' + row.id)
  assert.ok(['confirmed', 'retained', 'unresolved'].includes(row.disposition) && typeof row.basis === 'string' && row.basis.trim().length > 0, 'Incomplete rule ' + row.id)
  if (row.disposition === 'confirmed') assert.ok(row.relatedFindings.length && row.relatedFindings.every(id => rawIds.has(id)), 'Orphan confirmed rule ' + row.id)
  seenRuleIds.add(row.id)
}
const ruleMissing = rules.candidates.filter(row => !seenRuleIds.has(row.id)).map(row => row.id)
const summary = { generatedAt: new Date().toISOString(), files: coverage.length, categoryChecks: coverage.length * categories.length,
  areas: Object.fromEntries(['implementation', 'test', 'experiment'].map(area => [area, coverage.filter(row => row.area === area).length])),
  runtimeSourceFiles: coverage.filter(row => row.area === 'implementation' && !row.file.startsWith('scripts/') && row.file.includes('/')).length,
  rawFindings: raw.length, rootCauseGroups: groups.length, kinds: Object.fromEntries(['behavior', 'redundancy', 'minor'].map(kind => [kind, groups.filter(group => group.kind === kind).length])),
  productionGroups: groups.filter(group => group.areas.includes('production')).length, toolingOnlyGroups: groups.filter(group => !group.areas.includes('production')).length,
  genericAstCandidates: read('candidate-index.json').candidates.length, highSignalCandidates: rules.candidates.length,
  ruleDispositions: Object.fromEntries(['confirmed', 'retained', 'unresolved'].map(kind => [kind, ruleRecords.filter(row => row.disposition === kind).length])),
  priorFindingsReconciled: prior.length, contextFiles: inventory.supportFiles.length, pending, drift, addedCode, ruleMissing }
save('coverage.json', { categories, files: coverage })
save('raw-findings.json', { findings: raw })
save('findings.json', { groups, aliases })
save('prior-findings.json', { prior })
save('rule-review.json', { candidates: ruleRecords })
save('verification.json', summary)
console.log(JSON.stringify(summary))
if (process.argv.includes('--final')) {
  assert.equal(pending.length, 0, 'Some file/category checks remain pending')
  assert.equal(drift.length, 0, 'Audited implementation/context changed since baseline')
  assert.equal(addedCode.length, 0, 'New source file is outside fixed audit inventory')
  assert.equal(ruleMissing.length, 0, 'High signal candidate review incomplete')
}
