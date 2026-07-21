# Staging Deployment — One-Time Setup

## 目前目的

這個階段只驗證一件事：

> 在瀏覽器 A 上傳交易檔後，登入相同身分的瀏覽器 B 能自動取得同一份 ACTIVE Dataset。

還不是正式上線，也不要先放真實交易資料。

## 已自動化

GitHub Actions 的 `Deploy Staging` workflow 會自動：

1. 執行單元測試、TypeScript typecheck 與 production build。
2. 尋找 `portfolio-analyzer-staging` D1；不存在時自動建立在 APAC location hint。
3. 產生不含 dev authentication 的 staging Wrangler config。
4. 套用 D1 migrations。
5. 部署 `portfolio-analyzer-staging` Worker。
6. 呼叫 `/api/health` 執行 smoke test。
7. 在 workflow summary 顯示部署 URL 與 D1 ID。

## 你只需做一次的帳號設定

### 1. Cloudflare API token

在 Cloudflare 建立只供 GitHub Actions 使用的 API token。權限只需涵蓋：

- Workers 部署與更新。
- D1 database 建立、讀取與 migration。

不要使用 Global API Key，也不要把 token 貼在程式碼或聊天公開內容。

### 2. Cloudflare Account ID

從 Cloudflare Dashboard 複製 Account ID。

### 3. GitHub staging environment secrets

在 `TechTWC/Portfolio`：

```text
Settings
→ Environments
→ New environment
→ staging
```

在 `staging` environment 加入：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

兩個值都必須使用 GitHub Secret，不得寫入 repository file。

### 4. 執行部署

```text
GitHub repository
→ Actions
→ Deploy Staging
→ Run workflow
→ Branch: agent/cloud-bootstrap-v0-1
```

成功後，workflow summary 會出現 staging URL。

## Access 設定

首次部署完成後，將 staging URL 放入 Cloudflare Access Application，只允許你的指定 Email。

Access 尚未完成前：

- `/api/health` 可以公開回應，供自動部署檢查。
- 其他 `/api/*` 必須回傳 401。
- 不得上傳真實交易資料。

正式環境不得設定：

```text
AUTH_MODE=dev
DEV_USER_EMAIL=...
```

## 完成標準

- Deploy Staging workflow 全綠。
- D1 migration 成功。
- `/api/health` 成功。
- 未登入時 `/api/bootstrap` 回傳 401。
- Cloudflare Access 只允許指定 Email。
- 完成 Browser A → Browser B 驗收。
