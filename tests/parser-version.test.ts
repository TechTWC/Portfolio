import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PARSER_VERSION } from '../src/lib/parser'
import { VALUATION_PARSER_VERSION } from '../src/lib/valuation-parser'

describe('parser provenance versions', () => {
  it('uses the current transaction parser version in upload payloads', async () => {
    const uploadSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

    expect(PARSER_VERSION).toBe('cloud-v0.1.7')
    expect(PARSER_VERSION).not.toBe('cloud-v0.1.4')
    expect(uploadSource).toMatch(/parserVersion:\s*PARSER_VERSION/g)
    expect(uploadSource.match(/parserVersion:\s*PARSER_VERSION/g)).toHaveLength(2)
  })

  it('uses the current valuation parser version in upload payloads', async () => {
    const uploadSource = await readFile(new URL('../src/ValuationWorkspace.tsx', import.meta.url), 'utf8')

    expect(VALUATION_PARSER_VERSION).toBe('valuation-v0.3.7')
    expect(VALUATION_PARSER_VERSION).not.toBe('valuation-v0.3.5')
    expect(uploadSource).toMatch(/parserVersion:\s*VALUATION_PARSER_VERSION/g)
    expect(uploadSource.match(/parserVersion:\s*VALUATION_PARSER_VERSION/g)).toHaveLength(2)
  })
})
