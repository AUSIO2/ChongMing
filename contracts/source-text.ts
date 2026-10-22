// 统一来源脚注的硬换行、空行和原文摘录规则，供服务端校验与阅读页共同使用。
export interface SourceTextLine { number: number; text: string; start: number; end: number }

/** 按原文换行划分行；CRLF 只计一个换行，末尾换行仍产生空白末行。 */
export function sourceTextReadLines(text: string): SourceTextLine[] {
  const lines: SourceTextLine[] = []
  let start = 0
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const end = match.index
    lines.push({ number: lines.length + 1, text: text.slice(start, end), start, end })
    start = end + match[0].length
  }
  lines.push({ number: lines.length + 1, text: text.slice(start), start, end: text.length })
  return lines
}

/** 摘录闭区间行的完整原文，保留内部换行并排除最后一行的结束符。 */
export function sourceTextReadQuote(text: string, startLine: number, endLine: number): string | undefined {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) return undefined
  const lines = sourceTextReadLines(text)
  const first = lines[startLine - 1], last = lines[endLine - 1]
  return first && last ? text.slice(first.start, last.end) : undefined
}
