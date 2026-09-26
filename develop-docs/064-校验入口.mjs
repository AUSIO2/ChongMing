import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const ts = require('typescript')
// 用途：读取仓库内的文件，供依赖和入口检查使用。
const read = file => readFileSync(path.join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json')), lock = JSON.parse(read('package-lock.json'))
for (const dependency of ['@langchain/core', '@langchain/langgraph', '@langchain/openai', 'langsmith', 'vite-plugin-electron-renderer']) {
  assert(!pkg.dependencies?.[dependency] && !pkg.devDependencies?.[dependency], 'Obsolete direct dependency: ' + dependency)
  assert(!lock.packages['node_modules/' + dependency], 'Obsolete installed dependency: ' + dependency)
}
const roots = ['apps/cli/main.ts', 'apps/desktop/main.ts', 'apps/desktop/preload.ts', 'apps/ui/main.ts']
const counts = {}
for (const entry of roots) {
  const seen = new Set()
  // 用途：沿着当前客户端入口的导入关系，检查是否混入后端或执行依赖。
  function visit(file) {
    if (seen.has(file)) return
    seen.add(file)
    assert(!file.startsWith('backend/'), entry + ' must not load backend: ' + file)
    if (!/\.(ts|vue)$/.test(file)) return
    const source = read(file)
    const imports = ts.preProcessFile(source, true, true).importedFiles
    for (const item of imports) {
      const specifier = item.fileName
      if (!specifier.startsWith('.')) {
        assert(!/^(mongoose|mongodb|amqplib|@deepseek-ai\/|@langchain\/|langsmith)/.test(specifier), entry + ' imports execution/storage dependency: ' + specifier)
        continue
      }
      const base = path.resolve(root, path.dirname(file), specifier)
      const resolved = [base, base + '.ts', base + '.vue', path.join(base, 'index.ts')].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
      assert(resolved, 'Unresolved import: ' + file + ' → ' + specifier)
      visit(path.relative(root, resolved))
    }
  }
  visit(entry); counts[entry] = seen.size
}
const desktopModules = new Set([
  'main.ts', 'preload.ts', 'ipc-channels.ts', 'ipc-handlers.ts',
  'connection-manager.ts', 'credential-store.ts', 'local-service-process.ts', 'local-service-entry.ts',
])
for (const file of readdirSync(path.join(root, 'apps/desktop'), { recursive: true })) {
  if (!String(file).endsWith('.ts')) continue
  assert(desktopModules.has(String(file)), 'Unknown desktop module retained: ' + file)
}
for (const directory of ['electron', 'server', 'src', 'tests/electron', 'tests/server']) {
  assert(!existsSync(path.join(root, directory)), 'Obsolete entry directory retained: ' + directory)
}
console.log(JSON.stringify({ dependencyBoundaries: 'passed', reachableFiles: counts }, null, 2))
