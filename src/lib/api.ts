import type { BootstrapResponse, DatasetDiff, DatasetUpload } from './contracts'
import type { DatasetActivationGate } from './dataset-gate'
import type {
  ValuationBootstrapResponse,
  ValuationPreviewResponse,
  ValuationSnapshotUpload,
} from './valuation-contracts'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentRevision?: number,
    readonly baseRevision?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-cache',
      ...(init?.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => ({})) as {
    error?: string
    code?: string
    currentRevision?: number
    baseRevision?: number
  }
  if (!response.ok) {
    throw new ApiError(
      body.error ?? `HTTP ${response.status}`,
      response.status,
      body.code,
      body.currentRevision,
      body.baseRevision,
    )
  }
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
  valuationBootstrap: () =>
    requestJson<ValuationBootstrapResponse>('/api/valuations/bootstrap'),
  valuationPreview: (payload: ValuationSnapshotUpload) =>
    requestJson<ValuationPreviewResponse>('/api/valuations/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  valuationActivate: (payload: ValuationSnapshotUpload) =>
    requestJson<ValuationBootstrapResponse>('/api/valuations/activate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
}
