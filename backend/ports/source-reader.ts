// 来源读取端口由运行入口注入，领域层不直接依赖 HTTP 或本机网络实现。
// 读取 URL 正文；allowPrivate 明确控制是否允许访问私有网络来源，失败以 Promise 拒绝报告。
export type SourceReader = (/* 经过来源节点校验、需要获取正文的 HTTP 或 HTTPS 地址。 */ url: string, /* 是否允许解析并访问私有或本机网络地址。 */ allowPrivate: boolean) => Promise<string>
// 允许从附件作为文本来源解码的媒体类型，其他二进制内容不能直接作为原稿。
export const SOURCE_MEDIA_TYPES = new Set(['text/plain', 'text/markdown', 'text/html', 'application/json'])
