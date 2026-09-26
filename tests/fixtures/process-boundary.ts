import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRegisterBoundary, processRunEntry } from '../../platform/node/process-boundary'

const mode = process.argv[2]
if (mode === 'uncaught' || mode === 'rejection') {
  processRegisterBoundary({ component: 'boundary-fixture' })
  if (mode === 'uncaught') setTimeout(() => { throw new Error('private-token-value') }, 0)
  else void Promise.reject(new Error('private-token-value'))
} else {
  const reporter = diagnosticCreateReporter({ component: 'boundary-fixture' })
  processRunEntry({ component: 'boundary-fixture', reporter, timeoutMs: 60, start: async () => {
    if (mode === 'startup') throw new Error('private-token-value')
    setInterval(() => {}, 1000)
    process.stdout.write('ready\n')
    return () => new Promise<void>(() => {})
  } })
}
