/** 将 unknown 错误规范为可读字符串。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
