import { describe, expect, it } from 'vitest'
import { createDataRegistry, createMetricRegistry } from '../worker/ai/platform'

describe('AI semantic platform catalog', () => {
  it('publishes exactly the v0.1 business Resource catalog', () => {
    expect(createDataRegistry().list().map((resource) => resource.name)).toEqual([
      'cash_flows',
      'data_quality',
      'fx_rates',
      'market_prices',
      'portfolio_snapshot',
      'positions',
      'security_cash_flows',
      'strategy_comparison',
      'transactions',
      'valuations',
    ])
  })

  it('publishes exactly the verified v0.1 Metric catalog', () => {
    expect(createMetricRegistry().list().map((metric) => metric.name)).toEqual([
      'cash_ratio',
      'max_drawdown',
      'nav',
      'realized_pl',
      'twr',
      'unrealized_pl',
      'xirr',
    ])
  })

  it('does not expose the deferred Security XIRR metric', async () => {
    const registry = createMetricRegistry()
    expect(registry.list().map((metric) => metric.name)).not.toContain('security_xirr')
    await expect(registry.getMetric('security_xirr', {}, {} as never)).rejects.toThrow()
  })

  it('does not advertise an unsupported central security-performance quality domain', () => {
    const description = createDataRegistry().describe('data_quality')
    const domain = description.fields.find((field) => field.name === 'domain')
    expect(domain?.enum_values).not.toContain('SECURITY_PERFORMANCE')
  })

  it('describes percentage units as decimal values rather than ambiguous percent numbers', () => {
    const metrics = createMetricRegistry().list()
    expect(metrics.find((metric) => metric.name === 'twr')?.unit).toBe('decimal')
    expect(metrics.find((metric) => metric.name === 'cash_ratio')?.unit).toBe('decimal')
  })
})
