import { describe, expect, it } from 'vitest'
import { buildCashFundingLedger } from '../src/lib/cash-ledger'
import type { NormalizedTransaction } from '../src/lib/contracts'

function transaction(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
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
    rowHash: 'b'.repeat(64),
    ...overrides,
  }
}

describe('cash and FX funding ledger', () => {
  it('keeps security-only files backward compatible and untracked', () => {
    const result = buildCashFundingLedger([
      transaction({ quantity: 10, amountForeign: 10_000 }),
      transaction({ sourceRowNumber: 3, tradeDate: '2026-01-02', quantity: -2, amountForeign: 2_200 }),
    ])

    expect(result).toEqual({
      trackingMode: 'UNTRACKED',
      wallets: [],
      issues: [],
      blockingIssueCount: 0,
    })
  })

  it('uses a TWD deposit to fund a local security buy', () => {
    const result = buildCashFundingLedger([
      transaction({ transactionType: 'CASH_IN', ticker: '', quantity: 0, price: 0, amountForeign: 20_000 }),
      transaction({ sourceRowNumber: 3, tradeDate: '2026-01-02', quantity: 10, amountForeign: 10_000, fee: 20 }),
    ])

    expect(result.trackingMode).toBe('TRACKED')
    expect(result.blockingIssueCount).toBe(0)
    expect(result.wallets).toEqual([
      expect.objectContaining({
        currency: 'TWD',
        deposits: 20_000,
        securitySpent: 10_000,
        fees: 20,
        endingBalance: 9_980,
      }),
    ])
  })

  it('handles explicit USD conversion and a funded stock buy', () => {
    const result = buildCashFundingLedger([
      transaction({ transactionType: 'CASH_IN', ticker: '', quantity: 0, price: 0, amountForeign: 100_000 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'FX_BUY',
        ticker: '',
        currency: 'USD',
        quantity: 0,
        price: 0,
        amountForeign: 2_000,
        fxRate: 32,
        fee: 100,
      }),
      transaction({
        sourceRowNumber: 4,
        tradeDate: '2026-01-03',
        ticker: 'AAPL',
        currency: 'USD',
        quantity: 5,
        price: 200,
        amountForeign: 1_000,
        fxRate: 32.2,
        fee: 5,
      }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.wallets).toEqual([
      expect.objectContaining({
        currency: 'TWD',
        deposits: 100_000,
        explicitFxOut: 64_000,
        fees: 100,
        endingBalance: 35_900,
      }),
      expect.objectContaining({
        currency: 'USD',
        explicitFxIn: 2_000,
        securitySpent: 1_000,
        fees: 5,
        endingBalance: 995,
      }),
    ])
  })

  it('auto-funds the exact foreign-currency shortfall from TWD', () => {
    const result = buildCashFundingLedger([
      transaction({ transactionType: 'CASH_IN', ticker: '', quantity: 0, price: 0, amountForeign: 50_000 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        ticker: 'AAPL',
        currency: 'USD',
        quantity: 5,
        price: 200,
        amountForeign: 1_000,
        fxRate: 32,
        fee: 5,
      }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.wallets).toEqual([
      expect.objectContaining({
        currency: 'TWD',
        autoFundingOut: 32_160,
        endingBalance: 17_840,
      }),
      expect.objectContaining({
        currency: 'USD',
        autoFundedIn: 1_005,
        securitySpent: 1_000,
        fees: 5,
        endingBalance: 0,
      }),
    ])
  })

  it('blocks excessive cash withdrawal without truncating it', () => {
    const result = buildCashFundingLedger([
      transaction({ transactionType: 'CASH_IN', ticker: '', quantity: 0, price: 0, amountForeign: 1_000 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'CASH_OUT',
        ticker: '',
        quantity: 0,
        price: 0,
        amountForeign: 1_100,
      }),
    ])

    expect(result.issues[0].code).toBe('CASH_OUT_EXCEEDS_BALANCE')
    expect(result.wallets[0].endingBalance).toBe(1_000)
  })

  it('blocks excessive foreign-currency sale without truncating it', () => {
    const result = buildCashFundingLedger([
      transaction({
        transactionType: 'CASH_IN',
        ticker: '',
        currency: 'USD',
        quantity: 0,
        price: 0,
        amountForeign: 100,
        fxRate: 32,
      }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'FX_SELL',
        ticker: '',
        currency: 'USD',
        quantity: 0,
        price: 0,
        amountForeign: 120,
        fxRate: 32.5,
      }),
    ])

    expect(result.issues[0].code).toBe('FX_SELL_EXCEEDS_BALANCE')
    expect(result.wallets.find((wallet) => wallet.currency === 'USD')?.endingBalance).toBe(100)
  })

  it('requires an actual FX rate for automatic funding', () => {
    const result = buildCashFundingLedger([
      transaction({ transactionType: 'CASH_IN', ticker: '', quantity: 0, price: 0, amountForeign: 50_000 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        ticker: 'AAPL',
        currency: 'USD',
        quantity: 5,
        price: 200,
        amountForeign: 1_000,
        fxRate: null,
      }),
    ])

    expect(result.issues[0].code).toBe('MISSING_FX_RATE_FOR_AUTO_FUND')
    expect(result.wallets.find((wallet) => wallet.currency === 'TWD')?.endingBalance).toBe(50_000)
  })

  it('blocks automatic funding when TWD cash is insufficient', () => {
    const result = buildCashFundingLedger([
      transaction({ transactionType: 'CASH_IN', ticker: '', quantity: 0, price: 0, amountForeign: 10_000 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        ticker: 'AAPL',
        currency: 'USD',
        quantity: 5,
        price: 200,
        amountForeign: 1_000,
        fxRate: 32,
      }),
    ])

    expect(result.issues[0].code).toBe('INSUFFICIENT_TWD_FOR_AUTO_FUND')
    expect(result.wallets.find((wallet) => wallet.currency === 'TWD')?.endingBalance).toBe(10_000)
  })
})
