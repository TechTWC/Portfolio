import { describe, expect, it } from 'vitest'
import { buildCurrentPerformance } from '../src/lib/performance'
import type { StoredTransaction } from '../src/lib/contracts'
import { createMetricRegistry } from '../worker/ai/platform'
import type { PortfolioReadSession } from '../worker/ai/read-session'

const contribution: StoredTransaction = {
  transactionId: 'transaction-1',
  sourceRowNumber: 2,
  tradeDate: '2025-01-01',
  transactionType: 'CASH_IN',
  ticker: '',
  currency: 'TWD',
  quantity: 0,
  price: 0,
  amountForeign: 1000,
  fxRate: 1,
  fee: 0,
  budgetWaterline: null,
  budgetBalance: null,
  note: '',
  rowHash: 'a'.repeat(64),
}

function baseSession(overrides: Record<string, unknown> = {}) {
  const valuationBundle = {
    revision: 7,
    snapshot: {
      id: 'snapshot-7', revision: 7, valuation_date: '2026-01-01',
      parser_version: 'valuation-v0.3', transaction_dataset_id: 'dataset-8',
      transaction_revision: 8, activated_at: '2026-01-01 00:00:00',
    },
    marks: [], transactions: [contribution], freshness: 'CURRENT' as const,
    valuation: {
      valuationDate: '2026-01-01', baseCurrency: 'TWD' as const, complete: true,
      positions: [], cash: [], issues: [], blockingIssueCount: 0, futureMarkCount: 0,
      knownPositionValueTwd: 0, knownCashValueTwd: 1100,
      knownTotalAssetsTwd: 1100, totalAssetsTwd: 1100,
    },
  }
  const performance = buildCurrentPerformance({
    transactions: [contribution],
    valuationDate: '2026-01-01',
    valuationComplete: true,
    terminalAssetsTwd: 1100,
  })
  return {
    portfolioState: async () => ({
      activeDatasetId: 'dataset-8', cloudRevision: 8, filename: 'transactions.csv',
      parserVersion: 'parser-v0.8', earliestDate: '2025-01-01', latestDate: '2025-01-01',
      activatedAt: '2026-01-01 00:00:00',
    }),
    valuationBundle: async () => valuationBundle,
    marketBundle: async () => ({
      revision: 3, run: { dataVersion: 'market-data-v1.0.0', latestBarDate: '2026-01-01' },
      freshness: 'CURRENT', observations: [], marks: [],
    }),
    analytics: async () => ({ performance, valuationBundle }),
    ...overrides,
  }
}

function context(session = baseSession()) {
  return {
    user: { id: 'user-1', email: 'owner@example.test' },
    session: session as unknown as PortfolioReadSession,
  }
}

describe('AI official Metric golden parity', () => {
  it('returns the exact NAV already produced by the Point-in-Time valuation service', async () => {
    const result = await createMetricRegistry().getMetric('nav', {}, context())
    expect(result).toMatchObject({
      metric: 'nav', value: 1100, unit: 'TWD', status: 'COMPLETE',
      as_of: '2026-01-01', calculation_version: 'point-in-time-valuation-v0.3',
    })
    expect(result.lineage).toMatchObject({ transaction_revision: 8, valuation_version: 7 })
  })

  it('keeps stale valuation lineage bound to its source transaction revision', async () => {
    const original = baseSession()
    const bundle = await original.valuationBundle()
    const session = baseSession({
      portfolioState: async () => ({
        activeDatasetId: 'dataset-9', cloudRevision: 9, filename: 'new-transactions.csv',
        parserVersion: 'parser-v0.9', earliestDate: '2025-01-01', latestDate: '2026-02-01',
        activatedAt: '2026-02-01 00:00:00',
      }),
      valuationBundle: async () => ({ ...bundle, freshness: 'STALE' as const }),
    })

    const result = await createMetricRegistry().getMetric('nav', {}, context(session))
    expect(result).toMatchObject({ value: null, status: 'STALE' })
    expect(result.lineage).toMatchObject({ transaction_revision: 8, valuation_version: 7 })
  })

  it('returns the exact XIRR already produced by buildCurrentPerformance', async () => {
    const official = buildCurrentPerformance({
      transactions: [contribution], valuationDate: '2026-01-01',
      valuationComplete: true, terminalAssetsTwd: 1100,
    })
    const result = await createMetricRegistry().getMetric('xirr', {}, context())
    expect(official.complete).toBe(true)
    expect(result.status).toBe('COMPLETE')
    expect(result.value).toBe(official.xirr)
    expect(result.value).toBeCloseTo(0.1, 10)
  })

  it('does not expose TWR or drawdown when total-return coverage is blocked', async () => {
    const blockedHistorical = {
      performance: {
        complete: false,
        startDate: '2025-01-01', endDate: '2026-01-01',
        cumulativeTwr: null,
        drawdown: { maximumDrawdown: null },
        issues: [{
          code: 'UNSUPPORTED_TOTAL_RETURN_COVERAGE',
          message: '股息與公司行動尚未支援', dates: ['2025-01-01', '2026-01-01'],
        }],
      },
    }
    const session = baseSession({ historicalPerformance: async () => blockedHistorical })
    const registry = createMetricRegistry()
    const twr = await registry.getMetric('twr', {}, context(session))
    const drawdown = await registry.getMetric('max_drawdown', {}, context(session))
    expect(twr).toMatchObject({ value: null, status: 'INCOMPLETE' })
    expect(drawdown).toMatchObject({ value: null, status: 'INCOMPLETE' })
    expect(twr.issues[0]?.type).toBe('UNSUPPORTED_TOTAL_RETURN_COVERAGE')
  })
})
