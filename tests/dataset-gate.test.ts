import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import { validateDatasetForActivation } from '../src/lib/dataset-gate'

function row(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'SECURITY',
    ticker: 'TEST',
    currency: 'TWD',
    quantity: 1,
    price: 100,
    amountForeign: 100,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: 'a'.repeat(64),
    ...overrides,
  }
}

describe('dataset activation gate', () => {
  it('allows a reconciled cash, FX and security sequence', () => {
    const result = validateDatasetForActivation([
      row({ transactionType: 'CASH_IN', ticker: '', quantity: 0, price: 0, amountForeign: 100_000 }),
      row({ sourceRowNumber: 3, tradeDate: '2026-01-02', transactionType: 'FX_BUY', ticker: '', currency: 'USD', quantity: 0, price: 0, amountForeign: 2_000, fxRate: 32, fee: 100 }),
      row({ sourceRowNumber: 4, tradeDate: '2026-01-03', ticker: 'AAPL', currency: 'USD', quantity: 2, price: 200, amountForeign: 400, fxRate: 32.5 }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.issues).toEqual([])
  })

  it('blocks an oversell without duplicating the FX cost basis error', () => {
    const result = validateDatasetForActivation([
      row({ quantity: 2, amountForeign: 200 }),
      row({ sourceRowNumber: 3, tradeDate: '2026-01-02', quantity: -3, amountForeign: 330 }),
    ])

    expect(result.blockingIssueCount).toBe(1)
    expect(result.issues[0]).toMatchObject({ domain: 'SECURITY_ACCOUNTING', code: 'OVERSELL' })
  })

  it('blocks a withdrawal larger than tracked cash without duplicate pool errors', () => {
    const result = validateDatasetForActivation([
      row({ transactionType: 'CASH_IN', ticker: '', quantity: 0, price: 0, amountForeign: 10_000 }),
      row({ sourceRowNumber: 3, tradeDate: '2026-01-02', transactionType: 'CASH_OUT', ticker: '', quantity: 0, price: 0, amountForeign: 20_000 }),
    ])

    expect(result.blockingIssueCount).toBe(1)
    expect(result.issues[0]).toMatchObject({ domain: 'CASH_FX_FUNDING', code: 'CASH_OUT_EXCEEDS_BALANCE' })
  })

  it('blocks a foreign security sale that lacks sale-date FX for TWD basis', () => {
    const result = validateDatasetForActivation([
      row({
        ticker: 'AAPL',
        currency: 'USD',
        quantity: 2,
        price: 200,
        amountForeign: 400,
        fxRate: 32,
      }),
      row({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        ticker: 'AAPL',
        currency: 'USD',
        quantity: -1,
        price: 250,
        amountForeign: 250,
        fxRate: null,
      }),
    ])

    expect(result.blockingIssueCount).toBe(1)
    expect(result.issues[0]).toMatchObject({
      domain: 'FX_COST_BASIS',
      code: 'MISSING_SECURITY_SALE_FX',
      sourceRowNumber: 3,
    })
  })

  it('keeps legacy security-only files compatible when historical FX is supplied', () => {
    const result = validateDatasetForActivation([
      row({ ticker: '2330.TW', quantity: 10, amountForeign: 10_000 }),
      row({ sourceRowNumber: 3, tradeDate: '2026-01-02', ticker: 'AAPL', currency: 'USD', quantity: 2, price: 200, amountForeign: 400, fxRate: 32.5 }),
    ])

    expect(result.blockingIssueCount).toBe(0)
  })
})
