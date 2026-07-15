import { homedir } from 'node:os'
import path from 'node:path'

let dataDirOverride: string | null = null

/** 测试 / CLI 启动前覆盖数据目录。 */
export function pathsUpdateDataDir(dir: string): void {
  dataDirOverride = dir
}

export function pathsDeleteDataDirOverride(): void {
  dataDirOverride = null
}

/**
 * 应用数据根目录（settings / client identity 等）。
 * 优先 override → CHONGMING_DATA_DIR → Electron userData → ~/.chongming
 */
export function pathsReadDataDir(): string {
  if (dataDirOverride) return dataDirOverride
  const fromEnv = process.env.CHONGMING_DATA_DIR?.trim()
  if (fromEnv) return fromEnv

  if (process.versions.electron) {
    // 延迟加载，避免纯 Node CLI 顶层 import electron
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    return app.getPath('userData')
  }

  // 优先项目内 .data（避免无写权限的家目录）；可被 CHONGMING_DATA_DIR 覆盖
  if (process.env.APP_ROOT) {
    return path.join(process.env.APP_ROOT, '.data')
  }

  return path.join(homedir(), '.chongming')
}

export function pathsReadSettingsDir(): string {
  return path.join(pathsReadDataDir(), 'settings')
}
