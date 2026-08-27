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

  it('describes percentage units as decimal values rather than ambiguous percent numbers', () => {
    const metrics = createMetricRegistry().list()
    expect(metrics.find((metric) => metric.name === 'twr')?.unit).toBe('decimal')
    expect(metrics.find((metric) => metric.name === 'cash_ratio')?.unit).toBe('decimal')
  })
})
