import { describe, expect, it } from 'vitest'
import { buildCurrentPerformance } from '../src/lib/performance'
import { buildSecurityInvestmentPerformance } from '../src/lib/security-performance'
import type { StoredTransaction } from '../src/lib/contracts'
import { createDataRegistry, createMetricRegistry } from '../worker/ai/platform'
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

const securityPurchase: StoredTransaction = {
  ...contribution,
  transactionId: 'transaction-2',
  transactionType: 'SECURITY',
  ticker: '2330.TW',
  quantity: 1,
  price: 100,
  amountForeign: 100,
  rowHash: 'b'.repeat(64),
}

function baseSession(overrides: Record<string, unknown> = {}) {
  const valuationBundle = {
    revision: 7,
    snapshot: {
      id: 'snapshot-7', revision: 7, valuation_date: '2026-01-01',
      parser_version: 'valuation-v0.3', transaction_dataset_id: 'dataset-8',
      transaction_revision: 8, activated_at: '2026-01-01 00:00:00',
    },
    marks: [], transactions: [contribution], freshness: 'CURRENT' as const, freshnessIssues: [],
    valuation: {
      valuationDate: '2026-01-01', baseCurrency: 'TWD' as const, complete: true,
      positions: [], cash: [], issues: [], blockingIssueCount: 0, futureMarkCount: 0,
      knownPositionValueTwd: 110, knownCashValueTwd: 990,
      knownTotalAssetsTwd: 1100, totalAssetsTwd: 1100,
    },
  }
  const performance = buildCurrentPerformance({
    transactions: [contribution],
    valuationDate: '2026-01-01',
    valuationComplete: true,
    terminalAssetsTwd: 1100,
  })
  const securityPerformance = buildSecurityInvestmentPerformance({
    transactions: [securityPurchase],
    valuationDate: '2026-01-01',
    valuationComplete: true,
    terminalPositionValueTwd: 110,
  })
  const currentAnalytics = { performance, securityPerformance, valuationBundle }
  return {
    portfolioState: async () => ({
      activeDatasetId: 'dataset-8', cloudRevision: 8, filename: 'transactions.csv',
      parserVersion: 'parser-v0.8', earliestDate: '2025-01-01', latestDate: '2025-01-01',
      activatedAt: '2026-01-01 00:00:00',
    }),
    valuationBundle: async () => valuationBundle,
    valuationMetadata: async () => ({
      revision: valuationBundle.revision,
      snapshot: valuationBundle.snapshot,
      freshness: valuationBundle.freshness, freshnessIssues: valuationBundle.freshnessIssues,
    }),
    marketBundle: async () => ({
      revision: 3, run: { dataVersion: 'market-data-v1.0.0', latestBarDate: '2026-01-01' },
      freshness: 'CURRENT', freshnessIssues: [], observations: [], marks: [],
    }),
    marketMetadata: async () => ({
      revision: 3, run: { dataVersion: 'market-data-v1.0.0', latestBarDate: '2026-01-01' },
      freshness: 'CURRENT', freshnessIssues: [],
    }),
    currentAnalytics: async () => currentAnalytics,
    analytics: async () => currentAnalytics,
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

  it('returns the distinct estimated security XIRR without changing official XIRR semantics', async () => {
    const registry = createMetricRegistry()
    const estimated = await registry.getMetric('security_xirr', {}, context())
    const official = await registry.getMetric('xirr', {}, context())

    expect(estimated).toMatchObject({
      metric: 'security_xirr',
      status: 'ESTIMATED',
      calculation_version: 'estimated-security-investment-xirr-v0.1',
    })
    expect(estimated.value).toBeCloseTo(0.1, 9)
    expect(estimated.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ESTIMATED_SECURITY_RETURN_SCOPE', severity: 'WARNING' }),
      expect.objectContaining({
        type: 'UNRECORDED_DISTRIBUTIONS_AND_CORPORATE_ACTIONS', severity: 'WARNING',
      }),
      expect.objectContaining({ type: 'TRADE_DATE_AND_RECORDED_FX_ASSUMPTIONS', severity: 'WARNING' }),
    ]))
    expect(official.value).toBeCloseTo(0.1, 9)
    expect(registry.list().find((metric) => metric.name === 'xirr')?.description)
      .toContain('Official')
    expect(registry.list().find((metric) => metric.name === 'security_xirr')?.description)
      .toContain('Estimated')
  })

  it('exposes the exact estimated security cash-flow chain as a read-only resource', async () => {
    const result = await createDataRegistry().query('security_cash_flows', {
      sort: { field: 'date', direction: 'asc' },
    }, context())

    expect(result.data_quality.status).toBe('ESTIMATED')
    expect(result.data_quality.issues).toContainEqual(expect.objectContaining({
      type: 'UNRECORDED_DISTRIBUTIONS_AND_CORPORATE_ACTIONS', severity: 'WARNING',
    }))
    expect(result.lineage.calculation_version).toBe('estimated-security-investment-xirr-v0.1')
    expect(result.rows).toEqual([
      expect.objectContaining({
        date: '2025-01-01', type: 'PURCHASE', signed_amount_twd: -100, source: 'TRANSACTION',
      }),
      expect.objectContaining({
        date: '2026-01-01', type: 'TERMINAL_POSITION_VALUE', signed_amount_twd: 110,
        source: 'ACTIVE_POSITION_VALUATION',
      }),
    ])
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
