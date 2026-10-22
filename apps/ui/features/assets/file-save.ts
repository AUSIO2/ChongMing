// 浏览器文件保存：通过临时下载链接保存网关返回的文件并释放资源。
import type { ClientFile } from '../../../../contracts/client'

/** 文件通过浏览器下载入口保存，渲染进程不直接访问文件系统。 */
/**
 * 用临时 Blob 地址触发浏览器下载，并移除链接和延迟释放地址。
 *
 * @param file 网关已校验的下载文件，含文件名、媒体类型与字节；构造 Blob 时复制字节。
 */
export function clientSaveFile(file: ClientFile): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(file.bytes).buffer], { type: file.mediaType }))
  const link = document.createElement('a')
  link.href = url; link.download = file.filename; link.hidden = true
  document.body.append(link)
  try { link.click() }
  finally { link.remove(); setTimeout(() => /* 下载触发后释放临时 Blob 地址，避免长期占用内存。 */ URL.revokeObjectURL(url), 1000) }
}
