// 将固定陈述和查询文本转换成可用索引匹配的有界词项。
import { EvidenceMessage } from '../../../contracts/evidence-library'
import { GraphError } from '../shared/domain-error'

export function evidenceTokenize(
  /* 需要建立检索词项的 Claim 原文或用户查询，函数不修改原文。 */
  text: string,
): string[] {
  // Unicode 字母数字按连续词处理，汉字使用单字及相邻双字，使多语言查询无需回扫正文。
  if (Buffer.byteLength(text) > 65_536) throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
  const tokens = new Set<string>()
  const parts = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  for (const part of parts) {
    // 相邻中文和其他语言文字分别切词，避免中文查询被嵌在一个跨语言长词内。
    for (const [segment] of part.matchAll(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu)) {
      if (!/^[\p{Script=Han}]/u.test(segment)) tokens.add(segment)
      else {
        const characters = Array.from(segment)
        for (const [index, character] of characters.entries()) {
          tokens.add(character)
          const next = characters[index + 1]
          if (next !== undefined) tokens.add(character + next)
        }
      }
      if (tokens.size > 4096) throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
    }
  }
  return [...tokens].sort()
}
