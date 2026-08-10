export function assertAccessEnforced(
  response: Response,
  options: { deploymentUrl: string; teamDomain: string },
): string

export function probeAccessEnforcement(options: {
  deploymentUrl?: string
  teamDomain?: string
  fetchImpl?: typeof fetch
  attempts?: number
  retryDelayMs?: number
}): Promise<void>
