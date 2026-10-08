import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import { buildSecurityCashFlowSummary } from '../src/lib/security-performance'

function row(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'SECURITY',
    ticker: '2330.TW',
    currency: 'TWD',
    quantity: 1,
    price: 100,
    amountForeign: 100,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: 'd'.repeat(64),
    ...overrides,
  }
}

function calculate(
  transactions: NormalizedTransaction[],
  overrides: Partial<Parameters<typeof buildSecurityCashFlowSummary>[0]> = {},
) {
  return buildSecurityCashFlowSummary({
    transactions,
    valuationDate: '2027-01-01',
    positionValuationComplete: true,
    terminalPositionValueTwd: 110,
    ...overrides,
  })
}

describe('estimated security investment cash-flow summary', () => {
  it('summarizes purchase, terminal value, gain and money multiple without XIRR', () => {
    const result = calculate([row()])

    expect(result.complete).toBe(true)
    expect(result.estimated).toBe(true)
    expect(result.calculationVersion).toBe('estimated-security-cash-flow-v0.1')
    expect(result.grossPurchasesTwd).toBe(100)
    expect(result.grossSaleProceedsTwd).toBe(0)
    expect(result.netSecurityCapitalDeployedTwd).toBe(100)
    expect(result.terminalPositionValueTwd).toBe(110)
    expect(result.estimatedGainTwd).toBe(10)
    expect(result.securityMultiple).toBeCloseTo(1.1, 12)
  })

  it('treats purchase fees as outflow and sale fees as a reduction of proceeds', () => {
    const result = calculate([
      row({ amountForeign: 100, fee: 2 }),
      row({ sourceRowNumber: 3, tradeDate: '2026-07-01', quantity: -1, amountForeign: 70, fee: 3 }),
    ], { terminalPositionValueTwd: 50 })

    expect(result.grossPurchasesTwd).toBe(102)
    expect(result.grossSaleProceedsTwd).toBe(67)
    expect(result.netSecurityCapitalDeployedTwd).toBe(35)
    expect(result.terminalPositionValueTwd).toBe(50)
    expect(result.estimatedGainTwd).toBe(15)
    expect(result.securityCashFlows).toEqual([
      expect.objectContaining({ kind: 'PURCHASE', signedAmountTwd: -102 }),
      expect.objectContaining({ kind: 'SALE', signedAmountTwd: 67 }),
      expect.objectContaining({ kind: 'TERMINAL_POSITION_VALUE', signedAmountTwd: 50 }),
    ])
  })

  it('treats epsilon-sized foreign sale proceeds as zero without requiring FX', () => {
    const result = calculate([
      row({ quantity: 2, amountForeign: 200, price: 100 }),
      row({
        sourceRowNumber: 3,
        tradeDate: '2026-07-01',
        ticker: 'VOO',
        currency: 'USD',
        quantity: -3,
        amountForeign: 0,
        price: 0.1,
        fxRate: null,
        fee: 0.3,
      }),
    ], { terminalPositionValueTwd: 220 })

    expect(3 * 0.1 - 0.3).toBeGreaterThan(0)
    expect(3 * 0.1 - 0.3).toBeLessThan(1e-9)
    expect(result.complete).toBe(true)
    expect(result.grossSaleProceedsTwd).toBe(0)
    expect(result.issues).toEqual([])
    expect(result.securityCashFlows).toEqual([
      expect.objectContaining({ kind: 'PURCHASE', signedAmountTwd: -200 }),
      expect.objectContaining({ kind: 'TERMINAL_POSITION_VALUE', signedAmountTwd: 220 }),
    ])
  })

  it('uses each foreign security transaction FX rate', () => {
    const result = calculate([
      row({ ticker: 'VOO', currency: 'USD', amountForeign: 100, fxRate: 30, fee: 1 }),
      row({
        sourceRowNumber: 3,
        tradeDate: '2026-07-01',
        ticker: 'VOO',
        currency: 'USD',
        quantity: -1,
        amountForeign: 40,
        fxRate: 32,
        fee: 1,
      }),
    ], { terminalPositionValueTwd: 2_000 })

    expect(result.grossPurchasesTwd).toBe(3_030)
    expect(result.grossSaleProceedsTwd).toBe(1_248)
  })

  it('excludes bank cash flows and internal FX trades from the security cash-flow series', () => {
    const result = calculate([
      row(),
      row({ sourceRowNumber: 3, transactionType: 'CASH_IN', ticker: '', quantity: 0, amountForeign: 1_000 }),
      row({ sourceRowNumber: 4, transactionType: 'FX_BUY', ticker: '', quantity: 0, currency: 'USD', amountForeign: 20, fxRate: 31 }),
    ])

    expect(result.securityCashFlows).toHaveLength(2)
    expect(result.grossPurchasesTwd).toBe(100)
  })

  it('uses terminal position value rather than total account assets supplied elsewhere', () => {
    const result = calculate([row()], { terminalPositionValueTwd: 125 })

    expect(result.terminalPositionValueTwd).toBe(125)
    expect(result.estimatedGainTwd).toBe(25)
    expect(result.securityMultiple).toBeCloseTo(1.25, 12)
  })

  it('allows same-day purchase and terminal valuation because no annualized XIRR is calculated', () => {
    const result = calculate([row({ tradeDate: '2026-01-01' })], {
      valuationDate: '2026-01-01',
      terminalPositionValueTwd: 110,
    })

    expect(result.complete).toBe(true)
    expect(result.estimatedGainTwd).toBe(10)
    expect(result.securityMultiple).toBeCloseTo(1.1, 12)
    expect(result.issues).toEqual([])
  })

  it('fails gain and multiple closed when a foreign security flow has no usable FX rate', () => {
    const result = calculate([row({ ticker: 'VOO', currency: 'USD', fxRate: null })])

    expect(result.complete).toBe(false)
    expect(result.estimatedGainTwd).toBeNull()
    expect(result.securityMultiple).toBeNull()
    expect(result.terminalPositionValueTwd).toBe(110)
    expect(result.grossPurchasesTwd).toBe(0)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'MISSING_SECURITY_FLOW_FX', sourceRowNumbers: [2],
    }))
  })

  it('blocks an incomplete valuation instead of using partial position value', () => {
    const result = calculate([row()], {
      positionValuationComplete: false,
      terminalPositionValueTwd: null,
    })

    expect(result.complete).toBe(false)
    expect(result.terminalPositionValueTwd).toBeNull()
    expect(result.issues.some((issue) => issue.code === 'INCOMPLETE_VALUATION')).toBe(true)
  })

  it('ignores non-security transactions after the valuation date', () => {
    const result = calculate([
      row(),
      row({
        sourceRowNumber: 3,
        tradeDate: '2027-02-01',
        transactionType: 'CASH_IN',
        ticker: '',
        quantity: 0,
        amountForeign: 1_000,
      }),
    ])

    expect(result.complete).toBe(true)
    expect(result.estimatedGainTwd).toBe(10)
    expect(result.issues).toEqual([])
  })

  it('fails summary metrics closed when a security transaction is later than the valuation date', () => {
    const result = calculate([
      row(),
      row({ sourceRowNumber: 3, tradeDate: '2027-02-01' }),
    ])

    expect(result.complete).toBe(false)
    expect(result.estimatedGainTwd).toBeNull()
    expect(result.securityMultiple).toBeNull()
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'TRANSACTION_AFTER_VALUATION_DATE', sourceRowNumbers: [3],
    }))
  })
})
