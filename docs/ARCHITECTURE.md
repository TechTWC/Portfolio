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
        ├─ normalized transactions
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

## 4. Concurrency

每次上傳帶入 `baseRevision`。若雲端 revision 已改變，API 回傳：

```text
409 VERSION_CONFLICT
```

使用者必須先重新 bootstrap 最新 ACTIVE Dataset，避免舊瀏覽器覆蓋新資料。

`UNIQUE(user_id, revision)` 同時扮演 revision reservation，避免兩個裝置同時建立相同下一版。

## 5. Authentication

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

## 6. Analysis migration strategy

不一次重寫全部 Python 演算法。

1. Python 先完成 P0 帳務修正及 golden tests。
2. Cloudflare Web 層先完成資料同步垂直切片。
3. 逐函式移植至 TypeScript。
4. 每項 TypeScript 結果必須與 Python golden cases 比對。
5. 完成 parity 後，才由 Web App 正式取代 Streamlit 分析頁。
