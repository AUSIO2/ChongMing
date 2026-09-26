import type { ClientFile } from '../../../../contracts/client'

/** Save through the browser download surface; no renderer filesystem access. */
// 用途：处理客户端请求相关工作，并把结果交给调用方。
export function clientSaveFile(file: ClientFile): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(file.bytes).buffer], { type: file.mediaType }))
  const link = document.createElement('a')
  link.href = url; link.download = file.filename; link.hidden = true
  document.body.append(link)
  try { link.click() }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}
