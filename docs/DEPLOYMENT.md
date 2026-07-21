# Cloudflare Deployment

## 1. GitHub

建議建立新的 private repository：

```text
TechTWC/portfolio-analyzer-cloud
```

不要放入 TWstock，也不要覆蓋現有 stock-dashboard。

## 2. D1

```bash
npx wrangler d1 create portfolio-analyzer
```

將回傳的 `database_id` 填入 `wrangler.jsonc`，再執行：

```bash
npm run db:migrate:remote
```

## 3. Cloudflare Access

將正式 Worker hostname 放在 Access Application 後方，只允許指定 Email。

正式環境不得設定：

```text
AUTH_MODE=dev
```

沒有 Access header 時，API 會回傳 401。

## 4. Deploy

```bash
npm run test
npm run typecheck
npm run build
npm run deploy
```

## 5. Git automation

Cloudflare 連接 GitHub repository 後：

```text
push branch → preview build
merge main  → production deploy
```

財務算法變更仍建議以 Draft PR、測試與人工確認後再合併。

## 6. Secrets

不得 commit：

- `.dev.vars`
- Cloudflare API token
- 真實交易 Excel／CSV
- D1 database backups
- 使用者 Email allowlist export
