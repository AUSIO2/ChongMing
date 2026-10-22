// 只读复现已安装 Vite 的端口装配；不启动浏览器、数据库或监听端口。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const load = createRequire(path.resolve(__dirname, '../../package.json'))
const ts = load('typescript')
const vitePackage = load.resolve('vite/package.json')
const nodeRoot = path.join(path.dirname(vitePackage), 'dist/node')
const filename = fs.readdirSync(path.join(nodeRoot, 'chunks')).map(name => path.join(nodeRoot, 'chunks', name))
  .find(file => file.endsWith('.js') && fs.readFileSync(file, 'utf8').includes('async function startServer(server, inlinePort)'))
assert.ok(filename)
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startServer')
assert.ok(declaration)
const constants = fs.readFileSync(path.join(nodeRoot, 'constants.js'), 'utf8')
const match = /const DEFAULT_DEV_PORT = (\d+);/.exec(constants)
assert.ok(match)
const defaultPort = Number(match[1])
const results = []
const startServer = new Function('resolveHostname', 'httpServerStart', 'DEFAULT_DEV_PORT', `${declaration.getText(source)}; return startServer;`)(
  async host => ({ host }),
  async (_http, options) => { results.push(options); return options.port },
  defaultPort,
)
startServer({ httpServer: {}, config: { server: { host: '127.0.0.1', port: 0, strictPort: true }, logger: {} } }).then(() => {
  assert.equal(results[0].port, defaultPort)
  assert.notEqual(results[0].port, 0)
  console.log(JSON.stringify({ case: 'recovery-vite-port-zero', exactInstalledFunction: path.relative(path.resolve(__dirname, '../..'), filename) + ':startServer', configuredPort: 0, actualRequestedPort: results[0].port, strictPort: results[0].strictPort, opensNetworkListener: false }, null, 2))
}).catch(error => { console.error(error); process.exitCode = 1 })
