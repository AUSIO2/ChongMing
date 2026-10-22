// 只在进程内模拟资产读写，统计当前导入流程对同份内嵌附件的完整哈希次数。
// 运行：node --import tsx develop-docs/103-全库审计/repro-domain-import.cjs
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const crypto = require('node:crypto')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const localRequire = createRequire(path.join(root, 'package.json'))
const { assetsCreateService } = localRequire('./backend/modules/assets/asset-service.ts')
const file = path.join(root, 'tests/backend/modules/assets/bundle-v4.spec.ts')
const prefix = fs.readFileSync(file, 'utf8').split("describe('Portable v4 bundle codec'")[0]
  .replace(/import[^\n]*from 'vitest'\n/, '')
const moduleFixture = { exports: {} }
new Function('require', 'module', 'exports', ts.transpileModule(prefix + '\nexport { genericBundle }\n', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(createRequire(file), moduleFixture, moduleFixture.exports)
const bundle = moduleFixture.exports.genericBundle()
const bytes = Buffer.from(JSON.stringify(bundle))
const originalCreateHash = crypto.createHash
const stagingAsset = { _id: crypto.randomUUID(), workspaceId: 'staging', state: 'ready', blobId: 'bundle-blob',
  filename: 'bundle.json', mediaType: 'application/json', size: bytes.length,
  sha256: originalCreateHash('sha256').update(bytes).digest('hex') }
const ctx = { mutation: true, session: { inTransaction: () => true }, actor: { userId: 'owner' } }
const measurements = []
crypto.createHash = function (...args) {
  const hash = originalCreateHash(...args)
  const stack = new Error().stack
  if (/bundlesReadAsset|assetsReadChunks/.test(stack)) {
    const row = { source: stack.includes('bundlesReadAsset') ? 'bundle.asset.parse' : 'asset.stream.check', bytes: 0 }
    measurements.push(row)
    const originalUpdate = hash.update
    hash.update = function (value, ...rest) { row.bytes += Buffer.byteLength(value); return originalUpdate.call(this, value, ...rest) }
  }
  return hash
}
const tables = {
  control_assets: { get: async () => stagingAsset, insert: async () => {} },
  asset_receipts: { get: async () => null, insert: async () => {} },
  graphv3: {},
}
const database = { records: name => tables[name], graph: () => ({ create: async () => true }), blobs: {
  read: async function* () { yield bytes },
  write: async function (source) { for await (const chunk of source) void chunk; return 'embedded-blob' },
  remove: async () => true,
} }
const auth = { read: async () => ctx, transact: async (token, callback) => callback(ctx) }
const control = { requireRole: async () => {}, createWorkspace: async () => {} }
async function main() {
  try {
    const assets = assetsCreateService(database, auth, control, { readUrl: async () => '' })
    const result = await assets.importWorkspace('token', { requestId: crypto.randomUUID(), method: 'workspace.import', params: {
      id: crypto.randomUUID(), bundleAssetId: stagingAsset._id, stagingWorkspaceId: 'staging', name: null,
    } })
    console.log(JSON.stringify({ id: 'D07-import-bytes', importedAssets: result.data.assetIds.length,
      embeddedSize: bundle.assets[0].size, measurements,
      embeddedHashPasses: measurements.filter(row => row.bytes === bundle.assets[0].size).length }))
  } finally { crypto.createHash = originalCreateHash }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
