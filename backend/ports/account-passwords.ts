// 将账户密码规则与实际哈希算法适配器隔离，领域模块不加载外部运行时。
export interface AccountPasswords {
  // 对已校验长度的新密码生成包含算法参数的不可逆摘要。
  hash(/* 不裁剪且不记录日志的原始新密码。 */ password: string): Promise<string>
  // 校验原始密码；无法解析的摘要按凭据不匹配返回false。
  verify(/* 存储中带算法参数的密码摘要。 */ hash: string, /* 本次登录或改密的原始密码。 */ password: string): Promise<boolean>
}
