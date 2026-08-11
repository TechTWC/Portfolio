export type AccessPolicy = {
  decision?: string
  include?: Array<Record<string, unknown>>
  exclude?: Array<Record<string, unknown>>
  require?: Array<Record<string, unknown>>
}

export function assertPersonalPolicy(policies: AccessPolicy[], expectedEmail: string): void

export function verifyPersonalAccess(options: {
  apiToken?: string
  accountId?: string
  appDomain?: string
  personalEmail?: string
  fetchImpl?: typeof fetch
}): Promise<{ appId: string; audience: string }>
