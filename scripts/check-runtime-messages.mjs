import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const ts = require('typescript')
const constructors = new Map([
  ['Error', 0], ['GraphError', 2], ['ClientError', 0], ['QueueError', 1],
  ['WorkAccessError', 0], ['HostApiError', 2], ['HostProtocolError', 0],
])
const helpers = new Map([['clientCreateError', 1], ['clientCreateIpcError', 1], ['clientCreateServiceError', 0]])

// 用途：处理当前模块相关工作，并把结果交给调用方。
function list(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? list(directory + '/' + entry.name) : [directory + '/' + entry.name])
}
const requested = process.argv.slice(2)
const files = requested.length ? requested.map(file => path.resolve(file))
  : ['apps', 'backend', 'client', 'contracts', 'platform'].flatMap(list)
    .filter(file => /\.(ts|mjs)$/.test(file) && file !== 'contracts/messages.ts').map(file => path.join(root, file))

// 用途：处理当前模块相关工作，并把结果交给调用方。
function callName(expression) { return ts.isIdentifier(expression) ? expression.text : undefined }
// 用途：处理当前模块相关工作，并把结果交给调用方。
function propertyName(node, source) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : node.getText(source)
}
// 用途：处理当前模块相关工作，并把结果交给调用方。
function literalIn(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isTemplateExpression(expression)) return true
  if (ts.isParenthesizedExpression(expression)) return literalIn(expression.expression)
  if (ts.isConditionalExpression(expression)) return literalIn(expression.whenTrue) || literalIn(expression.whenFalse)
  if (ts.isBinaryExpression(expression)) return literalIn(expression.left) || literalIn(expression.right)
  return false
}

const violations = new Map()
// 用途：处理当前模块相关工作，并把结果交给调用方。
function inspect(file) {
  const content = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true,
    file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  // 用途：记录当前诊断或失败信息。
  function report(node) {
    if (!literalIn(node)) return
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    violations.set(`${file}:${line}`, node.getText(source).slice(0, 120))
  }
  // 用途：遍历并处理当前语法节点。
  function visit(node) {
    if (ts.isNewExpression(node)) {
      const name = callName(node.expression), index = name === undefined ? undefined : constructors.get(name)
      const argument = index === undefined ? undefined : node.arguments?.[index]
      if (argument) {
        if (name === 'ClientError' && ts.isObjectLiteralExpression(argument)) {
          const message = argument.properties.find(item => ts.isPropertyAssignment(item) && propertyName(item.name, source) === 'message')
          if (message && ts.isPropertyAssignment(message)) report(message.initializer)
        } else report(argument)
      }
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression), index = name === undefined ? undefined : helpers.get(name)
      if (index !== undefined && node.arguments[index]) report(node.arguments[index])
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'message' && node.initializer) report(node.initializer)
    if (ts.isPropertyAssignment(node) && ['message', 'error'].includes(propertyName(node.name, source))) report(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
}
for (const file of files) {
  assert(existsSync(file) && statSync(file).isFile(), `Message check input is not a file: ${file}`)
  inspect(file)
}

if (!requested.length) {
  const enumFile = readFileSync(path.join(root, 'contracts/messages.ts'), 'utf8')
  const enumSource = ts.createSourceFile('contracts/messages.ts', enumFile, ts.ScriptTarget.Latest, true)
  const declaration = enumSource.statements.find(node => ts.isEnumDeclaration(node) && node.name.text === 'RuntimeMessage')
  assert(declaration, 'RuntimeMessage enum is missing')
  const values = declaration.members.map(member => member.initializer).filter(ts.isStringLiteral).map(member => member.text)
  assert.equal(values.length, declaration.members.length, 'Every RuntimeMessage member must use a string literal')
  assert.equal(new Set(values).size, values.length, 'RuntimeMessage values must be unique')
  const pluginFile = path.join(root, 'backend/execution/dsh/dsh-business-plugin.mjs')
  const pluginSource = ts.createSourceFile(pluginFile, readFileSync(pluginFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const pluginDeclaration = pluginSource.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => ts.isIdentifier(node.name) && node.name.text === 'RuntimeMessage')
  const pluginObject = pluginDeclaration?.initializer && ts.isCallExpression(pluginDeclaration.initializer)
    ? pluginDeclaration.initializer.arguments[0] : undefined
  assert(pluginObject && ts.isObjectLiteralExpression(pluginObject), 'DSH RuntimeMessage enum is missing')
  const pluginValues = pluginObject.properties.filter(ts.isPropertyAssignment).map(member => member.initializer)
    .filter(ts.isStringLiteral).map(member => member.text)
  assert.equal(pluginValues.length, pluginObject.properties.length, 'Every DSH RuntimeMessage member must use a string literal')
  assert.equal(new Set(pluginValues).size, pluginValues.length, 'DSH RuntimeMessage values must be unique')
}

if (violations.size) {
  for (const [location, expression] of violations) console.error(`Hard-coded runtime message: ${path.relative(root, location)}: ${expression}`)
  process.exitCode = 1
} else console.log(JSON.stringify({ checkedFiles: files.length, hardCodedMessages: 0, messages: 'passed' }, null, 2))
