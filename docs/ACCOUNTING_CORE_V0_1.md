# Portfolio Accounting Core v0.1

## Purpose

This module turns the normalized ACTIVE transaction dataset into a deterministic security-accounting ledger before any market-price, FX valuation, return, drawdown, or strategy calculation is added.

The dashboard must not label these results as market value, NAV, total assets, or investment return.

## Processing order

Transactions are processed by:

1. `tradeDate` ascending;
2. `sourceRowNumber` ascending for rows on the same date.

This prevents file row order from changing the accounting result when dates differ.

## Security transaction rules

### Buy

A `SECURITY` row with positive quantity is a buy.

```text
buy total cost = amountForeign + fee
new quantity = old quantity + buy quantity
new cost basis = old cost basis + buy total cost
moving average unit cost = new cost basis / new quantity
security cash flow = -(amountForeign + fee)
```

### Sell

A `SECURITY` row with negative quantity is a sell.

```text
sell quantity = absolute value of quantity
released cost basis = pre-sell moving average unit cost × sell quantity
net sale proceeds = amountForeign - fee
realized security P&L = net sale proceeds - released cost basis
new quantity = old quantity - sell quantity
new cost basis = old cost basis - released cost basis
security cash flow = amountForeign - fee
```

### Oversell

A sell larger than the position available immediately before that trade produces blocking issue `OVERSELL`.

The invalid sell is not silently truncated and does not create a negative position or cash proceeds.

### Currency separation

Every position and cash-flow ledger remains in transaction currency.

TWD and USD amounts are not added together in v0.1. A ticker appearing under more than one currency produces blocking issue `CURRENCY_MISMATCH`.

## Fee treatment

- Buy fees are capitalized into security cost basis.
- Sell fees reduce net sale proceeds and realized security P&L.
- Fees remain recorded in their transaction currency.

## Deferred transaction types

The following normalized types are preserved in the cloud dataset but not yet incorporated into accounting balances:

- `FX_BUY`
- `FX_SELL`
- `CASH_IN`
- `CASH_OUT`

They produce a non-blocking `DEFERRED_TRANSACTION_TYPE` reminder.

## Current staging acceptance values

Using synthetic `portfolio_test_v4.csv`:

### TWD

- 2330.TW: buy 10 shares for 10,000; sell 2 shares for 2,200.
- Remaining quantity: 8.
- Moving average unit cost: 1,000.
- Remaining cost basis: 8,000.
- Realized security P&L: 200.
- Net security cash flow: -7,800.

### USD

- AAPL: 2 shares, cost basis 400.
- MSFT: 1 share, cost basis 500.
- NVDA: 1 share, cost basis 150.
- Combined USD security cash flow: -1,050.

No transaction fees are present in this synthetic dataset.

## Not implemented yet

- FIFO and LIFO comparison.
- Cash balance and capital-injection ledger.
- Actual FX conversion lots and realized FX P&L.
- USD cash unrealized FX remeasurement.
- Market prices and market value.
- Unrealized security P&L.
- Total assets and NAV.
- XIRR, TWR, CAGR, drawdown, benchmark, or strategy comparison.
- Dividends, stock splits, stock dividends, capital reductions, mergers, or other corporate actions.

## Planned progression

1. Validate moving-average accounting in staging.
2. Add FIFO and LIFO as comparison methods without changing the default ledger.
3. Add cash and FX lot accounting, keeping security P&L and FX P&L separate.
4. Add strict on-or-before market prices and FX rates.
5. Add market value, unrealized P&L, NAV, XIRR/TWR, and drawdown only after golden-case reconciliation.
