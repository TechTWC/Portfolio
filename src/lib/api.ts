import type { BootstrapResponse, DatasetDiff, DatasetUpload } from './contracts'
import { publishPortfolioDataUpdate } from './data-sync'
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
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        ...(init?.headers ?? {}),
      },
    })
  } catch (error) {
    const detail = error instanceof Error && error.message !== 'Failed to fetch'
      ? `（${error.message}）`
      : ''
    throw new ApiError(
      `無法連線至雲端 API ${url}；請確認網路與 Cloudflare Access 登入狀態後重試${detail}。舊的 ACTIVE 資料未被更新。`,
      0,
      'NETWORK_OR_ACCESS_ERROR',
    )
  }
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

function publishAfterCurrentHandler(update: Parameters<typeof publishPortfolioDataUpdate>[0]) {
  setTimeout(() => publishPortfolioDataUpdate(update), 0)
}

export const api = {
  bootstrap: () => requestJson<BootstrapResponse>('/api/bootstrap'),
  preview: (payload: DatasetUpload) =>
    requestJson<{ diff: DatasetDiff; warnings: string[]; activationGate: DatasetActivationGate }>('/api/datasets/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  activate: async (payload: DatasetUpload) => {
    const updated = await requestJson<BootstrapResponse>('/api/datasets/activate', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    publishAfterCurrentHandler({
      kind: 'TRANSACTIONS_ACTIVATED',
      transactionRevision: updated.cloudRevision,
    })
    return updated
  },
  valuationBootstrap: () =>
    requestJson<ValuationBootstrapResponse>('/api/valuations/bootstrap'),
  valuationPreview: (payload: ValuationSnapshotUpload) =>
    requestJson<ValuationPreviewResponse>('/api/valuations/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  valuationActivate: async (payload: ValuationSnapshotUpload) => {
    const updated = await requestJson<ValuationBootstrapResponse>('/api/valuations/activate', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    publishAfterCurrentHandler({
      kind: 'VALUATION_ACTIVATED',
      valuationRevision: updated.valuationRevision,
    })
    return updated
  },
}
