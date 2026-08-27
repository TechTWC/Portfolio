import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { z } from 'zod'
import type { Bindings } from '../auth'
import { runAudited } from './audit'
import { createDataRegistry, createMetricRegistry } from './platform'
import { PortfolioReadSession } from './read-session'
import { DataPlatformError, type AiUser, type JsonScalar } from './types'

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const parametersSchema = z.record(z.string(), scalarSchema).default({})
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const

function toolResponse(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  }
}

function requestIdFrom(request: Request): string {
  return request.headers.get('Cf-Ray')
    ?? request.headers.get('X-Request-Id')
    ?? crypto.randomUUID()
}

export function createPortfolioMcpHandler(env: Bindings, user: AiUser, request: Request) {
  const dataRegistry = createDataRegistry()
  const metricRegistry = createMetricRegistry()
  const context = { user, session: new PortfolioReadSession(env.DB, user) }
  const requestId = requestIdFrom(request)

  return createMcpHandler(() => {
    const server = new McpServer({
      name: 'portfolio-analyzer-read-only',
      version: '0.1.0',
    }, {
      instructions: 'Read-only Portfolio Analyzer semantic data layer. Never infer missing official metrics as complete.',
    })

    const audited = <T>(
      tool: string,
      target: string | null,
      operation: () => Promise<{ value: T; rowCount: number }>,
    ) => runAudited(env.DB, user, { requestId, tool, target }, async () => {
      const result = await operation()
      return { value: result.value, outcome: { rowCount: result.rowCount } }
    })

    server.registerTool('list_data_resources', {
      title: 'List portfolio data resources',
      description: 'Discover the allowlisted Portfolio Analyzer business resources available for read-only queries.',
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    }, async () => toolResponse(await audited('list_data_resources', null, async () => {
      const resources = dataRegistry.list()
      return { value: { resources }, rowCount: resources.length }
    })))

    server.registerTool('describe_resource', {
      title: 'Describe a portfolio resource',
      description: 'Return the stable data contract, filters, sorting, pagination, date, currency, quality and lineage semantics for one registered resource.',
      inputSchema: z.object({ resource: z.string().min(1).max(80) }),
      annotations: readOnlyAnnotations,
    }, async ({ resource }) => toolResponse(await audited('describe_resource', resource, async () => ({
      value: dataRegistry.describe(resource),
      rowCount: 1,
    }))))

    server.registerTool('query_data', {
      title: 'Query portfolio business data',
      description: 'Query one registered resource with allowlisted filters, fields, sorting and cursor pagination. SQL and database identifiers are not accepted.',
      inputSchema: z.object({
        resource: z.string().min(1).max(80),
        filters: parametersSchema.optional(),
        fields: z.array(z.string().min(1).max(80)).max(100).optional(),
        sort: z.object({
          field: z.string().min(1).max(80),
          direction: z.enum(['asc', 'desc']).default('asc'),
        }).optional(),
        pagination: z.object({
          limit: z.number().int().min(1).max(500).optional(),
          cursor: z.string().min(1).max(2_000).optional(),
        }).optional(),
      }).strict(),
      annotations: readOnlyAnnotations,
    }, async ({ resource, filters, fields, sort, pagination }) => toolResponse(await audited(
      'query_data',
      resource,
      async () => {
        const result = await dataRegistry.query(resource, {
          filters: filters as Record<string, JsonScalar> | undefined,
          fields,
          sort,
          pagination,
        }, context)
        return { value: result, rowCount: result.returned_row_count }
      },
    )))

    server.registerTool('list_metrics', {
      title: 'List official portfolio metrics',
      description: 'Discover the registered financial metrics calculated by Portfolio Analyzer domain services.',
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    }, async () => toolResponse(await audited('list_metrics', null, async () => {
      const metrics = metricRegistry.list()
      return { value: { metrics }, rowCount: metrics.length }
    })))

    server.registerTool('get_metric', {
      title: 'Get an official portfolio metric',
      description: 'Return one registered metric from the existing Portfolio Analyzer calculation services, including status, version and lineage.',
      inputSchema: z.object({
        metric: z.string().min(1).max(80),
        parameters: parametersSchema.optional(),
      }).strict(),
      annotations: readOnlyAnnotations,
    }, async ({ metric, parameters }) => toolResponse(await audited('get_metric', metric, async () => ({
      value: await metricRegistry.getMetric(metric, parameters as Record<string, JsonScalar> | undefined ?? {}, context),
      rowCount: 1,
    }))))

    server.registerTool('get_data_lineage', {
      title: 'Get portfolio data lineage',
      description: 'Trace a registered resource, metric or current valuation to its transaction, valuation, market and calculation versions.',
      inputSchema: z.object({
        target: z.object({
          kind: z.enum(['resource', 'metric', 'valuation']),
          name: z.string().min(1).max(80).optional(),
          parameters: parametersSchema.optional(),
        }).strict(),
      }).strict(),
      annotations: readOnlyAnnotations,
    }, async ({ target }) => {
      const name = target.kind === 'valuation' ? 'nav' : target.name
      if (!name) throw new DataPlatformError('INVALID_LINEAGE_TARGET', 'target.name 為必填')
      const value = await audited('get_data_lineage', `${target.kind}:${name}`, async () => ({
        value: target.kind === 'resource'
          ? await dataRegistry.lineage(name, context)
          : await metricRegistry.lineage(name, target.parameters as Record<string, JsonScalar> | undefined ?? {}, context),
        rowCount: 1,
      }))
      return toolResponse({ target: { kind: target.kind, name }, lineage: value })
    })

    return server
  }, {
    route: '/mcp',
    corsOptions: false,
  })
}
