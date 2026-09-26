import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { diagnosticCreateReporter, diagnosticReadLine } from '../../platform/node/diagnostics'

function diagnosticsRunChild(mode: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/fixtures/process-boundary.ts'), mode], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  return { child, exited, output: () => ({ stdout, stderr }) }
}

describe('fatal process and diagnostic boundaries', () => {
  it('removes arbitrary messages, credentials and local paths while retaining bounded diagnostic structure', () => {
    const secret = 'secret-value', error = new Error(`Bearer ${secret} at ${process.cwd()}/private.ts`)
    Object.defineProperty(error, 'cause', { get() { throw new Error('getter-secret') } })
    const output = diagnosticReadLine('test', 'instance', { name: 'request.failed', severity: 'error',
      context: { requestId: 'request', route: '/api/v1/query', reason: 'Bearer ' + secret }, error }).line
    expect(output).not.toContain(secret)
    expect(output).not.toContain(process.cwd())
    expect(output).not.toContain('getter-secret')
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.parse(output)).toMatchObject({ name: 'request.failed', component: 'test', errorId: expect.any(String),
      context: { requestId: 'request', route: '/api/v1/query' }, failure: { type: 'Error', stack: expect.any(Array) } })
  })

  it('rotates bounded desktop logs and tolerates an unavailable sink without throwing', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-diagnostics-'))
    try {
      const filename = path.join(directory, 'service.log')
      await writeFile(filename, Buffer.alloc(5 * 1024 * 1024, 120))
      const reporter = diagnosticCreateReporter({ component: 'desktop-service', filename, instanceId: 'instance' })
      expect(() => reporter.report({ name: 'service.failed', severity: 'error', error: new Error('private') })).not.toThrow()
      expect((await readFile(filename + '.1')).byteLength).toBe(5 * 1024 * 1024)
      expect(JSON.parse(await readFile(filename, 'utf8'))).toMatchObject({ name: 'service.failed', component: 'desktop-service' })
      await reporter.close()
      expect(() => reporter.report({ name: 'late', severity: 'error' })).not.toThrow()
      const broken = diagnosticCreateReporter({ component: 'broken', filename: path.join(directory, 'missing', 'log') })
      expect(() => broken.report({ name: 'write.failed', severity: 'error' })).not.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it.each(['uncaught', 'rejection', 'startup'])('exits a real child nonzero for %s without leaking its error message', async mode => {
    const child = diagnosticsRunChild(mode)
    expect(await child.exited).toBe(1)
    expect(child.output().stderr).toContain(mode === 'startup' ? 'process.start.failed' : 'process.fatal')
    expect(child.output().stderr).not.toContain('private-token-value')
  })

  it('bounds controlled shutdown from the moment the signal arrives', async () => {
    const child = diagnosticsRunChild('shutdown')
    await expect.poll(() => child.output().stdout).toContain('ready')
    const started = performance.now()
    child.child.kill('SIGTERM')
    expect(await child.exited).toBe(1)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(child.output().stderr).toContain('shutdown.failed')
  })
})
