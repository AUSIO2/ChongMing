// 在桌面打包前核对随包 Node 的平台和架构与 Electron 目标一致。
const fs = require('node:fs')
const path = require('node:path')
module.exports = async function checkDesktopTarget(/* electron-builder 提供的目标平台、架构和项目目录，用于核对已准备的 Node 运行时身份。 */ context) {
  // 读取已准备运行时的身份，拒绝与打包目标平台或架构不匹配的产物。
  const runtime = JSON.parse(fs.readFileSync(path.join(context.packager.projectDir, '.desktop-runtime/runtime.json'), 'utf8'))
  const architectures = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
  if (runtime.platform !== context.electronPlatformName || runtime.arch !== architectures[context.arch]) {
    throw new Error('Build the Node service natively for the requested desktop platform and architecture')
  }
}
