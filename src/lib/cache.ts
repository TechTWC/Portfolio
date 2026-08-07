import Dexie, { type EntityTable } from 'dexie'
import type { BootstrapResponse, StoredTransaction } from './contracts'

type CachedPortfolio = {
  key: string
  userId: string
  cloudRevision: number
  payload: BootstrapResponse
  cachedAt: string
}

const LAST_USER_KEY = 'portfolio-analyzer:last-user-id'

class PortfolioCache extends Dexie {
  portfolios!: EntityTable<CachedPortfolio, 'key'>

  constructor() {
    super('portfolio-analyzer-cache')
    this.version(1).stores({ portfolios: 'key, cloudRevision, cachedAt' })
    this.version(2).stores({ portfolios: 'key, userId, cloudRevision, cachedAt' })
  }
}

const db = new PortfolioCache()

export async function readCachedBootstrap(): Promise<BootstrapResponse | null> {
  const userId = localStorage.getItem(LAST_USER_KEY)
  if (!userId) return null
  const cached = await db.portfolios.get(`active:${userId}`)
  if (!cached) return null
  return {
    ...cached.payload,
    transactions: cached.payload.transactions.map((row) => ({
      ...row,
      transactionId: (row as Partial<StoredTransaction>).transactionId || `legacy:${row.rowHash}`,
    })),
  }
}

export async function writeCachedBootstrap(payload: BootstrapResponse): Promise<void> {
  localStorage.setItem(LAST_USER_KEY, payload.user.id)
  await db.portfolios.put({
    key: `active:${payload.user.id}`,
    userId: payload.user.id,
    cloudRevision: payload.cloudRevision,
    payload,
    cachedAt: new Date().toISOString(),
  })
}

export async function clearPortfolioCache(userId?: string): Promise<void> {
  if (userId) {
    await db.portfolios.delete(`active:${userId}`)
    if (localStorage.getItem(LAST_USER_KEY) === userId) localStorage.removeItem(LAST_USER_KEY)
    return
  }
  await db.portfolios.clear()
  localStorage.removeItem(LAST_USER_KEY)
}
