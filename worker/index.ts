import { Hono } from 'hono'
import { datasetUploadSchema } from '../src/lib/contracts'
import { compareTransactionSets } from '../src/lib/diff'
import { requireUser, type Bindings, type Variables } from './auth'
import { activateDataset, currentRevision, getActiveTransactions, getBootstrap } from './repository'

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
  return c.json({ diff, warnings })
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

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: '伺服器處理失敗，舊的 ACTIVE 交易資料未被覆蓋' }, 500)
})

export default app
