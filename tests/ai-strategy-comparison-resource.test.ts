import { describe, expect, it, vi } from 'vitest'
import { createDataRegistry } from '../worker/ai/platform'
import { parseStrategyQueryFilters } from '../worker/ai/strategy-request'
import type { StrategyComparisonResponse, StrategySimulationResult } from '../src/lib/strategy-comparison-contracts'
import type { PortfolioReadSession } from '../worker/ai/read-session'

const filters = {
  start_date: '2026-01-01',
  end_date: '2026-04-01',
  dca_monthly_amount_twd: 70000,
  allocations: '0050.TW:50,2330.TW:50',
}

function simulation(mode: StrategySimulationResult['mode'], status: StrategySimulationResult['status'] = 'ESTIMATED'): StrategySimulationResult {
  return {
    mode, status, startDate: '2026-01-02', endDate: '2026-04-01',
    grossContributionsTwd: 280000, grossWithdrawalsTwd: 0,
    terminalValueTwd: status === 'ESTIMATED' ? 300000 : null,
    estimatedGainTwd: status === 'ESTIMATED' ? 20000 : null,
    moneyMultiple: status === 'ESTIMATED' ? 300000 / 280000 : null,
    xirr: status === 'ESTIMATED' ? 0.2 : null,
    cumulativeTwr: status === 'ESTIMATED' ? 0.05 : null,
    annualizedTwr: status === 'ESTIMATED' ? 0.1 : null,
    maximumDrawdown: status === 'ESTIMATED' ? -0.1 : null,
    recoveryDate: status === 'ESTIMATED' ? '2026-03-01' : null,
    executionCount: 4, executions: [], curve: [],
    issues: status === 'ESTIMATED' ? [] : [{
      code: 'MISSING_REPLAY_FX',
      severity: 'BLOCKING', message: 'Missing observed trade-date FX',
      sourceRowNumbers: [2],
    }],
  }
}

function mockService(replayStatus: StrategySimulationResult['status'] = 'ESTIMATED') {
  const response: StrategyComparisonResponse = {
    calculationVersion: 'strategy-comparison-v0.1',
    status: replayStatus,
    priceBasis: 'YAHOO_ADJUSTED_CLOSE_TWD_PROXY',
    marketSource: 'YAHOO_FINANCE_CHART',
    marketDataVersion: 'YAHOO_FINANCE_CHART_ADJUSTED_CLOSE_PROXY:v0.1:fixture',
    transactionRevision: 9,
    allocations: [{ ticker: '0050.TW', weight: 0.5 }, { ticker: '2330.TW', weight: 0.5 }],
    instruments: [], assumptions: [],
    dcaMonthlyAmountTwd: 70000, lumpSumPrincipalTwd: 280000,
    strategies: {
      dca: simulation('DCA'),
      lumpSum: simulation('LUMP_SUM'),
      transactionReplay: simulation('TRANSACTION_REPLAY', replayStatus),
    },
  }
  const strategyComparison = vi.fn(async () => response)
  const mock = {
    strategyComparison,
    cachedStrategyComparison: vi.fn(async () => response),
    portfolioState: vi.fn(async () => ({ cloudRevision: 9, parserVersion: 'parser-v0.8' })),
    valuationMetadata: vi.fn(async () => ({ revision: 5, snapshot: null })),
    marketMetadata: vi.fn(async () => ({ run: null })),
    currentAnalytics: vi.fn(() => { throw new Error('should not call analytics or account XIRR') }),
  }
  const context = {
    user: { id: 'synthetic-user', email: 'user@example.test' },
    session: mock as unknown as PortfolioReadSession,
  }
  return { mock, context }
}

describe('MCP strategy comparison through existing read-only query_data', () => {
  it('parses 1–5 ticker weights from scalar resource filters', () => {
    expect(parseStrategyQueryFilters(filters)).toEqual({
      startDate: '2026-01-01', endDate: '2026-04-01',
      dcaMonthlyAmountTwd: 70000,
      allocations: [{ ticker: '0050.TW', weight: 0.5 }, { ticker: '2330.TW', weight: 0.5 }],
    })
  })

  it('returns three projected rows with estimated warnings and calculation lineage', async () => {
    const registry = createDataRegistry()
    const { context, mock } = mockService()
    const result = await registry.query('strategy_comparison', { filters }, context)
    expect(result.rows).toHaveLength(3)
    expect(result.rows.map((row) => row.mode)).toEqual(['DCA', 'LUMP_SUM', 'TRANSACTION_REPLAY'])
    expect(result.rows[0]).toMatchObject({
      status: 'ESTIMATED', gross_contributions_twd: 280000,
      terminal_value_twd: 300000, xirr: 0.2, maximum_drawdown: -0.1,
    })
    expect(result.returned_row_count).toBe(3)
    expect(result.next_cursor).toBeNull()
    expect(result.data_quality.status).toBe('ESTIMATED')
    expect(result.data_quality.issues).toContainEqual(expect.objectContaining({
      type: 'STRATEGY_ADJUSTED_CLOSE_PROXY', severity: 'WARNING',
    }))
    expect(result.lineage).toMatchObject({
      transaction_revision: 9, valuation_version: 5,
      calculation_version: 'strategy-comparison-v0.1',
      source_version: 'YAHOO_FINANCE_CHART_ADJUSTED_CLOSE_PROXY:v0.1:fixture',
      as_of: '2026-04-01',
    })
    expect(mock.currentAnalytics).not.toHaveBeenCalled()
    expect(mock.strategyComparison).toHaveBeenCalledWith(parseStrategyQueryFilters(filters))
  })

  it('returns distinct per-mode INCOMPLETE and machine-readable limitations', async () => {
    const { context } = mockService('INCOMPLETE')
    const result = await createDataRegistry().query('strategy_comparison', { filters }, context)
    expect(result.data_quality.status).toBe('INCOMPLETE')
    expect(result.rows[0].status).toBe('ESTIMATED')
    expect(result.rows[2]).toMatchObject({
      status: 'INCOMPLETE', terminal_value_twd: null, xirr: null,
      issue_codes: 'MISSING_REPLAY_FX',
    })
    expect(result.data_quality.issues).toContainEqual(expect.objectContaining({
      type: 'MISSING_REPLAY_FX', severity: 'BLOCKING',
    }))
  })

  it('get_data_lineage resource accepts the same validated query parameters', async () => {
    const { context, mock } = mockService()
    const registry = createDataRegistry()
    const query = await registry.query('strategy_comparison', { filters }, context)
    const lineage = await registry.lineage('strategy_comparison', context, filters)
    expect(lineage.transaction_revision).toBe(9)
    expect(lineage.calculation_version).toBe('strategy-comparison-v0.1')
    expect(lineage.source_version).toBe(query.lineage.source_version)
    expect(mock.strategyComparison).toHaveBeenCalledTimes(1)
    expect(mock.cachedStrategyComparison).toHaveBeenCalledTimes(1)
  })

  it('returns the fixed three rows in one snapshot and rejects cursor pagination', async () => {
    const registry = createDataRegistry()
    const { context, mock } = mockService()
    expect(registry.describe('strategy_comparison').pagination).toEqual({
      supported: false,
      default_page_size: null,
      max_page_size: null,
      cursor: null,
    })
    await expect(registry.query('strategy_comparison', {
      filters,
      pagination: { limit: 1 },
    }, context)).rejects.toMatchObject({ code: 'PAGINATION_NOT_SUPPORTED' })
    expect(mock.strategyComparison).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...filters, allocations: '0050.TW:60,2330.TW:30' }],
    [{ ...filters, allocations: '0050.TW:100,0050.TW:0' }],
    [{ ...filters, allocations: '0050.TW:100,0050.TW:100' }],
    [{ ...filters, allocations: '0050.TW:100,DROP TABLE users:1' }],
    [{ ...filters, allocations: '0050.TW:100,2330.TW:NaN' }],
    [{ ...filters, dca_monthly_amount_twd: -70000 }],
    [{ ...filters, start_date: '2026-03-01', end_date: '2026-02-01' }],
    [{ ...filters, allocations: '' }],
    [{ ...filters, allocations: null }],
    [{ ...filters, start_date: 'tomorrow' }],
  ])('fails closed for invalid input %# before running any strategy', async (invalid) => {
    const { context, mock } = mockService()
    await expect(createDataRegistry().query('strategy_comparison', { filters: invalid }, context))
      .rejects.toMatchObject({ code: 'INVALID_STRATEGY_FILTER' })
    expect(mock.strategyComparison).not.toHaveBeenCalled()
  })

  it('rejects unregistered SQL-shaped filters and fields before calculation', async () => {
    const { context, mock } = mockService()
    await expect(createDataRegistry().query('strategy_comparison', {
      filters: { ...filters, where_sql: 'select * from users' },
    }, context)).rejects.toMatchObject({ code: 'INVALID_FILTER' })
    await expect(createDataRegistry().query('strategy_comparison', {
      filters, fields: ['raw_transaction_notes'],
    }, context)).rejects.toMatchObject({ code: 'INVALID_FIELD' })
    expect(mock.strategyComparison).not.toHaveBeenCalled()
  })
})
