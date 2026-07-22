import { Hono } from 'hono'
import { buildPortfolioAccounting } from '../src/lib/accounting'
import { buildCashFundingLedger } from '../src/lib/cash-ledger'
import { datasetUploadSchema } from '../src/lib/contracts'
import { validateDatasetForActivation } from '../src/lib/dataset-gate'
import { compareTransactionSets } from '../src/lib/diff'
import { buildPointInTimeValuation } from '../src/lib/valuation'
import {
  toValuationMark,
  valuationSnapshotUploadSchema,
  type ValuationSnapshotUpload,
} from '../src/lib/valuation-contracts'
import { compareValuationMarks } from '../src/lib/valuation-diff'
import { requireUser, type Bindings, type Variables } from './auth'
import { activateDataset, currentRevision, getActiveTransactions, getBootstrap } from './repository'
import {
  activateValuationSnapshot,
  currentValuationRevision,
  getActiveValuationMarks,
  getValuationBootstrap,
} from './valuation-repository'

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.get('/api/health', (c) => c.json({ ok: true, service: 'portfolio-analyzer-cloud' }))
app.use('/api/*', requireUser)

app.get('/api/bootstrap', async (c) => {
  return c.json(await getBootstrap(c.env.DB, c.get('user')))
})

app.post('/api/datasets/preview', async (c) => {
  const parsed = datasetUploadSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '資料格式錯誤' }, 400)

  const user = c.get('user')
  const revision = await currentRevision(c.env.DB, user.id)
  if (revision !== parsed.data.baseRevision) {
    return c.json({ error: '雲端資料已更新，請先重新載入最新版本', code: 'VERSION_CONFLICT' }, 409)
  }

  const oldRows = await getActiveTransactions(c.env.DB, user.id)
  const diff = compareTransactionSets(oldRows, parsed.data.transactions)
  const warnings: string[] = []
  if (parsed.data.rejectedRowCount > 0) {
    warnings.push(`新檔案有 ${parsed.data.rejectedRowCount} 列未通過驗證，修正前不能啟用`)
  }
  const duplicateCount = parsed.data.transactions.length - new Set(parsed.data.transactions.map((row) => row.rowHash)).size
  if (duplicateCount > 0) warnings.push(`新檔案包含 ${duplicateCount} 筆重複交易，無法啟用`)
  if (parsed.data.transactions.some((row) => row.currency !== 'TWD' && row.fxRate === null)) {
    warnings.push('部分外幣交易缺少輸入匯率，財務引擎將需要市場匯率 fallback')
  }

  const activationGate = validateDatasetForActivation(parsed.data.transactions)
  if (activationGate.blockingIssueCount > 0) {
    warnings.push(`新檔案有 ${activationGate.blockingIssueCount} 項帳務或資金阻擋錯誤，修正前不能啟用`)
  }

  return c.json({ diff, warnings, activationGate })
})

app.post('/api/datasets/activate', async (c) => {
  const parsed = datasetUploadSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '資料格式錯誤' }, 400)

  const user = c.get('user')
  const revision = await currentRevision(c.env.DB, user.id)
  if (revision !== parsed.data.baseRevision) {
    return c.json({ error: '雲端資料已更新，請先重新載入最新版本', code: 'VERSION_CONFLICT' }, 409)
  }
  if (parsed.data.rejectedRowCount > 0) {
    return c.json({ error: `新檔案有 ${parsed.data.rejectedRowCount} 列未通過驗證，不能啟用` }, 400)
  }
  if (parsed.data.sourceRowCount !== parsed.data.transactions.length) {
    return c.json({ error: '來源列數與通過驗證的交易筆數不一致' }, 400)
  }
  const duplicateCount = parsed.data.transactions.length - new Set(parsed.data.transactions.map((row) => row.rowHash)).size
  if (duplicateCount > 0) return c.json({ error: `資料包含 ${duplicateCount} 個重複 rowHash` }, 400)

  const activationGate = validateDatasetForActivation(parsed.data.transactions)
  if (activationGate.blockingIssueCount > 0) {
    return c.json({
      error: `新檔案有 ${activationGate.blockingIssueCount} 項帳務或資金阻擋錯誤，不能啟用`,
      code: 'DATASET_ACCOUNTING_BLOCKED',
      issues: activationGate.issues,
    }, 400)
  }

  try {
    await activateDataset(c.env.DB, user, parsed.data, { duplicateCount })
  } catch (error) {
    if (error instanceof Error && (error.message.includes('UNIQUE') || error.message === 'VERSION_CONFLICT')) {
      return c.json({ error: '資料版本衝突或此檔案已上傳，請重新載入', code: 'VERSION_CONFLICT' }, 409)
    }
    throw error
  }
  return c.json(await getBootstrap(c.env.DB, user), 201)
})

async function evaluateValuationCandidate(
  db: D1Database,
  userId: string,
  payload: ValuationSnapshotUpload,
) {
  const transactions = await getActiveTransactions(db, userId)
  const accounting = buildPortfolioAccounting(transactions)
  const cashLedger = buildCashFundingLedger(transactions)
  const valuation = buildPointInTimeValuation({
    valuationDate: payload.valuationDate,
    positions: accounting.positions,
    wallets: cashLedger.wallets,
    marks: payload.marks.map(toValuationMark),
  })
  return { transactions, valuation }
}

app.get('/api/valuations/bootstrap', async (c) => {
  return c.json(await getValuationBootstrap(c.env.DB, c.get('user')))
})

app.post('/api/valuations/preview', async (c) => {
  const parsed = valuationSnapshotUploadSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '估值資料格式錯誤' }, 400)

  const user = c.get('user')
  const revision = await currentValuationRevision(c.env.DB, user.id)
  if (revision !== parsed.data.baseRevision) {
    return c.json({ error: '雲端估值資料已更新，請先重新載入', code: 'VALUATION_VERSION_CONFLICT' }, 409)
  }

  const oldMarks = await getActiveValuationMarks(c.env.DB, user.id)
  const diff = compareValuationMarks(oldMarks, parsed.data.marks)
  const warnings: string[] = []
  if (parsed.data.rejectedRowCount > 0) {
    warnings.push(`估值檔有 ${parsed.data.rejectedRowCount} 列未通過驗證，修正前不能啟用`)
  }
  const duplicateCount = parsed.data.marks.length - new Set(parsed.data.marks.map((mark) => mark.rowHash)).size
  if (duplicateCount > 0) warnings.push(`估值檔包含 ${duplicateCount} 筆重複標記，無法啟用`)

  const { transactions, valuation } = await evaluateValuationCandidate(c.env.DB, user.id, parsed.data)
  if (transactions.length === 0) warnings.push('目前沒有 ACTIVE 交易資料，不能建立估值')
  if (!valuation.complete) warnings.push(`估值有 ${valuation.blockingIssueCount} 項阻擋問題，修正前不能啟用`)
  if (valuation.futureMarkCount > 0) warnings.push(`${valuation.futureMarkCount} 筆未來標記已被 Point-in-Time 規則忽略`)

  const activationAllowed = parsed.data.rejectedRowCount === 0
    && parsed.data.sourceRowCount === parsed.data.marks.length
    && duplicateCount === 0
    && transactions.length > 0
    && valuation.complete

  return c.json({ diff, warnings, valuation, activationAllowed })
})

app.post('/api/valuations/activate', async (c) => {
  const parsed = valuationSnapshotUploadSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '估值資料格式錯誤' }, 400)

  const user = c.get('user')
  const revision = await currentValuationRevision(c.env.DB, user.id)
  if (revision !== parsed.data.baseRevision) {
    return c.json({ error: '雲端估值資料已更新，請先重新載入', code: 'VALUATION_VERSION_CONFLICT' }, 409)
  }
  if (parsed.data.rejectedRowCount > 0 || parsed.data.sourceRowCount !== parsed.data.marks.length) {
    return c.json({ error: '估值檔仍有未通過驗證的資料列，不能啟用' }, 400)
  }
  const duplicateCount = parsed.data.marks.length - new Set(parsed.data.marks.map((mark) => mark.rowHash)).size
  if (duplicateCount > 0) return c.json({ error: `估值檔包含 ${duplicateCount} 筆重複標記` }, 400)

  const { transactions, valuation } = await evaluateValuationCandidate(c.env.DB, user.id, parsed.data)
  if (transactions.length === 0) {
    return c.json({ error: '目前沒有 ACTIVE 交易資料，不能建立估值', code: 'NO_ACTIVE_DATASET' }, 400)
  }
  if (!valuation.complete) {
    return c.json({
      error: `估值有 ${valuation.blockingIssueCount} 項阻擋問題，不能啟用`,
      code: 'VALUATION_INCOMPLETE',
      issues: valuation.issues,
    }, 400)
  }

  try {
    await activateValuationSnapshot(c.env.DB, user, parsed.data, {
      duplicateCount,
      futureMarkCount: valuation.futureMarkCount,
      totalAssetsTwd: valuation.totalAssetsTwd,
    })
  } catch (error) {
    if (error instanceof Error && (error.message.includes('UNIQUE') || error.message === 'VALUATION_VERSION_CONFLICT')) {
      return c.json({ error: '估值版本衝突或此檔案已上傳，請重新載入', code: 'VALUATION_VERSION_CONFLICT' }, 409)
    }
    throw error
  }

  return c.json(await getValuationBootstrap(c.env.DB, user), 201)
})

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: '伺服器處理失敗，舊的 ACTIVE 資料未被覆蓋' }, 500)
})

export default app
