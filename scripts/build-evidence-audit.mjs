// 从已安装的官方SDK和stdx源码构建独立仓颉审计程序，并随包复制运行时与许可证。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const moduleDir = path.join(root, 'apps/evidence-audit-cj')
const targetDir = path.join(moduleDir, 'target')
const settingsFile = path.join(targetDir, 'local-build.json')
const { values } = parseArgs({ options: { sdk: { type: 'string' }, 'stdx-source': { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) {
  process.stdout.write('Usage: node scripts/build-evidence-audit.mjs --sdk SDK_ROOT --stdx-source STDX_SOURCE_ROOT\nSupports Cangjie 1.1.3 and stdx v1.1.3.1 on macOS arm64. Paths are remembered only in ignored target/local-build.json.\n')
  process.exit(0)
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This build currently supports macOS arm64; other platforms need their matching SDK/runtime build recipe.')
}
const previous = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
const sdk = path.resolve(values.sdk ?? process.env.CANGJIE_HOME ?? previous.sdk ?? '')
const stdx = path.resolve(values['stdx-source'] ?? process.env.CHONGMING_CANGJIE_STDX_SOURCE ?? previous.stdx ?? '')
const cjc = path.join(sdk, 'bin/cjc')
const sourceDir = path.join(stdx, 'src/stdx')
if (!existsSync(cjc) || !existsSync(path.join(sourceDir, 'encoding/json/native/json_string_escape.c'))) {
  throw new Error('Provide --sdk and --stdx-source for the downloaded matching official sources; see apps/evidence-audit-cj/README.md.')
}
const appleSdk = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8', timeout: 10_000 })
if (appleSdk.error || appleSdk.status !== 0 || !appleSdk.stdout.trim()) throw new Error('Install the Apple Command Line Tools before building the Cangjie module.')
const environment = { ...process.env, SDKROOT: appleSdk.stdout.trim(), CANGJIE_HOME: sdk, PATH: path.join(sdk, 'bin') + path.delimiter + process.env.PATH }

function run(/* 编译工具的可执行文件，调用时不启用shell。 */ executable,
  /* 作为独立argv传给工具的选项与源码路径。 */ args) {
  // 执行一次有界构建步骤，只有成功退出后才进入下一步。
  const result = spawnSync(executable, args, { cwd: moduleDir, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  if (result.stderr) process.stderr.write(result.stderr)
  return result.stdout.trim()
}
function sources(/* 只扫描当前包源文件的目录，不跨子包递归。 */ directory) {
  // 为同一仓颉包提供稳定排序的源文件列表，避免依赖shell通配符。
  return readdirSync(directory).filter(/* 当前目录项名称。 */ name => /* 只编译仓颉源文件。 */ name.endsWith('.cj')).sort().map(
    /* 包内源码的相对名称。 */ name => /* 转成编译器直接读取的绝对路径。 */ path.join(directory, name),
  )
}
function sha256(/* 需要写入构建证据的文件路径。 */ file) {
  // 对实际构建输入取摘要，便于将演示二进制追溯到源文件。
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const version = run(cjc, ['-v'])
if (!/Cangjie Compiler:\s*1\.1\.3\b/.test(version)) throw new Error(`Expected Cangjie 1.1.3, received ${version}`)
const deps = path.join(targetDir, 'deps')
const bin = path.join(moduleDir, 'bin')
const runtime = path.join(bin, 'runtime')
const licenses = path.join(bin, 'licenses')
for (const directory of [deps, bin, runtime, licenses]) mkdirSync(directory, { recursive: true })
const manifest = JSON.parse(readFileSync(path.join(moduleDir, 'toolchain-sources.json'), 'utf8'))
for (const [relative, expected] of Object.entries(manifest.stdx.sourceFilesSha256)) {
  if (sha256(path.join(stdx, relative)) !== expected) throw new Error(`stdx source does not match the pinned release: ${relative}`)
}
for (const [relative, expected] of Object.entries(manifest.sdk.runtimeFilesSha256)) {
  if (sha256(path.join(sdk, relative)) !== expected) throw new Error(`SDK runtime does not match the pinned release: ${relative}`)
}
const pinnedSources = Object.keys(manifest.stdx.sourceFilesSha256).sort()
const serializationSources = pinnedSources.filter(/* 固定标签内的源码相对路径。 */ file => /* 只选序列化包的仓颉源码。 */ file.startsWith('src/stdx/serialization/serialization/') && file.endsWith('.cj')).map(/* 已验证源码的相对路径。 */ file => /* 使用对应官方源码文件。 */ path.join(stdx, file))
const jsonSources = pinnedSources.filter(/* 固定标签内的源码相对路径。 */ file => /* 只选JSON包的仓颉源码。 */ file.startsWith('src/stdx/encoding/json/') && file.endsWith('.cj')).map(/* 已验证源码的相对路径。 */ file => /* 使用对应官方源码文件。 */ path.join(stdx, file))
const nativeSource = path.join(sourceDir, 'encoding/json/native/json_string_escape.c')
const nativeHeader = path.join(sourceDir, 'encoding/json/native/json_string_escape.h')
run(cjc, [...serializationSources, '--output-type=staticlib', '-O2', '-o', path.join(deps, 'libstdx.serialization.serialization.a')])
run('clang', ['-c', '-O2', '-mmacosx-version-min=12.0', nativeSource, '-o', path.join(deps, 'json_string_escape.o')])
run('ar', ['rcs', path.join(deps, 'libstdx.encoding.jsonFFI.a'), path.join(deps, 'json_string_escape.o')])
run(cjc, [...jsonSources, '--output-type=staticlib', '-O2', '--import-path', deps, '-o', path.join(deps, 'libstdx.encoding.json.a')])
const ownSources = sources(path.join(moduleDir, 'src'))
if (!ownSources.length) throw new Error('No Cangjie audit source files found.')
const binary = path.join(bin, 'evidence-audit')
run(cjc, [...ownSources, '-O2', '--import-path', deps, '-L', deps, '-lstdx.encoding.json', '-lstdx.serialization.serialization', '-lstdx.encoding.jsonFFI', '--link-options', '-rpath @executable_path/runtime', '-o', binary])
for (const name of ['libcangjie-runtime.dylib', 'libboundscheck.dylib']) {
  copyFileSync(path.join(sdk, 'runtime/lib/darwin_aarch64_cjnative', name), path.join(runtime, name))
}
copyFileSync(path.join(sdk, 'LICENSE'), path.join(licenses, 'Cangjie-SDK-LICENSE.txt'))
copyFileSync(path.join(stdx, 'LICENSE'), path.join(licenses, 'Cangjie-stdx-LICENSE.txt'))
copyFileSync(path.join(moduleDir, 'licenses/libboundscheck-LICENSE.txt'), path.join(licenses, 'libboundscheck-LICENSE.txt'))
copyFileSync(path.join(moduleDir, 'THIRD_PARTY_NOTICES.md'), path.join(bin, 'THIRD_PARTY_NOTICES.md'))
copyFileSync(path.join(moduleDir, 'toolchain-sources.json'), path.join(bin, 'toolchain-sources.json'))
for (const [base, label] of [[sdk, 'Cangjie-SDK'], [stdx, 'Cangjie-stdx']]) {
  if (existsSync(path.join(base, 'NOTICE'))) copyFileSync(path.join(base, 'NOTICE'), path.join(licenses, label + '-NOTICE.txt'))
}
for (const name of readdirSync(licenses)) chmodSync(path.join(licenses, name), 0o644)
writeFileSync(settingsFile, JSON.stringify({ sdk, stdx }, null, 2) + '\n', { mode: 0o600 })
writeFileSync(path.join(bin, 'build-info.json'), JSON.stringify({
  compiler: version, platform: process.platform, arch: process.arch, stdxTag: 'v1.1.3.1',
  binarySha256: sha256(binary),
  sources: Object.fromEntries(ownSources.map(/* 本次编译的仓颉源文件。 */ file => /* 记录仓库内相对路径与内容摘要。 */ [path.relative(root, file), sha256(file)])),
  dependencySourcesSha256: createHash('sha256').update([...serializationSources, ...jsonSources, nativeSource, nativeHeader].map(
    /* 已经参与构建的扩展库源文件。 */ file => /* 按固定顺序汇总文件内容摘要。 */ sha256(file),
  ).join('\n')).digest('hex'),
}, null, 2) + '\n')
process.stdout.write(`Built ${path.relative(root, binary)}\n${version}\n`)
