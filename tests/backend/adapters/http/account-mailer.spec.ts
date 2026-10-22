// 检查SMTP部署边界，不向任何外部地址发送测试邮件。
import { describe, expect, it } from 'vitest'
import { accountReadMailEnvironment } from '../../../../backend/adapters/email/smtp-account-mailer'

const configured = { CHONGMING_SMTP_HOST: 'smtp.example.test', CHONGMING_SMTP_USER: 'example-user',
  CHONGMING_SMTP_PASSWORD: 'fixture-only-password', CHONGMING_MAIL_FROM: 'service@example.test',
  CHONGMING_AUTH_CHALLENGE_SECRET: 'fixture-only-challenge-secret-at-least-32-characters' }

describe('账户邮件装配', () => {
  it('未配置SMTP仍允许原令牌和本地服务启动，不回退到日志验证码', () => {
    // 没有邮件能力就是未装配，不创建能泄漏验证码的开发发送器。
    expect(accountReadMailEnvironment({})).toEqual({})
  })
  it('配置完整时返回邮件能力与稳定验证码密钥，不建立网络连接', () => {
    // createTransport本身不发信，本测试只验证可注入的真实邮件能力。
    const options = accountReadMailEnvironment(configured)
    expect(options.accountMailer?.sendVerification).toBeTypeOf('function')
    expect(options.accountMailer?.sendPasswordReset).toBeTypeOf('function')
    expect(options.authChallengeSecret === configured.CHONGMING_AUTH_CHALLENGE_SECRET).toBe(true)
  })
  it('部分配置及弱验证码密钥在启动前明确拒绝', () => {
    // 无可预测开发默认值；错误不包含任何密码或密钥。
    expect(() => accountReadMailEnvironment({ CHONGMING_SMTP_HOST: configured.CHONGMING_SMTP_HOST })).toThrow()
    expect(() => accountReadMailEnvironment({ ...configured, CHONGMING_AUTH_CHALLENGE_SECRET: 'short' })).toThrow()
  })
  it('拒绝无效端口和TLS选项，支持587的STARTTLS配置', () => {
    // 配置解析不能把字符串false悄悄解释成true，或接受非端口值。
    expect(() => accountReadMailEnvironment({ ...configured, CHONGMING_SMTP_PORT: '0' })).toThrow()
    expect(() => accountReadMailEnvironment({ ...configured, CHONGMING_SMTP_SECURE: 'wrong' })).toThrow()
    expect(accountReadMailEnvironment({ ...configured, CHONGMING_SMTP_PORT: '587', CHONGMING_SMTP_SECURE: 'false' }).accountMailer).toBeDefined()
  })
})
