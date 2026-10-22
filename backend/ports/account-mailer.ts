// 由应用装配提供账户邮件发送能力；验证流程只持久化验证码摘要，不写日志。
export interface AccountMailer {
  // 发送注册验证邮件；错误由调用方转换为账户服务不可用，接口不拥有连接生命周期。
  sendVerification(/* 仅本次发信使用的收件邮箱、显示名和短期验证码。 */ input: { email: string; displayName: string; code: string }): Promise<void>
  // 发送密码重置邮件，凭据只交付用户邮箱，不返回公共调用者。
  sendPasswordReset(/* 仅本次发信使用的收件邮箱、显示名和短期验证码。 */ input: { email: string; displayName: string; code: string }): Promise<void>
}
