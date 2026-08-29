export type JsonScalar = string | number | boolean | null
export type DataRow = Record<string, JsonScalar>

export type DataQualityStatus = 'COMPLETE' | 'INCOMPLETE' | 'STALE'

export type DataQualityIssue = {
  type: string
  message: string
  field?: string
  symbol?: string
  date?: string
}

export type DataQuality = {
  status: DataQualityStatus
  issues: DataQualityIssue[]
}

export type DataLineage = {
  as_of: string | null
  resource_version?: string
  transaction_revision: number
  valuation_version: number
  calculation_version?: string
  source_version?: string
  freshness: DataQualityStatus
  data_quality: DataQuality
}

export type ResourceField = {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'enum'
  description: string
  nullable: boolean
  unit?: string
  currency?: string | 'row.currency' | 'TWD'
  date_semantics?: string
  enum_values?: string[]
}

export type QueryFilters = Record<string, JsonScalar>

export type QuerySort = {
  field: string
  direction: 'asc' | 'desc'
}

export type QueryPagination = {
  limit?: number
  cursor?: string
}

export type ResourceQuery = {
  filters?: QueryFilters
  fields?: string[]
  sort?: QuerySort
  pagination?: QueryPagination
}

export type ResourceReadResult = {
  rows: DataRow[]
  dataQuality: DataQuality
  lineage: DataLineage
}

export type QueryDataResult = {
  resource: string
  resource_version: string
  rows: DataRow[]
  returned_row_count: number
  next_cursor: string | null
  data_quality: DataQuality
  lineage: DataLineage
}

export type MetricResult = {
  metric: string
  value: number | null
  unit: string
  period: { from: string | null; to: string | null }
  as_of: string | null
  status: DataQualityStatus
  calculation_version: string
  lineage: DataLineage
  issues: DataQualityIssue[]
}

export type AiUser = { id: string; email: string }

export type AiRequestContext<TSession> = {
  user: AiUser
  session: TSession
}

export class DataPlatformError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DataPlatformError'
  }
}
