import { buildPortfolioAccounting } from '../../src/lib/accounting'
import { buildCashFundingLedger } from '../../src/lib/cash-ledger'
import { buildFxCostPool } from '../../src/lib/fx-cost-pool'
import {
  HISTORICAL_PERFORMANCE_CALCULATION_VERSION,
  UNSUPPORTED_TOTAL_RETURN_COVERAGE_MESSAGE,
  type HistoricalPerformanceSeries,
} from '../../src/lib/time-weighted-performance'
import { ResourceRegistry, MetricRegistry, type ResourceRegistration } from './registry'
import { PortfolioReadSession, qualityFromIssues } from './read-session'
import {
  DataPlatformError,
  type AiRequestContext,
  type DataLineage,
  type DataQuality,
  type DataQualityIssue,
  type DataRow,
  type JsonScalar,
  type MetricResult,
  type QueryFilters,
  type ResourceField,
  type ResourceReadResult,
} from './types'

const RESOURCE_VERSION = '1.0'
const VALUATION_CALCULATION_VERSION = 'point-in-time-valuation-v0.3'
const XIRR_CALCULATION_VERSION = 'money-weighted-performance-v0.5'
const FX_COST_CALCULATION_VERSION = 'fx-cost-pool-v0.4'

type Context = AiRequestContext<PortfolioReadSession>

function field(
  name: string,
  type: ResourceField['type'],
  description: string,
  options: Partial<Omit<ResourceField, 'name' | 'type' | 'description'>> = {},
): ResourceField {
  return { name, type, description, nullable: false, ...options }
}

function issue(type: string, message: string, extra: Partial<DataQualityIssue> = {}): DataQualityIssue {
  return { type, message, ...extra }
}

function domainIssues(items: Array<{ code: string; message: string }>): DataQualityIssue[] {
  return items.map((item) => issue(item.code, item.message))
}

function filterRows(
  rows: DataRow[],
  filters: QueryFilters,
  mapping: Record<string, string>,
  dateField?: string,
): DataRow[] {
  return rows.filter((row) => Object.entries(filters).every(([name, value]) => {
    if (name === 'from' && dateField) return value === null || String(row[dateField]) >= String(value)
    if (name === 'to' && dateField) return value === null || String(row[dateField]) <= String(value)
    const target = mapping[name] ?? name
    if (value === null) return row[target] === null
    return String(row[target] ?? '').toUpperCase() === String(value).toUpperCase()
  }))
}

async function lineage(
  context: Context,
  dataQuality: DataQuality,
  options: {
    asOf?: string | null
    resourceVersion?: string
    calculationVersion?: string
    sourceVersion?: string
    transactionRevision?: number
    valuationVersion?: number
  } = {},
): Promise<DataLineage> {
  const [state, valuation, market] = await Promise.all([
    context.session.portfolioState(),
    context.session.valuationMetadata(),
    context.session.marketMetadata(),
  ])
  return {
    as_of: options.asOf ?? valuation.snapshot?.valuation_date ?? market.run?.latestBarDate ?? null,
    resource_version: options.resourceVersion,
    transaction_revision: options.transactionRevision ?? state.cloudRevision,
    valuation_version: options.valuationVersion ?? valuation.revision,
    calculation_version: options.calculationVersion,
    source_version: options.sourceVersion ?? market.run?.dataVersion ?? state.parserVersion ?? undefined,
    freshness: dataQuality.status,
    data_quality: dataQuality,
  }
}

function resource(
  input: Omit<ResourceRegistration<PortfolioReadSession>,
    'version' | 'defaultPageSize' | 'maxPageSize' | 'dateSemantics'
    | 'currencySemantics' | 'dataQualitySemantics' | 'lineageAvailability'>
    & Partial<Pick<ResourceRegistration<PortfolioReadSession>,
      'dateSemantics' | 'currencySemantics'>>,
): ResourceRegistration<PortfolioReadSession> {
  return {
    version: RESOURCE_VERSION,
    defaultPageSize: 100,
    maxPageSize: 500,
    dateSemantics: input.dateSemantics ?? 'ISO 8601 calendar date (YYYY-MM-DD)',
    currencySemantics: input.currencySemantics
      ?? 'Amounts are in row.currency unless the field name or unit explicitly says TWD',
    dataQualitySemantics: 'COMPLETE is usable, INCOMPLETE must not be treated as complete, STALE is reproducible but not current',
    lineageAvailability: 'transaction, valuation, market-data and calculation versions are returned with every result',
    ...input,
  }
}

function completeOrIncomplete(issues: DataQualityIssue[]): DataQuality {
  return { status: issues.length ? 'INCOMPLETE' : 'COMPLETE', issues }
}

export function createDataRegistry(): ResourceRegistry<PortfolioReadSession> {
  const registry = new ResourceRegistry<PortfolioReadSession>()

  registry.register(resource({
    name: 'portfolio_snapshot',
    description: 'Current portfolio-level summary from the ACTIVE transaction and valuation lineage',
    fields: [
      field('as_of', 'date', 'Valuation date', { nullable: true, date_semantics: 'ACTIVE valuation date' }),
      field('base_currency', 'string', 'Portfolio reporting currency'),
      field('total_assets_twd', 'number', 'Total portfolio assets in TWD', { nullable: true, unit: 'TWD', currency: 'TWD' }),
      field('position_value_twd', 'number', 'Security market value in TWD', { nullable: true, unit: 'TWD', currency: 'TWD' }),
      field('cash_value_twd', 'number', 'Cash value in TWD', { nullable: true, unit: 'TWD', currency: 'TWD' }),
      field('open_position_count', 'number', 'Number of non-zero security positions', { unit: 'count' }),
      field('transaction_count', 'number', 'Number of ACTIVE transactions', { unit: 'count' }),
      field('valuation_status', 'enum', 'Whether the valuation is current and complete', { enum_values: ['COMPLETE', 'INCOMPLETE', 'STALE'] }),
    ],
    allowedFilters: ['as_of'],
    allowedSort: ['as_of'],
    applyFilters: (rows, filters) => filterRows(rows, filters, { as_of: 'as_of' }),
    readModel: async (context): Promise<ResourceReadResult> => {
      const analytics = await context.session.currentAnalytics()
      const valuationIssues = analytics.valuationBundle.valuation
        ? domainIssues(analytics.valuationBundle.valuation.issues)
        : [issue('MISSING_VALUATION', '尚未建立 ACTIVE 估值 Snapshot')]
      const dataQuality = qualityFromIssues(analytics.valuationBundle.freshness, [
        ...analytics.valuationBundle.freshnessIssues,
        ...valuationIssues,
      ])
      const valuation = analytics.currentValuation
      return {
        rows: [{
          as_of: analytics.valuationBundle.snapshot?.valuation_date ?? null,
          base_currency: 'TWD',
          total_assets_twd: valuation?.totalAssetsTwd ?? null,
          position_value_twd: valuation?.complete ? valuation.knownPositionValueTwd : null,
          cash_value_twd: valuation?.complete ? valuation.knownCashValueTwd : null,
          open_position_count: analytics.accounting.positions.filter((position) => Math.abs(position.quantity) > 1e-9).length,
          transaction_count: analytics.transactions.length,
          valuation_status: dataQuality.status,
        }],
        dataQuality,
        lineage: await lineage(context, dataQuality, {
          resourceVersion: RESOURCE_VERSION,
          calculationVersion: VALUATION_CALCULATION_VERSION,
        }),
      }
    },
  }))

  registry.register(resource({
    name: 'transactions',
    description: 'Canonical transaction records from the ACTIVE Dataset',
    fields: [
      field('transaction_id', 'string', 'Stable logical transaction identifier'),
      field('source_row_number', 'number', 'Source file row number', { unit: 'row' }),
      field('date', 'date', 'Trade or cash-flow date', { date_semantics: 'Economic effective date' }),
      field('type', 'enum', 'Transaction type', { enum_values: ['SECURITY', 'FX_BUY', 'FX_SELL', 'CASH_IN', 'CASH_OUT'] }),
      field('symbol', 'string', 'Security symbol; blank for non-security rows'),
      field('currency', 'string', 'Native transaction currency'),
      field('quantity', 'number', 'Signed security quantity', { unit: 'shares' }),
      field('price', 'number', 'Native-currency security price', { currency: 'row.currency' }),
      field('amount_foreign', 'number', 'Transaction amount in row currency', { currency: 'row.currency' }),
      field('fx_rate_twd', 'number', 'TWD per one unit of row currency', { nullable: true, unit: 'TWD per currency unit', currency: 'TWD' }),
      field('fee', 'number', 'Transaction fee in row currency', { currency: 'row.currency' }),
      field('budget_waterline', 'number', 'Optional source budget waterline', { nullable: true }),
      field('budget_balance', 'number', 'Optional source budget balance', { nullable: true }),
      field('note', 'string', 'Source note'),
    ],
    allowedFilters: ['transaction_id', 'symbol', 'from', 'to', 'type', 'currency'],
    allowedSort: ['date', 'symbol', 'type', 'currency', 'source_row_number'],
    applyFilters: (rows, filters) => filterRows(rows, filters, {
      transaction_id: 'transaction_id', symbol: 'symbol', type: 'type', currency: 'currency',
    }, 'date'),
    readModel: async (context) => {
      const [state, rows] = await Promise.all([
        context.session.portfolioState(),
        context.session.currentTransactions(),
      ])
      const accounting = buildPortfolioAccounting(rows)
      const dataQuality = completeOrIncomplete(domainIssues(accounting.issues))
      return {
        rows: rows.map((row) => ({
          transaction_id: row.transactionId,
          source_row_number: row.sourceRowNumber,
          date: row.tradeDate,
          type: row.transactionType,
          symbol: row.ticker,
          currency: row.currency,
          quantity: row.quantity,
          price: row.price,
          amount_foreign: row.amountForeign,
          fx_rate_twd: row.fxRate,
          fee: row.fee,
          budget_waterline: row.budgetWaterline,
          budget_balance: row.budgetBalance,
          note: row.note,
        })),
        dataQuality,
        lineage: await lineage(context, dataQuality, {
          asOf: state.latestDate,
          resourceVersion: RESOURCE_VERSION,
          sourceVersion: state.parserVersion ?? undefined,
        }),
      }
    },
  }))

  registry.register(resource({
    name: 'cash_flows',
    description: 'External contributions and withdrawals used by the official performance service',
    fields: [
      field('transaction_id', 'string', 'Stable source transaction identifier'),
      field('date', 'date', 'External cash-flow date', { date_semantics: 'Economic effective date' }),
      field('type', 'enum', 'External cash-flow direction', { enum_values: ['CONTRIBUTION', 'WITHDRAWAL'] }),
      field('currency', 'string', 'Native cash-flow currency'),
      field('amount_native', 'number', 'Absolute cash-flow amount in native currency', { currency: 'row.currency' }),
      field('fx_rate_twd', 'number', 'TWD per one native currency unit', { nullable: true, unit: 'TWD per currency unit', currency: 'TWD' }),
      field('amount_twd', 'number', 'Cash-flow amount translated to TWD', { nullable: true, unit: 'TWD', currency: 'TWD' }),
      field('note', 'string', 'Source note'),
    ],
    allowedFilters: ['transaction_id', 'from', 'to', 'type', 'currency'],
    allowedSort: ['date', 'type', 'currency'],
    applyFilters: (rows, filters) => filterRows(rows, filters, {
      transaction_id: 'transaction_id', type: 'type', currency: 'currency',
    }, 'date'),
    readModel: async (context) => {
      const [state, transactions] = await Promise.all([
        context.session.portfolioState(), context.session.currentTransactions(),
      ])
      const rows = transactions
        .filter((row) => row.transactionType === 'CASH_IN' || row.transactionType === 'CASH_OUT')
        .map((row) => {
          const rate = row.currency === 'TWD' ? 1 : row.fxRate
          return {
            transaction_id: row.transactionId,
            date: row.tradeDate,
            type: row.transactionType === 'CASH_IN' ? 'CONTRIBUTION' : 'WITHDRAWAL',
            currency: row.currency,
            amount_native: row.amountForeign,
            fx_rate_twd: rate,
            amount_twd: rate === null ? null : row.amountForeign * rate,
            note: row.note,
          }
        })
      const issues = rows.filter((row) => row.amount_twd === null)
        .map((row) => issue('MISSING_EXTERNAL_FLOW_FX', `${row.date} ${row.currency} 現金流缺少 FX`, { date: String(row.date) }))
      const dataQuality = completeOrIncomplete(issues)
      return {
        rows,
        dataQuality,
        lineage: await lineage(context, dataQuality, {
          asOf: state.latestDate,
          resourceVersion: RESOURCE_VERSION,
          calculationVersion: XIRR_CALCULATION_VERSION,
        }),
      }
    },
  }))

  registry.register(resource({
    name: 'positions',
    description: 'Current security positions with official moving-average cost and available valuation',
    fields: [
      field('as_of', 'date', 'ACTIVE valuation date', { nullable: true }),
      field('symbol', 'string', 'Security symbol'),
      field('currency', 'string', 'Native trading currency'),
      field('quantity', 'number', 'Current position quantity', { unit: 'shares' }),
      field('average_unit_cost_native', 'number', 'Moving-average native unit cost', { currency: 'row.currency' }),
      field('cost_basis_native', 'number', 'Remaining native cost basis', { currency: 'row.currency' }),
      field('cost_basis_twd', 'number', 'Remaining TWD cost basis', { nullable: true, unit: 'TWD', currency: 'TWD' }),
      field('price_native', 'number', 'Latest allowed as-of price', { nullable: true, currency: 'row.currency' }),
      field('market_value_twd', 'number', 'Position market value in TWD', { nullable: true, unit: 'TWD', currency: 'TWD' }),
      field('unrealized_pl_twd', 'number', 'Unrealized profit/loss in TWD', { nullable: true, unit: 'TWD', currency: 'TWD' }),
      field('realized_pl_twd', 'number', 'Realized profit/loss in TWD', { nullable: true, unit: 'TWD', currency: 'TWD' }),
    ],
    allowedFilters: ['as_of', 'symbol', 'currency'],
    allowedSort: ['symbol', 'currency', 'quantity', 'market_value_twd', 'cost_basis_twd'],
    applyFilters: (rows, filters) => filterRows(rows, filters, {
      as_of: 'as_of', symbol: 'symbol', currency: 'currency',
    }),
    readModel: async (context) => {
      const analytics = await context.session.currentAnalytics()
      const valuationByKey = new Map(analytics.currentValuation?.positions.map((position) => [
        `${position.ticker}\u0000${position.currency}`, position,
      ]) ?? [])
      const costByKey = new Map(analytics.fxCost.positions.map((position) => [
        `${position.ticker}\u0000${position.currency}`, position,
      ]))
      const reconciliationByKey = new Map(analytics.reconciliation?.positions.map((position) => [
        `${position.ticker}\u0000${position.currency}`, position,
      ]) ?? [])
      const qualityIssues = [
        ...domainIssues(analytics.accounting.issues),
        ...domainIssues(analytics.fxCost.issues),
        ...(analytics.currentValuation ? domainIssues(analytics.currentValuation.issues) : [issue('STALE_OR_MISSING_VALUATION', '目前估值不是 CURRENT')]),
      ]
      const dataQuality = qualityFromIssues(analytics.valuationBundle.freshness, [
        ...analytics.valuationBundle.freshnessIssues,
        ...qualityIssues,
      ])
      return {
        rows: analytics.accounting.positions
          .filter((position) => Math.abs(position.quantity) > 1e-9)
          .map((position) => {
            const key = `${position.ticker}\u0000${position.currency}`
            const valuation = valuationByKey.get(key)
            const cost = costByKey.get(key)
            const reconciliation = reconciliationByKey.get(key)
            return {
              as_of: analytics.valuationBundle.snapshot?.valuation_date ?? null,
              symbol: position.ticker,
              currency: position.currency,
              quantity: position.quantity,
              average_unit_cost_native: position.averageUnitCost,
              cost_basis_native: position.costBasis,
              cost_basis_twd: cost?.twdCostBasis ?? null,
              price_native: valuation?.price ?? null,
              market_value_twd: valuation?.marketValueTwd ?? null,
              unrealized_pl_twd: reconciliation?.unrealizedPnlTwd ?? null,
              realized_pl_twd: cost?.realizedPnlTwd ?? null,
            }
          }),
        dataQuality,
        lineage: await lineage(context, dataQuality, {
          resourceVersion: RESOURCE_VERSION,
          calculationVersion: `${VALUATION_CALCULATION_VERSION}+${FX_COST_CALCULATION_VERSION}`,
        }),
      }
    },
  }))

  registry.register(resource({
    name: 'valuations',
    description: 'ACTIVE point-in-time position and cash valuation components',
    fields: [
      field('as_of', 'date', 'Valuation date'),
      field('asset_type', 'enum', 'Valued asset type', { enum_values: ['POSITION', 'CASH'] }),
      field('symbol', 'string', 'Security symbol; blank for cash'),
      field('currency', 'string', 'Native asset currency'),
      field('quantity_or_units', 'number', 'Security quantity or cash units'),
      field('price_or_fx_rate', 'number', 'Native security price or TWD FX rate', { nullable: true }),
      field('source_date', 'date', 'Price or FX observation date', { nullable: true }),
      field('market_value_native', 'number', 'Native-currency market value', { nullable: true, currency: 'row.currency' }),
      field('market_value_twd', 'number', 'TWD market value', { nullable: true, unit: 'TWD', currency: 'TWD' }),
      field('complete', 'boolean', 'Whether this component is fully valued'),
    ],
    allowedFilters: ['as_of', 'asset_type', 'symbol', 'currency'],
    allowedSort: ['as_of', 'asset_type', 'symbol', 'currency', 'market_value_twd'],
    applyFilters: (rows, filters) => filterRows(rows, filters, {
      as_of: 'as_of', asset_type: 'asset_type', symbol: 'symbol', currency: 'currency',
    }),
    readModel: async (context) => {
      const bundle = await context.session.valuationBundle()
      const valuationIssues = bundle.valuation
        ? domainIssues(bundle.valuation.issues)
        : [issue('MISSING_VALUATION', '尚未建立 ACTIVE 估值 Snapshot')]
      const dataQuality = qualityFromIssues(bundle.freshness, [...bundle.freshnessIssues, ...valuationIssues])
      const asOf = bundle.snapshot?.valuation_date ?? null
      const rows: DataRow[] = bundle.valuation ? [
        ...bundle.valuation.positions.map((position) => ({
          as_of: asOf,
          asset_type: 'POSITION',
          symbol: position.ticker,
          currency: position.currency,
          quantity_or_units: position.quantity,
          price_or_fx_rate: position.price,
          source_date: position.priceDate,
          market_value_native: position.marketValueNative,
          market_value_twd: position.marketValueTwd,
          complete: position.marketValueTwd !== null,
        })),
        ...bundle.valuation.cash.map((cash) => ({
          as_of: asOf,
          asset_type: 'CASH',
          symbol: '',
          currency: cash.currency,
          quantity_or_units: cash.endingBalance,
          price_or_fx_rate: cash.fxRate,
          source_date: cash.fxDate,
          market_value_native: cash.endingBalance,
          market_value_twd: cash.marketValueTwd,
          complete: cash.marketValueTwd !== null,
        })),
      ] : []
      return {
        rows,
        dataQuality,
        lineage: await lineage(context, dataQuality, {
          asOf,
          resourceVersion: RESOURCE_VERSION,
          calculationVersion: VALUATION_CALCULATION_VERSION,
          sourceVersion: bundle.snapshot?.parser_version,
          transactionRevision: bundle.snapshot?.transaction_revision,
        }),
      }
    },
  }))

  const marketFields = [
    field('date', 'date', 'Market observation date', { date_semantics: 'Exchange-local trading date' }),
    field('instrument_type', 'enum', 'Market instrument type', { enum_values: ['SECURITY', 'BENCHMARK', 'FX'] }),
    field('symbol', 'string', 'Security or benchmark symbol; blank for FX'),
    field('currency', 'string', 'Quote currency or FX foreign currency'),
    field('provider_symbol', 'string', 'Provider-specific symbol'),
    field('exchange_timezone', 'string', 'Provider exchange timezone'),
    field('raw_close', 'number', 'Unadjusted close used by Portfolio Analyzer', { currency: 'row.currency' }),
    field('adjusted_close', 'number', 'Provider adjusted close retained for reference', { nullable: true, currency: 'row.currency' }),
  ]

  for (const definition of [
    { name: 'market_prices', description: 'Security and benchmark raw close history', types: ['SECURITY', 'BENCHMARK'] },
    { name: 'fx_rates', description: 'Historical TWD FX rates used by valuation', types: ['FX'] },
  ] as const) {
    registry.register(resource({
      name: definition.name,
      description: definition.description,
      fields: marketFields,
      allowedFilters: ['symbol', 'currency', 'instrument_type', 'from', 'to'],
      allowedSort: ['date', 'symbol', 'currency', 'instrument_type'],
      applyFilters: (rows, filters) => filterRows(rows, filters, {
        symbol: 'symbol', currency: 'currency', instrument_type: 'instrument_type',
      }, 'date'),
      readModel: async (context) => {
        const market = await context.session.marketBundle()
        const marketIssues = market.run ? [] : [issue('MISSING_MARKET_DATA', '尚未建立 ACTIVE 行情版本')]
        const dataQuality = qualityFromIssues(market.freshness, [...market.freshnessIssues, ...marketIssues])
        return {
          rows: market.observations
            .filter((observation) => (definition.types as readonly string[]).includes(observation.instrumentType))
            .map((observation) => ({
              date: observation.date,
              instrument_type: observation.instrumentType,
              symbol: observation.ticker,
              currency: observation.currency,
              provider_symbol: observation.providerSymbol,
              exchange_timezone: observation.exchangeTimezone,
              raw_close: observation.rawClose,
              adjusted_close: observation.adjustedClose,
            })),
          dataQuality,
          lineage: await lineage(context, dataQuality, {
            asOf: market.run?.latestBarDate,
            resourceVersion: RESOURCE_VERSION,
            sourceVersion: market.run?.dataVersion,
            transactionRevision: market.run?.transactionRevision,
          }),
        }
      },
    }))
  }

  registry.register(resource({
    name: 'data_quality',
    description: 'Current blocking and freshness issues across accounting, cash, FX, valuation and performance',
    fields: [
      field('domain', 'enum', 'Affected business domain', { enum_values: ['TRANSACTIONS', 'CASH', 'FX_COST', 'VALUATION', 'PERFORMANCE', 'MARKET_DATA'] }),
      field('code', 'string', 'Stable issue code'),
      field('message', 'string', 'Human-readable issue explanation'),
      field('severity', 'enum', 'Issue severity', { enum_values: ['BLOCKING'] }),
      field('date', 'date', 'Affected date when available', { nullable: true }),
      field('symbol', 'string', 'Affected symbol when available', { nullable: true }),
    ],
    allowedFilters: ['domain', 'code', 'symbol', 'from', 'to'],
    allowedSort: ['domain', 'code', 'date', 'symbol'],
    applyFilters: (rows, filters) => filterRows(rows, filters, {
      domain: 'domain', code: 'code', symbol: 'symbol',
    }, 'date'),
    readModel: async (context) => {
      const [analytics, market] = await Promise.all([
        context.session.currentAnalytics(),
        context.session.marketMetadata(),
      ])
      const rows: DataRow[] = []
      const add = (domain: string, code: string, message: string, date: string | null = null, symbol: string | null = null) => {
        rows.push({ domain, code, message, severity: 'BLOCKING', date, symbol })
      }
      analytics.accounting.issues.forEach((item) => add('TRANSACTIONS', item.code, item.message, item.tradeDate, item.ticker))
      analytics.cashLedger.issues.forEach((item) => add('CASH', item.code, item.message, item.tradeDate))
      analytics.fxCost.issues.forEach((item) => add('FX_COST', item.code, item.message, item.tradeDate, item.ticker || null))
      analytics.currentValuation?.issues.forEach((item) => add('VALUATION', item.code, item.message))
      analytics.performance.issues.forEach((item) => add('PERFORMANCE', item.code, item.message))
      analytics.valuationBundle.freshnessIssues.forEach((item) => add(
        'VALUATION', item.type, item.message, item.date ?? null, item.symbol ?? null,
      ))
      if (analytics.valuationBundle.snapshot) {
        add(
          'PERFORMANCE',
          'UNSUPPORTED_TOTAL_RETURN_COVERAGE',
          UNSUPPORTED_TOTAL_RETURN_COVERAGE_MESSAGE,
          analytics.state.earliestDate,
        )
      }
      market.freshnessIssues.forEach((item) => add(
        'MARKET_DATA', item.type, item.message, item.date ?? null, item.symbol ?? null,
      ))
      if (market.freshness === 'NO_RUN') add('MARKET_DATA', 'NO_RUN', '尚未建立 ACTIVE 行情版本')
      const dataQuality: DataQuality = rows.length
        ? { status: analytics.valuationBundle.freshness === 'STALE' || market.freshness === 'STALE' ? 'STALE' : 'INCOMPLETE', issues: rows.map((row) => issue(String(row.code), String(row.message))) }
        : { status: 'COMPLETE', issues: [] }
      return {
        rows,
        dataQuality,
        lineage: await lineage(context, dataQuality, { resourceVersion: RESOURCE_VERSION }),
      }
    },
  }))

  return registry
}

function dateParameter(parameters: Record<string, JsonScalar>, name: 'from' | 'to'): string | undefined {
  const value = parameters[name]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DataPlatformError('INVALID_METRIC_PARAMETER', `${name} 必須是 YYYY-MM-DD`)
  }
  return value
}

async function metricLineage(
  context: Context,
  dataQuality: DataQuality,
  calculationVersion: string,
  asOf: string | null,
  options: { transactionRevision?: number; valuationVersion?: number } = {},
): Promise<DataLineage> {
  return lineage(context, dataQuality, { asOf, calculationVersion, ...options })
}

function metricResult(input: Omit<MetricResult, 'lineage'> & { lineage: Promise<DataLineage> }): Promise<MetricResult> {
  return input.lineage.then((resolved) => ({ ...input, lineage: resolved }))
}

export function createMetricRegistry(): MetricRegistry<PortfolioReadSession> {
  const registry = new MetricRegistry<PortfolioReadSession>()

  registry.register({
    name: 'nav',
    description: 'Official current point-in-time total portfolio assets',
    unit: 'TWD',
    calculationVersion: VALUATION_CALCULATION_VERSION,
    allowedParameters: [],
    calculate: async (context) => {
      const bundle = await context.session.valuationBundle()
      const issues = bundle.valuation ? domainIssues(bundle.valuation.issues) : [issue('MISSING_VALUATION', '尚未建立 ACTIVE 估值 Snapshot')]
      const dataQuality = qualityFromIssues(bundle.freshness, [...bundle.freshnessIssues, ...issues])
      const value = dataQuality.status === 'COMPLETE' ? bundle.valuation?.totalAssetsTwd ?? null : null
      const asOf = bundle.snapshot?.valuation_date ?? null
      return metricResult({
        metric: 'nav', value, unit: 'TWD', period: { from: asOf, to: asOf }, as_of: asOf,
        status: dataQuality.status, calculation_version: VALUATION_CALCULATION_VERSION,
        issues: dataQuality.issues,
        lineage: metricLineage(context, dataQuality, VALUATION_CALCULATION_VERSION, asOf, {
          transactionRevision: bundle.snapshot?.transaction_revision,
        }),
      })
    },
  })

  for (const definition of [
    { name: 'twr', unit: 'decimal', pick: (series: HistoricalPerformanceSeries) => series.performance.cumulativeTwr },
    { name: 'max_drawdown', unit: 'decimal', pick: (series: HistoricalPerformanceSeries) => series.performance.drawdown.maximumDrawdown },
  ] as const) {
    registry.register({
      name: definition.name,
      description: definition.name === 'twr' ? 'Official cumulative time-weighted return' : 'Official maximum drawdown',
      unit: definition.unit,
      calculationVersion: HISTORICAL_PERFORMANCE_CALCULATION_VERSION,
      allowedParameters: ['from', 'to'],
      calculate: async (context, parameters) => {
        const from = dateParameter(parameters, 'from')
        const to = dateParameter(parameters, 'to')
        if (from && to && from > to) throw new DataPlatformError('INVALID_METRIC_PARAMETER', 'from 不得晚於 to')
        const [series, bundle] = await Promise.all([
          context.session.historicalPerformance(from, to),
          context.session.valuationBundle(),
        ])
        const issues = series ? domainIssues(series.performance.issues) : [issue('MISSING_VALUATION', '尚未建立歷史績效資料')]
        const dataQuality: DataQuality = bundle.freshness === 'STALE'
          ? { status: 'STALE', issues: [...bundle.freshnessIssues, ...issues] }
          : series?.performance.complete
            ? { status: 'COMPLETE', issues: [] }
            : { status: 'INCOMPLETE', issues }
        const asOf = series?.performance.endDate ?? null
        return metricResult({
          metric: definition.name,
          value: series && dataQuality.status === 'COMPLETE' ? definition.pick(series) : null,
          unit: definition.unit,
          period: { from: series?.performance.startDate ?? from ?? null, to: asOf ?? to ?? null },
          as_of: asOf,
          status: dataQuality.status,
          calculation_version: HISTORICAL_PERFORMANCE_CALCULATION_VERSION,
          issues: dataQuality.issues,
          lineage: metricLineage(context, dataQuality, HISTORICAL_PERFORMANCE_CALCULATION_VERSION, asOf, {
            transactionRevision: bundle.snapshot?.transaction_revision,
          }),
        })
      },
    })
  }

  registry.register({
    name: 'xirr',
    description: 'Official money-weighted annualized return using dated external cash flows',
    unit: 'decimal',
    calculationVersion: XIRR_CALCULATION_VERSION,
    allowedParameters: [],
    calculate: async (context) => {
      const analytics = await context.session.currentAnalytics()
      const issues = domainIssues(analytics.performance.issues)
      const dataQuality = analytics.performance.complete && analytics.valuationBundle.freshness === 'CURRENT'
        ? { status: 'COMPLETE' as const, issues: [] }
        : qualityFromIssues(analytics.valuationBundle.freshness, [
          ...analytics.valuationBundle.freshnessIssues,
          ...issues,
        ])
      const asOf = analytics.performance.valuationDate
      return metricResult({
        metric: 'xirr', value: dataQuality.status === 'COMPLETE' ? analytics.performance.xirr : null,
        unit: 'decimal', period: { from: analytics.performance.externalCashFlows[0]?.date ?? null, to: asOf }, as_of: asOf,
        status: dataQuality.status, calculation_version: XIRR_CALCULATION_VERSION,
        issues: dataQuality.issues,
        lineage: metricLineage(context, dataQuality, XIRR_CALCULATION_VERSION, asOf),
      })
    },
  })

  for (const definition of [
    { name: 'realized_pl', pick: (analytics: Awaited<ReturnType<PortfolioReadSession['currentAnalytics']>>) => analytics.reconciliation?.totalRealizedPnlTwd ?? null },
    { name: 'unrealized_pl', pick: (analytics: Awaited<ReturnType<PortfolioReadSession['currentAnalytics']>>) => analytics.reconciliation?.totalUnrealizedPnlTwd ?? null },
  ] as const) {
    registry.register({
      name: definition.name,
      description: definition.name === 'realized_pl' ? 'Official realized security and FX profit/loss in TWD' : 'Official unrealized position profit/loss in TWD',
      unit: 'TWD',
      calculationVersion: FX_COST_CALCULATION_VERSION,
      allowedParameters: [],
      calculate: async (context) => {
        const analytics = await context.session.currentAnalytics()
        const issues = [
          ...domainIssues(analytics.fxCost.issues),
          ...(analytics.reconciliation?.complete ? [] : [issue('INCOMPLETE_COST_RECONCILIATION', 'TWD 成本與估值尚未完整對帳')]),
        ]
        const dataQuality = qualityFromIssues(analytics.valuationBundle.freshness, [
          ...analytics.valuationBundle.freshnessIssues,
          ...issues,
        ])
        const asOf = analytics.valuationBundle.snapshot?.valuation_date ?? null
        return metricResult({
          metric: definition.name,
          value: dataQuality.status === 'COMPLETE' ? definition.pick(analytics) : null,
          unit: 'TWD', period: { from: null, to: asOf }, as_of: asOf,
          status: dataQuality.status, calculation_version: FX_COST_CALCULATION_VERSION,
          issues: dataQuality.issues,
          lineage: metricLineage(context, dataQuality, FX_COST_CALCULATION_VERSION, asOf),
        })
      },
    })
  }

  registry.register({
    name: 'cash_ratio',
    description: 'Current cash value divided by total portfolio assets',
    unit: 'decimal',
    calculationVersion: VALUATION_CALCULATION_VERSION,
    allowedParameters: [],
    calculate: async (context) => {
      const bundle = await context.session.valuationBundle()
      const valuation = bundle.valuation
      const issues = valuation ? domainIssues(valuation.issues) : [issue('MISSING_VALUATION', '尚未建立 ACTIVE 估值 Snapshot')]
      const dataQuality = qualityFromIssues(bundle.freshness, [...bundle.freshnessIssues, ...issues])
      const value = dataQuality.status === 'COMPLETE' && valuation && (valuation.totalAssetsTwd ?? 0) > 0
        ? valuation.knownCashValueTwd / (valuation.totalAssetsTwd ?? 1)
        : null
      const asOf = bundle.snapshot?.valuation_date ?? null
      return metricResult({
        metric: 'cash_ratio', value, unit: 'decimal', period: { from: asOf, to: asOf }, as_of: asOf,
        status: dataQuality.status, calculation_version: VALUATION_CALCULATION_VERSION,
        issues: dataQuality.issues,
        lineage: metricLineage(context, dataQuality, VALUATION_CALCULATION_VERSION, asOf, {
          transactionRevision: bundle.snapshot?.transaction_revision,
        }),
      })
    },
  })

  return registry
}
