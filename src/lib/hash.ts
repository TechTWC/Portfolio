const encoder = new TextEncoder()

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function stableTransactionValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return String(value).trim()
}
