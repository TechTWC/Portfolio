export function assertAccessEnforced(
  response: Response,
  options: { deploymentUrl: string; teamDomain: string; responseBody?: unknown },
): string

export function probeAccessEnforcement(options: {
  deploymentUrl?: string
  teamDomain?: string
  fetchImpl?: typeof fetch
  attempts?: number
  retryDelayMs?: number
}): Promise<void>
