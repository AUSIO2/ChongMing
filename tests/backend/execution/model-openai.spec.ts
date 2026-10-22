// 110原生适配器验收：真实DSH只请求本机OpenAI协议夹具，不访问任何供应商。
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { dshCreateRuntime } from '../../../backend/execution/dsh/runtime'

it('sends the selected OpenAI key and model to the explicit endpoint through the installed DSH adapter', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-openai-model-'))
  let observed: { selectedKey: boolean; model: unknown; bodyHasKey: boolean; path: string | undefined } | undefined
  const server = createServer(async (request, response) => {
    // 只记录相等判断，不把凭据原值带到失败报告。
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(text)
    observed = { selectedKey: request.headers.authorization === 'Bearer fake-work-openai-key', model: body.model,
      bodyHasKey: text.includes('fake-work-openai-key'), path: request.url }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '本机模型响应' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  let runtime: ReturnType<typeof dshCreateRuntime> | undefined
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local model did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`, patch = path.join(directory, 'openai.patch.json')
    await writeFile(patch, JSON.stringify([{ id: 'llm-pi-ai', config: { providers: { openai: {
      apiKeyEnv: 'CHONGMING_MODEL_API_KEY', baseURL: baseUrl, api: 'openai-completions', models: [{ id: 'fixture-openai' }],
    } } } }]), { mode: 0o600 })
    vi.stubEnv('OPENAI_API_KEY', 'fake-server-key-must-not-be-used')
    runtime = dshCreateRuntime({ dshHome: path.join(directory, 'home'), cwd: directory, processCwd: directory,
      provider: 'openai', model: 'fixture-openai', patches: [patch], maxTokens: 64,
      modelConnection: { provider: 'openai', model: 'fixture-openai', baseUrl, apiKey: 'fake-work-openai-key' } })
    await runtime.start()
    const result = await runtime.run({ prompt: '请回复本机模型响应。' })
    expect(observed).toEqual({ selectedKey: true, model: 'fixture-openai', bodyHasKey: false, path: '/v1/chat/completions' })
    expect(result.finalResponse).toContain('本机模型响应')
    expect(JSON.stringify(result)).not.toContain('fake-work-openai-key')
  } finally {
    vi.unstubAllEnvs()
    await runtime?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
