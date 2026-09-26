import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json')), ts = require('typescript')
// 用途：列出目录里的全部文件，供模块归属和资源检查使用。
const files = directory => readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(directory + '/' + entry.name) : [directory + '/' + entry.name])
// 用途：找出文件导入的本地代码和外部依赖，并报告不存在的导入路径。
function imports(file) {
  const text = readFileSync(path.join(root, file), 'utf8')
  return ts.preProcessFile(text, true, true).importedFiles.map(item => {
    if (!item.fileName.startsWith('.')) return { external: item.fileName }
    const base = path.resolve(root, path.dirname(file), item.fileName)
    const found = [base, base + '.ts', base + '.vue', base + '/index.ts'].find(value => existsSync(value) && statSync(value).isFile())
    assert(found, 'Unresolved module: ' + file + ' → ' + item.fileName)
    return { file: path.relative(root, found).split(path.sep).join('/') }
  })
}
const rules = {
  'backend/application/': ['backend/application/', 'backend/modules/', 'backend/ports/', 'contracts/'],
  'backend/modules/graph/': ['backend/modules/graph/', 'backend/modules/shared/', 'backend/ports/', 'contracts/'],
  'backend/modules/workspace/': [
    'backend/modules/workspace/', 'backend/modules/shared/', 'backend/modules/identity/identity-service.ts',
    'backend/modules/graph/graph-record.ts', 'backend/ports/', 'contracts/',
  ],
  'backend/modules/identity/': ['backend/modules/identity/', 'backend/modules/shared/', 'backend/ports/', 'contracts/'],
  'backend/modules/assets/': [
    'backend/modules/assets/', 'backend/modules/shared/', 'backend/modules/identity/identity-service.ts',
    'backend/modules/workspace/workspace-service.ts', 'backend/modules/workspace/workspace-input.ts',
    'backend/modules/graph/graph-input.ts', 'backend/modules/graph/graph-record.ts', 'backend/ports/', 'contracts/',
  ],
  'backend/modules/shared/': ['backend/modules/shared/', 'contracts/'],
  'backend/ports/': ['backend/ports/', 'backend/modules/graph/graph-record.ts', 'contracts/'],
  'backend/adapters/storage/mongo/': ['backend/adapters/storage/mongo/', 'backend/modules/', 'backend/ports/', 'contracts/'],
  'backend/adapters/storage/sqlite/': ['backend/adapters/storage/sqlite/', 'backend/modules/', 'backend/ports/', 'contracts/'],
  'backend/adapters/messaging/': ['backend/adapters/messaging/', 'backend/modules/', 'backend/ports/', 'contracts/'],
  'backend/adapters/sources/': ['backend/adapters/sources/', 'backend/modules/shared/domain-error.ts', 'backend/ports/', 'contracts/'],
  'backend/adapters/http/': ['backend/adapters/http/', 'backend/application/', 'backend/modules/', 'backend/ports/', 'contracts/'],
  'backend/execution/': ['backend/execution/', 'backend/ports/', 'backend/modules/shared/domain-error.ts', 'contracts/'],
  'client/': ['client/', 'contracts/'],
  'contracts/': ['contracts/'],
  'apps/ui/': ['apps/ui/', 'client/', 'contracts/'],
  'platform/node/': ['platform/node/', 'contracts/'],
}
for (const obsolete of [
  'backend/core', 'backend/storage', 'backend/messaging', 'backend/api', 'backend/worker',
  'apps/server', 'apps/local', 'apps/dsh', 'apps/ui/stores', 'apps/ui/components/client',
  'client/api.ts', 'apps/ui/api.ts', 'apps/ui/views/ClientHome.vue',
]) {
  assert(!existsSync(path.join(root, obsolete)), 'Obsolete module path retained: ' + obsolete)
}
for (const directory of ['backend/application', 'backend/modules', 'backend/ports']) {
  assert(!files(directory).some(file => file.endsWith('.json') || file.split('/').includes('prompts')), 'Business modules must not own prompt resources: ' + directory)
}
let checked = 0
for (const directory of ['backend', 'client', 'contracts', 'apps/ui', 'platform']) {
  for (const file of files(directory).filter(file => /\.(ts|vue|mjs)$/.test(file))) {
    const rule = Object.entries(rules).find(([prefix]) => file.startsWith(prefix))
    assert(rule, 'Module has no ownership rule: ' + file)
    for (const dependency of imports(file)) {
      if (dependency.file) assert(rule[1].some(prefix => prefix.endsWith('/') ? dependency.file.startsWith(prefix) : dependency.file === prefix), 'Forbidden dependency: ' + file + ' → ' + dependency.file)
      if (/^backend\/(application|modules|ports)\//.test(file) && dependency.external) assert(dependency.external.startsWith('node:'), 'Business module loads an external runtime: ' + file + ' → ' + dependency.external)
      if (file.startsWith('backend/execution/')) assert(!/^(mongoose|mongodb|amqplib)(\/|$)/.test(dependency.external ?? ''), 'Execution loads a persistence/queue driver: ' + file)
    }
    checked++
  }
}
// 用途：沿着导入关系，收集一个运行入口能加载的全部代码和外部依赖。
function closure(entry) {
  const seen = new Set(), external = new Set()
  // 用途：记录当前文件，并继续检查它尚未访问过的依赖。
  function visit(file) {
    if (seen.has(file)) return
    seen.add(file)
    if (!/\.(ts|vue|mjs)$/.test(file)) return
    for (const dependency of imports(file)) { if (dependency.file) visit(dependency.file); else external.add(dependency.external) }
  }
  visit(entry); return { seen, external }
}
const local = closure('apps/desktop/local-service-entry.ts')
for (const file of local.seen) assert(!/^(apps\/graph-server\/|backend\/adapters\/storage\/mongo\/|backend\/adapters\/messaging\/(rabbitmq|mongo-outbox)\.ts)/.test(file), 'Local entry loads collaboration code: ' + file)
for (const name of local.external) assert(!/^(mongoose|mongodb|amqplib)(\/|$)/.test(name), 'Local entry loads collaboration driver: ' + name)
for (const entry of ['apps/desktop/main.ts', 'apps/desktop/preload.ts', 'apps/cli/main.ts', 'apps/ui/main.ts']) {
  const client = closure(entry)
  for (const file of client.seen) assert(!file.startsWith('backend/'), 'Client entry loads backend code: ' + entry + ' → ' + file)
}
const serverApi = closure('apps/graph-server/main.ts'), serverHost = closure('apps/execution-host/main.ts')
assert(![...serverApi.seen].some(file => file.startsWith('backend/execution/')), 'Graph server loads execution code')
assert(![...serverApi.external].some(name => name.startsWith('@deepseek-ai/')), 'Graph server loads DSH execution')
assert(![...serverHost.seen].some(file => file.startsWith('backend/adapters/storage/')), 'Execution host loads storage code')
assert(![...serverHost.external].some(name => /^(mongoose|mongodb)(\/|$)/.test(name)), 'Execution host loads the database driver')
console.log(JSON.stringify({ checkedModules: checked, localModules: local.seen.size, localExternal: [...local.external].sort(), boundaries: 'passed' }, null, 2))
