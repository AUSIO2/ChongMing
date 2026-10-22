// 账户界面自身的固定校验与能力提示；服务端业务错误沿已验证的中文合同展示。
export enum AccountUiMessage {
  UNAVAILABLE = '当前连接不支持账户登录，请使用访问令牌或本机入口。',
  PASSWORD_MISMATCH = '两次输入的密码不一致。',
}
