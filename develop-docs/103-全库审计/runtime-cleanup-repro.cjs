// 精确入口函数体的受控双故障；不打开真实数据库/端口或写受审文件。
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const root = path.resolve(__dirname, '../..')
function extract(file, name) {
  const ast = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const node = ast.statements.find(x => ts.isFunctionDeclaration(x) && x.name?.text === name)
  if (!node) throw new Error('Expected exact audited function')
  return ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
}
async function run() {
  const primary = new Error('controlled-startup-primary'), secondary = new Error('controlled-cleanup-secondary')
  const graph = new Function('localReadConfiguration', 'storeCreateConnection', 'applicationCreateService', 'leaseMs', 'reporter', 'process',
    extract('apps/graph-server/main.ts', 'apiStartProcess') + '; return apiStartProcess;')(
    async () => ({ settings: {}, secrets: {} }),
    async () => ({ close: async () => { throw secondary } }),
    () => ({ initialize: async () => { throw primary } }),
    15000, {}, { env: { CHONGMING_AMQP_URL: 'amqp://audit-unused' } },
  )
  const local = new Function('sqliteCreatePersistence', 'applicationCreateLocalService', 'path', 'exports',
    extract('apps/local-server/runtime.ts', 'localCreateRuntime') + '; return localCreateRuntime;')(
    () => ({ close: async () => { throw secondary } }),
    () => ({ initialize: async () => { throw primary }, closeMessaging: async () => {} }),
    path, {},
  )
  const openPage = new Function(extract('tests/browser/workspace-recovery.spec.ts', 'recoveryOpenPage') + '; return recoveryOpenPage;')()
  const browser = { newContext: async () => ({ newPage: async () => { throw primary }, close: async () => { throw secondary } }) }
  const output = []
  for (const [name, action] of [['graph-api', () => graph()], ['local-runtime', () => local({ directory: '/unused-audit-directory' })], ['recovery-page', () => openPage(browser, {}, 'unused-map')]]) {
    try { await action(); throw new Error('Expected startup rejection') }
    catch (error) { output.push({ case: name, primaryRetained: Boolean(error === primary || error.cause === primary || error.errors?.includes(primary)), observedCleanupInstead: error === secondary, observedName: error.name }) }
  }
  console.log(JSON.stringify(output, null, 2))
}
run().catch(error => { console.error(error); process.exitCode = 1 })
