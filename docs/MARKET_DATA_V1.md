# Automatic Market Data v1

## Goal

Provide one user-triggered action that downloads completed daily closing data, validates the
entire portfolio universe, stores an auditable history, and activates a complete latest
Point-in-Time valuation. A provider failure must not turn partial prices into an ACTIVE
financial result.

## Coverage

- every security appearing in the bound transaction dataset, including fully sold positions;
- required non-TWD/TWD FX series;
- `SPY` as the initial benchmark series for the later strategy-comparison module;
- Yahoo Finance chart data through a replaceable server-side provider adapter;
- raw/unadjusted close for holdings valuation and NAV;
- adjusted close stored separately for later total-return research, never mixed into current
  share-count valuation.

The initial run starts from each instrument's first relevant transaction date. Later runs
download a ten-calendar-day overlap so recent provider corrections can be observed without
re-downloading the whole history.

## Safety contract

The refresh is initiated by the signed-in user and is all-or-nothing at the financial-result
gate:

1. bind the request to the exact ACTIVE transaction dataset and valuation revision;
2. fetch every required instrument through a fixed provider host;
3. reject HTTP/provider errors, missing closes, non-positive values, currency mismatches,
   unfinished current-session bars, and data older than ten calendar days;
4. reconstruct the latest valuation in memory and require a complete result;
5. save a PENDING market-data run, append-only observations, and (when required) a PENDING
   valuation snapshot;
6. use one guarded D1 batch to verify transaction, market, and valuation revisions and publish
   the market-data run together with its matching valuation;
7. abort and roll back the entire publication batch when any concurrent request wins first.

If any provider or completeness check fails before activation, the prior ACTIVE valuation is
preserved. Market-data and valuation revisions remain separate and explicit.

## Storage

- `market_data_runs`: provider run, revision, transaction binding, range, counts, validation;
- `market_data_instruments`: per-run source symbol, timezone, range, latest raw close, and a
  compact append-only JSON series segment;
- `market_state`: the ACTIVE run and optimistic market revision.

Historical reads merge series segments through the ACTIVE market revision and choose the latest
observation for each instrument/date. Failed or unactivated runs therefore cannot leak into the
equity curve. Compact per-instrument segments also keep the first multi-year backfill within a
small number of D1 write statements.

## Current UI behavior

`更新最新收盤價` performs the guarded refresh. On success it shows source, date, raw close,
per-instrument counts, market revision, transaction binding, and the new valuation revision.
The Historical NAV workspace consumes the ACTIVE daily raw-close/FX series immediately and
shows a TWD portfolio equity curve even when missing external CASH_IN/CASH_OUT rows still block
XIRR or a complete TWR chain.

## Explicit limitations

- Yahoo Finance is an adapter, not a guaranteed official market-data SLA. The provider must
  remain replaceable and its source must be shown.
- This release is user-triggered; Cloudflare Cron scheduling is deferred.
- Corporate actions, delistings, ticker changes, dividends, and adjusted-close total-return
  methodology require a separate reviewed module.
- Until that module exists, the UI labels the absolute series as a price-only TWD market-value
  curve and blocks cumulative TWR, annualized TWR, and drawdown claims.
- SPY data is stored, but benchmark/strategy calculations and comparison UI are deferred.
- No brokerage login, trading credential, or order execution is used.
