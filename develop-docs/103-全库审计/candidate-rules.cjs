// 高信号候选规则：只导航人工审查，不把命中直接认作缺陷或CI失败。
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory.json'), 'utf8'))
const findings = []
const ruleNames = {
  C01: '枚举成员检查前显式强转', C02: '动态索引写入或更新', C03: '动态索引读取附默认值',
  C04: '抛主错误或释放后续资源前直接等待可能失败的清理', C05: '同函数重复调用同参数解析器',
  C06: 'Object.keys.find字符串结果按truthy判断', C07: '排序出现在集合回调内部', C08: '表单枚举以String作为选项身份',
}
function scriptText(source, file) {
  if (!file.endsWith('.vue')) return source
  const regions = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/g)]
  let offset = 0, result = ''
  for (const match of regions) {
    const start = match.index + match[0].indexOf('>') + 1
    result += source.slice(offset, start).replace(/[^\r\n]/g, ' ') + match[1]
    offset = start + match[1].length
  }
  return result + source.slice(offset).replace(/[^\r\n]/g, ' ')
}
for (const row of inventory.files) {
  const text = fs.readFileSync(path.join(root, row.file), 'utf8')
  const source = ts.createSourceFile(row.file, scriptText(text, row.file), ts.ScriptTarget.Latest, true)
  const keysFound = new Map(), repeated = new Map()
  function position(node) { return source.getLineAndCharacterOfPosition(node.getStart(source)) }
  function add(rule, node, evidence) {
    const at = position(node)
    findings.push({ rule, file: row.file, owner: row.owner, line: at.line + 1, column: at.character + 1,
      evidence, source: node.getText(source).replace(/\s+/g, ' ').slice(0, 240) })
  }
  function visit(node, scope = '<module>') {
    if (ts.isFunctionLike(node) && node.body) scope = `${node.name?.getText(source) || '<callback>'}@${position(node).line + 1}`
    if (ts.isCallExpression(node)) {
      const target = node.expression.getText(source)
      if (/\.(includes|has)$/.test(target) && node.arguments.some(argument => ts.isCallExpression(argument) && /^(String|Number|Boolean)$/.test(argument.expression.getText(source)))) add('C01', node, '强转后的成员资格不能单独证明原值符合枚举类型；需沿前置边界核对。')
      if (/\.sort$/.test(target)) {
        let parent = node.parent
        while (parent && !ts.isFunctionDeclaration(parent)) {
          if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
            if (ts.isCallExpression(parent.parent) && /\.(every|map|forEach|filter)$/.test(parent.parent.expression.getText(source))) add('C07', node, '核对排序输入是否每轮不变；不同分组的排序可以有实际用途。')
            break
          }
          parent = parent.parent
        }
      }
      if (/(ReadError|Parse|Validate|readerCreateSourceAnchors|sessionReadReferenceTargets|migrationArray|migrationString|JSON\.parse)/i.test(target)) {
        const signature = `${scope}:${target}(${node.arguments.map(argument => argument.getText(source)).join(',')})`
        const prior = repeated.get(signature)
        if (prior) add('C05', node, { priorLine: prior.line, sameTextArguments: true, awaitBetween: /\bawait\b/.test(text.slice(prior.end, node.getStart(source))), note: '相同源码参数可能已改变；必须人工判值、循环和异步边界。' })
        else repeated.set(signature, { line: position(node).line + 1, end: node.end })
      }
    }
    if (ts.isBinaryExpression(node)) {
      if (ts.isElementAccessExpression(node.left) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)) add('C02', node, '区分普通字典、已有自有数据属性、数组及UUID键；不能一律判原型问题。')
      if (ts.isElementAccessExpression(node.left) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) add('C03', node, '核对可缺省合同、自有键保证和生产构造者；默认值可能正确，也可能读到继承字段。')
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const expression = node.initializer.expression
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'find' && ts.isCallExpression(expression.expression) && expression.expression.expression.getText(source) === 'Object.keys') keysFound.set(`${scope}:${node.name.text}`, position(node).line + 1)
    }
    if (ts.isIfStatement(node)) {
      const condition = ts.isIdentifier(node.expression) ? node.expression : ts.isPrefixUnaryExpression(node.expression) && node.expression.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(node.expression.operand) ? node.expression.operand : undefined
      if (condition && keysFound.has(`${scope}:${condition.text}`)) add('C06', node.expression, { findLine: keysFound.get(`${scope}:${condition.text}`), note: '字符串空键与undefined不同；检查实际输入是否允许该键。' })
    }
    if (ts.isBlock(node)) {
      const statements = node.statements
      for (let index = 0; index + 1 < statements.length; index++) {
        const statement = statements[index]
        if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression) || !ts.isCallExpression(statement.expression.expression)) continue
        const call = statement.expression.expression
        if (!/(?:\.|^)(cancel|close|stop|dispose)$/.test(call.expression.getText(source))) continue
        const next = statements[index + 1]
        if (ts.isThrowStatement(next) || node.parent && ts.isTryStatement(node.parent) && node.parent.finallyBlock === node) add('C04', statement, '清理拒绝可能覆盖主错误或跳过后续释放；区分真实主要清理失败、次生失败及既有错误归属。')
      }
    }
    ts.forEachChild(node, child => visit(child, scope))
  }
  visit(source)
  if (row.file.endsWith('.vue')) {
    const expression = /<option\b[^>]*:value\s*=\s*["']String\([^>]*>/g
    for (const match of text.matchAll(expression)) findings.push({ rule: 'C08', file: row.file, owner: row.owner,
      line: text.slice(0, match.index).split('\n').length, evidence: '核对enum是否可包含0/字符串0或结构值；String展示不能兼任无碰撞身份。', source: match[0].replace(/\s+/g, ' ').slice(0, 240) })
  }
}
const counts = Object.fromEntries(Object.keys(ruleNames).map(rule => [rule, findings.filter(row => row.rule === rule).length]))
for (const row of findings) {
  row.id = `${row.rule}:${row.file}:${row.line}:${row.column || 1}`
  row.reviewer = row.owner
  if (row.file.startsWith('tests/browser/') || row.file.startsWith('tests/client/ui-')
    || ['tests/client/files.spec.ts', 'tests/client/stream.spec.ts', 'tests/client/integration.spec.ts'].includes(row.file)) row.reviewer = 'runtime'
  if (row.file.startsWith('experiments/')) row.reviewer = 'domain'
}
fs.writeFileSync(path.join(__dirname, 'rule-candidates.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ruleNames,
  scope: '当前固定301个TS/JS/Vue文件；Vue脚本AST和特定模板枚举规则，未解析全部嵌入字符串代码。命中不是确证问题。', counts, candidates: findings }, null, 2) + '\n')
for (const reviewer of ['root', 'domain', 'runtime', 'ui']) fs.writeFileSync(path.join(__dirname, `rules-${reviewer}.json`), JSON.stringify(findings.filter(row => row.reviewer === reviewer), null, 2) + '\n')
console.log(JSON.stringify({ rules: Object.keys(ruleNames).length, candidates: findings.length, counts }))
