import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'
import type { BootstrapResponse, DatasetUpload } from '../src/lib/contracts'

const payload: DatasetUpload = {
  baseRevision: 6,
  filename: 'synthetic.xlsx',
  fileHash: 'a'.repeat(64),
  parserVersion: 'test',
  sourceRowCount: 1,
  rejectedRowCount: 0,
  transactions: [{
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'SECURITY',
    ticker: 'TEST',
    currency: 'TWD',
    quantity: 1,
    price: 100,
    amountForeign: 100,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: 'b'.repeat(64),
  }],
}

const activated: BootstrapResponse = {
  user: { id: 'synthetic-user', email: 'synthetic@example.test' },
  cloudRevision: 7,
  activeDataset: null,
  transactions: payload.transactions,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dataset API activation', () => {
  it('activates after a successful Excel preview', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        diff: { unchanged: false },
        warnings: [],
        activationGate: { blockingIssueCount: 0, issues: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(activated), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await api.preview(payload)
    await expect(api.activate(payload)).resolves.toMatchObject({ cloudRevision: 7 })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/datasets/activate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(payload),
    }))
  })

  it('does not report activation when the API request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(api.activate(payload)).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'NETWORK_OR_ACCESS_ERROR',
    })
  })

  it('turns a browser fetch failure into an actionable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(api.bootstrap()).rejects.toEqual(expect.objectContaining({
      message: expect.stringContaining('更新結果尚未確認，請重新登入 Access 並重新同步確認'),
      code: 'NETWORK_OR_ACCESS_ERROR',
      status: 0,
    }))
  })
})
