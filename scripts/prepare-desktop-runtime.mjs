// 准备独立 Node 服务目录、安装最小 DSH 依赖并打包桌面本地服务及必要资源。
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Desktop runtime preparation requires Node.js 24')
const output = path.join(root, '.desktop-runtime')
const lock = await readFile(path.join(root, 'package-lock.json'))
const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const runtimePackage = { name: 'chongming-local-runtime', private: true, version: rootPackage.version,
  dependencies: Object.fromEntries(['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh-tools'].map(name => /* 只将两个 DSH 包及项目锁定版本纳入随包运行时依赖清单。 */  [name, rootPackage.dependencies[name]])) }
const runtimeLock = JSON.parse(lock)
runtimeLock.name = runtimePackage.name
runtimeLock.packages[''] = { name: runtimePackage.name, version: runtimePackage.version, dependencies: runtimePackage.dependencies }
const identity = { version: 2, nodeVersion: process.version, platform: process.platform, arch: process.arch,
  lockHash: createHash('sha256').update(lock).digest('hex') }
let previous
try { previous = JSON.parse(await readFile(path.join(output, 'runtime.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
await mkdir(path.join(output, 'bin'), { recursive: true })
const binary = path.join(output, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
if (JSON.stringify(previous) !== JSON.stringify(identity)) {
  // 此目录仅存放生成产物，重装运行依赖不能改动项目自身已安装的原生依赖。
  await rm(path.join(output, 'node_modules'), { recursive: true, force: true })
  await cp(process.execPath, binary)
  await chmod(binary, 0o755)
  await writeFile(path.join(output, 'package.json'), JSON.stringify(runtimePackage, null, 2))
  await writeFile(path.join(output, 'package-lock.json'), JSON.stringify(runtimeLock))
  if (!process.env.npm_execpath) throw new Error('Run preparation through npm run desktop:prepare')
  execFileSync(binary, [process.env.npm_execpath, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: output, stdio: 'inherit', env: { ...process.env, PATH: path.dirname(binary) + path.delimiter + process.env.PATH, ELECTRON_RUN_AS_NODE: undefined },
  })
  await writeFile(path.join(output, 'runtime.json'), JSON.stringify(identity))
}
for (const name of ['mongoose', 'mongodb', 'amqplib', 'vue', 'pinia']) {
  if (existsSync(path.join(output, 'node_modules', name))) throw new Error('Unexpected local-runtime dependency: ' + name)
}
let license
for (const candidate of [process.env.CHONGMING_NODE_LICENSE, path.join(path.dirname(process.execPath), 'LICENSE'), path.join(path.dirname(process.execPath), '..', 'LICENSE')].filter(Boolean)) {
  try { license = await readFile(candidate); break } catch (error) { if (error.code !== 'ENOENT') throw error }
}
if (!license) throw new Error('Set CHONGMING_NODE_LICENSE to the license shipped with this Node runtime')
await writeFile(path.join(output, 'NODE-LICENSE'), license)
const actual = JSON.parse(execFileSync(binary, ['-p', 'JSON.stringify({nodeVersion:process.version,platform:process.platform,arch:process.arch})'], { encoding: 'utf8' }))
for (const key of ['nodeVersion', 'platform', 'arch']) if (actual[key] !== identity[key]) throw new Error('Bundled Node identity mismatch: ' + key)
await rm(path.join(output, 'backend'), { recursive: true, force: true })
await mkdir(path.join(output, 'service'), { recursive: true })
await build({ entryPoints: [path.join(root, 'apps/desktop/local-service-entry.ts')], outfile: path.join(output, 'service/main.mjs'),
  platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', sourcemap: false })
for (const file of ['dsh-business.patch.yml', 'dsh-business-plugin.mjs']) await cp(path.join(root, 'backend/execution/dsh', file), path.join(output, 'service', file))
console.log('Desktop runtime ready:', process.platform, process.arch, process.version)
