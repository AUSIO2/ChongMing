// 定义账户请求、短期访问凭据和可轮换刷新会话，沿用现有Identity授权身份。
import type { Identity } from './control'

export interface AuthSession {
  identity: Identity
  accessToken: string
  accessExpiresAt: string
  refreshToken: string
  refreshExpiresAt: string
}
export interface AuthRegisterInput { email: string; displayName: string; password: string }
export interface AuthRegisterUsernameInput { username: string; displayName: string; password: string; remember: boolean }
export interface AuthLoginUsernameInput { username: string; password: string; remember: boolean }
export interface AuthVerifyEmailInput { email: string; code: string; remember: boolean }
export interface AuthLoginInput { email: string; password: string; remember: boolean }
export interface AuthRefreshInput { refreshToken: string }
export interface AuthEmailInput { email: string }
export interface AuthResetPasswordInput { email: string; code: string; password: string }
export interface AuthChangePasswordInput { currentPassword: string; newPassword: string; remember: boolean }
export interface AuthMessage { message: string }

export enum AccountMessage {
  INVALID_USERNAME = '用户名须为3至32位字母、数字、下划线或短横线。',
  USERNAME_EXISTS = '该用户名已注册，请直接登录。',
  USERNAME_INVALID_CREDENTIALS = '用户名或密码错误。',
  INVALID_EMAIL = '请输入有效的邮箱地址。',
  WEAK_PASSWORD = '密码长度须为15至128个字符。',
  INVALID_CODE = '验证码无效或已过期。',
  CODE_ATTEMPTS_EXHAUSTED = '验证码尝试次数已用尽，请重新发送。',
  INVALID_REMEMBER = 'remember必须是布尔值。',
  INVALID_DISPLAY_NAME = '显示名称不能为空且最多80个字符。',
  ACCOUNT_EXISTS = '该邮箱已注册，请直接登录。',
  EMAIL_ALREADY_VERIFIED = '邮箱已验证，请直接登录。',
  INVALID_CREDENTIALS = '邮箱或密码错误。',
  EMAIL_NOT_VERIFIED = '请先完成邮箱验证。',
  INVALID_REFRESH_TOKEN = '登录状态已失效，请重新登录。',
  INVALID_CURRENT_PASSWORD = '当前密码错误。',
  MAIL_UNAVAILABLE = '账户邮件服务暂不可用。',
  AUTH_UNAVAILABLE = '账户认证服务暂不可用。',
  REGISTERED = '注册成功，请查收邮箱验证码。',
  VERIFICATION_SENT = '如果该邮箱需要验证，我们已发送新的验证码。',
  RESET_SENT = '如果该邮箱已注册，我们已发送重置验证码。',
  PASSWORD_RESET = '密码已重置，请使用新密码登录。',
  LOGGED_OUT = '已退出登录。',
}
