// 只在内存编译原实验入口，依赖注入只制造初始化/清理故障；不启动Mongo/HTTP或改受审文件。
// 运行：node --import tsx develop-docs/103-全库审计/repro-experiments.cjs
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
function load(relative, additions, stubs = {}, omitStart = false) {
  const file = path.join(root, relative)
  let source = fs.readFileSync(file, 'utf8')
  if (omitStart) {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    source = sf.statements.filter(statement => !ts.isExpressionStatement(statement)
      || !statement.getText(sf).startsWith('void start()')).map(statement => statement.getFullText(sf)).join('\n')
  }
  source += '\nexport { ' + additions.join(', ') + ' }\n'
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const originalRequire = createRequire(file), module = { exports: {} }
  const scopedRequire = name => Object.hasOwn(stubs, name) ? stubs[name] : originalRequire(name)
  new Function('require', 'module', 'exports', code)(scopedRequire, module, module.exports)
  return module.exports
}
function report(id, values) { console.log(JSON.stringify({ id, ...values })) }
async function main() {
  const loader = load('experiments/evidence-library-tests/load-target.ts', ['assertTarget'])
  const candidate = { info: { name: 'Audit fixture', backend: 'mongo', executionModel: ['remote'], isolated: true },
    workspaceId: 'one', otherWorkspaceId: 'two', request() {}, close() {},
    fixtures: Object.fromEntries(['createNode', 'updateClaim', 'deleteClaim', 'deleteMap', 'createAsset', 'deleteAsset', 'revoke', 'failNextCommit', 'seed'].map(name => [name, () => {}])),
    inspect: { counts() {}, telemetry() {} } }
  loader.assertTarget(candidate, 'mongo')
  report('E01-target-enum', { acceptedArray: Array.isArray(candidate.info.executionModel), executionModel: candidate.info.executionModel })

  const primary = new Error('PRIMARY_START_FAILURE'), secondary = new Error('SECONDARY_STOP_FAILURE')
  const fixture = load('experiments/evidence-library-tests/ui-fixture.ts', [], {
    'mongodb-memory-server': { MongoMemoryReplSet: class { async start() { throw primary } async stop() { throw secondary } } },
  })
  try { await fixture.evidenceCreateUiFixture() }
  catch (error) {
    const flattened = []
    const collect = value => { flattened.push(value); if (value instanceof AggregateError) value.errors.forEach(collect) }
    collect(error)
    report('E02-cleanup-primary', { thrown: error.message, includesPrimary: flattened.includes(primary), includesSecondary: flattened.includes(secondary) })
  }

  for (const [filename, moduleName, factoryName] of [
    ['ui-preview.ts', './ui-fixture', 'evidenceCreateUiFixture'],
    ['relations-preview.ts', './relations-fixture', 'evidenceCreateRelationFixture'],
    ['usage-preview.ts', './usage-fixture', 'evidenceCreateUsageFixture'],
  ]) {
    let closed = 0
    const preview = load('experiments/evidence-library-tests/' + filename, ['start'], {
      [moduleName]: { [factoryName]: async () => ({ async close() { closed++ } }) },
      'node:fs/promises': { ...require('node:fs/promises'), async mkdtemp() { throw new Error('MKTEMP_FAILURE') } },
    }, true)
    try { await preview.start() }
    catch (error) { report('E03-preview-init-window', { file: filename, error: error.message, fixtureCloseCalls: closed }) }
  }

  let sharedClosed = 0
  const usage = load('experiments/evidence-library-tests/usage-fixture.ts', [], {
    './relations-fixture': { async evidenceCreateRelationFixture() { return { connection: {}, async close() { sharedClosed++ } } } },
    '../../apps/graph-server/application': { applicationCreateService() { throw new Error('APP_CONSTRUCTOR_FAILURE') } },
  })
  try { await usage.evidenceCreateUsageFixture() }
  catch (error) { report('E03-usage-init-window', { error: error.message, sharedCloseCalls: sharedClosed }) }
  const defaults = JSON.parse(fs.readFileSync(path.join(root, 'resources/data-definitions/fact-checking.json'), 'utf8'))
  const opinion = defaults.dataTypes.find(type => type.id === 'factcheck.opinion')
  report('E04-retired-opinion-shape', { currentField: Object.hasOwn(opinion.schema.properties, 'evidenceClaimIds'),
    retiredField: Object.hasOwn(opinion.schema.properties, 'evidenceIds') })
  const driver = load('experiments/evidence-library-tests/stress.ts', ['measureRound'])
  for (const code of ['constructor', '__proto__']) {
    const context = { pending: new Set(), calls: 0, peakDriverRssBytes: 0, queryIds: new Set() }
    const target = { async request() { throw Object.assign(new Error('Controlled target failure'), { code }) } }
    const scenario = { roundTimeoutMs: 1_000, maxOperationsPerSecond: 1_000_000, requestTimeoutMs: 1_000, hotSetSize: null }
    const seeded = { entryRefs: [{ entryId: 'entry', contentDigest: 'digest' }] }
    const result = await driver.measureRound(context, target, scenario, seeded, 1, [{ operation: 'get', source: null, index: 0 }])
    report('E05-error-dictionary', { code, failed: result.operations.get.failed,
      hasOwnCounter: Object.hasOwn(result.operations.get.errors, code), counterType: typeof result.operations.get.errors[code] })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
