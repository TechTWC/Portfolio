import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const smokeScript = fileURLToPath(new URL('../scripts/smoke-test.mjs', import.meta.url))
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

async function serve(responseBody: (baseUrl: string) => unknown): Promise<string> {
  let baseUrl = ''
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify(responseBody(baseUrl)))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server address unavailable')
  baseUrl = `http://127.0.0.1:${address.port}`
  return baseUrl
}

function runSmoke(baseUrl: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeScript, baseUrl], {
      env: {
        ...process.env,
        SMOKE_MAX_ATTEMPTS: '1',
        SMOKE_RETRY_DELAY_MS: '0',
      },
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

describe('Staging smoke test Managed OAuth protection', () => {
  it('accepts Cloudflare invalid_token only when resource metadata belongs to this deployment', async () => {
    const baseUrl = await serve((origin) => ({
      error: 'invalid_token',
      error_description: 'Missing or invalid access token',
      resource_metadata: `${origin}/.well-known/cloudflare-access-protected-resource/api/health`,
    }))

    const result = await runSmoke(baseUrl)

    expect(result.code).toBe(0)
    expect(result.output).toContain('Cloudflare Access Managed OAuth (401)')
  })

  it('rejects a 401 that points resource metadata at another origin', async () => {
    const baseUrl = await serve(() => ({
      error: 'invalid_token',
      error_description: 'Missing or invalid access token',
      resource_metadata: 'https://attacker.example/.well-known/cloudflare-access-protected-resource/api/health',
    }))

    const result = await runSmoke(baseUrl)

    expect(result.code).not.toBe(0)
    expect(result.output).toContain('HTTP 401')
  })
})
