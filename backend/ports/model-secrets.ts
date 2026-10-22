// 密钥加解密由部署适配器提供，领域模块不持有服务器文件或加密主密钥。
export interface ModelSecretCodec {
  seal(/* 仅用于加密、不能写入日志的API Key。 */ value: string): string
  open(/* 已保存的认证密文。 */ value: string): string
}
