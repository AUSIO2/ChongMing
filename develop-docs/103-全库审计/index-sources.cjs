// 审计工件：固定当前仓库实现清单并生成语法候选；候选不等于已确认问题。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const relative = value => value.split(path.sep).join('/')
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
const paths = [...new Set(tracked)].filter(file => !file.startsWith('develop-docs/') && !file.startsWith('.git/')).sort()
const categories = ['F', 'E', 'V', 'S', 'P', 'K', 'L']
function owner(file) {
  if (/^(apps\/ui\/|client\/|tests\/client\/|tests\/browser\/)/.test(file)) return 'ui'
  if (/^(backend\/application\/|backend\/modules\/(graph|workspace|assets)\/|tests\/backend\/modules\/(graph|workspace|assets)\/)/.test(file)) return 'domain'
  if (/^(backend\/(adapters|execution)\/|apps\/|platform\/|tests\/(apps|platform)\/|tests\/backend\/(adapters|execution)\/)/.test(file)) return 'runtime'
  return 'root'
}
function scriptText(source, file) {
  if (!file.endsWith('.vue')) return source
  const chunks = [], expression = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/g
  let last = 0
  for (const match of source.matchAll(expression)) {
    const start = match.index + match[0].indexOf('>') + 1
    chunks.push(source.slice(last, start).replace(/[^\n\r]/g, ' '), match[1])
    last = start + match[1].length
  }
  chunks.push(source.slice(last).replace(/[^\n\r]/g, ' '))
  return chunks.join('')
}
const files = [], candidates = [], supportFiles = [], missing = []
for (const file of paths) {
  const absolute = path.join(root, file)
  if (!fs.existsSync(absolute)) { missing.push(file); continue }
  if (!fs.statSync(absolute).isFile()) continue
  const bytes = fs.readFileSync(absolute)
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  if (!/\.(?:[cm]?js|[cm]?tsx?|vue)$/.test(file)) {
    supportFiles.push({ file, bytes: bytes.length, sha256: hash })
    continue
  }
  const source = bytes.toString('utf8')
  const parsed = ts.createSourceFile(file, scriptText(source, file), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const row = { file: relative(file), owner: owner(file), area: file.startsWith('tests/') ? 'test' : file.startsWith('experiments/') ? 'experiment' : 'implementation',
    lines: source.split('\n').length, bytes: bytes.length, sha256: hash, imports: [], functions: [], candidateCounts: Object.fromEntries(categories.map(kind => [kind, 0])) }
  let serial = 0
  function add(node, category, syntax, scope) {
    const start = node.getStart(parsed), location = parsed.getLineAndCharacterOfPosition(start)
    const text = source.slice(start, Math.min(node.end, start + 220)).replace(/\s+/g, ' ').trim()
    candidates.push({ id: `${file}:${location.line + 1}:${location.character + 1}:${category}:${++serial}`, file, owner: row.owner,
      line: location.line + 1, column: location.character + 1, category, syntax, scope, text })
    row.candidateCounts[category]++
  }
  function visit(node, scope = '<module>') {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) row.imports.push(node.moduleSpecifier.text)
    if (ts.isFunctionLike(node) && node.body) {
      const name = node.name?.getText(parsed) || (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(parsed) : `<callback@${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1}>`)
      scope = name
      row.functions.push({ name, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, endLine: parsed.getLineAndCharacterOfPosition(node.end).line + 1 })
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken].includes(node.operatorToken.kind)) add(node, 'F', ts.tokenToString(node.operatorToken.kind), scope)
    if (ts.isParameter(node) && node.initializer) add(node, 'F', 'parameter-default', scope)
    if (ts.isCatchClause(node)) add(node, 'E', 'catch', scope)
    if (ts.isTryStatement(node) && node.finallyBlock) add(node.finallyBlock, 'E', 'finally', scope)
    if (ts.isThrowStatement(node)) add(node, 'E', 'throw', scope)
    if (ts.isTypeOfExpression(node) || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) add(node, 'V', 'type-guard', scope)
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isDefaultClause(node)) add(node, 'S', 'branch', scope)
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken) add(node, 'S', 'optional-chain', scope)
    if (ts.isElementAccessExpression(node)) add(node, 'K', 'key-access', scope)
    if (ts.isAwaitExpression(node)) add(node, 'L', 'await', scope)
    if (ts.isCallExpression(node)) {
      const target = node.expression.getText(parsed)
      if (/^(?:String|Number|Boolean)$/.test(target)) add(node, 'F', 'coercion', scope)
      if (/(?:^|\.)(?:catch)$/.test(target)) add(node, 'E', 'promise-catch', scope)
      if (/(?:assert|validate|^is[A-Z]|\.isArray|\.hasOwnProperty|ReadEnvelope|ReadCommand|ReadQuery|Parse)/i.test(target)) add(node, 'V', 'validation-call', scope)
      if (/(?:parse|compile|validate|definitions|structuredClone|\.read$|\.list$|\.get$|\.map$|\.flatMap$|\.filter$)/i.test(target)) add(node, 'P', 'parse-traverse-read', scope)
      if (/Object\.(?:entries|keys|values|fromEntries)|(?:Pointer|References|SchemaAt)/.test(target)) add(node, 'K', 'dictionary-pointer', scope)
      if (/(?:abort|cancel|close|releaseLock|disconnect|dispose|destroy|getReader|addEventListener|removeEventListener|setTimeout|setInterval|clearTimeout|clearInterval)/i.test(target)) add(node, 'L', 'lifecycle-call', scope)
    }
    ts.forEachChild(node, child => visit(child, scope))
  }
  visit(parsed)
  row.imports = [...new Set(row.imports)]
  files.push(row)
}
const output = { schemaVersion: 1, root, generatedAt: new Date().toISOString(), categories,
  scope: 'Git tracked plus non-ignored untracked current repository code; historical develop-docs, generated output and dependencies excluded',
  files, supportFiles, missing }
fs.writeFileSync(path.join(__dirname, 'inventory.json'), JSON.stringify(output, null, 2) + '\n')
fs.writeFileSync(path.join(__dirname, 'candidate-index.json'), JSON.stringify({ schemaVersion: 1, candidates }, null, 2) + '\n')
for (const scope of ['domain', 'runtime', 'ui', 'root']) {
  const scoped = files.filter(file => file.owner === scope)
  fs.writeFileSync(path.join(__dirname, `files-${scope}.txt`), scoped.map(file => `${file.file}\t${file.lines}\t${file.area}`).join('\n') + '\n')
}
console.log(JSON.stringify({ files: files.length, supportFiles: supportFiles.length, candidates: candidates.length,
  owners: Object.fromEntries(['domain', 'runtime', 'ui', 'root'].map(scope => [scope, files.filter(file => file.owner === scope).length])), missing }))
