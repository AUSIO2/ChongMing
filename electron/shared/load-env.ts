import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

let loaded = false

/** 从项目根目录加载 .env（不依赖 dotenv 包） */
export function loadEnv(projectRoot: string): void {
  if (loaded) return

  const envPath = path.join(projectRoot, '.env')
  if (!existsSync(envPath)) {
    loaded = true
    return
  }

  const content = readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eq = trimmed.indexOf('=')
    if (eq === -1) continue

    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1)
    }

    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }

  loaded = true
}
