# Architecture

## 1. Design decision

本系統不是單純的瀏覽器記憶，也不是每次開啟都重新上傳，而是：

```text
Browser A / Browser B / Mobile
        │
        ├─ React UI
        ├─ IndexedDB last-known-good cache
        └─ Excel/CSV parser
                │
                ▼
Cloudflare Access
                │
                ▼
Cloudflare Worker + Hono
        ├─ identity isolation
        ├─ schema validation
        ├─ revision conflict control
        ├─ dataset activation
        └─ bootstrap/restore
                │
                ▼
Cloudflare D1
        ├─ ACTIVE canonical dataset
        ├─ ARCHIVED versions
        ├─ normalized transactions + stable transaction_id
        ├─ valuation → transaction dataset lineage
        └─ cloud_revision
```

## 2. Data authority

- **D1 ACTIVE Dataset**：跨瀏覽器正式版本。
- **IndexedDB**：離線與加速用途，不能覆蓋較新的雲端 revision。
- **原始 Excel**：MVP 不上傳雲端；瀏覽器只將標準化交易資料送至 Worker。
- **Python engine**：目前為財務計算 reference implementation，不是雲端同步 authority。

## 3. Dataset lifecycle

```text
Upload
  → browser parse
  → rejected-row validation
  → preview diff
  → PENDING dataset
  → insert normalized rows
  → verify baseRevision
  → old ACTIVE becomes ARCHIVED
  → PENDING becomes ACTIVE
  → cloudRevision + 1
```

技術失敗時刪除未完成的 PENDING dataset；舊 ACTIVE 資料保持不變。

交易資料庫列另保存邏輯 `transaction_id`。完全相同的交易即使換列順序也沿用 ID；
更正只有在來源列或語意鍵能一對一安全配對時才沿用 ID。重複而無法判定的交易不猜測，
會建立新 ID，避免把兩筆不同交易錯誤合併成同一血緣。

## 4. Valuation lineage and freshness

每個估值 Snapshot 保存建立當下的 `transaction_dataset_id` 與 `transaction_revision`。
所有估值、XIRR、歷史 NAV、TWR 與回撤都使用該綁定版本，不再與最新交易版本任意組合。

- 綁定版本等於目前 ACTIVE 交易：`CURRENT`
- 交易已更新：`STALE`，但舊數字仍可用原交易版本重現
- 尚無估值：`NO_SNAPSHOT`

估值 preview 與 activate 都會核對交易綁定；兩步之間若交易版本改變，回傳
`409 TRANSACTION_VERSION_CONFLICT`，使用者必須重新預覽。

## 5. Concurrency

每次上傳帶入 `baseRevision`。若雲端 revision 已改變，API 回傳：

```text
409 VERSION_CONFLICT
```

使用者必須先重新 bootstrap 最新 ACTIVE Dataset，避免舊瀏覽器覆蓋新資料。

`UNIQUE(user_id, revision)` 同時扮演 revision reservation，避免兩個裝置同時建立相同下一版。

## 6. Authentication

正式環境只接受 Cloudflare Access 注入的：

```text
Cf-Access-Authenticated-User-Email
```

Worker 將 Email 正規化後產生穩定 user ID，所有資料列皆綁定 `user_id`。

本機開發才允許：

```text
AUTH_MODE=dev
DEV_USER_EMAIL=local@example.com
```

## 7. Analysis migration strategy

不一次重寫全部 Python 演算法。

1. Python 先完成 P0 帳務修正及 golden tests。
2. Cloudflare Web 層先完成資料同步垂直切片。
3. 逐函式移植至 TypeScript。
4. 每項 TypeScript 結果必須與 Python golden cases 比對。
5. 完成 parity 後，才由 Web App 正式取代 Streamlit 分析頁。
