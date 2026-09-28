// 检查运行代码是否内联错误文案，并核对 TypeScript 与 DSH 文案集合的值唯一性。
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

function list(/* 从项目根目录开始解析的相对扫描目录。 */ directory) {
  // 递归收集目录内文件，供运行错误文案扫描选择输入。
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(/* 扫描目录中的文件系统条目，目录继续递归。 */ entry => /* 递归展开子目录，普通文件保留项目相对路径。 */
    entry.isDirectory() ? list(directory + '/' + entry.name) : [directory + '/' + entry.name])
}
const requested = process.argv.slice(2)
const files = requested.length ? requested.map(/* 命令行显式指定的待扫描源码路径。 */ file => /* 将显式传入的扫描文件转换为绝对路径。 */  path.resolve(file))
  : ['apps', 'backend', 'client', 'contracts', 'platform'].flatMap(list)
    .filter(/* 自动发现的相对文件路径，按扩展名筛选并排除文案定义文件。 */ file => /* 只扫描 TS/MJS 运行文件，并排除作为文案来源的枚举文件。 */  /\.(ts|mjs)$/.test(file) && file !== 'contracts/messages.ts').map(/* 已选中的项目相对源码路径，转换为绝对路径便于读取。 */ file => /* 将自动发现的文件转换为项目绝对路径。 */  path.join(root, file))

function callName(/* 调用或构造表达式的被调用部分，只识别直接标识符。 */ expression) {
  // 只返回直接标识符调用的名字，避免误判无法静态识别的调用表达式。
   return ts.isIdentifier(expression) ? expression.text : undefined }
function propertyName(/* 待识别的语法属性名，可能是标识符、字符串或计算形式。 */ node, /* 该属性所属源码树，用于取得复杂属性名的原始文本。 */ source) {
  // 读取标识符或字符串属性名，其他形式保留源码用于匹配。
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : node.getText(source)
}
function literalIn(/* 待检查的表达式，递归查找直接包含的字符串或模板字面量。 */ expression) {
  // 递归检查括号、条件和二元表达式中是否直接包含字符串或模板字面量。
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isTemplateExpression(expression)) return true
  if (ts.isParenthesizedExpression(expression)) return literalIn(expression.expression)
  if (ts.isConditionalExpression(expression)) return literalIn(expression.whenTrue) || literalIn(expression.whenFalse)
  if (ts.isBinaryExpression(expression)) return literalIn(expression.left) || literalIn(expression.right)
  return false
}

const violations = new Map()
function inspect(/* 当前需要扫描的绝对源码文件路径。 */ file) {
  // 解析单个文件的语法树并检查已登记的错误构造器、助手及文案字段。
  const content = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true,
    file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  function report(/* 疑似文案的初始化表达式，命中内联字符串才记录违规。 */ node) {
    // 仅对含内联文案的表达式记录文件行号与简短源码，按位置去重。
    if (!literalIn(node)) return
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    violations.set(`${file}:${line}`, node.getText(source).slice(0, 120))
  }
  function visit(/* 遍历中的当前 AST 节点，识别构造器参数、助手参数和文案字段。 */ node) {
    // 遍历语法节点，定位错误参数及 message/error 初始化表达式中的内联字符串。
    if (ts.isNewExpression(node)) {
      const name = callName(node.expression), index = name === undefined ? undefined : constructors.get(name)
      const argument = index === undefined ? undefined : node.arguments?.[index]
      if (argument) {
        if (name === 'ClientError' && ts.isObjectLiteralExpression(argument)) {
          const message = argument.properties.find(/* ClientError 输入对象的属性节点，寻找 message 初始化值。 */ item => /* 从 ClientError 配置对象中定位 message 字段。 */  ts.isPropertyAssignment(item) && propertyName(item.name, source) === 'message')
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
  const declaration = enumSource.statements.find(/* 共享文案文件的顶层声明，寻找指定枚举。 */ node => /* 定位共享 RuntimeMessage 字符串枚举声明。 */  ts.isEnumDeclaration(node) && node.name.text === 'RuntimeMessage')
  assert(declaration, 'RuntimeMessage enum is missing')
  const values = declaration.members.map(/* RuntimeMessage 枚举成员，提取其初始化值检查字符串类型。 */ member => /* 提取枚举成员的初始化值，检查其是否全部为字符串。 */  member.initializer).filter(ts.isStringLiteral).map(/* 已筛为字符串字面量的枚举值节点，读取文本用于去重。 */ member => /* 提取文案字符串内容用于唯一性检查。 */  member.text)
  assert.equal(values.length, declaration.members.length, 'Every RuntimeMessage member must use a string literal')
  assert.equal(new Set(values).size, values.length, 'RuntimeMessage values must be unique')
  const pluginFile = path.join(root, 'backend/execution/dsh/dsh-business-plugin.mjs')
  const pluginSource = ts.createSourceFile(pluginFile, readFileSync(pluginFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const pluginDeclaration = pluginSource.statements.flatMap(/* 插件源码的顶层语句，只展开变量声明列表。 */ node => /* 展开顶层变量声明，以定位 DSH 插件的文案对象。 */  ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(/* 插件变量声明，按标识符名称定位 RuntimeMessage。 */ node => /* 找到名称为 RuntimeMessage 的插件变量。 */  ts.isIdentifier(node.name) && node.name.text === 'RuntimeMessage')
  const pluginObject = pluginDeclaration?.initializer && ts.isCallExpression(pluginDeclaration.initializer)
    ? pluginDeclaration.initializer.arguments[0] : undefined
  assert(pluginObject && ts.isObjectLiteralExpression(pluginObject), 'DSH RuntimeMessage enum is missing')
  const pluginValues = pluginObject.properties.filter(ts.isPropertyAssignment).map(/* 插件文案对象的属性赋值，提取初始化表达式。 */ member => /* 提取插件文案属性值以验证字面量类型。 */  member.initializer)
    .filter(ts.isStringLiteral).map(/* 已筛为字符串字面量的插件文案值，用于唯一性检查。 */ member => /* 取出插件字符串文案，供重复值检查。 */  member.text)
  assert.equal(pluginValues.length, pluginObject.properties.length, 'Every DSH RuntimeMessage member must use a string literal')
  assert.equal(new Set(pluginValues).size, pluginValues.length, 'DSH RuntimeMessage values must be unique')
}

if (violations.size) {
  for (const [location, expression] of violations) console.error(`Hard-coded runtime message: ${path.relative(root, location)}: ${expression}`)
  process.exitCode = 1
} else console.log(JSON.stringify({ checkedFiles: files.length, hardCodedMessages: 0, messages: 'passed' }, null, 2))
