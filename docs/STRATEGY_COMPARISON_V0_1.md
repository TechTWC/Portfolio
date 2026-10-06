# Strategy Comparison v0.1

## Problem

Portfolio Analyzer can reconstruct the user's actual portfolio, but it cannot yet answer the counterfactual question: under the same comparison period, how would a chosen target portfolio have behaved under different capital-deployment paths?

## v0.1 scope

One comparison request evaluates the same custom target portfolio under three modes:

1. **DCA** — fixed TWD amount every month. The schedule keeps the start-date day-of-month and executes on the next date where every selected asset has a usable total-return proxy price.
2. **Lump Sum** — invests once on the first common trading date. Gross principal is automatically set equal to the DCA gross principal actually executed in the comparison window.
3. **Transaction Replay** — converts the ACTIVE Dataset's SECURITY transactions into a transaction-derived cash-flow path. Purchases are contributions; net sale proceeds are withdrawals. It is not standard external-cash-flow PME.

The target portfolio supports 1–5 Yahoo-recognized tickers. Weights must be positive and sum to 100%.

## Financial calculation contract

- Reporting currency: TWD.
- Strategy price basis: Yahoo adjusted close converted to TWD with historical FX. This is an **estimated total-return proxy**, not the official valuation basis and not a substitute for a reviewed Corporate Action Ledger.
- Official Point-in-Time valuation continues to use raw close; the two bases must never be mixed.
- Fractional units are allowed so allocation weights and equal-principal comparisons are deterministic.
- v0.1 excludes fees, taxes, spread, slippage, financing and leverage.
- Foreign SECURITY rows used by Transaction Replay must contain a usable transaction-date FX rate. Missing FX fails that strategy closed.
- Transaction Replay withdrawals sell the simulated portfolio pro rata to current simulated market value. If a copied withdrawal exceeds simulated wealth, the replay fails closed rather than inventing leverage or negative holdings.
- No automatic rebalancing occurs after the initial/recurring contribution allocation. New contributions are allocated at target weights; withdrawals are pro rata to current holdings.
- XIRR uses simulated contributions, withdrawals and terminal value. Multiple roots fail closed.
- TWR is unitized at each common market date: market return is measured on wealth immediately before that date's external strategy flow versus the prior post-flow wealth, so a DCA contribution executed at the current close cannot dilute the preceding market return. Drawdown is calculated from that unitized growth index.

## Data and safety boundaries

- Read-only simulation endpoint; no transaction, valuation or D1 mutation.
- No brokerage credential or order execution.
- Up to five selected tickers.
- Market history is fetched through the existing replaceable Yahoo adapter.
- Strategy results are `ESTIMATED` or `INCOMPLETE`; they must not be presented as official account performance.
- Transaction Replay is transaction-derived and must not be labeled PME.

## v0.1 output

For DCA, Lump Sum and Transaction Replay:

- gross contributions;
- gross withdrawals;
- terminal value;
- estimated gain/loss;
- money multiple;
- XIRR;
- cumulative and annualized TWR proxy;
- maximum drawdown;
- recovery date;
- execution count and execution lineage;
- machine-readable issues.

## Deferred

- persistent strategy presets;
- market-data caching for arbitrary strategy symbols;
- fees/tax/slippage modes;
- configurable DCA cadence and day;
- rebalancing rules;
- official corporate-action total return;
- standard PME based on true external account deposits/withdrawals;
- actual-portfolio versus simulated-strategy attribution;
- factor attribution, leverage, options, conditional rules and automated trading.

## Acceptance

1. DCA and Lump Sum use exactly equal gross principal in the same request.
2. Non-trading DCA dates move only forward to the next common executable date; no future price may leak backward.
3. A one-asset rising-price golden case reproduces deterministic terminal values for DCA and Lump Sum.
4. Transaction Replay reproduces SECURITY buy/sell TWD cash-flow amounts, including fees and transaction-row FX rules.
5. Missing replay FX and an impossible replay withdrawal fail closed.
6. A 1–5 asset weighted portfolio is accepted only when weights sum to 100%.
7. Strategy simulation is read-only and does not change ACTIVE transactions, valuations, market state or MCP write surface.
8. Typecheck, tests, production build and dependency gates pass before any Staging acceptance.
