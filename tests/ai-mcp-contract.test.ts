import { describe, expect, it } from 'vitest'
import { createPortfolioMcpHandler } from '../worker/ai/mcp'
import type { Bindings } from '../worker/auth'

const expectedTools = [
  'describe_resource',
  'get_data_lineage',
  'get_metric',
  'list_data_resources',
  'list_metrics',
  'query_data',
]

function createHandler() {
  const request = new Request('https://portfolio.example/mcp', {
    headers: { 'Cf-Ray': 'contract-test-request' },
  })
  const env = { DB: {} as D1Database } as Bindings
  return createPortfolioMcpHandler(env, {
    id: 'user-contract-test',
    email: 'owner@example.com',
  }, request)
}

async function jsonRpc(method: string, params: Record<string, unknown>) {
  const response = await createHandler().fetch(new Request('https://portfolio.example/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))

  expect(response.status).toBe(200)
  const text = await response.text()
  const payloadText = text.startsWith('event: message')
    ? text.split('\ndata: ')[1]?.trim()
    : text
  return JSON.parse(payloadText ?? '{}') as Record<string, unknown>
}

describe('AI MCP public contract', () => {
  it('negotiates the current Streamable HTTP protocol', async () => {
    const response = await jsonRpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'contract-test', version: '1.0.0' },
    })

    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'portfolio-analyzer-read-only', version: '0.1.0' },
    })
  })

  it('exposes exactly six non-destructive, closed-world tools', async () => {
    const response = await jsonRpc('tools/list', {})
    const result = response.result as { tools: Array<Record<string, unknown>> }

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(expectedTools)
    expect(result.tools).toHaveLength(6)
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      })
    }
  })
})
