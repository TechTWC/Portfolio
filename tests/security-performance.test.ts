import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import { buildSecurityInvestmentPerformance } from '../src/lib/security-performance'

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
  overrides: Partial<Parameters<typeof buildSecurityInvestmentPerformance>[0]> = {},
) {
  return buildSecurityInvestmentPerformance({
    transactions,
    valuationDate: '2027-01-01',
    positionValuationComplete: true,
    terminalPositionValueTwd: 110,
    ...overrides,
  })
}

describe('estimated security investment XIRR', () => {
  it('calculates a 10 percent one-year return from a purchase and terminal position value', () => {
    const result = calculate([row()])

    expect(result.complete).toBe(true)
    expect(result.estimated).toBe(true)
    expect(result.xirr).toBeCloseTo(0.1, 9)
    expect(result.grossPurchasesTwd).toBe(100)
    expect(result.grossSaleProceedsTwd).toBe(0)
    expect(result.netSecurityCapitalDeployedTwd).toBe(100)
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
    expect(result.xirr).toBeCloseTo(0.25, 9)
  })

  it('locks the anonymized synthetic golden rate verified against the supplied workbook', () => {
    const result = calculate([
      row({ tradeDate: '2025-09-01', amountForeign: 1_000, price: 1_000 }),
      row({ sourceRowNumber: 3, tradeDate: '2026-01-15', amountForeign: 600, price: 600 }),
      row({
        sourceRowNumber: 4,
        tradeDate: '2026-05-20',
        quantity: -1,
        amountForeign: 250,
        price: 250,
      }),
    ], {
      valuationDate: '2026-09-01',
      terminalPositionValueTwd: 1_787.1596659049292,
    })

    expect(result.complete).toBe(true)
    expect(result.securityCashFlows).toHaveLength(4)
    expect(result.xirr).toBeCloseTo(0.3384104923, 9)
  })

  it('blocks a foreign security transaction without a usable trade-date FX rate', () => {
    const result = calculate([row({ ticker: 'VOO', currency: 'USD', fxRate: null })])

    expect(result.complete).toBe(false)
    expect(result.xirr).toBeNull()
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
    expect(result.xirr).toBeCloseTo(0.1, 9)
    expect(result.issues).toEqual([])
  })

  it('blocks transactions later than the valuation date', () => {
    const result = calculate([
      row(),
      row({ sourceRowNumber: 3, tradeDate: '2027-02-01' }),
    ])

    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'TRANSACTION_AFTER_VALUATION_DATE', sourceRowNumbers: [3],
    }))
  })

  it('blocks multiple mathematical roots instead of selecting one silently', () => {
    const result = calculate([
      row({ tradeDate: '2026-01-01', amountForeign: 100 }),
      row({ sourceRowNumber: 3, tradeDate: '2027-01-01', quantity: -1, amountForeign: 230 }),
      row({ sourceRowNumber: 4, tradeDate: '2028-01-01', quantity: 1, amountForeign: 132 }),
    ], {
      valuationDate: '2028-01-01',
      terminalPositionValueTwd: 0,
    })

    expect(result.complete).toBe(false)
    expect(result.xirr).toBeNull()
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'MULTIPLE_XIRR_ROOTS' }))
  })
})
