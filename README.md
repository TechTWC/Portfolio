# Portfolio Analyzer Cloud

個人投資交易明細的跨瀏覽器雲端版本管理與分析工具。

本專案採用 **Cloud-canonical, Local-cached**：

- Cloudflare D1 的 `ACTIVE Dataset` 是跨裝置正式版本。
- 每個瀏覽器以 IndexedDB 保存最近一次成功同步的離線快取。
- 新上傳檔案必須先解析、驗證與比較，確認後才啟用。
- 舊的 ACTIVE 版本會轉成 ARCHIVED，不會先刪除再寫入。
- `baseRevision` 防止兩台裝置互相覆蓋。

## 已完成範圍

### Cloud vertical slice

- React + Vite + TypeScript 使用者介面
- Cloudflare Worker + Hono API
- Cloudflare Access 身分標頭驗證；本機可使用 dev identity
- D1 migration：使用者、資料集版本、交易、設定、同步 revision
- Excel / CSV 瀏覽器端解析
- 新舊資料 hash 比較
- `PENDING → ACTIVE → ARCHIVED` 資料版本流程
- 409 revision conflict 防護
- IndexedDB 離線快取與跨瀏覽器雲端還原
- 拒收列不得啟用
- 跨資料集穩定交易 ID 與保守的交易更正血緣
- 估值 Snapshot 綁定精確交易 Dataset／Revision
- 交易更新後估值顯示 `STALE`，舊結果仍以原交易版本重現
- 使用者觸發的自動收盤行情 v1（開發分支）：歷史 raw close、FX、SPY 基準與增量快取

### Python reference engine fixes（下一批推送）

`reference/python` 保留原始 Python 財務引擎作為正確性基準，已修正：

- 一次性投入本金重複及基準不一致
- 台幣現金未優先支應外幣證券買進
- 外幣出金未按出金日匯率認列
- 超賣、超額換回及超額出金只被截斷
- DCA／一次性投入在非交易日錯用前一日價格
- 鏡像策略未一致使用市場匯率 fallback
- 市場價格混用 adjusted/raw basis

### MDD reference fixes（下一批推送）

`reference/mdd` 已加入獨立 `mdd_engine.py`：

- 每日資料改名為 Current Drawdown from Historical Peak
- 年度最小值才稱為 Maximum Drawdown
- 分位數只使用實際交易日，不再以前向填值加入週末
- 價格 basis 明確指定 raw Close；另保留 adjusted proxy 選項
- 深度回撤不再直接描述成買進訊號

## 專案結構

```text
portfolio-analyzer-cloud/
├─ src/                    React UI、parser、IndexedDB、shared contracts
├─ worker/                 Hono API、Access auth、D1 repository
├─ migrations/             D1 schema、交易血緣與估值版本綁定
├─ tests/                  TypeScript tests
├─ reference/python/       修正後 Python 投資組合引擎
├─ reference/mdd/          修正後 MDD reference app/engine
├─ docs/                   架構、帳務政策、部署與 roadmap
└─ .github/workflows/      CI
```

## 本機啟動

1. 安裝 Node.js 22 與 Python 3.11+。
2. 複製本機身分設定：

```bash
cp .dev.vars.example .dev.vars
```

3. 建立本機 D1 並執行 migration：

```bash
npm ci
npm run db:migrate:local
npm run dev
```

`xlsx` 使用已提交至 `vendor/` 的 SheetJS CE 0.20.3 官方套件。首次取得或更新
其他 npm 相依套件時仍需連線至 npm registry；SheetJS 本身不需要連線至外部 CDN。

## 測試

```bash
npm test
npm run typecheck
npm run build
npm run audit:production
npm run audit:all

python -m pytest reference/python/tests -q
python -m pytest reference/mdd/tests -q
```

## 部署前必要設定

1. 建立 Cloudflare D1 database。
2. 將 `wrangler.jsonc` 的 `database_id` 換成實際 ID。
3. 將網站放在 Cloudflare Access 後方，只允許指定 Email。
4. 不要在正式環境設定 `AUTH_MODE=dev`。
5. 執行 remote migration 後再 deploy。

詳見 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。
