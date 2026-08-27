import type { AiUser } from './types'

export type AuditOutcome = {
  rowCount: number
}

export async function runAudited<T>(
  db: D1Database,
  user: AiUser,
  input: {
    requestId: string
    tool: string
    target: string | null
  },
  operation: () => Promise<{ value: T; outcome: AuditOutcome }>,
): Promise<T> {
  const started = Date.now()
  let value: T | undefined
  let rowCount = 0
  let operationError: unknown

  try {
    const result = await operation()
    value = result.value
    rowCount = result.outcome.rowCount
  } catch (error) {
    operationError = error
  }

  try {
    await db.prepare(
      `INSERT INTO mcp_audit_log
        (id, request_id, user_id, authenticated_email, tool, target,
         success, duration_ms, returned_row_count, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      input.requestId,
      user.id,
      user.email,
      input.tool,
      input.target,
      operationError ? 0 : 1,
      Math.max(0, Date.now() - started),
      rowCount,
      operationError instanceof Error && 'code' in operationError
        ? String((operationError as Error & { code: unknown }).code)
        : operationError ? 'UNHANDLED_ERROR' : null,
    ).run()
  } catch (auditError) {
    console.error('MCP audit write failed', auditError)
    throw new Error('MCP_AUDIT_UNAVAILABLE')
  }

  if (operationError) throw operationError
  return value as T
}
