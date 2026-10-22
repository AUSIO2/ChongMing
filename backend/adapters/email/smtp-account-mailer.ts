// 由部署环境装配SMTP账户邮件，不回退到输出验证码的日志发送器。
import nodemailer from 'nodemailer'
import { AccountMessage } from '../../../contracts/auth'
import { GraphError } from '../../modules/shared/domain-error'
import type { AccountMailer } from '../../ports/account-mailer'

enum AccountMailConfigurationMessage {
  INCOMPLETE = '账户邮件配置不完整，请配置SMTP主机、用户、密码、发件人与验证码密钥。',
  INVALID_PORT = '账户邮件SMTP端口无效。',
  INVALID_SECURE = '账户邮件TLS选项必须为true或false。',
  INVALID_SECRET = '账户验证码密钥至少需要32个字符。',
}

export function accountReadMailEnvironment(
  /* 仅由运行入口传入的部署环境，密码和验证码密钥不进入公共响应。 */ environment: NodeJS.ProcessEnv,
): { accountMailer?: AccountMailer; authChallengeSecret?: string } {
  // 未配置邮件时保留原令牌/本地功能；部分配置则在启动前明确拒绝。
  const names = ['CHONGMING_SMTP_HOST', 'CHONGMING_SMTP_USER', 'CHONGMING_SMTP_PASSWORD', 'CHONGMING_MAIL_FROM']
  if (!names.some((/* SMTP必需配置名。 */ name) => /* 仅检查是否配置，不记录内容。 */ environment[name])) return {}
  function required(
    /* 本模块固定选择的环境字段名。 */ name: string,
  ): string {
    // 只返回已检查的配置，错误消息不包含配置值。
    const value = environment[name]
    if (!value?.trim()) throw new Error(AccountMailConfigurationMessage.INCOMPLETE)
    return value
  }
  const host = required('CHONGMING_SMTP_HOST'), user = required('CHONGMING_SMTP_USER')
  const password = required('CHONGMING_SMTP_PASSWORD'), from = required('CHONGMING_MAIL_FROM')
  const challengeSecret = required('CHONGMING_AUTH_CHALLENGE_SECRET')
  if (challengeSecret.length < 32) throw new Error(AccountMailConfigurationMessage.INVALID_SECRET)
  const port = Number(environment.CHONGMING_SMTP_PORT ?? '465')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(AccountMailConfigurationMessage.INVALID_PORT)
  const secureText = environment.CHONGMING_SMTP_SECURE ?? (port === 465 ? 'true' : 'false')
  if (secureText !== 'true' && secureText !== 'false') throw new Error(AccountMailConfigurationMessage.INVALID_SECURE)
  const transport = nodemailer.createTransport({ host, port, secure: secureText === 'true', requireTLS: secureText === 'false',
    auth: { user, pass: password }, disableFileAccess: true, disableUrlAccess: true })
  async function send(
    /* 已由账户模块规范化的收件邮箱。 */ email: string,
    /* 仅用于纯文本邮件称呼的显示名称。 */ displayName: string,
    /* 服务生成、仅交付本次收件人的短期验证码。 */ code: string,
    /* 本模块固定的验证或重置标题。 */ subject: string,
  ): Promise<void> {
    // 使用纯文本避免把显示名当HTML，SMTP失败只返回固定账户错误。
    try {
      await transport.sendMail({ from, to: email, subject,
        text: `${displayName}，你好。\n\n${subject}\n验证码：${code}\n验证码10分钟内有效。请在重明客户端输入。\n若非本人操作，请忽略此邮件。` })
    } catch { throw new GraphError(503, 'ACCOUNT_MAIL_UNAVAILABLE', AccountMessage.MAIL_UNAVAILABLE) }
  }
  return { authChallengeSecret: challengeSecret, accountMailer: {
    sendVerification: (/* 只交付当前验证目的的账户邮件字段。 */ value) => /* 验证码只进入邮件，不进入服务诊断。 */ send(value.email, value.displayName, value.code, '验证你的重明账户'),
    sendPasswordReset: (/* 当前密码重置邮件字段。 */ value) => /* 不把邮件凭据持久化到应用配置。 */ send(value.email, value.displayName, value.code, '重置你的重明账户密码'),
  } }
}
