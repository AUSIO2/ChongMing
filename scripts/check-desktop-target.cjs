const fs = require('node:fs')
const path = require('node:path')
module.exports = async function checkDesktopTarget(context) {
  const runtime = JSON.parse(fs.readFileSync(path.join(context.packager.projectDir, '.desktop-runtime/runtime.json'), 'utf8'))
  const architectures = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
  if (runtime.platform !== context.electronPlatformName || runtime.arch !== architectures[context.arch]) {
    throw new Error('Build the Node service natively for the requested desktop platform and architecture')
  }
}
