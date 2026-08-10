# Cloudflare Deployment

## 1. Current repository

```text
TechTWC/Portfolio
```

目前部署來源為 Draft PR #2 的 branch：

```text
agent/cloud-bootstrap-v0-1
```

Repository 是 public，因此不得 commit 真實交易明細、Cloudflare token、Account ID secret、`.dev.vars`、Email allowlist 或 D1 backup。

## 2. Recommended staging path

本專案不要求使用者在本機安裝 Node.js。部署由 GitHub Actions 的：

```text
Deploy Staging
```

自動完成。

Workflow 會：

1. 執行測試、typecheck 與 build。
2. 尋找或建立 `portfolio-analyzer-staging` D1。
3. 產生 staging Wrangler config。
4. 套用 remote migrations。
5. 部署 `portfolio-analyzer-staging` Worker。
6. 執行 `/api/health` smoke test。

完整一次性設定見：

- [STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md)
- [CROSS_BROWSER_ACCEPTANCE.md](CROSS_BROWSER_ACCEPTANCE.md)

## 3. Required GitHub environment secrets

建立 GitHub environment：

```text
staging
```

加入：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

API token 只授予 Workers 部署及 D1 管理所需權限。不要使用 Global API Key。

## 4. D1

Staging workflow 會自動尋找或建立：

```text
portfolio-analyzer-staging
```

並以 APAC 作為 location hint。資料庫 ID 只在 workflow 執行期間寫入暫存 Wrangler config，不 commit 到 repository。

Migration 使用：

```text
migrations/
```

套用失敗時，Cloudflare D1 會回滾該次 migration；既有成功 migration 保持不變。

## 5. Cloudflare Access

Staging Worker 建立後，必須將 hostname 放入 Cloudflare Access Application，只允許指定 Email。

目前只有：

```text
/api/health
```

可在未登入時公開回應，供自動部署 smoke test 使用。其他 `/api/*` 沒有 Access identity 時應回傳 401。

正式及 staging 雲端環境不得設定：

```text
AUTH_MODE=dev
DEV_USER_EMAIL=...
```

## 6. Deployment lifecycle

```text
Draft PR code
→ CI tests/typecheck/build
→ Deploy Staging workflow
→ D1 migration
→ Worker deploy
→ health smoke test
→ Cloudflare Access
→ Browser A/B acceptance
→ PR review
→ merge main
```

財務算法變更仍必須經過 Draft PR、golden tests 與人工確認，不得直接自動合併。

## 7. Personal Production

正式個人環境使用 GitHub environment：

```text
production
```

必要 secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_PERSONAL_EMAIL
```

`CLOUDFLARE_PERSONAL_EMAIL` 只保存在 GitHub environment secret，不得寫入 Repository、
Workflow Log 或部署摘要。

正式資源與 Staging 完全分離：

```text
Worker: portfolio-analyzer
D1: portfolio-analyzer-production
URL: https://portfolio-analyzer.techtwc.workers.dev
```

`Deploy Personal Production` 只允許手動觸發，且輸入必須是當下 `main` 的完整
40 字元 Commit SHA。部署在建立 D1 或套用 Migration 前會先確認：

1. 正式 hostname 恰好對應一個 Cloudflare Access Application。
2. Application 恰好只有一個 Policy。
3. Policy 是 `Allow`，而且唯一 Include Rule 是設定於 Secret 的本人 Email。
4. 不接受 Everyone、Email Domain、Group、第二個 Email、Bypass 或額外 Require／Exclude Rule。

任何條件不符都必須停止部署，不得以 Staging D1 或 `AUTH_MODE=dev` 代替。
