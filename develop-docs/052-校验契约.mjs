#!/usr/bin/env node
// Run from any directory: node /path/to/ChongMing/develop-docs/052-校验契约.mjs
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const directory = path.dirname(fileURLToPath(import.meta.url))
const project = path.dirname(directory)
const require = createRequire(path.join(project, 'package.json'))
const ts = require('typescript')
const read = file => readFileSync(file, 'utf8')
const parse = file => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
// 064 removed the audited runtime. Freeze its method/command inventory and source hashes
// instead of keeping executable legacy code solely for historical-document checks.
const historical = JSON.parse(read(path.join(directory, '052-历史审计索引.json')))
const { oldMethods, oldCommands } = historical
const documentation = read(path.join(directory, '052-完整接口文档.md'))
assert.equal(oldMethods.length, 43, 'Historical API inventory changed')
for (const name of oldMethods) assert(documentation.includes(`| ${name} |`), `Missing old API mapping: ${name}`)
for (const name of oldCommands) assert(documentation.includes(`| ${name} |`), `Missing old Mapper command: ${name}`)

const contract = path.join(directory, '052-接口契约.ts')
const target = parse(contract)
const targetCounts = {}
for (const interfaceName of ['QueryMap', 'CommandMap']) {
  const declaration = target.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === interfaceName)
  assert(declaration, `Missing ${interfaceName}`)
  const names = declaration.members.map(member => member.name.text)
  assert.equal(new Set(names).size, names.length, `Duplicate ${interfaceName} entry`)
  for (const name of names) assert(documentation.includes(`| \`${name}\` |`), `Missing target method: ${name}`)
  targetCounts[interfaceName] = names.length
}

let linkCount = 0, archivedLinks = 0
const documents = readdirSync(directory).filter(name => name.startsWith('052-') && name.endsWith('.md'))
for (const name of documents) {
  const file = path.join(directory, name)
  const content = read(file)
  const lines = content.split('\n')
  assert.equal(lines.filter(line => /^```/.test(line)).length % 2, 0, `Unclosed code fence: ${name}`)
  assert(lines.every(line => line === line.trimEnd()), `Trailing whitespace: ${name}`)
  for (const [, raw] of content.matchAll(/\]\(([^)]+)\)/g)) {
    const link = raw.replace(/^<|>$/g, '')
    if (/^(https?:|#|codex:)/.test(link)) continue
    const match = link.match(/^(.*?)(?::(\d+))?(?:#.*)?$/)
    const absolute = path.resolve(directory, match[1])
    const archived = historical.sources[path.relative(project, absolute)]
    if (archived) {
      assert.match(archived.sha256, /^[a-f0-9]{64}$/)
      if (match[2]) assert(Number(match[2]) >= 1 && Number(match[2]) <= archived.lines, `Bad historical source line: ${link}`)
      archivedLinks++; linkCount++; continue
    }
    assert(existsSync(absolute), `Broken link in ${name}: ${link}`)
    if (match[2]) {
      const line = Number(match[2])
      assert(line >= 1 && line <= read(absolute).split('\n').length, `Bad source line: ${link}`)
    }
    linkCount++
  }
}
const result = spawnSync(process.execPath, [
  require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
  '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', contract,
  path.join(directory, '052-接口示例.ts'),
], { cwd: project, encoding: 'utf8' })
assert.equal(result.status, 0, `${result.stdout}${result.stderr}${result.error ?? ''}`)
assert.ok(Number(read(path.join(directory, 'counter.txt')).trim()) >= 52, 'Document counter precedes this contract')
console.log(JSON.stringify({
  historicalMethods: oldMethods.length, historicalMapperCommands: oldCommands.length, ...targetCounts,
  markdownDocuments: documents.length, localLinks: linkCount, archivedSourceLinks: archivedLinks, typecheck: 'passed',
}, null, 2))
