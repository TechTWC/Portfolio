import type { BootstrapResponse, DatasetDiff, DatasetUpload } from './contracts'
import type { DatasetActivationGate } from './dataset-gate'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string }
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status, body.code)
  return body as T
}

export const api = {
  bootstrap: () => requestJson<BootstrapResponse>('/api/bootstrap'),
  preview: (payload: DatasetUpload) =>
    requestJson<{ diff: DatasetDiff; warnings: string[]; activationGate: DatasetActivationGate }>('/api/datasets/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  activate: (payload: DatasetUpload) =>
    requestJson<BootstrapResponse>('/api/datasets/activate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
}
