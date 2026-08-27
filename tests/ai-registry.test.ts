import { describe, expect, it } from 'vitest'
import { MetricRegistry, ResourceRegistry } from '../worker/ai/registry'
import type { DataLineage, DataQuality, MetricResult } from '../worker/ai/types'

const complete: DataQuality = { status: 'COMPLETE', issues: [] }
const lineage: DataLineage = {
  as_of: '2026-08-27',
  resource_version: 'test-1.0',
  transaction_revision: 8,
  valuation_version: 7,
  freshness: 'COMPLETE',
  data_quality: complete,
}
const context = { user: { id: 'user-1', email: 'owner@example.test' }, session: {} }

function factorResource() {
  return {
    name: 'test_factor_exposure',
    description: 'Test-only factor exposure fixture',
    version: 'test-1.0',
    fields: [
      { name: 'date', type: 'date' as const, description: 'Observation date', nullable: false },
      { name: 'factor', type: 'string' as const, description: 'Factor name', nullable: false },
      { name: 'exposure', type: 'number' as const, description: 'Factor exposure', nullable: false, unit: 'decimal' },
    ],
    allowedFilters: ['factor'],
    allowedSort: ['date', 'factor', 'exposure'],
    defaultPageSize: 1,
    maxPageSize: 2,
    dateSemantics: 'ISO date',
    currencySemantics: 'Not applicable',
    dataQualitySemantics: 'COMPLETE/INCOMPLETE/STALE',
    lineageAvailability: 'Full fixture lineage',
    readModel: async () => ({
      rows: [
        { date: '2026-08-26', factor: 'VALUE', exposure: 0.2 },
        { date: '2026-08-27', factor: 'QUALITY', exposure: 0.4 },
      ],
      dataQuality: complete,
      lineage,
    }),
    applyFilters: (rows: Array<Record<string, string | number | boolean | null>>, filters: Record<string, string | number | boolean | null>) =>
      rows.filter((row) => !filters.factor || row.factor === filters.factor),
  }
}

describe('AI Data Registry extensibility and contracts', () => {
  it('discovers, describes and queries a test-only Resource without changing registry core methods', async () => {
    const registry = new ResourceRegistry<unknown>().register(factorResource())

    expect(registry.list()).toContainEqual(expect.objectContaining({ name: 'test_factor_exposure' }))
    expect(registry.describe('test_factor_exposure')).toMatchObject({
      name: 'test_factor_exposure',
      pagination: { default_page_size: 1, max_page_size: 2 },
    })

    const first = await registry.query('test_factor_exposure', {
      fields: ['date', 'factor', 'exposure'],
      sort: { field: 'date', direction: 'asc' },
      pagination: { limit: 1 },
    }, context)
    expect(first.rows).toEqual([{ date: '2026-08-26', factor: 'VALUE', exposure: 0.2 }])
    expect(first.next_cursor).toEqual(expect.any(String))
    expect(first.data_quality.status).toBe('COMPLETE')
    expect(first.lineage.transaction_revision).toBe(8)

    const second = await registry.query('test_factor_exposure', {
      pagination: { limit: 1, cursor: first.next_cursor! },
    }, context)
    expect(second.rows).toHaveLength(1)
    expect(second.next_cursor).toBeNull()
  })

  it('rejects unknown Resources, fields, filters, sort expressions, SQL-shaped input and oversized pages', async () => {
    const registry = new ResourceRegistry<unknown>().register(factorResource())
    await expect(registry.query('whatever', {}, context)).rejects.toMatchObject({ code: 'UNKNOWN_RESOURCE' })
    await expect(registry.query('test_factor_exposure', { fields: ['secret'] }, context))
      .rejects.toMatchObject({ code: 'INVALID_FIELD' })
    await expect(registry.query('test_factor_exposure', { filters: { where_sql: '1=1' } }, context))
      .rejects.toMatchObject({ code: 'INVALID_FILTER' })
    await expect(registry.query('test_factor_exposure', { sort: { field: 'DROP TABLE', direction: 'asc' } }, context))
      .rejects.toMatchObject({ code: 'INVALID_SORT' })
    await expect(registry.query('test_factor_exposure', { pagination: { limit: 3 } }, context))
      .rejects.toMatchObject({ code: 'INVALID_PAGE_SIZE' })
  })

  it('returns a valid empty result with data quality and lineage', async () => {
    const registry = new ResourceRegistry<unknown>().register(factorResource())
    const result = await registry.query('test_factor_exposure', {
      filters: { factor: 'MOMENTUM' },
    }, context)
    expect(result.rows).toEqual([])
    expect(result.returned_row_count).toBe(0)
    expect(result.data_quality).toEqual(complete)
    expect(result.lineage).toEqual(lineage)
  })
})

describe('AI Metric Registry extensibility', () => {
  it('discovers and calculates a test-only Metric without changing getMetric', async () => {
    const result: MetricResult = {
      metric: 'test_metric', value: 42, unit: 'count',
      period: { from: null, to: '2026-08-27' }, as_of: '2026-08-27',
      status: 'COMPLETE', calculation_version: 'test-v1', lineage, issues: [],
    }
    const registry = new MetricRegistry<unknown>().register({
      name: 'test_metric', description: 'Test-only metric', unit: 'count',
      calculationVersion: 'test-v1', allowedParameters: [],
      calculate: async () => result,
    })

    expect(registry.list()).toContainEqual(expect.objectContaining({ name: 'test_metric' }))
    await expect(registry.getMetric('test_metric', {}, context)).resolves.toEqual(result)
    await expect(registry.getMetric('test_metric', { raw_query: 'select 1' }, context))
      .rejects.toMatchObject({ code: 'INVALID_METRIC_PARAMETER' })
    await expect(registry.getMetric('unknown', {}, context))
      .rejects.toMatchObject({ code: 'UNKNOWN_METRIC' })
  })
})
