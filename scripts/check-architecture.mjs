// 静态检查模块依赖方向、资源归属及不同运行入口的依赖闭包隔离。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json')), ts = require('typescript')
const files = /* 项目根目录下的相对目录，用于递归枚举文件。 */ directory => /* 递归列出项目相对文件路径，供模块归属和资源检查使用。 */  readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap(/* 当前目录的 Dirent，按文件或子目录展开相对路径。 */ entry => /* 目录继续递归，文件转换为相对项目路径。 */  entry.isDirectory() ? files(directory + '/' + entry.name) : [directory + '/' + entry.name])
function imports(/* 需要解析依赖的项目相对源码路径。 */ file) {
  // 解析文件导入，区分外部包与本地模块并拒绝无法解析的本地路径。
  const text = readFileSync(path.join(root, file), 'utf8')
  return ts.preProcessFile(text, true, true).importedFiles.map(/* TypeScript 预处理器识别的导入引用，可能是外部包或相对路径。 */ item => {
    // 外部导入保留包名，本地导入按候选扩展名定位真实文件。
    if (!item.fileName.startsWith('.')) return { external: item.fileName }
    const base = path.resolve(root, path.dirname(file), item.fileName)
    const found = [base, base + '.ts', base + '.vue', base + '/index.ts'].find(/* 尝试解析导入的绝对路径候选，需要确认确实为文件。 */ value => /* 选择存在且确为文件的导入候选。 */  existsSync(value) && statSync(value).isFile())
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
  assert(!files(directory).some(/* 业务目录中发现的相对文件路径，用于排除提示词资源。 */ file => /* 检查业务层是否夹带 JSON 或 prompts 资源。 */  file.endsWith('.json') || file.split('/').includes('prompts')), 'Business modules must not own prompt resources: ' + directory)
}
let checked = 0
for (const directory of ['backend', 'client', 'contracts', 'apps/ui', 'platform']) {
  for (const file of files(directory).filter(/* 枚举到的相对路径，仅保留受架构扫描支持的源码扩展名。 */ file => /* 仅对支持的代码和 Vue 文件执行依赖规则检查。 */  /\.(ts|vue|mjs)$/.test(file))) {
    const rule = Object.entries(rules).find((/* 依赖规则条目，仅提取所属目录前缀与当前文件匹配。 */ [prefix]) => /* 寻找文件所属目录的依赖规则。 */  file.startsWith(prefix))
    assert(rule, 'Module has no ownership rule: ' + file)
    for (const dependency of imports(file)) {
      if (dependency.file) assert(rule[1].some(/* 当前模块允许的目录或精确文件路径，用于检查导入目标。 */ prefix => /* 按目录前缀或精确文件名判断依赖是否被允许。 */  prefix.endsWith('/') ? dependency.file.startsWith(prefix) : dependency.file === prefix), 'Forbidden dependency: ' + file + ' → ' + dependency.file)
      if (/^backend\/(application|modules|ports)\//.test(file) && dependency.external) assert(dependency.external.startsWith('node:'), 'Business module loads an external runtime: ' + file + ' → ' + dependency.external)
      if (file.startsWith('backend/execution/')) assert(!/^(mongoose|mongodb|amqplib)(\/|$)/.test(dependency.external ?? ''), 'Execution loads a persistence/queue driver: ' + file)
    }
    checked++
  }
}
function closure(/* 需要检查依赖闭包的运行入口相对路径。 */ entry) {
  // 从运行入口收集可达源码与外部包，用于检测不应随入口加载的能力。
  const seen = new Set(), external = new Set()
  function visit(/* 递归遍历到的本地源码路径，已访问项不再展开。 */ file) {
    // 记录尚未访问的文件并递归展开其本地导入，避免依赖循环导致无限遍历。
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
assert(![...serverApi.seen].some(/* 图服务可达的项目文件，用于检测执行模块越界。 */ file => /* 检查图 API 的依赖闭包是否加载执行模块。 */  file.startsWith('backend/execution/')), 'Graph server loads execution code')
assert(![...serverApi.external].some(/* 图服务可达的外部依赖名，用于检测 DSH 执行包。 */ name => /* 检查图 API 是否依赖 DSH 执行包。 */  name.startsWith('@deepseek-ai/')), 'Graph server loads DSH execution')
assert(![...serverHost.seen].some(/* 执行 Host 可达的项目文件，用于检测存储适配器越界。 */ file => /* 检查执行 Host 是否直接加载持久化适配器。 */  file.startsWith('backend/adapters/storage/')), 'Execution host loads storage code')
assert(![...serverHost.external].some(/* 执行 Host 可达的包名，用于检测 Mongo 驱动。 */ name => /* 检查执行 Host 是否加载 Mongo 数据库驱动。 */  /^(mongoose|mongodb)(\/|$)/.test(name)), 'Execution host loads the database driver')
console.log(JSON.stringify({ checkedModules: checked, localModules: local.seen.size, localExternal: [...local.external].sort(), boundaries: 'passed' }, null, 2))
