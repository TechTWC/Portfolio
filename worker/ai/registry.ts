import {
  DataPlatformError,
  type AiRequestContext,
  type DataLineage,
  type DataRow,
  type JsonScalar,
  type MetricResult,
  type QueryDataResult,
  type QueryFilters,
  type ResourceField,
  type ResourceQuery,
  type ResourceReadResult,
} from './types'

const DEFAULT_PAGE_SIZE = 100
const HARD_MAX_PAGE_SIZE = 500

export type ResourceRegistration<TSession> = {
  name: string
  description: string
  version: string
  fields: ResourceField[]
  allowedFilters: string[]
  allowedSort: string[]
  defaultPageSize?: number
  maxPageSize?: number
  dateSemantics: string
  currencySemantics: string
  dataQualitySemantics: string
  lineageAvailability: string
  readModel: (context: AiRequestContext<TSession>) => Promise<ResourceReadResult>
  applyFilters?: (rows: DataRow[], filters: QueryFilters) => DataRow[]
}

export type MetricRegistration<TSession> = {
  name: string
  description: string
  unit: string
  calculationVersion: string
  allowedParameters: string[]
  calculate: (
    context: AiRequestContext<TSession>,
    parameters: Record<string, JsonScalar>,
  ) => Promise<MetricResult>
}

type CursorPayload = { resource: string; version: string; offset: number }

function encodeCursor(payload: CursorPayload): string {
  return btoa(JSON.stringify(payload))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const normalized = cursor.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(padded)) as Partial<CursorPayload>
    if (
      typeof parsed.resource !== 'string'
      || typeof parsed.version !== 'string'
      || !Number.isInteger(parsed.offset)
      || (parsed.offset ?? -1) < 0
    ) throw new Error('invalid cursor payload')
    return parsed as CursorPayload
  } catch {
    throw new DataPlatformError('INVALID_CURSOR', 'pagination.cursor 無效或已過期')
  }
}

function compareScalar(left: JsonScalar, right: JsonScalar): number {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left).localeCompare(String(right))
}

function projectRow(row: DataRow, fields: string[]): DataRow {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]))
}

function assertOnlyAllowed(
  provided: string[],
  allowed: string[],
  code: string,
  label: string,
) {
  const invalid = provided.filter((item) => !allowed.includes(item))
  if (invalid.length > 0) {
    throw new DataPlatformError(code, `${label} 不允許：${invalid.join(', ')}`)
  }
}

export class ResourceRegistry<TSession> {
  private readonly registrations = new Map<string, ResourceRegistration<TSession>>()

  register(registration: ResourceRegistration<TSession>): this {
    if (this.registrations.has(registration.name)) {
      throw new DataPlatformError('DUPLICATE_RESOURCE', `Resource 已註冊：${registration.name}`)
    }
    if (registration.maxPageSize && registration.maxPageSize > HARD_MAX_PAGE_SIZE) {
      throw new DataPlatformError('INVALID_RESOURCE', `Resource maxPageSize 不得超過 ${HARD_MAX_PAGE_SIZE}`)
    }
    this.registrations.set(registration.name, registration)
    return this
  }

  list() {
    return [...this.registrations.values()]
      .map(({ name, description, version }) => ({ name, description, version }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  describe(name: string) {
    const registration = this.get(name)
    return {
      name: registration.name,
      description: registration.description,
      version: registration.version,
      fields: registration.fields,
      allowed_filters: registration.allowedFilters,
      allowed_sort_fields: registration.allowedSort,
      pagination: {
        supported: true,
        default_page_size: registration.defaultPageSize ?? DEFAULT_PAGE_SIZE,
        max_page_size: registration.maxPageSize ?? HARD_MAX_PAGE_SIZE,
        cursor: 'opaque',
      },
      date_semantics: registration.dateSemantics,
      currency_semantics: registration.currencySemantics,
      data_quality_semantics: registration.dataQualitySemantics,
      lineage_availability: registration.lineageAvailability,
    }
  }

  async query(
    name: string,
    query: ResourceQuery,
    context: AiRequestContext<TSession>,
  ): Promise<QueryDataResult> {
    const registration = this.get(name)
    const fieldNames = registration.fields.map((field) => field.name)
    const selectedFields = query.fields?.length ? query.fields : fieldNames
    assertOnlyAllowed(selectedFields, fieldNames, 'INVALID_FIELD', 'fields')

    const filters = query.filters ?? {}
    assertOnlyAllowed(Object.keys(filters), registration.allowedFilters, 'INVALID_FILTER', 'filters')

    if (query.sort) {
      assertOnlyAllowed([query.sort.field], registration.allowedSort, 'INVALID_SORT', 'sort.field')
    }

    const maxPageSize = registration.maxPageSize ?? HARD_MAX_PAGE_SIZE
    const defaultPageSize = registration.defaultPageSize ?? DEFAULT_PAGE_SIZE
    const limit = query.pagination?.limit ?? defaultPageSize
    if (!Number.isInteger(limit) || limit < 1 || limit > maxPageSize) {
      throw new DataPlatformError(
        'INVALID_PAGE_SIZE',
        `pagination.limit 必須介於 1 與 ${maxPageSize}`,
      )
    }

    let offset = 0
    if (query.pagination?.cursor) {
      const cursor = decodeCursor(query.pagination.cursor)
      if (cursor.resource !== name || cursor.version !== registration.version) {
        throw new DataPlatformError('INVALID_CURSOR', 'pagination.cursor 不屬於此 Resource 版本')
      }
      offset = cursor.offset
    }

    const read = await registration.readModel(context)
    let rows = registration.applyFilters
      ? registration.applyFilters(read.rows, filters)
      : read.rows

    if (query.sort) {
      const { field, direction } = query.sort
      rows = [...rows].sort((a, b) => compareScalar(a[field] ?? null, b[field] ?? null)
        * (direction === 'desc' ? -1 : 1))
    }

    const page = rows.slice(offset, offset + limit).map((row) => projectRow(row, selectedFields))
    const nextOffset = offset + page.length
    return {
      resource: name,
      resource_version: registration.version,
      rows: page,
      returned_row_count: page.length,
      next_cursor: nextOffset < rows.length
        ? encodeCursor({ resource: name, version: registration.version, offset: nextOffset })
        : null,
      data_quality: read.dataQuality,
      lineage: read.lineage,
    }
  }

  async lineage(
    name: string,
    context: AiRequestContext<TSession>,
  ): Promise<DataLineage> {
    return (await this.get(name).readModel(context)).lineage
  }

  private get(name: string): ResourceRegistration<TSession> {
    const registration = this.registrations.get(name)
    if (!registration) {
      throw new DataPlatformError('UNKNOWN_RESOURCE', `未註冊的 Resource：${name}`)
    }
    return registration
  }
}

export class MetricRegistry<TSession> {
  private readonly registrations = new Map<string, MetricRegistration<TSession>>()

  register(registration: MetricRegistration<TSession>): this {
    if (this.registrations.has(registration.name)) {
      throw new DataPlatformError('DUPLICATE_METRIC', `Metric 已註冊：${registration.name}`)
    }
    this.registrations.set(registration.name, registration)
    return this
  }

  list() {
    return [...this.registrations.values()]
      .map(({ name, description, unit, calculationVersion, allowedParameters }) => ({
        name,
        description,
        unit,
        calculation_version: calculationVersion,
        allowed_parameters: allowedParameters,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async getMetric(
    name: string,
    parameters: Record<string, JsonScalar>,
    context: AiRequestContext<TSession>,
  ): Promise<MetricResult> {
    const registration = this.get(name)
    assertOnlyAllowed(
      Object.keys(parameters),
      registration.allowedParameters,
      'INVALID_METRIC_PARAMETER',
      'parameters',
    )
    return registration.calculate(context, parameters)
  }

  async lineage(
    name: string,
    parameters: Record<string, JsonScalar>,
    context: AiRequestContext<TSession>,
  ): Promise<DataLineage> {
    return (await this.getMetric(name, parameters, context)).lineage
  }

  private get(name: string): MetricRegistration<TSession> {
    const registration = this.registrations.get(name)
    if (!registration) {
      throw new DataPlatformError('UNKNOWN_METRIC', `未註冊的 Metric：${name}`)
    }
    return registration
  }
}
