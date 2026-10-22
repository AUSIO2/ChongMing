// 仅在运行入口装配时加载Argon2，保持账户领域模块只依赖密码端口。
import argon2 from 'argon2'
import type { AccountPasswords } from '../../ports/account-passwords'

export function accountCreatePasswords(): AccountPasswords {
  // 提供真实Argon2id哈希与校验，沿用原账户实现的库默认成本参数。
  return {
    async hash(/* 领域入口已校验15至128字符的新密码。 */ password): Promise<string> {
      // 摘要携带算法参数，由同一适配器读取，不复制算法验证逻辑。
      return argon2.hash(password, { type: argon2.argon2id })
    },
    async verify(/* 持久化的Argon2密码摘要。 */ hash, /* 用户本次提交的密码。 */ password): Promise<boolean> {
      // 损坏或不支持的摘要等同校验失败，不向账户接口泄漏库错误。
      return argon2.verify(hash, password).catch(() => /* 沿用原实现对损坏摘要的拒绝行为。 */ false)
    },
  }
}
